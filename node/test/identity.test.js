'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const { identity } = require('../src');

/** 宿主权限类错误替身：插件应原样上抛（不判定、不包装） */
class PermissionError extends Error {}

test('T11 identity.jwt：bag 无 authorization → 严格 null', async () => {
  const decode = identity.jwt({ secret: 's' });
  assert.strictEqual(await decode({}), null);
  assert.strictEqual(await decode({ cookie: 'x=1' }), null);
});

test('T12 identity.jwt：合法 HS256 token → {userId, roles}；roles 缺省 []', async () => {
  const decode = identity.jwt({ secret: 's' });
  const token = jwt.sign({ sub: 'u1', roles: ['editor'] }, 's');
  assert.deepEqual(await decode({ authorization: `Bearer ${token}` }), { userId: 'u1', roles: ['editor'] });
  const noRoles = jwt.sign({ sub: 'u2' }, 's');
  assert.deepEqual(await decode({ authorization: noRoles }), { userId: 'u2', roles: [] });
});

test('T13 identity.jwt：错签名 / 已过期 → 抛普通 Error（无 ERR_ 前缀）', async () => {
  const decode = identity.jwt({ secret: 's' });
  const wrong = jwt.sign({ sub: 'u' }, 'other');
  await assert.rejects(
    () => decode({ authorization: wrong }),
    (e) => e.constructor === Error && !/ERR_/.test(e.message),
  );
  const expired = jwt.sign({ sub: 'u' }, 's', { expiresIn: '-1s' });
  await assert.rejects(
    () => decode({ authorization: expired }),
    (e) => e.constructor === Error && !/ERR_/.test(e.message),
  );
});

test('T14 identity.jwt：构造期无 secret / 非 HS 算法 → 抛 Error', () => {
  assert.throws(() => identity.jwt({}), /secret/);
  assert.throws(() => identity.jwt({ secret: 's', algorithm: 'RS256' }), /HS/);
});

test('T15 identity.apiKey：无头 → null；命中 → ctx；lookup 返回 null → null；回调错原样上抛', async () => {
  const decode = identity.apiKey({
    lookup: async (k) => (k === 'good' ? { userId: 'u', roles: [] } : null),
  });
  assert.strictEqual(await decode({}), null);
  assert.deepEqual(await decode({ 'x-api-key': 'good' }), { userId: 'u', roles: [] });
  assert.strictEqual(await decode({ 'x-api-key': 'bad' }), null);

  const boom = identity.apiKey({ lookup: () => { throw new PermissionError('no'); } });
  await assert.rejects(() => boom({ 'x-api-key': 'k' }), (e) => e instanceof PermissionError);
});

test('T16 identity.session：无 cookie 头 → null；sid=s1 + 命中 → ctx（含多 cookie 解析）', async () => {
  const decode = identity.session({ lookup: async (sid) => (sid === 's1' ? { userId: 'u', roles: [] } : null) });
  assert.strictEqual(await decode({}), null);
  assert.deepEqual(await decode({ cookie: 'sid=s1' }), { userId: 'u', roles: [] });
  assert.deepEqual(await decode({ cookie: 'other=1; sid=s1; z=2' }), { userId: 'u', roles: [] });
  assert.strictEqual(await decode({ cookie: 'sid=nope' }), null);
});

test('T17 adapt(store-api)：req.headers 展开为小写 bag', async () => {
  const bag = {};
  const hook = identity.adapt('store-api', async (b) => { Object.assign(bag, b); return { userId: 'u', roles: [] }; });
  const ctx = await hook({ headers: { Authorization: 'Bearer t' } });
  assert.deepEqual(bag, { authorization: 'Bearer t' });
  assert.deepEqual(ctx, { userId: 'u', roles: [] });
});

test('T18 adapt(store-grpc)：支持可遍历 Metadata 与 .getMap() 两形态', async () => {
  let bag = {};
  const hook = identity.adapt('store-grpc', async (b) => { bag = { ...b }; return null; });

  const md = new Map();
  md.set('authorization', 'Bearer t');
  await hook(md);                                       // 可遍历 / forEach 形态
  assert.deepEqual(bag, { authorization: 'Bearer t' });

  await hook({ getMap: () => ({ Authorization: 'Bearer z' }) }); // getMap 形态（键大小写归一）
  assert.deepEqual(bag, { authorization: 'Bearer z' });
});

test('T19 adapt(store-graphql)：{request, serverContext}.request.headers 展开', async () => {
  let bag = {};
  const hook = identity.adapt('store-graphql', async (b) => { bag = { ...b }; return null; });
  await hook({ request: { headers: { Authorization: 'Bearer t' } }, serverContext: {} });
  assert.deepEqual(bag, { authorization: 'Bearer t' });
});

test('T20 adapt：未知皮名 → 构造期抛 Error', () => {
  assert.throws(() => identity.adapt('unknown', async () => null), /未知皮名/);
  assert.throws(() => identity.adapt('store-api', null), /解码器/);
});

test('T21 adapt 产物：无凭证时严格返回 null（显式清除语义）', async () => {
  const hook = identity.adapt('store-api', identity.jwt({ secret: 's' }));
  assert.strictEqual(await hook({ headers: {} }), null);
  assert.strictEqual(await hook({}), null);
});
