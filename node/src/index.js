// store-rbac-bootstrap/node/src/index.js
'use strict';

const fs = require('fs');

const ALLOWED_KEYS = ['policy', 'exemptRoles', 'denyWriteRoles', 'unconfiguredPolicy'];
const FACADES = ['setRbac', 'setExemptRoles', 'setDenyWriteRoles', 'setUnconfiguredPolicy'];

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

module.exports = { policy: { file, url, db, create } /*, identity: {...} */ };
