"""store-rbac-bootstrap-py — RBAC 皮肤层插件包（第一期消费面）。

唯一事实源：spec/00-protocol.md。零判决、零语义发明、零宿主依赖。
"""
from __future__ import annotations

import copy
import inspect
import json
import urllib.request
from pathlib import Path
from types import SimpleNamespace

import jwt as _jwt  # PyJWT

from .schemas import RBAC_SCHEMAS

_ALLOWED_KEYS = ("policy", "exemptRoles", "denyWriteRoles", "unconfiguredPolicy")
_FACADES = ("set_rbac", "set_exempt_roles", "set_deny_write_roles", "set_unconfigured_policy")


async def _call(fn, arg):
    """门面调用：sync 直接调；返回 awaitable（宿主支持 async 门面时）则 await。"""
    result = fn(arg)
    if inspect.isawaitable(result):
        result = await result
    return result


def file(path):                                    # 策略源 ①：本地文件
    async def source():
        return json.loads(Path(path).read_text(encoding="utf-8"))
    return source


def url(u, headers=None):                          # 策略源 ②：远端策略分发服务
    async def source():
        req = urllib.request.Request(u, headers=headers or {})
        with urllib.request.urlopen(req) as resp:
            if not (200 <= resp.status < 300):
                raise ValueError(f"策略源请求失败: {resp.status} {u}")
            return json.loads(resp.read().decode("utf-8"))
    return source


def db(loader):                                    # 策略源 ③：DB / 配置中心
    async def source():
        result = loader()
        return await result if inspect.isawaitable(result) else result
    return source


def _validate(config):
    """校验先于应用；任一不符即抛 ValueError（此时零门面调用）。"""
    if not isinstance(config, dict):
        raise ValueError("引导配置必须是 JSON 对象")
    unknown = [k for k in config if k not in _ALLOWED_KEYS]
    if unknown:
        raise ValueError(f"引导配置含未知键: {', '.join(unknown)}")
    for key in ("exemptRoles", "denyWriteRoles"):
        v = config.get(key)
        if v is not None and (not isinstance(v, list) or any(not isinstance(r, str) for r in v)):
            raise ValueError(f"引导配置 {key} 必须是字符串数组")
    p = config.get("unconfiguredPolicy")
    if p is not None and p not in ("open", "closed"):
        raise ValueError('引导配置 unconfiguredPolicy 只能是 "open" 或 "closed"')


class _Handle:
    def __init__(self, store, source, schemas):
        self._store = store
        self._source = source
        self._schemas = schemas

    async def start(self):
        config = await self._source()              # 读取失败原样上抛（不吞错）
        _validate(config)                          # 校验先于应用（此时零门面调用）
        registered = []
        skipped = []
        for defn in self._schemas:
            if self._store.has(defn["name"]):      # has 为同步门面
                skipped.append(defn["name"])
            else:
                self._store.register(defn)         # register 为同步门面，幂等
                registered.append(defn["name"])
        await _call(self._store.set_exempt_roles, config.get("exemptRoles", []))
        await _call(self._store.set_deny_write_roles, config.get("denyWriteRoles", []))
        await _call(self._store.set_unconfigured_policy, config.get("unconfiguredPolicy", "open"))
        await _call(self._store.set_rbac, config.get("policy", None))   # 策略最后生效
        return {"registered": registered, "skipped": skipped}

    async def reload(self):
        await _call(self._store.set_rbac, None)    # 先清除，再重注入
        return await self.start()


def schemas():
    """内置「可选参考」RBAC 管理面定义（两表，深拷贝）——库不据此强制注册，schema 归属上层业务。"""
    return copy.deepcopy(RBAC_SCHEMAS)


def create(store, source, schemas=None):
    if store is None:
        raise ValueError("policy.create 需要 store 实例")
    for name in _FACADES:
        if not callable(getattr(store, name, None)):
            raise ValueError(f"store 缺少门面方法: {name}")
    if not callable(source):
        raise ValueError("policy.create 需要 source（策略源函数）")

    # schemas：要注册进宿主的定义注入点（库不内置权威 RBAC schema）——
    # 缺省 / None / False → 不注册任何表；列表 → 逐项校验后按序注册
    if schemas is None or schemas is False:
        effective_schemas = []
    elif isinstance(schemas, list):
        for i, defn in enumerate(schemas):
            if not isinstance(defn, dict):
                raise ValueError(f"policy.create: schemas[{i}] 须为对象")
            name = defn.get("name")
            if not isinstance(name, str) or name == "":
                raise ValueError(f"policy.create: schemas[{i}].name 须为非空字符串")
        effective_schemas = copy.deepcopy(schemas)
    else:
        raise ValueError("policy.create: schemas 须为数组、null 或 false")
    # 条件化门面校验：仅当有 schema 需要注册时才要求宿主门面（向后兼容旧 store）
    if len(effective_schemas) > 0:
        for name in ("has", "register"):
            if not callable(getattr(store, name, None)):
                raise ValueError(f"store 缺少门面方法: {name}")

    return _Handle(store, source, effective_schemas)


