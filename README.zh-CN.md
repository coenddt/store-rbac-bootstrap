# store-rbac-bootstrap

**common-store 数据层家族皮肤层的可选 RBAC 引导插件**（REST：[store-api](../store-api)；GraphQL：[store-graphql](../store-graphql)；gRPC：[store-grpc](../store-grpc)）。它只做两件事——把一套 RBAC 策略装到宿主 store 上，以及把各皮的身份源适配成统一的 `{userId, roles}` 上下文——然后把**裁决本身**交给数据层内核（[rust-store](../rust-store)）。它绝不自行判定任何权限。

> English: [README.md](./README.md)

## 运行端与包矩阵

本仓库发布两个同构运行端，实现同一份协议，并共享同一份一致性语料。

| 运行端 | 包 | 仓库 | 导入 | 最低运行环境 |
|---|---|---|---|---|
| Node | `store-rbac-bootstrap-node` | npm | `require('store-rbac-bootstrap-node')` | Node >= 18 |
| Python | `store-rbac-bootstrap-py` | PyPI | `import store_rbac_bootstrap` | Python >= 3.10 |

自有依赖：Node `jsonwebtoken ^9`；Python `PyJWT >= 2.8`。宿主 store（`nodejs-store >= 3.0.0` / `py-store >= 3.0.0`）**仅声明为可选 peer**——**对宿主无运行时依赖**。

首期接缝——3 皮 × 2 运行端 = **6 条钩子**，逐条签名各不相同：

| 皮 | 运行端 | 返回的钩子所填补的接缝 |
|---|---|---|
| REST（store-api） | node | `contextProvider(req)` |
| REST（store-api） | py | `context_provider(request)` |
| gRPC（store-grpc） | node | `contextProvider(call.metadata)` |
| gRPC（store-grpc） | py | `context_provider(dict(invocation_metadata()))` |
| GraphQL（store-graphql） | node | `opts.contextFactory({ request, serverContext })` |
| GraphQL（store-graphql） | py | `context_provider(request)` |

## 目录

