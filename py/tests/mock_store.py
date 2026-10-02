"""内存记录器：记录门面调用序列 [("set_rbac", v), ...]（snake_case 门面）。"""


class MockStore:
    def __init__(self):
        self.calls = []                                     # [("set_rbac", v), ...]

    def set_rbac(self, v):
        self.calls.append(("set_rbac", v))

    def set_exempt_roles(self, v):
        self.calls.append(("set_exempt_roles", v))

    def set_deny_write_roles(self, v):
        self.calls.append(("set_deny_write_roles", v))

    def set_unconfigured_policy(self, v):
        self.calls.append(("set_unconfigured_policy", v))