policy = SimpleNamespace(file=file, url=url, db=db, schemas=schemas, create=create)

# ------------------------------------------------------------------ #
# identity：身份源适配（凭证 → {userId, roles} → 各皮 context_provider 接缝）
# ------------------------------------------------------------------ #


def _headers_to_bag(headers):
    """普通 Mapping → {lower: 首个字符串值}；非字符串丢弃。"""
    bag = {}
    if not headers:
        return bag
    for k, v in dict(headers).items():
        if v is None:
            continue
        bag.setdefault(str(k).lower(), v if isinstance(v, str) else str(v))
    return bag


def _metadata_to_bag(invocation_metadata):
    """gRPC invocation_metadata（(key, value) 序列 或 支持 .get 的对象）→ 同形 bag。"""
    bag = {}
    if not invocation_metadata:
        return bag
    if hasattr(invocation_metadata, "get") and not isinstance(invocation_metadata, (list, tuple)):
        # 对象形态：已知键按需取（authorization / x-api-key / cookie）
        for name in ("authorization", "x-api-key", "cookie"):
            v = invocation_metadata.get(name)
            if v:
                bag[name] = v if isinstance(v, str) else str(v)
        return bag
    for item in invocation_metadata:               # (key, value) 序列形态
        k, v = item[0], item[1]
        bag.setdefault(str(k).lower(), v if isinstance(v, str) else str(v))
    return bag


def _parse_cookie(cookie_header, name):
    for part in (cookie_header or "").split(";"):
        if "=" in part:
            k, _, v = part.partition("=")
            if k.strip() == name:
                return v.strip()
    return None


def jwt(secret, algorithm="HS256", header="authorization",
        user_id_claim="sub", roles_claim="roles"):
    if not isinstance(secret, str) or not secret:
        raise ValueError("identity.jwt 需要非空 secret")
    if algorithm not in ("HS256", "HS384", "HS512"):
        raise ValueError(f"identity.jwt 首期仅支持 HS 系算法（收到 {algorithm}）")

    async def decode(bag):
        raw = bag.get(header.lower())
        if not raw:
            return None                            # 无凭证 → None（显式清除）
        token = raw[7:] if raw.startswith("Bearer ") else raw
        try:
            payload = _jwt.decode(token, secret, algorithms=[algorithm])
        except Exception as exc:                   # 验签失败 / 过期 → 普通错误
            raise ValueError(f"无效的 JWT 凭证: {exc}") from None
        user_id = payload.get(user_id_claim)
        if not isinstance(user_id, str) or not user_id:
            raise ValueError("JWT 缺非空 userId 声明")
        roles = payload.get(roles_claim)
        return {
            "userId": user_id,
            "roles": [r for r in roles if isinstance(r, str)] if isinstance(roles, list) else [],
        }

    return decode


def api_key(header="x-api-key", lookup=None):
    if not callable(lookup):
        raise ValueError("identity.api_key 需要 lookup 回调")

    async def decode(bag):
        key = bag.get(header.lower())
        if not key:
            return None
        ctx = lookup(key)
        if inspect.isawaitable(ctx):
            ctx = await ctx
        return None if ctx is None else ctx

    return decode


def session(cookie="sid", lookup=None):
    if not callable(lookup):
        raise ValueError("identity.session 需要 lookup 回调")

    async def decode(bag):
        sid = _parse_cookie(bag.get("cookie") or "", cookie)
        if not sid:
            return None
        ctx = lookup(sid)
        if inspect.isawaitable(ctx):
            ctx = await ctx
        return None if ctx is None else ctx

    return decode


def adapt(skin, decode):
    if not callable(decode):
        raise ValueError("identity.adapt 需要解码器函数")
    if skin == "store-api":
        async def provider(request):
            return await decode(_headers_to_bag(getattr(request, "headers", None)))
        return provider
    if skin == "store-grpc":
        async def provider(invocation_metadata):
            return await decode(_metadata_to_bag(invocation_metadata))
        return provider
    if skin == "store-graphql":
        async def provider(request):
            return await decode(_headers_to_bag(getattr(request, "headers", None)))
        return provider
    raise ValueError(f"identity.adapt 未知皮名: {skin}")


identity = SimpleNamespace(jwt=jwt, api_key=api_key, session=session, adapt=adapt)
