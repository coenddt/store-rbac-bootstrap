# store-rbac-bootstrap

Optional **RBAC bootstrap plugin** for the three API skins of the common-store data-layer family (REST: [store-api](../store-api); GraphQL: [store-graphql](../store-graphql); gRPC: [store-grpc](../store-grpc)):

| Skin | Package | Seam |
|---|---|---|
| REST | store-api (node / py) | `contextProvider` / `context_provider` |
| GraphQL | store-graphql (node / py) | `contextFactory` / `context_provider` |
| gRPC | store-grpc (node / py) | `contextProvider` / `context_provider` |

> 中文说明：[README.zh-CN.md](./README.zh-CN.md)

## 1. Positioning

The plugin does exactly two mappings and nothing else:

1. **Policy bootstrap** — read a bootstrap config and call the host store's existing RBAC facades (`setRbac` + the built-in role-rule configs);
2. **Identity-source adaptation** — decode JWT / API-Key / Session credentials into `{userId, roles}` and plug them into each skin's existing `contextProvider` seam.

Three invariants: **zero adjudication**, **zero semantic invention**, **zero regression**. The plugin never decides permissions, never reads/interprets policy content (it only carries it to `setRbac`), never invents error prefixes or status codes (it throws plain errors / returns `null`), and never touches any sibling repository. The single source of truth is [`spec/00-protocol.md`](./spec/00-protocol.md).

## 2. Quick start

### Node (`store-rbac-bootstrap-node`)

```js
const { init, store } = require('nodejs-store');       // host store (provided by the integrator)
const { policy, identity } = require('store-rbac-bootstrap-node');

// policy bootstrap: read config → apply to the host facades (validation before application)
const handle = policy.create(store, { source: policy.file('./rbac.json') });
await handle.start();
// await handle.reload();  // re-read the source and re-apply (setRbac(null) first)

// identity adaptation: credential → {userId, roles} → skin seam
const jwtHook = identity.adapt('store-api', identity.jwt({ secret: process.env.JWT_SECRET }));
const gw = await serve(store, { rest: { enabled: true, contextProvider: jwtHook } });
```

### Python (`store-rbac-bootstrap-py`)

```python
import asyncio
from py_store import init, store                        # host store (provided by the integrator)
from store_rbac_bootstrap import policy, identity

async def main():
    handle = policy.create(store, policy.file("./rbac.json"))
    await handle.start()
    # await handle.reload()

    jwt_hook = identity.adapt("store-api", identity.jwt(secret=os.environ["JWT_SECRET"]))
    # pass jwt_hook as context_provider to store-api-py / store-graphql-py, or as the grpc hook

asyncio.run(main())
```

## 3. Config shape

```jsonc
{
  "policy": { /* opaque to the plugin; carried verbatim to setRbac */ },  // null / absent ⇒ clear policy
  "exemptRoles": ["super_admin"],          // default []
  "denyWriteRoles": ["guest"],             // default []
  "unconfiguredPolicy": "open"             // "open" | "closed" (lowercase only), default "open"
}
```

Only the four top-level keys above are allowed; any unknown key is a config error (throws, never silently ignored). `policy` content is fully opaque — the plugin never reads `mode` / `grants` / role names. See [`spec/00-protocol.md`](./spec/00-protocol.md) §Configuration / §Bootstrap rules for the full contract.

## 4. Per-skin hook table (first wave: 6)

| Skin · Runtime | Hook signature | First wave |
|---|---|---|
| store-api · node | `contextProvider(req)` | ✅ |
| store-api · py | `context_provider(request)` (awaitable) | ✅ |
| store-grpc · node | `contextProvider(call.metadata)` | ✅ |
| store-grpc · py | `context_provider(dict(invocation_metadata()))` | ✅ |
| store-graphql · node | `opts.contextFactory({ request, serverContext })` | ✅ |
| store-graphql · py | `context_provider(request)` (async) | ✅ |

Signatures differ across skins and runtimes — the factory adapts per skin per runtime (`identity.adapt(skin, decode)`); there is no "one signature fits all".

## 5. First-wave scope and exclusions

Included: policy bootstrap + identity-source adaptation for the three skins × node / py.

Explicitly **excluded** in this phase (with rationale):

| Excluded | Rationale |
|---|---|
| Admin plane (2nd phase, `__rbac_*` schemas + store-api CRUD) | design §5 — chicken-and-egg; an enhancement, not a prerequisite |
| go runtimes (store-api go / store-graphql go) | design §6.3 |
| store-mcp (node / py) | design §2.5 — anchored on the gateway's fourth switch |
| store-api rust | design §2.5 — first wave is node / py only |

"Excluded" is not "unsupported": inclusion anchors are the go ecosystem maturity and the gateway's fourth switch; no code is reserved in this phase.

## 6. Development and testing

```bash
node: cd node && npm i && npm test          # unit + conformance cases
py:   cd py && pip install -e ".[dev]" && pytest   # unit + conformance cases
```

Pipeline: **spec is the single source of truth** → both runtimes implement from it → `conformance/cases.json` is loaded by both runtimes as the shared parity corpus (no per-runtime duplicated expectations).
