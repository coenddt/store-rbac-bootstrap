'use strict';

/** 内存记录器：记录门面调用序列 [['setRbac', v], ...] */
function mockStore() {
  const calls = [];
  return {
    calls,                                              // [['setRbac', v], ...] 记录调用序列
    setRbac(v) { calls.push(['setRbac', v]); },
    setExemptRoles(v) { calls.push(['setExemptRoles', v]); },
    setDenyWriteRoles(v) { calls.push(['setDenyWriteRoles', v]); },
    setUnconfiguredPolicy(v) { calls.push(['setUnconfiguredPolicy', v]); },
  };
}

module.exports = { mockStore };
