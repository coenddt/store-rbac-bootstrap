"""store-rbac-bootstrap-py — RBAC 皮肤层插件包（第一期消费面）。

唯一事实源：spec/00-protocol.md。零判决、零语义发明、零宿主依赖。
"""
from __future__ import annotations

import inspect
import json
import urllib.request
from pathlib import Path
from types import SimpleNamespace

import jwt as _jwt  # PyJWT

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
    def __init__(self, store, source):
        self._store = store
        self._source = source

    async def start(self):
        config = await self._source()              # 读取失败原样上抛（不吞错）
        _validate(config)                          # 校验先于应用
        await _call(self._store.set_exempt_roles, config.get("exemptRoles", []))
        await _call(self._store.set_deny_write_roles, config.get("denyWriteRoles", []))
        await _call(self._store.set_unconfigured_policy, config.get("unconfiguredPolicy", "open"))
        await _call(self._store.set_rbac, config.get("policy", None))   # 策略最后生效

    async def reload(self):
        await _call(self._store.set_rbac, None)    # 先清除，再重注入
        await self.start()


def create(store, source):
    if store is None:
        raise ValueError("policy.create 需要 store 实例")
    for name in _FACADES:
        if not callable(getattr(store, name, None)):
            raise ValueError(f"store 缺少门面方法: {name}")
    if not callable(source):
        raise ValueError("policy.create 需要 source（策略源函数）")
    return _Handle(store, source)


policy = SimpleNamespace(file=file, url=url, db=db, create=create)
