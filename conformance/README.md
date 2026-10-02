# conformance —— 双端一致性用例

`cases.json` 是 **node 与 py 两端共享的同一份**一致性用例（parity 税的可执行形态）。两端测试各自加载本文件，**不各自复制期望值常量**。

## 加载方式

- node：`node/test/conformance.test.js` → `require('../../conformance/cases.json')`
- py：`py/tests/test_conformance.py` → `json.loads(Path(__file__).parents[2] / 'conformance' / 'cases.json')`

## 字段含义

| 字段 | 含义 |
|---|---|
| `facades.node` / `facades.py` | 两端门面方法名（camelCase ↔ snake_case），供调用序列断言取各自分支 |
| `skins.first_wave` | 首期实现的 6 条钩子（三层皮 × node / py），`{node, py}` 给出各自签名形态 |
| `skins.excluded` | 首期排除的 5 条（`皮:端` 枚举），供机器核对首期范围不漂移 |
| `config.full` / `config.defaults` | 引导配置输入 → 期望门面调用序列（逐位相等） |
| `config.unknown_key` / `bad_*` | 非法配置 → 期望抛错（`error_contains` 有则断言消息）+ 零门面调用（`expected_call_count`） |
| `reload.expected_first_call` | `reload()` 首调用（清除前置），`{node, py}` 各分支 |
| `identity.null_clear` | 三解码器在空 bag 下须严格返回 `null` / `None` |
| `identity.jwt_payload` / `jwt_roles_default` | token claims → 期望 `{userId, roles}`（`roles` 缺省 `[]`） |
| `identity.invalid.error_class` | 无效凭证的错误类（`Error` / `ValueError`），且不得为宿主权限类 |
| `identity.bag_lowercase` | HTTP 头大小写归一为小写 bag 键 |
| `identity.metas` | 各皮取 bag 的位置 |
| `identity.unknown_skin` | 未知皮名 → 构造期抛错 |
| `machine_checks` | 供 04-步骤 5 机检脚本读取（`forbidden_literals` / `forbidden_policy_keys`），单一事实源，避免脚本与用例两处维护 |

## 双端差异约定

同一 case 的期望值逐字一致；仅「错误类 `Error`↔`ValueError`、门面名 camelCase↔snake_case、`null`↔`None`」等以 `{node, py}` 对象表达。函数型场景（`lookup` / JWT 验签）由各端测试以内联回调 / 本地签发承载，本文件只固化期望值。

## 新增 case 约定

1. **先改本文件**（`cases.json`），再改两端测试加载执行——同「先改 spec」铁律；
2. 禁止只更新一端而不同步本文件；
3. 双端可表达为数据的新增场景一律进本文件；无法数据化的（回调行为）在两端测试内以同形逻辑承载，并在本文件对应段留注释说明。
