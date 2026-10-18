# store-rbac-bootstrap

**Optional RBAC bootstrap plugin** for the skin layer of the common-store data-layer family (REST: [store-api](../store-api); GraphQL: [store-graphql](../store-graphql); gRPC: [store-grpc](../store-grpc)). It does exactly two things — install an RBAC policy onto the host store, and adapt each skin's identity source into a unified `{userId, roles}` context — and then hands **adjudication itself** to the data-layer core ([rust-store](../rust-store)). It never decides a permission on its own.

> 中文说明：[README.zh-CN.md](./README.zh-CN.md)

## Runtime and package matrix

This repository ships two isomorphic runtimes. They implement the same protocol and share one conformance corpus.

| Runtime | Package | Registry | Import | Min runtime |
|---|---|---|---|---|
| Node | `store-rbac-bootstrap-node` | npm | `require('store-rbac-bootstrap-node')` | Node >= 18 |
| Python | `store-rbac-bootstrap-py` | PyPI | `import store_rbac_bootstrap` | Python >= 3.10 |

Own dependencies: Node `jsonwebtoken ^9`; Python `PyJWT >= 2.8`. The host store (`nodejs-store >= 3.0.0` / `py-store >= 3.0.0`) is declared **only as an optional peer** — there is **no runtime dependency on the host**.

First-wave seams — 3 skins × 2 runtimes = **6 hooks**, each with a different signature:

| Skin | Runtime | Seam the returned hook fills |
|---|---|---|
| REST (store-api) | node | `contextProvider(req)` |
| REST (store-api) | py | `context_provider(request)` |
| gRPC (store-grpc) | node | `contextProvider(call.metadata)` |
| gRPC (store-grpc) | py | `context_provider(dict(invocation_metadata()))` |
| GraphQL (store-graphql) | node | `opts.contextFactory({ request, serverContext })` |
| GraphQL (store-graphql) | py | `context_provider(request)` |

## Table of contents

