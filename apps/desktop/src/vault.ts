/**
 * The key for the credentials vault: 32 random bytes the server uses for AES-256-GCM.
 *
 * Installed app: stored as <dataDir>/vault-key.bin, encrypted with the operating system's
 * key store (safeStorage: DPAPI on Windows, the Keychain on macOS), so a copy of the data folder alone does not
 * reveal any password. Without safeStorage the app refuses to start rather than keep the key
 * in plain text.
 *
 * Development: <repo>/.dev-data/vault.key in plain base64, the same file the server uses on its
 * own, so `pnpm dev` and `pnpm dev:browser` can read each other's (test) credentials.
 *
 * An existing key is never replaced: if it cannot be read, the start fails with a clear
 * message, because a new key would make every saved password unreadable.
 */
import { safeStorage } from "electron";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export class VaultKeyError extends Error {
  override name = "VaultKeyError";
}

function decodeKey(base64: string, source: string): Buffer {
  const key = Buffer.from(base64.trim(), "base64");
  if (key.length !== 32) throw new VaultKeyError(`${source} does not hold a valid key.`);
  return key;
}

/** Writes through a temp file so a crash never leaves half a key behind. */
function writeAtomically(file: string, data: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, data, { mode: 0o600 });
  fs.renameSync(temp, file);
}

export function loadProtectedKey(dataDir: string): { key: Buffer; created: boolean } {
  const file = path.join(dataDir, "vault-key.bin");
  if (!safeStorage.isEncryptionAvailable()) {
    throw new VaultKeyError(
      "Fancy Mail can't use Windows' protected storage, so it can't keep your passwords safe. Sign in to Windows normally (not a temporary profile) and start Fancy Mail again.",
    );
  }
  if (fs.existsSync(file)) {
    let base64: string;
    try {
      base64 = safeStorage.decryptString(fs.readFileSync(file));
    } catch {
      throw new VaultKeyError(
        `Fancy Mail can't unlock its saved passwords (${file}). This happens when the data folder was copied from another Windows user or computer. Your mail is untouched.`,
      );
    }
    return { key: decodeKey(base64, file), created: false };
  }
  const key = crypto.randomBytes(32);
  writeAtomically(file, safeStorage.encryptString(key.toString("base64")));
  return { key, created: true };
}

export function loadDevKey(dataDir: string): { key: Buffer; created: boolean } {
  const file = path.join(dataDir, "vault.key");
  if (fs.existsSync(file)) return { key: decodeKey(fs.readFileSync(file, "utf8"), file), created: false };
  const key = crypto.randomBytes(32);
  writeAtomically(file, key.toString("base64"));
  return { key, created: true };
}
