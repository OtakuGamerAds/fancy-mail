import { describe, expect, it } from "vitest";

import { sameScope, scopeOf, scopeQuery, toggleScopeItem, viewQuery, type ViewScope } from "./views.ts";

describe("scopes", () => {
  it("adds and takes out groups and accounts, down to one and to everything", () => {
    let scope: ViewScope = { type: "all" };
    scope = toggleScopeItem(scope, { type: "group", id: "g1" });
    expect(scope).toEqual({ type: "group", groupId: "g1" });
    scope = toggleScopeItem(scope, { type: "account", id: "a1" });
    expect(scope).toEqual({ type: "set", groupIds: ["g1"], accountIds: ["a1"] });
    scope = toggleScopeItem(scope, { type: "group", id: "g1" });
    expect(scope).toEqual({ type: "account", accountId: "a1" });
    scope = toggleScopeItem(scope, { type: "account", id: "a1" });
    expect(scope).toEqual({ type: "all" });
  });

  it("asks for any of a set's groups and accounts", () => {
    const scope = scopeOf([
      { type: "group", id: "g1" },
      { type: "group", id: "g2" },
      { type: "account", id: "a1" },
    ]);
    expect(scopeQuery(scope)).toBe("group:g1 group:g2 account:a1");
    expect(viewQuery({ kind: "label", labelId: "l1", scope })).toBe("label:l1 group:g1 group:g2 account:a1");
  });

  it("compares sets whatever their order", () => {
    const a = scopeOf([{ type: "group", id: "g1" }, { type: "account", id: "a1" }]);
    const b = scopeOf([{ type: "account", id: "a1" }, { type: "group", id: "g1" }]);
    expect(sameScope(a, b)).toBe(true);
    expect(sameScope(a, { type: "group", groupId: "g1" })).toBe(false);
  });
});
