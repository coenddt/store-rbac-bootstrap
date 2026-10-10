'use strict';

/** 内存记录器：记录门面调用序列 [['setRbac', v], ...]；另记 schema 注入点 has/register */
function mockStore() {
  const calls = [];
  const knownSchemas = new Set();
  return {
    calls,                                              // [['setRbac', v], ...] 记录调用序列
    registeredSchemas: [],                              // 已 register 的 schema 名（按序）
    setRbac(v) { calls.push(['setRbac', v]); },
    setExemptRoles(v) { calls.push(['setExemptRoles', v]); },
    setDenyWriteRoles(v) { calls.push(['setDenyWriteRoles', v]); },
    setUnconfiguredPolicy(v) { calls.push(['setUnconfiguredPolicy', v]); },
    has(name) { return knownSchemas.has(name); },
    register(defn) { knownSchemas.add(defn.name); this.registeredSchemas.push(defn.name); },
  };
}

module.exports = { mockStore };
