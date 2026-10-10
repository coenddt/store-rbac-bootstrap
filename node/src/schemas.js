'use strict';

/**
 * 内置「可选参考」RBAC 管理面定义（两表）——库不再把它作为权威 schema 预置/强制注册。
 * RBAC 策略存储（角色清单 / grant 表）属**上层业务**的持久化模型；库只提供这份参考定义
 * 供开箱即用，是否注册、注册哪套，由接入方按需注入
 * （`policy.create(store, { source, schemas: policy.schemas() })` 或自有定义；缺省不注册任何表）。
 * 字段依据 core 策略模型：`rust-store/core/src/rbac.rs`（`RbacPolicy` / `Grant`：mode / roles / grants，
 * grant 键 role / model / actions / readFields / writeFields / ownerOnly / condition）。
 * 语义与 spec/00-protocol.md 附录 A 一致；conformance 校验本常量与之深比较全等。
 */
const RBAC_SCHEMAS = [
  {
    name: 'RbacRole', collection: '__rbac_roles', idPrefix: 'rr', timestamps: true,
    read: [], write: [],
    fields: {
      _id:         { type: 'string' },
      name:        { type: 'string' },   // 角色名（与策略 roles 键一致）
      description: { type: 'string' },
    },
    relations: {},
    indexes: [
      { keys: { name: 1 }, options: { unique: true } },
    ],
  },
  {
    name: 'RbacGrant', collection: '__rbac_grants', idPrefix: 'rg', timestamps: true,
    read: [], write: [],
    fields: {
      _id:         { type: 'string' },
      role:        { type: 'string' },   // 角色名（对应 RbacRole.name）
      model:       { type: 'string' },   // 精确 schema 名或 "*"（通配）
      actions:     { type: 'array' },    // ["read","insert","update","remove"]（"write" 展开在 core）
      readFields:  { type: 'array' },    // 读字段白名单；空/缺省 = 不收紧
      writeFields: { type: 'array' },    // 写字段白名单；空/缺省 = 不收紧
      ownerOnly:   { type: 'boolean' },  // 仅本人可及
      condition:   { type: 'object' },   // 等值标量条件（core 解析期校验）
    },
    relations: {
      roleDef: { model: 'RbacRole', type: 'one', localField: 'role', foreignField: 'name', read: [] },
    },
    indexes: [
      { keys: { role: 1, model: 1 }, options: { unique: true } },
    ],
  },
];

module.exports = { RBAC_SCHEMAS };