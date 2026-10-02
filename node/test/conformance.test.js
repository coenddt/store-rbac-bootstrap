'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const jwtToken = require('jsonwebtoken');

const cases = require('../../conformance/cases.json');
const { policy, identity } = require('../src');
const { mockStore } = require('./mock-store');

const SECRET = 'conformance-secret';

function sourceOf(config) {
  return async () => config;
}

test('conformance · config.full 调用序列逐位一致', async () => {
  const store = mockStore();
  const handle = policy.create(store, { source: sourceOf(cases.config.full.input) });
  await handle.start();
  assert.deepEqual(store.calls, cases.config.full.expected_calls);
});

test('conformance · config.defaults 调用序列逐位一致', async () => {
  const store = mockStore();
  const handle = policy.create(store, { source: sourceOf(cases.config.defaults.input) });
  await handle.start();
  assert.deepEqual(store.calls, cases.config.defaults.expected_calls);
});

test('conformance · 非法配置抛错且零门面调用', async () => {
  const entries = [
    ['unknown_key', cases.config.unknown_key],
    ['bad_unconfigured_policy', cases.config.bad_unconfigured_policy],
    ['bad_exempt_roles', cases.config.bad_exempt_roles],
  ];
  for (const [name, c] of entries) {
    const store = mockStore();
    const handle = policy.create(store, { source: sourceOf(c.input) });
    await assert.rejects(() => handle.start(), (e) => {
      assert.ok(e instanceof Error, `${name} 应抛 Error`);
      if (c.error_contains) assert.ok(e.message.includes(c.error_contains), `${name} 消息应含 ${c.error_contains}`);
      return true;
    });
    assert.equal(store.calls.length, c.expected_call_count, `${name} 应零门面调用`);
  }
});

test('conformance · reload 首调用为清除前置', async () => {
  const store = mockStore();
  const handle = policy.create(store, { source: sourceOf({}) });
  await handle.start();
  const before = store.calls.length;
  await handle.reload();
  assert.deepEqual(store.calls[before], cases.reload.expected_first_call.node);
});

test('conformance · null_clear 三解码器空 bag 严格 null', async () => {
  const decoders = {
    jwt: identity.jwt({ secret: SECRET }),
    api_key: identity.apiKey({ lookup: async () => null }),
    session: identity.session({ lookup: async () => null }),
  };
  for (const entry of cases.identity.null_clear) {
    assert.strictEqual(await decoders[entry.kind](entry.bag), null, `${entry.kind} 应严格 null`);
  }
});

test('conformance · jwt 载荷与 roles 缺省', async () => {
  const decode = identity.jwt({ secret: SECRET });
  const p = cases.identity.jwt_payload;
  const t1 = jwtToken.sign(p.claims, SECRET);
  assert.deepEqual(await decode({ authorization: `Bearer ${t1}` }), p.expected);
  const r = cases.identity.jwt_roles_default;
  const t2 = jwtToken.sign(r.claims, SECRET);
  assert.deepEqual(await decode({ authorization: t2 }), r.expected);
});

test('conformance · 无效凭证为普通 Error 且非权限类', async () => {
  const decode = identity.jwt({ secret: SECRET });
  const bad = jwtToken.sign({ sub: 'u' }, 'other-secret');
  await assert.rejects(() => decode({ authorization: bad }), (e) => {
    assert.equal(e.constructor.name, cases.identity.invalid.error_class.node);
    assert.notEqual(e.name, 'PermissionError');
    return true;
  });
});

test('conformance · bag 键小写归一', async () => {
  const { headers, expected_bag_key } = cases.identity.bag_lowercase;
  let captured = null;
  const spy = async (bag) => { captured = bag; return null; };
  const hook = identity.adapt('store-api', spy);
  await hook({ headers });
  assert.ok(Object.prototype.hasOwnProperty.call(captured, expected_bag_key));
});

test('conformance · 未知皮名构造期抛错', () => {
  assert.throws(() => identity.adapt(cases.identity.unknown_skin.skin, async () => null));
});
