# store-rbac-bootstrap

common-store 数据层家族三层 API 皮肤（REST：[store-api](../store-api)；GraphQL：[store-graphql](../store-graphql)；gRPC：[store-grpc](../store-grpc)）的**可选 RBAC 引导插件**：

| 皮肤 | 包 | 接缝 |
|---|---|---|
| REST | store-api（node / py） | `contextProvider` / `context_provider` |
| GraphQL | store-graphql（node / py） | `contextFactory` / `context_provider` |
| gRPC | store-grpc（node / py） | `contextProvider` / `context_provider` |

> English: [README.md](./README.md)

## 1. 定位

插件只做两个映射，别的一概不做：

1. **策略引导** —— 读 bootstrap 配置 → 调宿主 store 既有 RBAC 配置门面（`setRbac` + 内置角色三配置面）；
2. **身份源适配** —— 把 JWT / API-Key / Session 凭证解码为 `{userId, roles}` → 挂到各皮既有 `contextProvider` 接缝。

三条铁律：**零判决、零语义发明、零回归**。插件不参与任何权限判定、不读取 / 解释策略内容（只搬运给 `setRbac`）、不发明错误前缀 / 状态码（只抛普通错误 / 返回 `null`）、不触碰任何兄弟仓库。唯一事实源是 [`spec/00-protocol.md`](./spec/00-protocol.md)。

## 2. 快速上手

### Node（`store-rbac-bootstrap-node`）

```js
const { init, store } = require('nodejs-store');       // 宿主 store（由接入方提供）
const { policy, identity } = require('store-rbac-bootstrap-node');

// 策略引导：读配置 → 应用到宿主门面（校验先于应用）
const handle = policy.create(store, { source: policy.file('./rbac.json') });
await handle.start();
// await handle.reload();  // 重读源并重应用（先 setRbac(null)）

// 身份源适配：凭证 → {userId, roles} → 皮接缝
const jwtHook = identity.adapt('store-api', identity.jwt({ secret: process.env.JWT_SECRET }));
const gw = await serve(store, { rest: { enabled: true, contextProvider: jwtHook } });
```

### Python（`store-rbac-bootstrap-py`）

```python
import asyncio
from py_store import init, store                        # 宿主 store（由接入方提供）
from store_rbac_bootstrap import policy, identity

async def main():
    handle = policy.create(store, policy.file("./rbac.json"))
    await handle.start()
    # await handle.reload()

    jwt_hook = identity.adapt("store-api", identity.jwt(secret=os.environ["JWT_SECRET"]))
    # 把 jwt_hook 作为 context_provider 传给 store-api-py / store-graphql-py，或作为 grpc 钩子

asyncio.run(main())
```

## 3. 配置形状

```jsonc
{
  "policy": { /* 对插件完全不透明；原样搬运给 setRbac */ },  // null / 缺省 ⇒ 清除策略
  "exemptRoles": ["super_admin"],          // 缺省 []
  "denyWriteRoles": ["guest"],             // 缺省 []
  "unconfiguredPolicy": "open"             // "open" | "closed"（仅小写），缺省 "open"
}
```

顶层仅允许上述四个键；出现未知键即配置错误（抛错，绝不静默忽略）。`policy` 内容对插件完全透明——不读 `mode` / `grants` / 角色名。完整契约见 [`spec/00-protocol.md`](./spec/00-protocol.md) §配置形状 / §引导规则。

## 4. 各皮各端钩子表（首期 6 条）

| 皮 · 运行端 | 钩子签名 | 首期 |
|---|---|---|
| store-api · node | `contextProvider(req)` | ✅ |
| store-api · py | `context_provider(request)`（awaitable） | ✅ |
| store-grpc · node | `contextProvider(call.metadata)` | ✅ |
| store-grpc · py | `context_provider(dict(invocation_metadata()))` | ✅ |
| store-graphql · node | `opts.contextFactory({ request, serverContext })` | ✅ |
| store-graphql · py | `context_provider(request)`（async） | ✅ |

签名跨皮、且皮内各端均不同构——工厂逐皮逐端适配（`identity.adapt(skin, decode)`），不存在「一套签名通用」。

## 5. 首期范围与不支持项

含：三层皮 × node / py 的策略引导 + 身份源适配。

首期明确**排除**（附依据）：

| 排除项 | 依据 |
|---|---|
| 管理面（二期，`__rbac_*` schema + 复用 store-api CRUD） | 设计 §5 —— 鸡生蛋；属增强非前置依赖 |
| go 端（store-api go / store-graphql go） | 设计 §6.3 |
| store-mcp（node / py） | 设计 §2.5 —— 锚在 gateway 第四开关 |
| store-api rust | 设计 §2.5 —— 首期仅 node / py |

「首期排除」≠「不支持」：纳入时机锚点为 go 生态成熟与 gateway 第四开关落地；首期**不预留代码**。

## 6. 开发与测试

```bash
node: cd node && npm i && npm test          # 单测 + conformance 用例
py:   cd py && pip install -e ".[dev]" && pytest   # 单测 + conformance 用例
```

流程：**spec 为唯一事实源** → 双端各自据其实现 → `conformance/cases.json` 由双端加载为共享对拍语料（禁止两端各自复制期望值）。
