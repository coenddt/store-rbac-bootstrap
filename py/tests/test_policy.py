"""policy 用例（与 02 node/test/policy.test.js 的 T1–T10 逐场景对拍）。"""
import asyncio
import json

import pytest

from store_rbac_bootstrap import policy
from mock_store import MockStore


def run(coro):
    return asyncio.run(coro)


def make_source(cfg):
    async def source():
        return cfg
    return source


def test_T1_full_config_strict_order():
    store = MockStore()
    cfg = {
        "policy": {"mode": "overlay", "roles": {}, "grants": []},
        "exemptRoles": ["a"],
        "denyWriteRoles": ["g"],
        "unconfiguredPolicy": "closed",
    }
    handle = policy.create(store, make_source(cfg))
    run(handle.start())
    assert store.calls == [
        ("set_exempt_roles", ["a"]),
        ("set_deny_write_roles", ["g"]),
        ("set_unconfigured_policy", "closed"),
        ("set_rbac", cfg["policy"]),
    ]


def test_T2_empty_config_defaults():
    store = MockStore()
    handle = policy.create(store, make_source({}))
    run(handle.start())
    assert store.calls == [
        ("set_exempt_roles", []),
        ("set_deny_write_roles", []),
        ("set_unconfigured_policy", "open"),
        ("set_rbac", None),
    ]


def test_T3_unknown_top_key_no_facade_call():
    store = MockStore()
    handle = policy.create(store, make_source({"foo": 1}))
    with pytest.raises(ValueError, match="foo"):
        run(handle.start())
    assert store.calls == []


def test_T4_bad_unconfigured_policy_no_facade_call():
    store = MockStore()
    handle = policy.create(store, make_source({"unconfiguredPolicy": "x"}))
    with pytest.raises(ValueError, match="unconfiguredPolicy"):
        run(handle.start())
    assert store.calls == []


def test_T5_bad_exempt_roles_no_facade_call():
    store = MockStore()
    handle = policy.create(store, make_source({"exemptRoles": "a"}))
    with pytest.raises(ValueError, match="exemptRoles"):
        run(handle.start())
    assert store.calls == []


def test_T6_source_error_propagates_no_facade_call():
    store = MockStore()

    async def boom():
        raise RuntimeError("boom")

    handle = policy.create(store, boom)
    with pytest.raises(RuntimeError, match="boom"):
        run(handle.start())
    assert store.calls == []


def test_T7_policy_file(tmp_path):
    p = tmp_path / "cfg.json"
    p.write_text(json.dumps({"exemptRoles": ["x"]}), encoding="utf-8")
    store = MockStore()
    handle = policy.create(store, policy.file(str(p)))
    run(handle.start())
    assert store.calls == [
        ("set_exempt_roles", ["x"]),
        ("set_deny_write_roles", []),
        ("set_unconfigured_policy", "open"),
        ("set_rbac", None),
    ]
    with pytest.raises(Exception):
        run(policy.file(str(p) + ".nope")())


def test_T8_reload_clear_first():
    store = MockStore()
    handle = policy.create(store, make_source({"exemptRoles": ["a"]}))
    run(handle.start())
    before = len(store.calls)                    # 4
    run(handle.reload())
    assert store.calls[before] == ("set_rbac", None)   # 清除前置
    assert len(store.calls) == before + 1 + 4


def test_T9_missing_facade_raises():
    class S:                                     # 缺 set_deny_write_roles
        def set_rbac(self, v):
            pass

        def set_exempt_roles(self, v):
            pass

        def set_unconfigured_policy(self, v):
            pass

    with pytest.raises(ValueError, match="set_deny_write_roles"):
        policy.create(S(), make_source({}))


def test_T10_source_not_callable_raises():
    with pytest.raises(ValueError, match="source"):
        policy.create(MockStore(), 123)
