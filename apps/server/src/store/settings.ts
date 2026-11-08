import { DEFAULT_SETTINGS, Settings } from "@fancy-mail/contracts";

import { parseJson } from "../db/sqlite.ts";
import type { Db } from "../db/sqlite.ts";

/** Settings live as one row per top-level key; missing keys fall back to the defaults. */
export function createSettingsStore(db: Db) {
  return {
    get(): Settings {
      const stored: Record<string, unknown> = {};
      for (const row of db.all<{ key: string; value: string }>("SELECT key, value FROM settings")) {
        stored[row.key] = parseJson<unknown>(row.value, undefined);
      }
      const merged: Record<string, unknown> = { ...DEFAULT_SETTINGS };
      for (const [key, value] of Object.entries(stored)) {
        if (!(key in DEFAULT_SETTINGS) || value === undefined) continue;
        const fallback = (DEFAULT_SETTINGS as Record<string, unknown>)[key];
        merged[key] =
          fallback && typeof fallback === "object" && !Array.isArray(fallback) && value && typeof value === "object"
            ? { ...fallback, ...value }
            : value;
      }
      const parsed = Settings.safeParse(merged);
      return parsed.success ? parsed.data : DEFAULT_SETTINGS;
    },

    set(patch: Partial<Settings>): void {
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        db.run(
          "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          key,
          JSON.stringify(value),
        );
      }
    },
  };
}

export type SettingsStore = ReturnType<typeof createSettingsStore>;

/** Small values that are not settings (the MCP token, the demo seed marker, …). */
export function createKvStore(db: Db) {
  return {
    get(key: string): string | null {
      return db.value<string>("SELECT value FROM kv WHERE key = ?", key) ?? null;
    },
    set(key: string, value: string): void {
      db.run("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
    },
    delete(key: string): void {
      db.run("DELETE FROM kv WHERE key = ?", key);
    },
  };
}

export type KvStore = ReturnType<typeof createKvStore>;
