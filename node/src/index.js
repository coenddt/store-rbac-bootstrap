// store-rbac-bootstrap/node/src/index.js
'use strict';

const fs = require('fs');
const jwt = require('jsonwebtoken');

const ALLOWED_KEYS = ['policy', 'exemptRoles', 'denyWriteRoles', 'unconfiguredPolicy'];
const FACADES = ['setRbac', 'setExemptRoles', 'setDenyWriteRoles', 'setUnconfiguredPolicy'];

/* ------------------------------------------------------------------ *
 * policy：策略引导（读 bootstrap 配置 → 调 store 既有门面）
 * ------------------------------------------------------------------ */

/** 策略源 ①：本地文件 → JSON.parse；文件不存在 / JSON 非法 ⇒ 抛 Error */
function file(path) {
  return async () => JSON.parse(fs.readFileSync(path, 'utf8'));
}

/** 策略源 ②：远端策略分发服务（集中下发、判决仍在本进程 core）→ fetch；非 2xx / JSON 非法 ⇒ 抛 Error */
function url(u, opts = {}) {
  return async () => {
    const res = await fetch(u, { headers: opts.headers || {} });
    if (!res.ok) throw new Error(`策略源请求失败: ${res.status} ${u}`);
    return res.json();
  };
}

/** 策略源 ③：DB / 配置中心 → loader 原样包装 */
function db(loader) {
  return async () => loader();
}

/** 配置校验（校验先于应用；任一不符即抛 Error，此时零门面调用） */
function validate(config) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('引导配置必须是 JSON 对象');
  }
  const unknown = Object.keys(config).filter((k) => !ALLOWED_KEYS.includes(k));
  if (unknown.length) throw new Error(`引导配置含未知键: ${unknown.join(', ')}`);
  for (const key of ['exemptRoles', 'denyWriteRoles']) {
    const v = config[key];
    if (v !== undefined && (!Array.isArray(v) || v.some((r) => typeof r !== 'string'))) {
      throw new Error(`引导配置 ${key} 必须是字符串数组`);
    }
  }
  const p = config.unconfiguredPolicy;
  if (p !== undefined && p !== 'open' && p !== 'closed') {
    throw new Error(`引导配置 unconfiguredPolicy 只能是 "open" 或 "closed"`);
  }
}

/** 构造引导句柄；构造期校验 store 门面齐备 + source 为函数 */
function create(store, opts) {
  if (!store || typeof store !== 'object') throw new Error('policy.create 需要 store 实例');
  for (const name of FACADES) {
    if (typeof store[name] !== 'function') throw new Error(`store 缺少门面方法: ${name}`);
  }
  if (!opts || typeof opts.source !== 'function') throw new Error('policy.create 需要 opts.source（策略源函数）');

  async function start() {
    const config = await opts.source();      // 读取失败原样上抛（不吞错）
    validate(config);                        // 校验先于应用
    await store.setExemptRoles(config.exemptRoles ?? []);            // ① 角色清单
    await store.setDenyWriteRoles(config.denyWriteRoles ?? []);      // ② 拒写清单
    await store.setUnconfiguredPolicy(config.unconfiguredPolicy ?? 'open'); // ③ 未配置姿态
    await store.setRbac(config.policy ?? null);                      // ④ 策略最后生效（core 解析期 fail-fast，不捕获）
  }

  async function reload() {
    await store.setRbac(null);               // 先清除，再重注入
    await start();
  }

  return { start, reload };
}

/* ------------------------------------------------------------------ *
 * identity：身份源适配（凭证 → {userId, roles} → 各皮 contextProvider 接缝）
 * ------------------------------------------------------------------ */

/** bag 提取：HTTP 头（普通对象）→ 统一小写键、取首个、非字符串丢弃 */
function normalizeHeaders(raw) {
  const bag = {};
  putEntry(bag, (cb) => {
    if (!raw || typeof raw !== 'object') return;
    for (const [k, v] of Object.entries(raw)) cb(k, v);
  });
  return bag;
}

