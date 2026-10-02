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

## 钩子签名逐端清单

首期实现 **6 条**（三层皮 × node / py）；排除 **5 条**。签名原文出处以各皮 spec + 各端代码为准；skin 层文档（如 gateway README 的笼统写法）不作为依据。

| 皮 · 端 | 钩子实际签名 | 首期 | 依据 |
|---|---|---|---|
| store-api · node | `contextProvider(req)`（返回值经 `store.setContext(ctx)` 注入） | ✅ 实现 | `store-api/spec/04-context.md:9`；`store-api/node/src/plugin.js:42,50,62` |
| store-api · py | `context_provider(request)`（awaitable 支持） | ✅ 实现 | `store-api/spec/04-context.md:9`；`store-api/py/src/store_api_py/app.py:28,37,73` |
| store-api · go | `ContextProvider func(r *http.Request) (*gostore.Context, error)` | ❌ 排除（go 端不做） | `store-api/go/adapter.go:23-26,96-97`；排除依据：皮肤层设计 §6.3 |
| store-api · rust | `Arc<dyn Fn(&HeaderMap) -> BoxFuture<Result<Option<Value>, String>>>`（`Ok(None)` = 不注入） | ❌ 排除（首期 node / py） | `store-api/rust/src/lib.rs:72-75,120-137`；排除依据：皮肤层设计 §2.5 |
| store-grpc · node | `contextProvider(call.metadata)`（返回值经 `store.setContext` 注入） | ✅ 实现 | `store-grpc/spec/02-execution-mapping.md:41`；`store-grpc/node/src/index.js:210-213` |
| store-grpc · py | `context_provider(dict(invocation_metadata()))` | ✅ 实现 | `store-grpc/spec/02-execution-mapping.md:41`；`store-grpc/py/src/store_grpc/server.py:144-146` |
| store-graphql · node | `opts.contextFactory({ request, serverContext })` | ✅ 实现 | `store-graphql/node/src/index.js:426` |
| store-graphql · py | `context_provider(request)`（async 支持：`inspect.isawaitable`） | ✅ 实现 | `store-graphql/spec/04-errors-context.md:22`；`store-graphql/py/src/store_graphql/adapter.py:504-516` |
| store-graphql · go | `ContextProvider func(r *http.Request) (*gostore.Context, error)` | ❌ 排除（go 端不做） | `store-graphql/go/adapter.go:165-166,689-690`；排除依据：皮肤层设计 §6.3 |
| store-mcp · node | `contextProvider(req.params._meta)` | ❌ 排除（锚在 gateway 第四开关） | `store-mcp/node/src/index.js:246-248`；排除依据：皮肤层设计 §2.5 |
| store-mcp · py | `context_provider(...)`（经 `opts` 读取） | ❌ 排除（同上） | `store-mcp/py/store_mcp/__init__.py:285-288`；排除依据：皮肤层设计 §2.5 |

**结论：跨皮、且皮内各端均不同构** —— 插件工厂逐皮逐端适配，禁止「一套签名通用」。

> 「首期排除」≠「不支持」：排除项的后续纳入时机锚点为 go 生态成熟（go 端）与 gateway 第四开关落地（store-mcp），但**首期不预留代码**。

## 身份源适配与错误清除语义

**两层结构**：皮无关**解码器**（`bag → ctx`）+ 逐皮**适配器**（把解码器装到该皮该端钩子签名）。

**bag 约定**：平铺的字符串映射，键为**小写**凭证据名，值为字符串；同名多值取**首个**。各皮适配器负责从钩子入参提取 bag（node / py 同构）：

| 皮 | 取 bag 的位置 |
|---|---|
| store-api | HTTP 请求头 `req.headers` / `request.headers` |
| store-grpc | RPC 元数据 `call.metadata` / `invocation_metadata` |
| store-graphql | 请求头 `{request, serverContext}.request.headers` / `request.headers` |

**解码器**（皮无关，入参 `bag`）：