1. [What it is](#what-it-is)
2. [When to use / When NOT to use](#when-to-use--when-not-to-use)
3. [Installation](#installation)
4. [Quick start](#quick-start)
5. [Policy bootstrap](#policy-bootstrap)
6. [Identity adaptation](#identity-adaptation)
7. [Configuration reference](#configuration-reference)
8. [The three invariants](#the-three-invariants)
9. [Error mapping](#error-mapping)
10. [Scenario walkthroughs](#scenario-walkthroughs)
11. [Customization and extension points](#customization-and-extension-points)
12. [Boundaries and non-goals](#boundaries-and-non-goals)
13. [FAQ](#faq)
14. [Development](#development)
15. [Related projects](#related-projects)
16. [License](#license)

## What it is

`store-rbac-bootstrap` is shaped like [store-gateway](../store-gateway): it *reads configuration and hooks into pre-existing seams* of the skins. It performs only two mappings:

1. **Policy bootstrap** — read a bootstrap config and call the host store's **existing** RBAC facades (`setRbac` / `setExemptRoles` / `setDenyWriteRoles` / `setUnconfiguredPolicy`), and register the schema definitions **injected by the integrator** (`opts.schemas`, optional; by default no tables) into the host registry (`has` / `register`, idempotent).
2. **Identity-source adaptation** — decode JWT / API-Key / Session credentials into `{userId, roles}` and plug the result into each skin's existing `contextProvider` seam.

Everything it does not do is deliberate. It never reads or interprets the policy content, never invents an error prefix or status code, and never touches a sibling repository. The single source of truth is [`spec/00-protocol.md`](./spec/00-protocol.md) — every field name, value and signature below is taken from it and from the two implementations.

**Schema ownership is decoupled.** The library ships **no authoritative RBAC schema**. Business-entity schemas are entirely out of scope (defined by the upper business layer). The RBAC admin plane's *own* storage schemas (role table `__rbac_roles` / grant table `__rbac_grants`) are shipped **only as optional reference definitions** (`policy.schemas()`), and only get registered if the integrator injects them via `opts.schemas` (default `[]` → nothing is registered). The plugin **does not create tables** — it `register`s definitions into the host schema registry, no DDL is triggered.

### Relationship to the rust-store permission model

The plugin and rust-store are two halves of one permission story, split on a hard line:

- rust-store owns the **decision**. Its static engine evaluates a schema-level (`read` / `write`), field-level (`field.read` / `field.write`), relation-level (`relation.read`) and computed-column-level (`compute.read`) whitelist while a plan is built. Its dynamic RBAC engine reads the policy (`RbacPolicy`: `mode` / `roles` / `grants`) and a `Grant` is keyed by `role` / `model` / `actions` / `readFields` / `writeFields` / `ownerOnly` / `condition`.
- This plugin owns only the **inputs to that decision**: it carries the policy object verbatim to `setRbac(policy)`, and it produces the `{userId, roles}` context that rust-store consumes as `ctx`.
- The `creator` **pseudo-role** (resolved by rust-store as `doc.createdBy == ctx.userId`) and the `ownerOnly` grant flag (which injects a `{createdBy: userId}` row condition) are rust-store's own mechanisms. This plugin never inspects them — it only makes sure a truthful `userId` reaches `ctx`.

The reference schemas in `policy.schemas()` mirror the `Grant` model exactly (see [Customization](#customization-and-extension-points)); the full semantics live in rust-store and are not re-stated here.

## When to use / When NOT to use

**Use it when:**

- You expose the *same* data through more than one skin (REST + GraphQL + gRPC) and want **one** RBAC policy that takes effect everywhere, instead of re-writing authorization in each skin.
- You want the policy to be a **versioned artifact** (a JSON file, a URL, or a config-center value) that you can roll out without redeploying code.
- You want identity extraction (JWT / API-Key / cookie session) written **once**, with the same claim-mapping and the same "no credential → clear context" semantics across skins and runtimes.
- You need node and py to behave **identically**, backed by one shared conformance corpus.

**Do NOT use it when:**

- You want an authorization engine. This plugin makes no decision — that is rust-store's job.
- You need it to build tables or own your business schemas.
- You need an admin plane / management API for policies. That is deferred (design §5) and, in the intended design, is built by reusing store-api's auto-generated CRUD over schemas you define.
- You need a watcher/poller. The plugin ships none — you decide *when* to call `reload()`.
- You are on a go runtime, store-api rust, or store-mcp in this phase (see [Boundaries and non-goals](#boundaries-and-non-goals)).

## Installation

**Node**

```bash
npm i store-rbac-bootstrap-node
# optional peer, installed by the integrator as the host store:
npm i nodejs-store
```

**Python**

```bash
pip install store-rbac-bootstrap-py
# optional peer, installed by the integrator as the host store:
pip install py-store
```

## Quick start

### Node (`store-rbac-bootstrap-node`)

```js
const { policy, identity } = require('store-rbac-bootstrap-node');

// `store` is the host store instance (nodejs-store), created by the integrator.
// It must expose the four RBAC facades: setRbac / setExemptRoles /
// setDenyWriteRoles / setUnconfiguredPolicy.

// 1) Policy bootstrap: read config -> apply to the host facades (validation before application).
//    `schemas` is optional: inject the RBAC admin-plane reference definitions
//    (default registers no tables; schema is owned by the upper business layer).
const handle = policy.create(store, {
  source: policy.file('./rbac.json'),
  schemas: policy.schemas(),        // optional; or your own definitions, or omit
});
await handle.start();               // -> { registered: ['RbacRole', 'RbacGrant'], skipped: [] }
// await handle.reload();           // clear first (setRbac(null)), then re-read and re-apply

// 2) Identity adaptation: credential -> {userId, roles} -> the skin's seam.
const decode = identity.jwt({ secret: process.env.JWT_SECRET });
const restHook = identity.adapt('store-api', decode);   // (req) => Promise<ctx | null>
// pass restHook as store-api's contextProvider (see store-api/spec/04-context.md)
```

### Python (`store-rbac-bootstrap-py`)

```python
import asyncio, os
from store_rbac_bootstrap import policy, identity

# `store` is the host store instance (py-store), created by the integrator.
# It must expose the four facades: set_rbac / set_exempt_roles /
# set_deny_write_roles / set_unconfigured_policy.

async def main():
    handle = policy.create(store, policy.file("./rbac.json"), schemas=policy.schemas())
    await handle.start()
    # await handle.reload()

    decode = identity.jwt(secret=os.environ["JWT_SECRET"])
    rest_hook = identity.adapt("store-api", decode)   # async (request) => ctx | None
    # pass rest_hook as store-api-py's context_provider

asyncio.run(main())
```

## Policy bootstrap

Two entry families: the **policy sources** (which produce a config object) and **`policy.create`** (which installs it).

### Policy sources

Each of these returns a source function `() => object` (node) / a callable (py). Reading failures propagate unchanged — the plugin never swallows them.

| Entry | Signature | Behavior |
|---|---|---|
| `policy.file(path)` | node `file(path)`; py `file(path)` | Read a local file and `JSON.parse`/`json.loads` it. File missing or invalid JSON ⇒ throws. |
| `policy.url(url, opts)` | node `url(u, { headers } = {})`; py `url(u, headers=None)` | `fetch`/`urlopen` the remote policy service → JSON. Non-2xx or invalid JSON ⇒ throws. |
| `policy.db(loader)` | node `db(loader)`; py `db(loader)` | Wrap a DB / config-center loader: `loader: () => object \| Promise<object>`. |
| `policy.schemas()` | node `schemas()`; py `schemas()` | Return the optional reference RBAC admin-plane definitions (2 tables), **deep-copied** so callers cannot mutate the internal constant. |

### `policy.create(...)`

```js
// node
const handle = policy.create(store, { source, schemas });
```

```python
# python
handle = policy.create(store, source, schemas=None)
```

- `source` (required) — the product of one of the three policy sources (or any no-arg function returning an object / promise).
- `schemas` (optional, default `[]`) — the schema-definition **injection point**. An array (each entry an object with a non-empty string `name`), or `null` / `false` to register nothing. Node validates the option shape at construction; the host must additionally expose `has` / `register` **only when the effective set is non-empty** (this keeps older stores that only have the four RBAC facades working).

Returns a handle:

| Method | Behavior |
|---|---|
| `handle.start()` | Run the fixed boot sequence below; returns `{ registered: string[], skipped: string[] }`. |
| `handle.reload()` | Call `setRbac(null)` first, then re-run `start()` (re-read + re-validate + idempotent re-register + re-apply). |

### `start()` — fixed sequence (validation before application)

1. `config = await source()` — a read failure propagates **unchanged** (never caught, never skipped).
2. **Validate** `config`: must be a plain object; unknown top-level keys ⇒ error; each field checked against the [config shape](#configuration-reference) ⇒ any mismatch throws. **At this point zero facade calls have happened** — there is no half-applied state.
3. **Register schemas** from the effective `opts.schemas` set (`has` / `register` are **synchronous**, idempotent; default `[]` ⇒ this step is a no-op): `has(name)`? push to `skipped` : `register(defn)` and push to `registered`.
4. **Apply, in strict order**:
   1. `await store.setExemptRoles(config.exemptRoles ?? [])`
   2. `await store.setDenyWriteRoles(config.denyWriteRoles ?? [])`
   3. `await store.setUnconfiguredPolicy(config.unconfiguredPolicy ?? 'open')`
   4. `await store.setRbac(config.policy ?? null)` — the **policy takes effect last**.
5. Return `{ registered, skipped }` (observable — never silent).

`start()` / `reload()` are **idempotent**: calling them again simply re-applies. For schemas, the first round `registered`s, the second round `skipped`s them all.

The plugin ships **no watcher and no timer**. Change timing (file watch / polling / push-then-`reload()`) is the integrator's decision.

## Identity adaptation

### Decoders (skin-agnostic)

Each decoder takes a **bag** — a flat map with **lowercase** credential keys and string values (same-name multiples keep the first) — and returns a strict three-state result.

| Factory | Options (with defaults) | Semantics |
|---|---|---|
| `identity.jwt(opts)` (py `identity.jwt(secret, ...)`) | `secret` (required, non-empty), `algorithm` (default `'HS256'`, one of `HS256` / `HS384` / `HS512`), `header` (default `'authorization'`, accepts `Bearer <token>`), `userIdClaim` (default `'sub'`, py `user_id_claim`), `rolesClaim` (default `'roles'`, py `roles_claim`) | Verify signature + `exp`; on success → `{userId, roles}` (`roles` defaults to `[]`) |
| `identity.apiKey(opts)` (py `identity.api_key`) | `header` (default `'x-api-key'`), `lookup` (required, `(key) => {userId, roles} \| null`, may be async) | `lookup` hit → `{userId, roles}`; `null` → `null` |
| `identity.session(opts)` (py `identity.session`) | `cookie` (default `'sid'`), `lookup` (required, `(sid) => {userId, roles} \| null`, may be async) | Parse `<cookie>=<value>` from the `cookie` header; `lookup` hit → `{userId, roles}`; `null` → `null` |

### Decoder return contract (strict, node and py identical)

- **No credential** (header / cookie absent or empty) → return **`null`** / **`None`** — it *must* be `null`, never `undefined` / a missing return / an empty object. This is what triggers the skin's explicit "clear context" behavior.
- **Credential present but invalid** (bad signature / expired / no non-empty `userId`) → throw a **plain `Error`** (node) / **`ValueError`** (py) with a Chinese reason message and **no `ERR_` prefix**. No new prefix may be introduced.
- **Valid** → `{ userId: string, roles: string[] }`.

### `identity.adapt(skin, decode)` — per-skin adapters

Takes a skin name and a decoder, returns a hook whose signature matches that skin's seam. An unknown skin name throws at construction. The returned hook **always returns `ctx | null`** — on no credential it returns `null`, it never "returns nothing" (which would bypass the skin's explicit clear).

| Runtime | `skin` | Returned hook |
|---|---|---|
| node | `'store-api'` | `(req) => Promise<ctx \| null>` |
| node | `'store-grpc'` | `(metadata) => Promise<ctx \| null>` |
| node | `'store-graphql'` | `({ request, serverContext }) => Promise<ctx \| null>` |
| py | `'store-api'` | `async (request) => ctx \| None` |
| py | `'store-grpc'` | `async (invocation_metadata) => ctx \| None` |
| py | `'store-graphql'` | `async (request) => ctx \| None` |

### The 6 per-skin hooks (first wave)

Where each adapter reads its bag from, and the skin seam it fills:

| Skin · Runtime | Hook (the seam it fills) | Bag source | Purpose |
|---|---|---|---|
| store-api · node | `contextProvider(req)` | `req.headers` | Decode the REST request's credentials into ctx |
| store-api · py | `context_provider(request)` | `request.headers` | Same, as an awaitable provider |
| store-grpc · node | `contextProvider(call.metadata)` | `call.metadata` | Decode gRPC metadata into ctx |
| store-grpc · py | `context_provider(dict(invocation_metadata()))` | `invocation_metadata` | Same, from the RPC invocation metadata |
| store-graphql · node | `opts.contextFactory({ request, serverContext })` | `{request, serverContext}.request.headers` | Decode GraphQL request headers into ctx |
| store-graphql · py | `context_provider(request)` | `request.headers` | Same, as an awaitable provider |

Signatures differ **across skins and across runtimes within a skin** — the factory adapts per skin per runtime. There is no "one signature fits all".

## Configuration reference

The bootstrap config is one JSON object with **exactly four allowed top-level keys**. Any unknown key is a config error (throws — never silently ignored).

```jsonc
{
  "policy": { "mode": "overlay", "roles": {}, "grants": [] },  // optional; -> store.setRbac(policy). null/absent = clear policy
  "exemptRoles": ["super_admin"],                              // optional; default []. -> store.setExemptRoles(roles)
  "denyWriteRoles": ["guest"],                                 // optional; default []. -> store.setDenyWriteRoles(roles)
  "unconfiguredPolicy": "open"                                 // optional; default "open". in {"open","closed"} -> store.setUnconfiguredPolicy(v)
}
```

| Key | Allowed type / value | Default | Notes |
|---|---|---|---|
| `policy` | plain object \| `null` \| absent | `null` (clear) | Fully **opaque to the plugin** — it never reads `mode` / `grants` / role names; it is carried verbatim to `setRbac`. |
| `exemptRoles` | string array (each element a string) | `[]` | Applied as `setExemptRoles`. |
| `denyWriteRoles` | string array (each element a string) | `[]` | Applied as `setDenyWriteRoles`. |
| `unconfiguredPolicy` | `"open"` \| `"closed"` (**lowercase only**) | `"open"` | Applied as `setUnconfiguredPolicy`; any other value throws. |

### Constructor options (`policy.create`)

```jsonc
{
  "source": "<a policy source, see above>",                       // required
  "schemas": [ "<schema definition, see appendix A>" ]            // optional; default [] (register no tables)
}
```

| Field | Allowed type / value | Default | Notes |
|---|---|---|---|
| `source` | function `() => object \| Promise<object>` (py: callable) | none (required) | The product of one of the three policy sources. |
| `schemas` | array \| `null` \| `false` | `[]` | The **schema-definition injection point**. Array entries must be objects with a non-empty string `name`, applied in order via idempotent `has` / `register`. `null` / `false` / absent ⇒ register no tables. |

`policy.schemas()` returns the optional reference definitions (role table / grant table, **deep-copied**). The host must expose `has` / `register` **only when the effective schemas set is non-empty**.

## The three invariants

These three rules define the plugin's entire value: it is useful precisely because it refuses to do anything else.

1. **Zero adjudication (零判决).** The plugin never participates in any permission decision. It does not read or interpret policy content (`mode`, `grants`, role names, …) — it carries the config verbatim to the host facade. It does not inspect the context it decodes beyond producing `{userId, roles}`. The decision is made in core (rust-store).
2. **Zero semantic invention (零语义发明).** It invents no error prefix and no status code, and interprets no policy-content key. It throws a **plain `Error`** (py `ValueError`) with a Chinese message and no `ERR_` prefix, or returns **`null`** when there is no credential. Any status-code mapping (REST/GraphQL → 401, gRPC → `UNAUTHENTICATED`, etc.) belongs to the skins, not to this plugin.
3. **Zero regression (零回归).** It modifies no sibling repository — `store-api` / `store-grpc` / `store-graphql` / `store-mcp` / `store-gateway` / `nodejs-store` / `py-store` / `go-store` / `rust-store`. It is pure additive.

The corollary: upgrading host facades is a caller compatibility concern (an older store with only the four RBAC facades still works as long as you do not inject schemas).

## Error mapping

**This repository introduces no error codes of its own.** It defines no `ERR_` prefix, no status code, and no permission error class. Its conformance corpus machine-checks that none of the forbidden literals below ever appear in this repo's behavior:

```
ERR_PERMISSION, CONTEXT_ERROR, UNAUTHENTICATED, PERMISSION_DENIED, 401, 403
```

What the plugin actually does for each situation, and what the **skins' existing** behavior is (the plugin produces none of the status codes in the right column):

| Situation | Plugin behavior | Skin's existing mapping (plugin has zero status-code knowledge) |
|---|---|---|
| No credential | return `null` | Skin injects an empty context |
| Credential invalid / expired | throw plain `Error` / `ValueError` (message as-is) | REST / GraphQL → 401; gRPC → `UNAUTHENTICATED` |
| `lookup` callback throws a host `PermissionError` | propagate **as-is** (no `instanceof` check, no wrapping) | REST / GraphQL → 403; gRPC → `PERMISSION_DENIED` |
| Malformed policy JSON | not caught; core's `setRbac` throws at parse time and it surfaces at the injection point | injection point fails fast |

Config and construction errors thrown by this plugin are plain `Error` (node) / `ValueError` (py) whose message names the offending key or method, e.g. `引导配置含未知键: foo`, `引导配置 unconfiguredPolicy 只能是 "open" 或 "closed"`, `store 缺少门面方法: setDenyWriteRoles`, `identity.adapt 未知皮名: unknown`.

## Scenario walkthroughs

Seven scenarios that show *why* a single bootstrap plugin beats writing authorization into every skin by hand.

### Scenario 1 — One policy, three skins (define once, effective in three places)

**Business background.** An application exposes the same data through REST, GraphQL and gRPC. Each skin used to carry its own ad-hoc authorization glue; the team wants a single policy that governs all three, and a single way to tell "who is calling".

**Config / call**

```js
const { policy, identity } = require('store-rbac-bootstrap-node');

// 1) Install the policy once.
const handle = policy.create(store, {
  source: policy.file('./rbac.json'),
  schemas: policy.schemas(),
});
const { registered, skipped } = await handle.start();
// -> registered: ['RbacRole', 'RbacGrant'], skipped: []

// 2) One decoder, three skins.
const decode = identity.jwt({ secret: process.env.JWT_SECRET });
const restHook    = identity.adapt('store-api', decode);      // (req) => Promise<ctx|null>
const graphqlHook = identity.adapt('store-graphql', decode);  // ({request, serverContext}) => Promise<ctx|null>
const grpcHook    = identity.adapt('store-grpc', decode);     // (metadata) => Promise<ctx|null>
// wire each hook into that skin's existing seam
```

**Result.** `start()` calls the facades in the fixed order (`setExemptRoles`, `setDenyWriteRoles`, `setUnconfiguredPolicy`, then `setRbac` last) and installs the policy. Each `adapt` returns a hook with exactly that skin's signature; all three decode the same `{userId, roles}`. The plugin itself never reads the policy content — rust-store does.

**Advantage.** The policy is defined **once** and is effective in three places. There is no per-skin authorization code to keep in sync, and no per-skin divergence in how identity is extracted. Adding a fourth surface later is a wiring change, not a re-implementation.

### Scenario 2 — `policy.file` for a versioned, CI/CD-friendly policy

**Business background.** The policy must be reviewed, diffed and rolled back like code, but must not require a redeploy of the application to change.

**Config / call**

```js
const handle = policy.create(store, {
  source: policy.file('./rbac.json'),   // a file in the repo / a config artifact
  schemas: policy.schemas(),
});
await handle.start();

// after a new rbac.json is deployed:
await handle.reload();                   // 1st call: setRbac(null); then re-read + re-apply
```

**Result.** `policy.file(path)` returns a reader that reads and `JSON.parse`s the file. A missing file or invalid JSON throws (the failure propagates unchanged). After the file changes, `reload()` re-reads it; its **first** call is `setRbac(null)`, then the full boot sequence re-runs.

**Advantage.** The policy becomes a versioned artifact in the pipeline (same review/rollback path as code), while activation stays a runtime action (`reload()`) rather than a code change. There is no policy logic hard-coded in the plugin.

### Scenario 3 — JWT identity unified across skins

**Business background.** Tokens are issued centrally; every skin must verify them the same way and map claims the same way.

**Config / call**

```js
const decode = identity.jwt({
  secret: process.env.JWT_SECRET,
  algorithm: 'HS256',      // default
  header: 'authorization', // default; accepts "Bearer <token>" or a bare token
  userIdClaim: 'sub',      // default
  rolesClaim: 'roles',     // default
});
const restHook = identity.adapt('store-api', decode);
const grpcHook = identity.adapt('store-grpc', decode);
```

**Result.** Given claims `{ "sub": "u1", "roles": ["editor"] }`, the decoder returns `{ userId: 'u1', roles: ['editor'] }`; with no `roles` claim it returns `{ userId: 'u1', roles: [] }`. No credential ⇒ `null`. Bad signature or expired ⇒ a plain `Error` (message like `无效的 JWT 凭证: ...`, no `ERR_` prefix).

**Advantage.** One verification path and one claim-mapping convention, applied identically on every skin and in both runtimes. There is exactly one place to reason about "what a valid token is".

### Scenario 4 — Different identity sources per skin converge to one context

**Business background.** The browser calls REST with a cookie session, gRPC callers send an API key in metadata, and an internal GraphQL service sends a bearer token. All of them must produce the same `{userId, roles}` for the data layer to adjudicate.

**Config / call**

```js
const sessionDecode = identity.session({ lookup: (sid) => sessions.lookup(sid) });  // reads the `cookie` header -> `sid`
const apiKeyDecode  = identity.apiKey({  lookup: (key) => keys.lookup(key) });      // reads the `x-api-key` header/metadata
const jwtDecode     = identity.jwt({ secret: process.env.JWT_SECRET });             // reads the `authorization` header/metadata

const restHook    = identity.adapt('store-api', sessionDecode);     // bag from req.headers
const grpcHook    = identity.adapt('store-grpc', apiKeyDecode);     // bag from call.metadata / invocation_metadata
const graphqlHook = identity.adapt('store-graphql', jwtDecode);     // bag from {request, serverContext}.request.headers
```

**Result.** Each adapter extracts a lowercase, flat bag from its own seam (REST from HTTP headers, gRPC from RPC metadata, GraphQL from request headers) and hands it to the decoder. Whichever `lookup`/verification path is used, the output is the same contract: `{userId, roles}` or `null`. `lookup` may be async.

**Advantage.** Heterogeneous credential sources are converged at the edge, so the data layer only ever sees one identity shape. Swapping a skin's credential style is a one-line change to which decoder you pass to `adapt` — the downstream contract never moves.

### Scenario 5 — `creator` ownership: "see only the rows you created"

**Business background.** A `user` role should be able to read and update **only** the orders it created, without any per-skin row-filtering code.

**Config / call** (`rbac.json`)

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

**Result.** The plugin carries the `policy` object verbatim to `setRbac` — it does not know or care what `ownerOnly` means. rust-store parses the policy (fail-fast) and, for an `ownerOnly` grant, injects a row condition `{createdBy: userId}`; a `userId` that is missing makes the condition always false. The `creator` pseudo-role is resolved by rust-store as `doc.createdBy == ctx.userId`.

**Advantage.** "Own data only" is declared **once, in the policy**, and is enforced uniformly on every skin because enforcement lives in rust-store, not in any skin. The bootstrap plugin's refusal to interpret `ownerOnly` is a feature: there is no second place where row-filtering could drift from the policy.

### Scenario 6 — The path a policy change takes

**Business background.** A new policy version is deployed; it must take effect cleanly, with no stale grants left behind.

**Config / call**

```js
await handle.start();    // initial install
// ... policy file/config updated ...
await handle.reload();   // setRbac(null) first, then re-read + re-validate + re-register + re-apply
```

**Result.** `reload()`'s first call is `setRbac(null)` (explicit clear, so no old grants survive), then it runs the `start()` sequence again: re-read the source, re-validate, idempotently re-register schemas, and re-apply in the fixed order. Schema re-registration is idempotent: the first `start()` reports `{ registered: ['RbacRole','RbacGrant'], skipped: [] }`, a second `start()` reports `{ registered: [], skipped: ['RbacRole','RbacGrant'] }`.

**Advantage.** The plugin provides a **governed, clear-first** reload mechanism, and makes its effect observable (`registered` / `skipped`). It deliberately does not own *when* to reload — file watch, polling or a push event is the integrator's call.

### Scenario 7 — The behavior boundary when no policy is configured

**Business background.** RBAC should be opt-in: an environment that has not configured a policy must behave exactly as it did before.

**Config / call**

```js
const handle = policy.create(store, { source: async () => ({}) }); // empty config
await handle.start();
```

**Result.** An empty config takes all defaults, so the facade call sequence is exactly:

```js
['setExemptRoles', []],
['setDenyWriteRoles', []],
['setUnconfiguredPolicy', 'open'],
['setRbac', null],
```

`setRbac(null)` clears the policy. In rust-store, when no policy is injected, all primitives pass through — behavior is identical to before, i.e. RBAC only ever tightens, never amplifies existing permissions. If instead you want "no policy" to mean "closed", set `"unconfiguredPolicy": "closed"`.

**Advantage.** Enabling RBAC is a safe, opt-in step: the unconfigured posture is explicit and configurable (`open` / `closed`), the default is unchanged, and a misconfiguration never silently opens or closes anything.

## Customization and extension points

Everything below is taken from the implementations and can be replaced by the integrator.

- **`source`** — any no-arg function returning an object (or a promise of one). Besides `file` / `url` / `db`, you can pass your own (e.g. a wrapper over a config center).
- **`schemas`** — inject `policy.schemas()` (the reference definitions), your own definitions, or `null` / `false` to register nothing. The two reference tables (deep-copied each call):
  - `RbacRole` → collection `__rbac_roles`, fields `_id`, `name`, `description`, unique index on `name`.
  - `RbacGrant` → collection `__rbac_grants`, fields `_id`, `role`, `model` (exact schema name or `*`), `actions` (`["read","insert","update","remove"]`; `"write"` is expanded in core), `readFields`, `writeFields`, `ownerOnly`, `condition`; a `roleDef` relation to `RbacRole`; unique index on `(role, model)`.
- **`identity.jwt`** options — `algorithm` (HS256/HS384/HS512), `header`, `userIdClaim` / `rolesClaim` (node) or `user_id_claim` / `roles_claim` (py) let you match your existing token format.
- **`identity.apiKey` / `identity.session`** `lookup` — you own the credential store; the callback may be async and must return `{userId, roles}` on a hit or `null` on a miss.
- **`identity.adapt(skin, decode)`** — `decode` may be *any* function following the decoder contract, not only the three built-ins.

## Boundaries and non-goals

- **It is not an authorization engine.** It makes no permission decision — that is core (rust-store). This is the [first invariant](#the-three-invariants), not a temporary limitation.
- **It does not create tables or define business schemas.** `opts.schemas` only `register`s definitions into the host schema registry; no DDL runs. Business-entity schemas belong to the upper business layer.
- **It invents no error codes or status codes.** See [Error mapping](#error-mapping).
- **It ships no watcher or timer.** You decide when to call `reload()`.
- **It provides no policy admin plane / management API in this phase.** Deferred by design (§5); the intended path is to build it by reusing store-api's auto-generated CRUD over schemas you define.
- **First-wave exclusions** (out of scope for now, no code reserved): the go runtimes (`store-api` go, `store-graphql` go), `store-api` rust, and `store-mcp` (node and py). These are the 5 hooks excluded opposite the 6 included ones.

"Excluded" is not "unsupported": the inclusion anchors are go-ecosystem maturity (go) and the store-gateway fourth switch (`store-mcp`).

## FAQ

1. **Does this plugin make permission decisions?** No. It carries the policy to `setRbac` and produces the `{userId, roles}` context; rust-store decides.
2. **No credential present — do I get `undefined` or `null`?** Strict `null` (py `None`). Returning nothing would bypass the skin's explicit clear, so the adapters always return `ctx | null`.
3. **What error class for an invalid credential?** A plain `Error` (node) / `ValueError` (py) with a Chinese message and no `ERR_` prefix. The skin maps it to 401 / `UNAUTHENTICATED`.
4. **My `lookup` throws a host `PermissionError`. Does the plugin swallow it?** No. It propagates as-is, with no `instanceof` check and no wrapping. The skin maps it to 403 / `PERMISSION_DENIED`.
5. **Which JWT algorithms are supported?** `HS256` / `HS384` / `HS512` in this phase. Anything else (e.g. `RS256`) throws at construction.
6. **Does the plugin create the `__rbac_*` tables?** No. `policy.schemas()` returns optional reference *definitions*; they are only `register`ed into the host registry if you inject them via `opts.schemas`, and no DDL is triggered.
7. **Do I have to pass `schemas`?** No. The default is `[]` → registers nothing. Business schemas are yours.
8. **Does it watch the policy file?** No. There is no watcher or timer; call `reload()` from your own trigger.
9. **In what order are the facades applied?** `setExemptRoles` → `setDenyWriteRoles` → `setUnconfiguredPolicy` → `setRbac` (policy last).
10. **Is it safe to call `start()` twice?** Yes — it is idempotent. For schemas, the first round `registered`s, later rounds `skipped`.
11. **Does it depend on `nodejs-store` / `py-store` at runtime?** No. The host store is passed in by the integrator; the host package is declared only as an optional peer.
12. **Can I use my own policy objects?** Yes. `source` is just a function returning the config object; `policy`'s content is opaque to the plugin.

## Development

```bash
# Node: unit tests + conformance cases
cd node && npm i && npm test          # runs `node --test`

# Python: unit tests + conformance cases
cd py && pip install -e ".[dev]" && pytest
```

Pipeline: **the spec is the single source of truth** → both runtimes implement from it → [`conformance/cases.json`](./conformance/cases.json) is loaded by both runtimes as a shared parity corpus (no per-runtime duplicated expectations). Node loads it via `require('../../conformance/cases.json')`; py via `json.loads(... 'conformance' / 'cases.json')`.

## Related projects

- [store-api](../store-api) — REST skin
- [store-graphql](../store-graphql) — GraphQL skin
- [store-grpc](../store-grpc) — gRPC skin
- [store-gateway](../store-gateway) — multi-skin gateway (the shape this plugin mirrors)
- [store-mcp](../store-mcp) — MCP skin (excluded in this phase)
- [nodejs-store](../nodejs-store) — node host store
- [py-store](../py-store) — python host store
- [rust-store](../rust-store) — the data-layer core that owns the permission decision

## License

MIT — see [LICENSE](./LICENSE) (Copyright (c) 2026 丁滔).