1. [它是什么](#它是什么)
2. [何时用 / 何时不用](#何时用--何时不用)
3. [安装](#安装)
4. [快速上手](#快速上手)
5. [策略引导](#策略引导)
6. [身份适配](#身份适配)
7. [配置参考](#配置参考)
8. [三条铁律](#三条铁律)
9. [错误映射](#错误映射)
10. [场景事例](#场景事例)
11. [定制化与扩展点](#定制化与扩展点)
12. [边界与非目标](#边界与非目标)
13. [FAQ](#faq)
14. [开发](#开发)
15. [相关项目](#相关项目)
16. [License](#license)

## 它是什么

`store-rbac-bootstrap` 的形态复刻 [store-gateway](../store-gateway)：它*读取配置，并挂接进各皮既有的接缝*。它只做两个映射：

1. **策略引导** —— 读一份 bootstrap 配置，调用宿主 store **既有的** RBAC 门面（`setRbac` / `setExemptRoles` / `setDenyWriteRoles` / `setUnconfiguredPolicy`），并把**由接入方注入**的 schema 定义（`opts.schemas`，可选；缺省不注册任何表）`register` 进宿主注册表（`has` / `register`，幂等）。
2. **身份源适配** —— 把 JWT / API-Key / Session 凭证解码为 `{userId, roles}`，并把结果挂到各皮既有的 `contextProvider` 接缝。

它不做的一切都是刻意的。它从不读取或解释策略内容，从不发明错误前缀或状态码，也从不触碰任何兄弟仓库。唯一事实源是 [`spec/00-protocol.md`](./spec/00-protocol.md)——下文每个字段名、取值与签名都取自它以及两个实现。

**schema 归属（解耦）。** 本库**不内置权威 RBAC schema**。业务实体 schema 一概不涉及（由业务上层定义）。RBAC 管理面*自身*的存储 schema（角色表 `__rbac_roles` / grant 表 `__rbac_grants`）**仅作可选参考定义**随包提供（`policy.schemas()`），只有接入方经 `opts.schemas` 注入时才会被注册（缺省 `[]` → 不注册任何表）。插件**不建表**——它只是把定义 `register` 进宿主 schema 注册表，不触发 DDL。

### 与 rust-store 权限模型的关系

插件与 rust-store 是同一条权限故事的两半，以一条硬线划分：

- rust-store 拥有**裁决**。它的静态引擎在计划构建时评估 schema 级（`read` / `write`）、字段级（`field.read` / `field.write`）、关系级（`relation.read`）与计算列级（`compute.read`）白名单；它的动态 RBAC 引擎读取策略（`RbacPolicy`：`mode` / `roles` / `grants`），一条 `Grant` 以 `role` / `model` / `actions` / `readFields` / `writeFields` / `ownerOnly` / `condition` 为键。
- 本插件只拥有**那次裁决的输入**：它把策略对象原样搬运给 `setRbac(policy)`，并产出 rust-store 作为 `ctx` 消费的 `{userId, roles}` 上下文。
- `creator` **伪角色**（由 rust-store 解析为 `doc.createdBy == ctx.userId`）与 `ownerOnly` grant 标志（注入 `{createdBy: userId}` 行条件）是 rust-store 自身的机制。本插件从不检视它们——它只确保一个真实的 `userId` 抵达 `ctx`。

`policy.schemas()` 中的参考 schema 与 `Grant` 模型一一对应（见 [定制化与扩展点](#定制化与扩展点)）；完整语义在 rust-store，此处不再重述。

## 何时用 / 何时不用

**在以下情况用它：**

- 你通过不止一个皮（REST + GraphQL + gRPC）暴露*同一份*数据，希望**一套** RBAC 策略处处生效，而不是在每个皮里各写一遍授权。
- 你希望策略是一份**可版本化的产物**（一个 JSON 文件、一个 URL、或一个配置中心取值），无需重新部署代码即可下发。
- 你希望身份提取（JWT / API-Key / cookie session）**只写一次**，让各皮、各运行端的 claim 映射与「无凭证 → 清空上下文」语义保持一致。
- 你需要 node 与 py 行为**完全一致**，并由一份共享的一致性语料背书。

**在以下情况不要用它：**

- 你想要一个授权引擎。本插件不做任何裁决——那是 rust-store 的职责。
- 你需要它建表，或拥有你的业务 schema。
- 你需要一个策略的管理面 / 管理 API。那被推迟（设计 §5），且按既定设计是复用 store-api 在你所定义 schema 上自动生成的 CRUD 来搭建。
- 你需要一个 watcher / 轮询器。插件不提供——由你决定*何时*调用 `reload()`。
- 你处于 go 运行端、store-api rust 或本期的 store-mcp（见 [边界与非目标](#边界与非目标)）。

## 安装

**Node**

```bash
npm i store-rbac-bootstrap-node
# 可选 peer，由接入方作为宿主 store 安装：
npm i nodejs-store
```

**Python**

```bash
pip install store-rbac-bootstrap-py
# 可选 peer，由接入方作为宿主 store 安装：
pip install py-store
```

## 快速上手

### Node（`store-rbac-bootstrap-node`）

```js
const { policy, identity } = require('store-rbac-bootstrap-node');

// `store` 是宿主 store 实例（nodejs-store），由接入方创建。
// 它必须暴露四个 RBAC 门面：setRbac / setExemptRoles /
// setDenyWriteRoles / setUnconfiguredPolicy。

// 1) 策略引导：读配置 -> 应用到宿主门面（校验先于应用）。
//    `schemas` 可选：注入 RBAC 管理面参考定义
//    （缺省不注册任何表；schema 归属上层业务）。
const handle = policy.create(store, {
  source: policy.file('./rbac.json'),
  schemas: policy.schemas(),        // 可选；或传自有定义，或不传
});
await handle.start();               // -> { registered: ['RbacRole', 'RbacGrant'], skipped: [] }
// await handle.reload();           // 先清除（setRbac(null)），再重读并重应用

// 2) 身份适配：凭证 -> {userId, roles} -> 皮接缝。
const decode = identity.jwt({ secret: process.env.JWT_SECRET });
const restHook = identity.adapt('store-api', decode);   // (req) => Promise<ctx | null>
// 把 restHook 作为 store-api 的 contextProvider 传入（见 store-api/spec/04-context.md）
```

### Python（`store-rbac-bootstrap-py`）

```python
import asyncio, os
from store_rbac_bootstrap import policy, identity

# `store` 是宿主 store 实例（py-store），由接入方创建。
# 它必须暴露四个门面：set_rbac / set_exempt_roles /
# set_deny_write_roles / set_unconfigured_policy。

async def main():
    handle = policy.create(store, policy.file("./rbac.json"), schemas=policy.schemas())
    await handle.start()
    # await handle.reload()

    decode = identity.jwt(secret=os.environ["JWT_SECRET"])
    rest_hook = identity.adapt("store-api", decode)   # async (request) => ctx | None
    # 把 rest_hook 作为 store-api-py 的 context_provider 传入

asyncio.run(main())
```

## 策略引导

两族入口：**策略源**（产出配置对象）与 **`policy.create`**（把它装上）。

### 策略源

以下每个都返回一个源函数 `() => object`（node）/ 一个 callable（py）。读取失败**原样传播**——插件从不吞掉。

| 入口 | 签名 | 行为 |
|---|---|---|
| `policy.file(path)` | node `file(path)`；py `file(path)` | 读取本地文件并 `JSON.parse` / `json.loads`。文件缺失或 JSON 非法 ⇒ 抛错。 |
| `policy.url(url, opts)` | node `url(u, { headers } = {})`；py `url(u, headers=None)` | `fetch` / `urlopen` 远程策略服务 → JSON。非 2xx 或 JSON 非法 ⇒ 抛错。 |
| `policy.db(loader)` | node `db(loader)`；py `db(loader)` | 包装一个 DB / 配置中心加载器：`loader: () => object \| Promise<object>`。 |
| `policy.schemas()` | node `schemas()`；py `schemas()` | 返回可选的 RBAC 管理面参考定义（2 张表），且**深拷贝**，调用方无法改动内部常量。 |

### `policy.create(...)`

```js
// node
const handle = policy.create(store, { source, schemas });
```

```python
# python
handle = policy.create(store, source, schemas=None)
```

- `source`（必填）——三策略源之一的产物（或任意返回对象 / promise 的无参函数）。
- `schemas`（可选，缺省 `[]`）——schema 定义的**注入点**。一个数组（每项为带非空字符串 `name` 的对象），或 `null` / `false` 表示不注册任何表。Node 在构造时校验该选项形状；宿主仅当生效集非空时才须额外暴露 `has` / `register`（这使仅有四个 RBAC 门面的旧 store 依然可用）。

返回一个句柄：

| 方法 | 行为 |
|---|---|
| `handle.start()` | 运行下方固定启动序列；返回 `{ registered: string[], skipped: string[] }`。 |
| `handle.reload()` | 先调 `setRbac(null)`，再重跑 `start()`（重读 + 重校验 + 幂等重注册 + 重应用）。 |

### `start()` —— 固定序列（校验先于应用）

1. `config = await source()` —— 读取失败**原样**传播（绝不捕获、绝不跳过）。
2. **校验** `config`：必须是普通对象；存在未知顶层键 ⇒ 抛错；每个字段按[配置形状](#配置参考)逐项检查 ⇒ 任何不符即抛错。**此刻尚未发生任何门面调用**——不存在半应用状态。
3. **注册 schema**（来自生效的 `opts.schemas` 集；`has` / `register` 是**同步**且幂等的；缺省 `[]` ⇒ 本步为空操作）：`has(name)`？推入 `skipped` : `register(defn)` 并推入 `registered`。
4. **应用，严格按序**：
   1. `await store.setExemptRoles(config.exemptRoles ?? [])`
   2. `await store.setDenyWriteRoles(config.denyWriteRoles ?? [])`
   3. `await store.setUnconfiguredPolicy(config.unconfiguredPolicy ?? 'open')`
   4. `await store.setRbac(config.policy ?? null)` —— **策略最后生效**。
5. 返回 `{ registered, skipped }`（可观测——绝不静默）。

`start()` / `reload()` 是**幂等**的：再次调用即重应用。对 schema 而言，第一轮 `registered`，第二轮全部 `skipped`。

插件**不提供 watcher，也不提供 timer**。变更时机（文件监听 / 轮询 / 推送后 `reload()`）是接入方的决定。

## 身份适配

### 解码器（皮无关）

每个解码器接收一个 **bag**——一个键**均为小写**、值均为字符串的扁平映射（同名多条取首条）——并返回严格的三态结果。

| 工厂 | 选项（含缺省） | 语义 |
|---|---|---|
| `identity.jwt(opts)`（py `identity.jwt(secret, ...)`） | `secret`（必填，非空），`algorithm`（缺省 `'HS256'`，取 `HS256` / `HS384` / `HS512` 之一），`header`（缺省 `'authorization'`，接受 `Bearer <token>`），`userIdClaim`（缺省 `'sub'`，py `user_id_claim`），`rolesClaim`（缺省 `'roles'`，py `roles_claim`） | 校验签名 + `exp`；通过 → `{userId, roles}`（`roles` 缺省为 `[]`） |
| `identity.apiKey(opts)`（py `identity.api_key`） | `header`（缺省 `'x-api-key'`），`lookup`（必填，`(key) => {userId, roles} \| null`，可为 async） | `lookup` 命中 → `{userId, roles}`；`null` → `null` |
| `identity.session(opts)`（py `identity.session`） | `cookie`（缺省 `'sid'`），`lookup`（必填，`(sid) => {userId, roles} \| null`，可为 async） | 从 `cookie` 头解析 `<cookie>=<value>`；`lookup` 命中 → `{userId, roles}`；`null` → `null` |

### 解码器返回契约（严格，node 与 py 一致）

- **无凭证**（header / cookie 缺失或为空）→ 返回 **`null`** / **`None`**——它*必须*是 `null`，绝不是 `undefined` / 无返回 / 空对象。这正是触发该皮「显式清空上下文」的取值。
- **凭证存在但无效**（签名错 / 过期 / `userId` 非空缺失）→ 抛一个**普通 `Error`**（node）/ **`ValueError`**（py），消息为中文原因且**无 `ERR_` 前缀**。不得引入新前缀。
- **有效** → `{ userId: string, roles: string[] }`。

### `identity.adapt(skin, decode)` —— 逐皮适配器

接收一个皮名与一个解码器，返回一个签名与该皮接缝吻合的钩子。未知皮名在构造时抛错。返回的钩子**始终返回 `ctx | null`**——无凭证时返回 `null`，绝不「什么都不返回」（那会绕开该皮的显式清空）。

| 运行端 | `skin` | 返回的钩子 |
|---|---|---|
| node | `'store-api'` | `(req) => Promise<ctx \| null>` |
| node | `'store-grpc'` | `(metadata) => Promise<ctx \| null>` |
| node | `'store-graphql'` | `({ request, serverContext }) => Promise<ctx \| null>` |
| py | `'store-api'` | `async (request) => ctx \| None` |
| py | `'store-grpc'` | `async (invocation_metadata) => ctx \| None` |
| py | `'store-graphql'` | `async (request) => ctx \| None` |

### 首期 6 条逐皮钩子

每个适配器从哪里读它的 bag，以及它所填补的皮接缝：

| 皮 · 运行端 | 钩子（所填补的接缝） | bag 来源 | 用途 |
|---|---|---|---|
| store-api · node | `contextProvider(req)` | `req.headers` | 解码 REST 请求凭证为 ctx |
| store-api · py | `context_provider(request)` | `request.headers` | 同上，以 awaitable provider 形式 |
| store-grpc · node | `contextProvider(call.metadata)` | `call.metadata` | 解码 gRPC metadata 为 ctx |
| store-grpc · py | `context_provider(dict(invocation_metadata()))` | `invocation_metadata` | 同上，取自 RPC 调用 metadata |
| store-graphql · node | `opts.contextFactory({ request, serverContext })` | `{request, serverContext}.request.headers` | 解码 GraphQL 请求头为 ctx |
| store-graphql · py | `context_provider(request)` | `request.headers` | 同上，以 awaitable provider 形式 |

签名**跨皮不同，且同一皮内跨运行端也不同**——工厂逐皮逐端适配。不存在「一套签名通用」。

## 配置参考

bootstrap 配置是一个 JSON 对象，顶层**恰好只有四个允许键**。任何未知键都是配置错误（抛错——绝不静默忽略）。

```jsonc
{
  "policy": { "mode": "overlay", "roles": {}, "grants": [] },  // 可选；-> store.setRbac(policy)。null/缺省 = 清除策略
  "exemptRoles": ["super_admin"],                              // 可选；缺省 []。-> store.setExemptRoles(roles)
  "denyWriteRoles": ["guest"],                                 // 可选；缺省 []。-> store.setDenyWriteRoles(roles)
  "unconfiguredPolicy": "open"                                 // 可选；缺省 "open"。取 {"open","closed"} -> store.setUnconfiguredPolicy(v)
}
```

| 键 | 允许类型 / 取值 | 缺省 | 备注 |
|---|---|---|---|
| `policy` | 普通对象 \| `null` \| 缺省 | `null`（清除） | 对插件**完全不透明**——它从不读取 `mode` / `grants` / 角色名；原样搬运给 `setRbac`。 |
| `exemptRoles` | 字符串数组（每项为字符串） | `[]` | 以 `setExemptRoles` 应用。 |
| `denyWriteRoles` | 字符串数组（每项为字符串） | `[]` | 以 `setDenyWriteRoles` 应用。 |
| `unconfiguredPolicy` | `"open"` \| `"closed"`（**仅小写**） | `"open"` | 以 `setUnconfiguredPolicy` 应用；任何其他值即抛错。 |

### 构造参数（`policy.create`）

```jsonc
{
  "source": "<一个策略源，见上文>",                       // 必填
  "schemas": [ "<schema 定义，见附录 A>" ]                // 可选；缺省 []（不注册任何表）
}
```

| 字段 | 允许类型 / 取值 | 缺省 | 备注 |
|---|---|---|---|
| `source` | 函数 `() => object \| Promise<object>`（py：callable） | 无（必填） | 三策略源之一的产物。 |
| `schemas` | 数组 \| `null` \| `false` | `[]` | schema 定义的**注入点**。数组逐项须为带非空字符串 `name` 的对象，按序经幂等的 `has` / `register` 应用。`null` / `false` / 缺省 ⇒ 不注册任何表。 |

`policy.schemas()` 返回可选的参考定义（角色表 / grant 表，**深拷贝**）。宿主仅当生效 schema 集非空时才须暴露 `has` / `register`。

## 三条铁律

这三条规则定义了插件的全部价值：它之所以有用，正是因为它拒绝做任何别的事。

1. **零判决（zero adjudication）。** 插件绝不参与任何权限判定。它不读取、不解释策略内容（`mode`、`grants`、角色名……）——它把配置原样搬运给宿主门面。除了产出 `{userId, roles}`，它不检视自己解码出的上下文。裁决在内核（rust-store）作出。
2. **零语义发明（zero semantic invention）。** 它不发明错误前缀，不发明状态码，也不解释任何策略内容键。它抛一个**普通 `Error`**（py `ValueError`），消息为中文且无 `ERR_` 前缀；无凭证时返回 **`null`**。任何状态码映射（REST/GraphQL → 401，gRPC → `UNAUTHENTICATED` 等）属于各皮，不属于本插件。
3. **零回归（zero regression）。** 它不改动任何兄弟仓库——`store-api` / `store-grpc` / `store-graphql` / `store-mcp` / `store-gateway` / `nodejs-store` / `py-store` / `go-store` / `rust-store`。它是纯粹增量的。

推论：升级宿主门面是调用方的兼容性事项（一个仅有四个 RBAC 门面的旧 store，只要你不注入 schema，就依然可用）。

## 错误映射

**本仓库不新增任何错误码。** 它不定义 `ERR_` 前缀、不定义状态码、不定义权限错误类。它的一致性语料机检以下禁用字面量在任何时刻都不出现在本仓库的行为中：

```
ERR_PERMISSION, CONTEXT_ERROR, UNAUTHENTICATED, PERMISSION_DENIED, 401, 403
```

插件在每种情形下实际做什么，以及**各皮既有**的行为是什么（右列状态码没有一个是本插件产出的）：

| 情形 | 插件行为 | 皮的既有映射（插件对状态码零知识） |
|---|---|---|
| 无凭证 | 返回 `null` | 皮注入空上下文 |
| 凭证无效 / 过期 | 抛普通 `Error` / `ValueError`（消息原样） | REST / GraphQL → 401；gRPC → `UNAUTHENTICATED` |
| `lookup` 回调抛出宿主 `PermissionError` | **原样**传播（不做 `instanceof` 检查、不做包装） | REST / GraphQL → 403；gRPC → `PERMISSION_DENIED` |
| 策略 JSON 畸形 | 不捕获；内核的 `setRbac` 在解析时抛错，并在注入点浮现 | 注入点快速失败 |

本插件抛出的配置与构造错误是普通 `Error`（node）/ `ValueError`（py），消息会点名出错的键或方法，例如 `引导配置含未知键: foo`、`引导配置 unconfiguredPolicy 只能是 "open" 或 "closed"`、`store 缺少门面方法: setDenyWriteRoles`、`identity.adapt 未知皮名: unknown`。

## 场景事例

七个事例，展示*为什么*一个引导插件胜过把授权手写进每个皮。

### 事例 1 —— 一套策略，三个皮（定义一次，三处生效）

**业务背景。** 一个应用通过 REST、GraphQL 与 gRPC 暴露同一份数据。每个皮过去各带一套临时授权胶水；团队想要一套策略统管三者，以及一种统一方式回答「谁在调用」。

**配置 · 调用**

```js
const { policy, identity } = require('store-rbac-bootstrap-node');

// 1) 装上策略一次。
const handle = policy.create(store, {
  source: policy.file('./rbac.json'),
  schemas: policy.schemas(),
});
const { registered, skipped } = await handle.start();
// -> registered: ['RbacRole', 'RbacGrant'], skipped: []

// 2) 一个解码器，三个皮。
const decode = identity.jwt({ secret: process.env.JWT_SECRET });
const restHook    = identity.adapt('store-api', decode);      // (req) => Promise<ctx|null>
const graphqlHook = identity.adapt('store-graphql', decode);  // ({request, serverContext}) => Promise<ctx|null>
const grpcHook    = identity.adapt('store-grpc', decode);     // (metadata) => Promise<ctx|null>
// 把每个钩子接进该皮既有的接缝
```

**结果。** `start()` 按固定顺序调用门面（`setExemptRoles`、`setDenyWriteRoles`、`setUnconfiguredPolicy`，最后 `setRbac`）并装上策略。每次 `adapt` 返回一个签名恰为对应皮的钩子；三者都解码出同一个 `{userId, roles}`。插件本身从不读取策略内容——rust-store 才读。

**优势所在。** 策略**定义一次**，三处生效。没有需要同步维护的逐皮授权代码，也没有逐皮的身份提取分歧。将来新增第四个面只是一次接线改动，而非重做一遍。

### 事例 2 —— 用 `policy.file` 承载可版本化、对 CI/CD 友好的策略

**业务背景。** 策略必须能像代码一样被评审、diff 与回滚，但变更时又不该要求重新部署应用。

**配置 · 调用**

```js
const handle = policy.create(store, {
  source: policy.file('./rbac.json'),   // 仓库中的文件 / 一份配置产物
  schemas: policy.schemas(),
});
await handle.start();

// 新的 rbac.json 部署后：
await handle.reload();                   // 首次调用：setRbac(null)；随后重读 + 重应用
```

**结果。** `policy.file(path)` 返回一个读取并 `JSON.parse` 该文件的读取器。文件缺失或 JSON 非法即抛错（失败原样传播）。文件变更后，`reload()` 重读它；其**首次**调用是 `setRbac(null)`，随后完整启动序列重跑。

**优势所在。** 策略成为流水线中一份可版本化的产物（与代码同一条评审/回滚路径），而生效则是一次运行时动作（`reload()`）而非代码改动。插件中没有硬编码任何策略逻辑。

### 事例 3 —— 跨皮统一的 JWT 身份

**业务背景。** Token 集中签发；每个皮必须以相同方式校验它们、以相同方式映射 claim。

**配置 · 调用**

```js
const decode = identity.jwt({
  secret: process.env.JWT_SECRET,
  algorithm: 'HS256',      // 缺省
  header: 'authorization', // 缺省；接受 "Bearer <token>" 或裸 token
  userIdClaim: 'sub',      // 缺省
  rolesClaim: 'roles',     // 缺省
});
const restHook = identity.adapt('store-api', decode);
const grpcHook = identity.adapt('store-grpc', decode);
```

**结果。** 给定 claims `{ "sub": "u1", "roles": ["editor"] }`，解码器返回 `{ userId: 'u1', roles: ['editor'] }`；无 `roles` claim 时返回 `{ userId: 'u1', roles: [] }`。无凭证 ⇒ `null`。签名错或过期 ⇒ 一个普通 `Error`（消息如 `无效的 JWT 凭证: ...`，无 `ERR_` 前缀）。

**优势所在。** 一条校验路径、一套 claim 映射约定，在每个皮、两个运行端上完全一致地应用。关于「什么样的 token 算有效」，只有一处需要推理。

### 事例 4 —— 各皮身份源不同，收敛到同一个上下文

**业务背景。** 浏览器用 cookie session 调 REST，gRPC 调用方在 metadata 里发 API key，一个内部 GraphQL 服务发 bearer token。它们都必须为数据层裁决产出同一个 `{userId, roles}`。

**配置 · 调用**

```js
const sessionDecode = identity.session({ lookup: (sid) => sessions.lookup(sid) });  // 读 `cookie` 头 -> `sid`
const apiKeyDecode  = identity.apiKey({  lookup: (key) => keys.lookup(key) });      // 读 `x-api-key` 头/metadata
const jwtDecode     = identity.jwt({ secret: process.env.JWT_SECRET });             // 读 `authorization` 头/metadata

const restHook    = identity.adapt('store-api', sessionDecode);     // bag 取自 req.headers
const grpcHook    = identity.adapt('store-grpc', apiKeyDecode);     // bag 取自 call.metadata / invocation_metadata
const graphqlHook = identity.adapt('store-graphql', jwtDecode);     // bag 取自 {request, serverContext}.request.headers
```

**结果。** 每个适配器从自己的接缝提取一个小写、扁平的 bag（REST 取自 HTTP 头，gRPC 取自 RPC metadata，GraphQL 取自请求头）并交给解码器。无论走哪条 `lookup`/校验路径，输出都是同一契约：`{userId, roles}` 或 `null`。`lookup` 可为 async。

**优势所在。** 异构凭证源在边缘收敛，因此数据层永远只看到一种身份形状。更换某皮的凭证风格，只需改一行——把哪个解码器传给 `adapt`——下游契约岿然不动。

### 事例 5 —— `creator` 归属：「只看得到自己创建的行」

**业务背景。** 一个 `user` 角色应当能读写**仅**由它自己创建的订单，而无需任何逐皮的行过滤代码。

**配置 · 调用**（`rbac.json`）

```jsonc
{
  "policy": {
    "mode": "overlay",
    "roles": { "user": {} },
    "grants": [
      {
        "role": "user", "model": "Order",
        "actions": ["read", "update"],
        "readFields": ["_id", "amount"], "writeFields": ["amount"],
        "ownerOnly": true
      }
    ]
  },
  "exemptRoles": ["super_admin"],
  "denyWriteRoles": ["guest"],
  "unconfiguredPolicy": "open"
}
```

**结果。** 插件把 `policy` 对象原样搬运给 `setRbac`——它不知道也不关心 `ownerOnly` 是什么意思。rust-store 解析策略（快速失败），并对一条 `ownerOnly` grant 注入行条件 `{createdBy: userId}`；`userId` 缺失会使该条件恒为假。`creator` 伪角色由 rust-store 解析为 `doc.createdBy == ctx.userId`。

**优势所在。** 「仅自己的数据」**在策略中声明一次**，并在每个皮上统一执行——因为执行在 rust-store，而不在任何皮。引导插件拒绝解释 `ownerOnly` 是一种特性：不存在第二处行过滤可能偏离策略。

### 事例 6 —— 一次策略变更走过的路径

**业务背景。** 一份新的策略版本部署了；它必须干净生效，不留任何陈旧 grant。

**配置 · 调用**

```js
await handle.start();    // 初次安装
// ... 策略文件/配置更新 ...
await handle.reload();   // 先 setRbac(null)，再重读 + 重校验 + 重注册 + 重应用
```

**结果。** `reload()` 的首次调用是 `setRbac(null)`（显式清除，故没有旧 grant 幸存），随后它再跑一遍 `start()` 序列：重读源、重校验、幂等重注册 schema、按固定顺序重应用。schema 重注册是幂等的：第一次 `start()` 报告 `{ registered: ['RbacRole','RbacGrant'], skipped: [] }`，第二次 `start()` 报告 `{ registered: [], skipped: ['RbacRole','RbacGrant'] }`。

**优势所在。** 插件提供一个**受治理、清除优先**的重载机制，并让效果可观测（`registered` / `skipped`）。它刻意不拥有*何时*重载——文件监听、轮询或一次推送事件都由接入方定夺。

### 事例 7 —— 未配置策略时的行为边界

**业务背景。** RBAC 应当是可选的：一个尚未配置策略的环境，其行为必须与从前完全一致。

**配置 · 调用**

```js
const handle = policy.create(store, { source: async () => ({}) }); // 空配置
await handle.start();
```

**结果。** 空配置取全部缺省，故门面调用序列恰为：

```js
['setExemptRoles', []],
['setDenyWriteRoles', []],
['setUnconfiguredPolicy', 'open'],
['setRbac', null],
```

`setRbac(null)` 清除策略。在 rust-store 中，当没有策略被注入时，所有原语直通——行为与从前完全一致，即 RBAC 只会收紧，绝不放大既有权限。若你反而想让「无策略」意味着「关闭」，设 `"unconfiguredPolicy": "closed"`。

**优势所在。** 启用 RBAC 是一步安全、可选的举措：未配置态是显式且可配置的（`open` / `closed`），缺省不变，且配置错误绝不会静默地开或关任何东西。

## 定制化与扩展点

以下均取自两个实现，接入方可替换。

- **`source`** —— 任意返回对象（或其 promise）的无参函数。除 `file` / `url` / `db` 外，你也可传自己的（例如某个配置中心的包装器）。
- **`schemas`** —— 注入 `policy.schemas()`（参考定义）、你自己的定义，或 `null` / `false` 表示不注册任何表。两张参考表（每次调用深拷贝）：
  - `RbacRole` → 集合 `__rbac_roles`，字段 `_id`、`name`、`description`，`name` 唯一索引。
  - `RbacGrant` → 集合 `__rbac_grants`，字段 `_id`、`role`、`model`（精确 schema 名或 `*`）、`actions`（`["read","insert","update","remove"]`；`"write"` 在内核展开）、`readFields`、`writeFields`、`ownerOnly`、`condition`；到 `RbacRole` 的 `roleDef` 关系；`(role, model)` 唯一索引。
- **`identity.jwt` 选项** —— `algorithm`（HS256/HS384/HS512）、`header`、`userIdClaim` / `rolesClaim`（node）或 `user_id_claim` / `roles_claim`（py），让你对齐既有 token 格式。
- **`identity.apiKey` / `identity.session` 的 `lookup`** —— 凭证库由你掌握；回调可为 async，命中须返回 `{userId, roles}`，未命中返回 `null`。
- **`identity.adapt(skin, decode)`** —— `decode` 可以是*任何*遵循解码器契约的函数，不限于三个内置项。

## 边界与非目标

- **它不是授权引擎。** 它不做任何权限判定——那是内核（rust-store）。这是[第一条铁律](#三条铁律)，不是临时限制。
- **它不建表，也不定义业务 schema。** `opts.schemas` 只是把定义 `register` 进宿主 schema 注册表；不跑 DDL。业务实体 schema 属于业务上层。
- **它不发明错误码或状态码。** 见[错误映射](#错误映射)。
- **它不提供 watcher 或 timer。** 何时调用 `reload()` 由你定。
- **本期不提供策略管理面 / 管理 API。** 按设计推迟（§5）；既定路径是复用 store-api 在你所定义 schema 上自动生成的 CRUD 来搭建。
- **首期排除项**（暂不在范围内，不预留代码）：go 运行端（`store-api` go、`store-graphql` go）、`store-api` rust，以及 `store-mcp`（node 与 py）。这 5 条钩子与纳入的 6 条相对。

「排除」不等于「不支持」：纳入锚点是 go 生态成熟度（go）与 store-gateway 第四开关（`store-mcp`）。

## FAQ

1. **这个插件做权限判定吗？** 不。它把策略搬运给 `setRbac` 并产出 `{userId, roles}` 上下文；由 rust-store 裁决。
2. **没有凭证时，我拿到的是 `undefined` 还是 `null`？** 严格是 `null`（py `None`）。什么都不返回会绕开该皮的显式清空，所以适配器始终返回 `ctx | null`。
3. **无效凭证抛什么错误类？** 普通 `Error`（node）/ `ValueError`（py），消息为中文且无 `ERR_` 前缀。皮把它映射为 401 / `UNAUTHENTICATED`。
4. **我的 `lookup` 抛出一个宿主 `PermissionError`，插件会吞掉吗？** 不会。它原样传播，不做 `instanceof` 检查、不做包装。皮把它映射为 403 / `PERMISSION_DENIED`。
5. **支持哪些 JWT 算法？** 本期为 `HS256` / `HS384` / `HS512`。其他任何算法（如 `RS256`）在构造时抛错。
6. **插件会创建 `__rbac_*` 表吗？** 不会。`policy.schemas()` 返回的是可选参考*定义*；只有你经 `opts.schemas` 注入时才会被 `register` 进宿主注册表，且不触发 DDL。
7. **我必须传 `schemas` 吗？** 不必。缺省 `[]` → 不注册任何表。业务 schema 归你。
8. **它会监听策略文件吗？** 不会。没有 watcher 或 timer；由你自己的触发去调用 `reload()`。
9. **门面按什么顺序应用？** `setExemptRoles` → `setDenyWriteRoles` → `setUnconfiguredPolicy` → `setRbac`（策略最后）。
10. **`start()` 调用两次安全吗？** 安全——它是幂等的。对 schema 而言，第一轮 `registered`，之后轮次 `skipped`。
11. **它在运行时依赖 `nodejs-store` / `py-store` 吗？** 不依赖。宿主 store 由接入方传入；宿主包仅声明为可选 peer。
12. **我可以用自己的策略对象吗？** 可以。`source` 只是一个返回配置对象的函数；`policy` 的内容对插件不透明。

## 开发

```bash
# Node：单测 + conformance 用例
cd node && npm i && npm test          # 运行 `node --test`

# Python：单测 + conformance 用例
cd py && pip install -e ".[dev]" && pytest
```

流程：**spec 为唯一事实源** → 双端各自据其实现 → [`conformance/cases.json`](./conformance/cases.json) 由双端加载为共享对拍语料（禁止两端各自复制期望值）。Node 经 `require('../../conformance/cases.json')` 加载；py 经 `json.loads(... 'conformance' / 'cases.json')` 加载。

## 相关项目

- [store-api](../store-api) —— REST 皮
- [store-graphql](../store-graphql) —— GraphQL 皮
- [store-grpc](../store-grpc) —— gRPC 皮
- [store-gateway](../store-gateway) —— 多皮网关（本插件复刻其形态）
- [store-mcp](../store-mcp) —— MCP 皮（本期排除）
- [nodejs-store](../nodejs-store) —— node 宿主 store
- [py-store](../py-store) —— python 宿主 store
- [rust-store](../rust-store) —— 拥有权限裁决的数据层内核

## License

MIT —— 见 [LICENSE](./LICENSE)（Copyright (c) 2026 丁滔）。
