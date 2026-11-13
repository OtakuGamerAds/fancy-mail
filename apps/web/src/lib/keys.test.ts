import { describe, expect, it } from "vitest";

import { isModKey, shortcutKeys, shortcutLabel } from "./keys";

describe("shortcuts per platform", () => {
  it("reads ⌘ on a Mac, in Apple's order", () => {
    expect(shortcutLabel("Ctrl+Shift+S", true)).toBe("⇧⌘S");
    expect(shortcutLabel("Ctrl+,", true)).toBe("⌘,");
    expect(shortcutLabel("Ctrl ,", true)).toBe("⌘,");
    expect(shortcutLabel("Ctrl+Enter", true)).toBe("⌘Enter");
    expect(shortcutKeys(["Ctrl", "Shift", "P"], true)).toEqual(["⇧", "⌘", "P"]);
    expect(shortcutKeys(["G", "I"], true)).toEqual(["G", "I"]);
  });

  it("stays as written elsewhere", () => {
    expect(shortcutLabel("Ctrl+Shift+S", false)).toBe("Ctrl+Shift+S");
    expect(shortcutKeys(["Ctrl", "K"], false)).toEqual(["Ctrl", "K"]);
  });

  it("takes ⌘ as the modifier on a Mac and Ctrl elsewhere", () => {
    expect(isModKey({ ctrlKey: false, metaKey: true }, true)).toBe(true);
    expect(isModKey({ ctrlKey: true, metaKey: false }, true)).toBe(false);
    expect(isModKey({ ctrlKey: true, metaKey: false }, false)).toBe(true);
    expect(isModKey({ ctrlKey: false, metaKey: true }, false)).toBe(false);
  });
});