| 工厂 | 选项（含默认值） | 语义 |
|---|---|---|
| `identity.jwt(opts)` | `secret`（必填非空）、`algorithm`（默认 `'HS256'`，∈ `HS256/HS384/HS512`）、`header`（默认 `'authorization'`，取 `Bearer <token>`）、`userIdClaim`（默认 `'sub'`）、`rolesClaim`（默认 `'roles'`） | 验签 + `exp` 到期判定；通过 → `{userId, roles}`（`roles` 缺省 `[]`） |
| `identity.apiKey(opts)`（py `identity.api_key`） | `header`（默认 `'x-api-key'`）、`lookup`（必填，`(key) => {userId, roles} \| null`，可 async） | `lookup` 命中 → `{userId, roles}`；返回 null → `null` |
| `identity.session(opts)` | `cookie`（默认 `'sid'`）、`lookup`（必填，`(sid) => {userId, roles} \| null`，可 async） | 从 `cookie` 头解析 `<cookie>=<value>`；`lookup` 命中 → `{userId, roles}`；返回 null → `null` |

**解码器返回契约**（严格三态，node / py 一致）：

- **无对应凭证**（bag 中无该头 / 该 cookie / 空值）→ 返回 `null`（**必须**是 `null`，不得为 `undefined` / 省略返回 / 空对象）；
- **凭证存在但无效**（验签失败 / 已过期 / 解不出非空 `userId`）→ 抛**普通 `Error`**，message 为中文原因（**不带任何 `ERR_` 前缀**，不得引入新前缀）；
- **通过** → 返回 `{userId: string, roles: string[]}`。

**逐皮适配器**（`identity.adapt(skin, decode)`；未知皮名 → 构造期 `Error`）：

| 端 | `skin` | 返回的钩子签名 |
|---|---|---|
| node | `'store-api'` | `(req) => Promise<ctx \| null>` |
| node | `'store-grpc'` | `(metadata) => Promise<ctx \| null>` |
| node | `'store-graphql'` | `({ request, serverContext }) => Promise<ctx \| null>` |
| py | `'store-api'` | `async (request) => ctx \| None` |
| py | `'store-grpc'` | `async (invocation_metadata) => ctx \| None` |
| py | `'store-graphql'` | `async (request) => ctx \| None` |

要求：适配器**恒返回** `ctx | null`（无凭证时返回 `null`，绝不「不返回」以绕过皮肤的显式清除）。

**错误与清除语义**（对齐皮肤层设计 §4.3 / §7 第 7 条）：

| 情形 | 插件行为 | 皮肤既有映射（插件零状态码知识） |
|---|---|---|
| 无凭证 | 返回 `null` | 皮肤显式注入空上下文（有状态持有端：node / py / go） |
| 凭证无效 / 过期 | 抛普通 `Error`（message 原样） | REST / GraphQL → 401；gRPC → `UNAUTHENTICATED` |
| 回调（`lookup`）抛出宿主 `PermissionError` | **原样上抛**（插件不做 `instanceof` 判定、不包装） | REST / GraphQL → 403；gRPC → `PERMISSION_DENIED` |
| 策略 JSON 畸形 | 不捕获，由 core `setRbac` 解析期抛错回流注入点 | 注入点 fail-fast |

> 上表「皮肤既有映射」一列仅描述**皮肤既有行为**，插件自身**不产生**上述状态码 / 错误名（零语义发明）。

## 依赖与宿主解耦

- **插件零宿主依赖**：不 `require('nodejs-store')`、不 `import py_store`，也不依赖任何 core / 皮肤包；`store` 实例由接入方**作为参数**传入，插件只调其既有门面；
- 宿主包在 `package.json` / `pyproject.toml` 中**仅作 optional peer 兼容性声明**（`nodejs-store >=3.0.0` / `py-store >=3.0.0`），不产生运行时依赖；
- **对皮肤层设计 §3.1 的收敛留痕**：设计预留「`PermissionError` 类可显式传入」的 optional-peer 手法；因插件**零判决、从不主动构造权限类错误**（无拒绝点），本期以更强约束「零宿主依赖」实现——接入方回调抛出的任何错误由插件原样上抛，分类责任在皮肤（各皮 spec 是唯一事实源）。此为**收敛而非扩大**；如后续出现插件主动拒绝的场景，再按设计 §3.1 启用 `errors` 传入点；
- **JWT 依赖**：node `jsonwebtoken`（`^9`）、py `PyJWT`（`>=2.8`）——为插件自身依赖（非宿主）。
