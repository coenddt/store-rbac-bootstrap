'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { policy } = require('../src');
const { mockStore } = require('./mock-store');

test('T1 完整配置：四键齐，应用顺序固定（策略最后）', async () => {
  const store = mockStore();
  const cfg = {
    policy: { mode: 'overlay', roles: {}, grants: [] },
    exemptRoles: ['a'],
    denyWriteRoles: ['g'],
    unconfiguredPolicy: 'closed',
  };
  const handle = policy.create(store, { source: async () => cfg });
  await handle.start();
  assert.deepEqual(store.calls, [
    ['setExemptRoles', ['a']],
    ['setDenyWriteRoles', ['g']],
    ['setUnconfiguredPolicy', 'closed'],
    ['setRbac', cfg.policy],
  ]);
});

test('T2 空配置 {}：走全部缺省值', async () => {
  const store = mockStore();
  const handle = policy.create(store, { source: async () => ({}) });
  await handle.start();
  assert.deepEqual(store.calls, [
    ['setExemptRoles', []],
    ['setDenyWriteRoles', []],
    ['setUnconfiguredPolicy', 'open'],
    ['setRbac', null],
  ]);
});

test('T3 未知顶层键：抛 Error 且零门面调用（校验先于应用）', async () => {
  const store = mockStore();
  const handle = policy.create(store, { source: async () => ({ foo: 1 }) });
  await assert.rejects(() => handle.start(), /foo/);
  assert.equal(store.calls.length, 0);
});

test('T4 非法 unconfiguredPolicy 值：抛 Error 且零门面调用', async () => {
  const store = mockStore();
  const handle = policy.create(store, { source: async () => ({ unconfiguredPolicy: 'x' }) });
  await assert.rejects(() => handle.start(), /unconfiguredPolicy/);
  assert.equal(store.calls.length, 0);
});

test('T5 exemptRoles 非字符串数组：抛 Error 且零门面调用', async () => {
  const store = mockStore();
  const handle = policy.create(store, { source: async () => ({ exemptRoles: 'a' }) });
  await assert.rejects(() => handle.start(), /exemptRoles/);
  assert.equal(store.calls.length, 0);
});

test('T6 策略源读取失败：原样上抛（不吞错）且零门面调用', async () => {
  const store = mockStore();
  const handle = policy.create(store, { source: async () => { throw new Error('boom'); } });
  await assert.rejects(() => handle.start(), /boom/);
  assert.equal(store.calls.length, 0);
});

test('T7 policy.file：读本地 JSON 成功注入；文件不存在抛 Error', async () => {
  const p = path.join(os.tmpdir(), `rbac-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(p, JSON.stringify({ exemptRoles: ['x'] }));
  try {
    const store = mockStore();
    const handle = policy.create(store, { source: policy.file(p) });
    await handle.start();
    assert.deepEqual(store.calls, [
      ['setExemptRoles', ['x']],
      ['setDenyWriteRoles', []],
      ['setUnconfiguredPolicy', 'open'],
      ['setRbac', null],
    ]);
    await assert.rejects(() => policy.file(`${p}.nope`)());
  } finally {
    fs.rmSync(p, { force: true });
  }
});

test('T8 reload：setRbac(null) 为首调用，随后重读源 + 四步重应用', async () => {
  const store = mockStore();
  const source = async () => ({ exemptRoles: ['a'] });
  const handle = policy.create(store, { source });
  await handle.start();
  const before = store.calls.length;               // 4
  await handle.reload();
  assert.equal(store.calls[before][0], 'setRbac'); // 清除前置
  assert.equal(store.calls[before][1], null);
  assert.equal(store.calls.length, before + 1 + 4);
});

test('T9 构造期：store 缺 setDenyWriteRoles → 抛 Error（消息含方法名）', () => {
  const store = mockStore();
  delete store.setDenyWriteRoles;
  assert.throws(() => policy.create(store, { source: async () => ({}) }), /setDenyWriteRoles/);
});

test('T10 构造期：opts.source 非函数 → 抛 Error', () => {
  assert.throws(() => policy.create(mockStore(), { source: 123 }), /source/);
});
