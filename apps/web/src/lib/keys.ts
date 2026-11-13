/**
 * The modifier key and how shortcuts read, per platform, after T3 Code's keybindings
 * (packages/shared/src/keybindingMatching.ts and apps/web/src/keybindings.ts, MIT License —
 * see THIRD_PARTY_LICENSE_T3CODE.txt): "mod" is ⌘ on a Mac and Ctrl elsewhere, and a Mac
 * shows the symbols in Apple's order (⌃⌥⇧⌘), with no "+".
 *
 * Shortcuts are written once, the Windows way ("Ctrl+Shift+S"), and shown through these.
 */
import { isMacPlatform } from "./utils";

export const IS_MAC = typeof navigator !== "undefined" && isMacPlatform(navigator.platform);

/** The shortcut modifier is down: ⌘ on a Mac, Ctrl elsewhere (Ctrl on a Mac is its own key). */
export function isModKey(event: { ctrlKey: boolean; metaKey: boolean }, mac = IS_MAC): boolean {
  return mac ? event.metaKey : event.ctrlKey;
}

const MAC_MODIFIERS: Record<string, string> = { Ctrl: "⌘", Alt: "⌥", Shift: "⇧" };
const MAC_ORDER = ["⌃", "⌥", "⇧", "⌘"];

/** ["Ctrl", "Shift", "S"] → ["⇧", "⌘", "S"] on a Mac; unchanged elsewhere. */
export function shortcutKeys(keys: readonly string[], mac = IS_MAC): string[] {
  if (!mac) return [...keys];
  const modifiers = keys.filter((k) => k in MAC_MODIFIERS).map((k) => MAC_MODIFIERS[k]!);
  modifiers.sort((a, b) => MAC_ORDER.indexOf(a) - MAC_ORDER.indexOf(b));
  return [...modifiers, ...keys.filter((k) => !(k in MAC_MODIFIERS))];
}

/** "Ctrl+Shift+S" (or "Ctrl ,") → "⇧⌘S" on a Mac; unchanged elsewhere. */
export function shortcutLabel(text: string, mac = IS_MAC): string {
  if (!mac) return text;
  const keys = text.split(/[+ ](?=.)/).filter(Boolean);
  return shortcutKeys(keys, true).join("");
}
