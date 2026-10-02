"""conformance 用例（加载与 node 同一份 conformance/cases.json；期望值不复制）。"""
import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

import jwt as pyjwt
import pytest

from store_rbac_bootstrap import policy, identity
from mock_store import MockStore

CASES = json.loads((Path(__file__).parents[2] / "conformance" / "cases.json").read_text(encoding="utf-8"))
SECRET = "conformance-secret"

# 双端门面名映射（camelCase → snake_case），供调用序列断言取 py 分支
_FACADE_MAP = dict(zip(CASES["facades"]["node"], CASES["facades"]["py"]))


def run(coro):
    return asyncio.run(coro)


def source_of(cfg):
    async def source():
        return cfg
    return source


def translate(expected_calls):
    return [(_FACADE_MAP[name], value) for name, value in expected_calls]


def test_conformance_config_full():
    store = MockStore()
    run(policy.create(store, source_of(CASES["config"]["full"]["input"])).start())
    assert store.calls == translate(CASES["config"]["full"]["expected_calls"])


def test_conformance_config_defaults():
    store = MockStore()
    run(policy.create(store, source_of(CASES["config"]["defaults"]["input"])).start())
    assert store.calls == translate(CASES["config"]["defaults"]["expected_calls"])


def test_conformance_invalid_configs_raise_with_zero_calls():
    entries = [
        ("unknown_key", CASES["config"]["unknown_key"]),
        ("bad_unconfigured_policy", CASES["config"]["bad_unconfigured_policy"]),
        ("bad_exempt_roles", CASES["config"]["bad_exempt_roles"]),
    ]
    for name, c in entries:
        store = MockStore()
        handle = policy.create(store, source_of(c["input"]))
        with pytest.raises(ValueError) as ei:
            run(handle.start())
        if c.get("error_contains"):
            assert c["error_contains"] in str(ei.value), f"{name} 消息应含 {c['error_contains']}"
        assert len(store.calls) == c["expected_call_count"], f"{name} 应零门面调用"


def test_conformance_reload_clear_first():
    store = MockStore()
    handle = policy.create(store, source_of({}))
    run(handle.start())
    before = len(store.calls)
    run(handle.reload())
    assert store.calls[before] == tuple(CASES["reload"]["expected_first_call"]["py"])


def test_conformance_null_clear():
    async def null_lookup(_):
        return None

    decoders = {
        "jwt": identity.jwt(secret=SECRET),
        "api_key": identity.api_key(lookup=null_lookup),
        "session": identity.session(lookup=null_lookup),
    }
    for entry in CASES["identity"]["null_clear"]:
        assert run(decoders[entry["kind"]](entry["bag"])) is None, f"{entry['kind']} 应严格 None"


def test_conformance_jwt_payload_and_roles_default():
    decode = identity.jwt(secret=SECRET)
    p = CASES["identity"]["jwt_payload"]
    t1 = pyjwt.encode(p["claims"], SECRET, algorithm="HS256")
    assert run(decode({"authorization": f"Bearer {t1}"})) == p["expected"]
    r = CASES["identity"]["jwt_roles_default"]
    t2 = pyjwt.encode(r["claims"], SECRET, algorithm="HS256")
    assert run(decode({"authorization": t2})) == r["expected"]


def test_conformance_invalid_is_plain_error_not_permission():
    decode = identity.jwt(secret=SECRET)
    bad = pyjwt.encode({"sub": "u"}, "other-secret", algorithm="HS256")
    with pytest.raises(ValueError) as ei:
        run(decode({"authorization": bad}))
    assert type(ei.value).__name__ == CASES["identity"]["invalid"]["error_class"]["py"]
    assert not isinstance(ei.value, PermissionError)


def test_conformance_bag_lowercase():
    headers = CASES["identity"]["bag_lowercase"]["headers"]
    expected_key = CASES["identity"]["bag_lowercase"]["expected_bag_key"]
    captured = {}

    async def spy(bag):
        captured.update(bag)
        return None

    provider = identity.adapt("store-api", spy)
    run(provider(SimpleNamespace(headers=headers)))
    assert expected_key in captured


def test_conformance_unknown_skin_raises():
    with pytest.raises(ValueError):
        identity.adapt(CASES["identity"]["unknown_skin"]["skin"], lambda bag: None)
