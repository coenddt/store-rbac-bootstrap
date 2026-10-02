# 00 — RBAC 皮肤层插件包：引导协议

> 唯一事实源：02（node）/ 03（py）两端的一切字段名、取值、签名一律回指本文件，不得另立口径。
> 日期：2026-10-03
> 上游设计：`.trae/documents/RBAC插件-皮肤层插件包-设计.md`；core 判决依据 `.trae/documents/RBAC插件-设计.md`（v3，已实施）。

## 定位

`store-rbac-bootstrap` 是 common-store 三层 API 皮肤（REST：store-api；GraphQL：store-graphql；gRPC：store-grpc）的**可选 RBAC 引导插件**，形态复刻 store-gateway（读配置 → 挂接各皮既有接缝），只做两件事：

1. **策略引导**：读 bootstrap 配置 → 调宿主 store 既有 RBAC 配置门面（`setRbac` / `setExemptRoles` / `setDenyWriteRoles` / `setUnconfiguredPolicy`）；
2. **身份源适配**：把 JWT / API-Key / Session 凭证解码为 `{userId, roles}` → 适配各皮既有 `contextProvider` 接缝。

三条铁律：

- **零判决**：插件不参与任何权限判定，不读取、不解释策略内容，只把配置原样搬运给宿主门面（判决在 core）；
- **零语义发明**：不发明错误前缀 / 状态码，不解释策略内容键；插件只抛普通 `Error`，无凭证时返回 `null`；
- **零回归**：不修改任何既有子仓（`store-api` / `store-grpc` / `store-graphql` / `store-mcp` / `store-gateway` / `nodejs-store` / `py-store` / `go-store` / `rust-store`），纯增量。

## 配置形状（node / py 同构）

```jsonc
{
  "policy": { "mode": "overlay", "roles": {}, "grants": [] },  // 可选；→ store.setRbac(policy)。null/缺省 = 清除策略
  "exemptRoles": ["super_admin"],                              // 可选；缺省 []。→ store.setExemptRoles(roles)
  "denyWriteRoles": ["guest"],                                 // 可选；缺省 []。→ store.setDenyWriteRoles(roles)
  "unconfiguredPolicy": "open"                                 // 可选；缺省 "open"。∈ {"open","closed"} → store.setUnconfiguredPolicy(v)
}
```

- `policy` 内容**对插件完全透明**（不读 `mode` / `grants` / 角色名等任何键，只搬运给 `setRbac`）；
- 顶层**仅允许** `policy` / `exemptRoles` / `denyWriteRoles` / `unconfiguredPolicy` 四个键；出现未知键 = 配置错误 → 抛 `Error`（禁静默忽略，对齐 no-error-masking）；
- 类型约束：

| 字段 | 允许类型 / 取值 | 缺省 |
|---|---|---|
| `policy` | 普通对象 \| `null` \| 缺省 | `null`（清除策略） |
| `exemptRoles` | 字符串数组（每元素为字符串） | `[]` |
| `denyWriteRoles` | 字符串数组（每元素为字符串） | `[]` |
| `unconfiguredPolicy` | `"open"` \| `"closed"`（**仅小写**） | `"open"` |

- `unconfiguredPolicy` 仅接受小写字符串，其余值 → 抛 `Error`；取值口径与宿主既有门面一致。

## 引导规则

### 入口（node；py 为同构 snake_case）

```js
const { policy, identity } = require('store-rbac-bootstrap-node');

// 策略源三选——产物均为 async 读取函数 () => object
policy.file(path)                 // 读本地文件 → JSON.parse；文件不存在 / JSON 非法 ⇒ 抛 Error
policy.url(url, { headers } = {}) // 远端策略分发服务 → fetch → JSON；非 2xx / JSON 非法 ⇒ 抛 Error
policy.db(loader)                 // DB / 配置中心；loader: () => object | Promise<object>

const handle = policy.create(store, { source });   // source 必填（上述三者之一的产物）
await handle.start();      // 启动引导
await handle.reload();     // 变更重注入
```

### `start()` 固定序列（校验先于应用，避免半配置状态）

1. `config = await source()` —— 读取失败**原样上抛**（不捕获、不静默跳过）；
2. 校验 `config`：必须是普通对象；未知顶层键 → `Error`（消息列出未知键）；各字段按「配置形状」类型 / 取值校验 → 任一不符即 `Error`（**此时零门面调用**）；
3. 应用（严格顺序）：
   1. `await store.setExemptRoles(config.exemptRoles ?? [])`
   2. `await store.setDenyWriteRoles(config.denyWriteRoles ?? [])`
   3. `await store.setUnconfiguredPolicy(config.unconfiguredPolicy ?? 'open')`
   4. `await store.setRbac(config.policy ?? null)` —— 策略**最后**生效

### `reload()` 固定序列

1. `await store.setRbac(null)` —— 先清除（等价「`setRbac(null)` + 重注入」）；
2. 重跑 `start()` 的 1–3（重读源 + 重校验 + 按序重应用）。

### 构造期校验

- `policy.create(store, opts)`：`store` 必填且具上述 4 个门面方法（缺任一 → `Error`，消息含缺失方法名）；`opts.source` 必须是函数（否则 → `Error`）；
- `start()` / `reload()` **幂等**（可重复调用，重复调用等价再应用一次）。

### 其它引导规则

- 策略 JSON 畸形由 core 在 `setRbac` 解析期 fail-fast 抛错，**插件不捕获、不改写消息**（错误在注入点暴露）；
- 变更时机由接入方决定（文件监听 / 轮询 / 推送后调 `reload()`），**插件不自带 watcher / 定时器**。