/** bag 提取：gRPC Metadata（`.getMap()` / `forEach` / 可遍历 / 普通对象）→ 小写平铺 bag */
function metadataToBag(metadata) {
  const bag = {};
  if (!metadata || typeof metadata !== 'object') return bag;
  if (typeof metadata.getMap === 'function') {
    const map = metadata.getMap();
    for (const [k, v] of Object.entries(map)) putKey(bag, k, v);
    return bag;
  }
  putEntry(bag, (cb) => {
    if (typeof metadata.forEach === 'function') {
      metadata.forEach((v, k) => cb(k, v));
    } else if (typeof metadata[Symbol.iterator] === 'function') {
      for (const entry of metadata) cb(entry[0], entry[1]);
    } else if (typeof metadata.entries === 'function') {
      for (const entry of metadata.entries()) cb(entry[0], entry[1]);
    } else {
      for (const [k, v] of Object.entries(metadata)) cb(k, v);
    }
  });
  return bag;
}

/** 单键写入：键小写、同名取首个、数组取首元素、非字符串丢弃 */
function putKey(bag, key, value) {
  const k = String(key).toLowerCase();
  if (k in bag) return;
  const v = Array.isArray(value) ? value[0] : value;
  if (typeof v === 'string' && v) bag[k] = v;
}

function putEntry(bag, iterate) {
  iterate((k, v) => putKey(bag, k, v));
}

/** 极简 cookie 解析：`k=v; k2=v2`，返回首个匹配 `name` 的非空值（不引 cookie 库） */
function parseCookie(cookieHeader, name) {
  if (typeof cookieHeader !== 'string') return null;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() !== name) continue;
    const v = part.slice(idx + 1).trim();
    return v || null;
  }
  return null;
}

/** ① JWT：验签 + exp 到期判定；无凭证 → null；无效 / 过期 / 解不出 userId → 抛普通 Error */
function jwtFactory(opts = {}) {
  const {
    secret, algorithm = 'HS256', header = 'authorization',
    userIdClaim = 'sub', rolesClaim = 'roles',
  } = opts;
  if (typeof secret !== 'string' || !secret) throw new Error('identity.jwt 需要非空 secret');
  if (!['HS256', 'HS384', 'HS512'].includes(algorithm)) {
    throw new Error(`identity.jwt 首期仅支持 HS 系算法（收到 ${algorithm}）`);
  }
  return async (bag) => {
    const raw = bag[header.toLowerCase()];
    if (!raw) return null;                                   // 无凭证 → null（显式清除）
    const token = raw.startsWith('Bearer ') ? raw.slice(7) : raw;
    let payload;
    try { payload = jwt.verify(token, secret, { algorithms: [algorithm] }); }
    catch (e) { throw new Error(`无效的 JWT 凭证: ${e.message}`); }   // 普通 Error，无 ERR_ 前缀
    const userId = payload[userIdClaim];
    if (typeof userId !== 'string' || !userId) throw new Error('JWT 缺非空 userId 声明');
    const roles = payload[rolesClaim];
    return { userId, roles: Array.isArray(roles) ? roles.filter((r) => typeof r === 'string') : [] };
  };
}

/** ② API-Key：lookup 命中 → ctx；lookup 返回 null / 缺头 → null */
function apiKeyFactory(opts = {}) {
  const { header = 'x-api-key', lookup } = opts;
  if (typeof lookup !== 'function') throw new Error('identity.apiKey 需要 lookup 回调');
  return async (bag) => {
    const key = bag[header.toLowerCase()];
    if (!key) return null;
    const ctx = await lookup(key);                            // 回调抛错（含宿主 PermissionError）→ 原样上抛
    return ctx == null ? null : ctx;
  };
}

/** ③ Session：cookie 解析 → lookup */
function sessionFactory(opts = {}) {
  const { cookie = 'sid', lookup } = opts;
  if (typeof lookup !== 'function') throw new Error('identity.session 需要 lookup 回调');
  return async (bag) => {
    const sid = parseCookie(bag['cookie'] || '', cookie);
    if (!sid) return null;
    const ctx = await lookup(sid);
    return ctx == null ? null : ctx;
  };
}

/** 逐皮适配：把解码器装到该皮 node 钩子签名（恒返回 ctx | null） */
function adapt(skin, decode) {
  if (typeof decode !== 'function') throw new Error('identity.adapt 需要解码器函数');
  if (skin === 'store-api') return async (req) => decode(normalizeHeaders(req && req.headers));
  if (skin === 'store-grpc') return async (metadata) => decode(metadataToBag(metadata));
  if (skin === 'store-graphql') {
    return async (input) => decode(normalizeHeaders(input && input.request && input.request.headers));
  }
  throw new Error(`identity.adapt 未知皮名: ${skin}`);
}

const identity = {
  jwt: jwtFactory, apiKey: apiKeyFactory, session: sessionFactory, adapt,
};

module.exports = { policy: { file, url, db, create }, identity };
