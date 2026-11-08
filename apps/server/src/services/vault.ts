/**
 * Credentials at rest: AES-256-GCM with the 32-byte vault key (from the OS keychain via the
 * desktop shell, or <dataDir>/vault.key in dev). Plaintext never leaves this module except as
 * the return value of `get`.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import type { Db } from "../db/sqlite.ts";

export type SecretKind = "password" | "oauth-refresh" | (string & {});

export interface Vault {
  put(accountId: string, kind: SecretKind, plaintext: string): void;
  /** null when missing or when it cannot be decrypted (wrong key). */
  get(accountId: string, kind: SecretKind): string | null;
  delete(accountId: string, kind?: SecretKind): void;
  has(accountId: string, kind: SecretKind): boolean;
}

export function createVault(db: Db, key: Buffer): Vault {
  if (key.length !== 32) throw new Error("The vault key must be 32 bytes.");
  return {
    put(accountId, kind, plaintext) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(`${accountId}:${kind}`, "utf8"));
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      db.run(
        `INSERT INTO secrets (account_id, kind, ciphertext, iv, tag, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id, kind) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv,
           tag = excluded.tag, updated_at = excluded.updated_at`,
        accountId,
        kind,
        ciphertext,
        iv,
        tag,
        Date.now(),
      );
    },
    get(accountId, kind) {
      const row = db.get<{ ciphertext: Uint8Array; iv: Uint8Array; tag: Uint8Array }>(
        "SELECT ciphertext, iv, tag FROM secrets WHERE account_id = ? AND kind = ?",
        accountId,
        kind,
      );
      if (!row) return null;
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(row.iv));
        decipher.setAAD(Buffer.from(`${accountId}:${kind}`, "utf8"));
        decipher.setAuthTag(Buffer.from(row.tag));
        return Buffer.concat([decipher.update(Buffer.from(row.ciphertext)), decipher.final()]).toString("utf8");
      } catch {
        return null;
      }
    },
    delete(accountId, kind) {
      if (kind) db.run("DELETE FROM secrets WHERE account_id = ? AND kind = ?", accountId, kind);
      else db.run("DELETE FROM secrets WHERE account_id = ?", accountId);
    },
    has(accountId, kind) {
      return db.value("SELECT 1 FROM secrets WHERE account_id = ? AND kind = ?", accountId, kind) !== undefined;
    },
  };
}
