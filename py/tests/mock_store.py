"""内存记录器：记录门面调用序列 [("set_rbac", v), ...]（snake_case 门面）；另记 schema 注入点 has/register。"""


class MockStore:
    def __init__(self):
        self.calls = []                                     # [("set_rbac", v), ...]
        self.known_schemas = set()
        self.registered_schemas = []                        # 已 register 的 schema 名（按序）

    def set_rbac(self, v):
        self.calls.append(("set_rbac", v))

    def set_exempt_roles(self, v):
        self.calls.append(("set_exempt_roles", v))

    def set_deny_write_roles(self, v):
        self.calls.append(("set_deny_write_roles", v))

    def set_unconfigured_policy(self, v):
        self.calls.append(("set_unconfigured_policy", v))

    def has(self, name):
        return name in self.known_schemas

    def register(self, defn):
        self.known_schemas.add(defn["name"])
        self.registered_schemas.append(defn["name"])
