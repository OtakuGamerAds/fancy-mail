/**
 * The key for the credentials vault: 32 random bytes the server uses for AES-256-GCM.
 *
 * Installed app, Windows: <dataDir>/vault-key.bin, encrypted with DPAPI (safeStorage). Any
 * program of this Windows user can unlock it; a copy of the data folder alone reveals nothing.
 *
 * Installed app, macOS: in the login Keychain, written and read through Apple's own
 * /usr/bin/security tool. The protection is Windows': encrypted under the user's login, out of
 * the data folder. Through safeStorage instead, macOS would tie the Keychain's permission to the
 * app's exact build (an app without an Apple Team ID gets no other kind), so every update asked
 * for the Mac's password again; the security tool never changes. A key kept the old way
 * (vault-key.bin, safeStorage) moves there on the first start: macOS asks one last time.
 *
 * Without the key store the app refuses to start rather than keep the key in plain text.
 *
 * Development: <repo>/.dev-data/vault.key in plain base64, the same file the server uses on its
 * own, so `pnpm dev` and `pnpm dev:browser` can read each other's (test) credentials.
 *
 * An existing key is never replaced: if it cannot be read, the start fails with a clear
 * message, because a new key would make every saved password unreadable.
 */
import { safeStorage } from "electron";
import { spawnSync } from "node:child_process";
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

// ── macOS: the login Keychain through /usr/bin/security ──────────────────────────────────────

const SECURITY = "/usr/bin/security";
const KEYCHAIN_SERVICE = "Fancy Mail vault key";
const KEYCHAIN_ACCOUNT = "vault";

/** The key in the Keychain, null when there is none yet. */
function readMacKeychainKey(): string | null {
  const result = spawnSync(SECURITY, ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"], { encoding: "utf8", timeout: 20_000 });
  if (result.status === 0) return result.stdout.trim();
  if (result.status === 44) return null; // errSecItemNotFound
  throw new VaultKeyError(`Fancy Mail couldn't read its key from the macOS Keychain (${(result.stderr || result.error?.message || "").trim()}). Your mail is untouched.`);
}

/** Stores the key (through stdin, so it never shows in a process list) and reads it back. */
function writeMacKeychainKey(base64: string): void {
  if (!/^[A-Za-z0-9+/=]+$/.test(base64)) throw new VaultKeyError("The vault key isn't base64.");
  const result = spawnSync(SECURITY, ["-i"], {
    input: `add-generic-password -U -s "${KEYCHAIN_SERVICE}" -a ${KEYCHAIN_ACCOUNT} -l "Fancy Mail" -D "application password" -w ${base64}\n`,
    encoding: "utf8",
    timeout: 20_000,
  });
  if (result.status !== 0 || readMacKeychainKey() !== base64) {
    throw new VaultKeyError(`Fancy Mail couldn't save its key in the macOS Keychain (${(result.stderr || result.error?.message || "").trim()}).`);
  }
}

function loadMacKey(dataDir: string): { key: Buffer; created: boolean } {
  const stored = readMacKeychainKey();
  if (stored) return { key: decodeKey(stored, "The Keychain item"), created: false };
  const legacy = path.join(dataDir, "vault-key.bin");
  if (fs.existsSync(legacy)) {
    // Kept the old way: unlock it once more (macOS may ask), move it, forget the file.
    let base64: string;
    try {
      base64 = safeStorage.decryptString(fs.readFileSync(legacy));
    } catch {
      throw new VaultKeyError(
        "Fancy Mail can't unlock its saved passwords: macOS didn't let it read its key in the Keychain. Open Fancy Mail again and, when macOS asks, enter the password you sign in to this Mac with. Your mail is untouched.",
      );
    }
    const key = decodeKey(base64, legacy);
    writeMacKeychainKey(key.toString("base64"));
    fs.rmSync(legacy, { force: true });
    return { key, created: false };
  }
  const key = crypto.randomBytes(32);
  writeMacKeychainKey(key.toString("base64"));
  return { key, created: true };
}

export function loadProtectedKey(dataDir: string): { key: Buffer; created: boolean } {
  if (process.platform === "darwin") return loadMacKey(dataDir);
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
