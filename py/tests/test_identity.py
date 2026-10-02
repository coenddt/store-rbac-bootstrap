"""identity 用例（与 02 node/test/identity.test.js 的 T11–T21 逐场景对拍）。"""
import asyncio
from types import SimpleNamespace

import jwt as pyjwt
import pytest

from store_rbac_bootstrap import identity


def run(coro):
    return asyncio.run(coro)


def test_T11_jwt_no_credential_returns_none():
    decode = identity.jwt(secret="s")
    assert run(decode({})) is None
    assert run(decode({"cookie": "x=1"})) is None


def test_T12_jwt_valid_payload_and_roles_default():
    decode = identity.jwt(secret="s")
    token = pyjwt.encode({"sub": "u1", "roles": ["editor"]}, "s", algorithm="HS256")
    assert run(decode({"authorization": f"Bearer {token}"})) == {"userId": "u1", "roles": ["editor"]}
    no_roles = pyjwt.encode({"sub": "u2"}, "s", algorithm="HS256")
    assert run(decode({"authorization": no_roles})) == {"userId": "u2", "roles": []}


def test_T13_jwt_invalid_raises_plain_error():
    decode = identity.jwt(secret="s")
    wrong = pyjwt.encode({"sub": "u"}, "other", algorithm="HS256")
    with pytest.raises(ValueError) as ei:
        run(decode({"authorization": wrong}))
    assert not isinstance(ei.value, PermissionError)
    expired = pyjwt.encode({"sub": "u", "exp": 1}, "s", algorithm="HS256")
    with pytest.raises(ValueError) as ei2:
        run(decode({"authorization": expired}))
    assert not isinstance(ei2.value, PermissionError)


def test_T14_jwt_construction_errors():
    with pytest.raises(ValueError, match="secret"):
        identity.jwt(secret="")
    with pytest.raises(ValueError, match="HS"):
        identity.jwt(secret="s", algorithm="RS256")


def test_T15_api_key_three_states_and_passthrough():
    async def lookup(k):
        return {"userId": "u", "roles": []} if k == "good" else None

    decode = identity.api_key(lookup=lookup)
    assert run(decode({})) is None
    assert run(decode({"x-api-key": "good"})) == {"userId": "u", "roles": []}
    assert run(decode({"x-api-key": "bad"})) is None

    class PermissionError(Exception):
        pass

    def boom(k):
        raise PermissionError("no")

    decode2 = identity.api_key(lookup=boom)
    with pytest.raises(PermissionError):
        run(decode2({"x-api-key": "k"}))


def test_T16_session_cookie_parsing():
    async def lookup(sid):
        return {"userId": "u", "roles": []} if sid == "s1" else None

    decode = identity.session(lookup=lookup)
    assert run(decode({})) is None
    assert run(decode({"cookie": "sid=s1"})) == {"userId": "u", "roles": []}
    assert run(decode({"cookie": "other=1; sid=s1; z=2"})) == {"userId": "u", "roles": []}
    assert run(decode({"cookie": "sid=nope"})) is None


def test_T17_adapt_store_api_lowercase_bag():
    captured = {}

    async def decode(bag):
        captured.update(bag)
        return {"userId": "u", "roles": []}

    provider = identity.adapt("store-api", decode)
    ctx = run(provider(SimpleNamespace(headers={"Authorization": "Bearer t"})))
    assert captured == {"authorization": "Bearer t"}
    assert ctx == {"userId": "u", "roles": []}


def test_T18_adapt_store_grpc_two_shapes():
    captured = {}

    async def decode(bag):
        captured.clear()
        captured.update(bag)
        return None

    provider = identity.adapt("store-grpc", decode)
    run(provider([("authorization", "Bearer t")]))       # (key, value) 序列形态
    assert captured == {"authorization": "Bearer t"}

    class MD:                                            # .get 对象形态
        def get(self, name):
            return {"authorization": "Bearer z"}.get(name)

    run(provider(MD()))
    assert captured == {"authorization": "Bearer z"}


def test_T19_adapt_store_graphql_headers():
    captured = {}

    async def decode(bag):
        captured.update(bag)
        return None

    provider = identity.adapt("store-graphql", decode)
    run(provider(SimpleNamespace(headers={"Authorization": "Bearer t"})))
    assert captured == {"authorization": "Bearer t"}


def test_T20_adapt_unknown_skin_raises():
    with pytest.raises(ValueError, match="未知皮名"):
        identity.adapt("unknown", lambda b: None)
    with pytest.raises(ValueError, match="解码器"):
        identity.adapt("store-api", None)


def test_T21_adapt_null_clear_semantics():
    provider = identity.adapt("store-api", identity.jwt(secret="s"))
    assert run(provider(SimpleNamespace(headers={}))) is None
    assert run(provider(SimpleNamespace())) is None
