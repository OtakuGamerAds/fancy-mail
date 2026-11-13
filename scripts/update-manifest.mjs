#!/usr/bin/env node
// Merges two electron-updater manifests of the same version into one, from T3 Code's
// scripts/lib/update-manifest.ts and scripts/merge-update-manifests.ts (MIT License — see
// THIRD_PARTY_LICENSE_T3CODE.txt).
//
// The Mac builds run per architecture and each writes its own latest-mac.yml; the installed
// app reads one, and picks the file whose name carries its architecture (arm64 or x64). So:
//
//   node scripts/update-manifest.mjs merge <primary.yml> <secondary.yml> [<out.yml>]
//
// writes both files' entries into <out.yml> (default: <primary.yml>).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function unquote(value) {
  const trimmed = value.trim();
  return trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'") ? trimmed.slice(1, -1).replace(/''/g, "'") : trimmed;
}

function scalar(raw) {
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) return unquote(trimmed);
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

/** latest*.yml (the shape electron-builder writes) → { version, releaseDate, files, extras }. */
export function parseUpdateManifest(raw, source = "manifest") {
  const files = [];
  const extras = {};
  let version = null;
  let releaseDate = null;
  let current = null;
  const finish = (line) => {
    if (!current) return;
    if (typeof current.url !== "string" || typeof current.sha512 !== "string" || typeof current.size !== "number") {
      throw new Error(`${source}:${line}: a file entry is incomplete.`);
    }
    files.push(current);
    current = null;
  };

  raw.split(/\r?\n/).forEach((rawLine, index) => {
    const lineNumber = index + 1;
    const line = rawLine.trimEnd();
    if (!line) return;
    const url = line.match(/^ {2}- url:\s*(.+)$/);
    if (url) {
      finish(lineNumber);
      current = { url: unquote(url[1]) };
      return;
    }
    const sha = line.match(/^ {4}sha512:\s*(.+)$/);
    if (sha) {
      if (!current) throw new Error(`${source}:${lineNumber}: sha512 outside a file entry.`);
      current.sha512 = unquote(sha[1]);
      return;
    }
    const size = line.match(/^ {4}size:\s*(\d+)$/);
    if (size) {
      if (!current) throw new Error(`${source}:${lineNumber}: size outside a file entry.`);
      current.size = Number(size[1]);
      return;
    }
    // Other keys of the entry (blockMapSize…) are kept as they are.
    const more = line.match(/^ {4}([A-Za-z][A-Za-z0-9]*):\s*(.+)$/);
    if (more && current) {
      current.more = { ...current.more, [more[1]]: scalar(more[2]) };
      return;
    }
    if (line === "files:") return;
    finish(lineNumber);
    const top = line.match(/^([A-Za-z][A-Za-z0-9]*):\s*(.+)$/);
    if (!top) throw new Error(`${source}:${lineNumber}: unexpected line "${line}".`);
    const [, key, value] = top;
    if (key === "version") version = String(scalar(value));
    else if (key === "releaseDate") releaseDate = String(scalar(value));
    // path and sha512 at the top describe the first file only (an old electron-updater fallback).
    else if (key !== "path" && key !== "sha512") extras[key] = scalar(value);
  });
  finish(raw.split(/\r?\n/).length);

  if (!version) throw new Error(`${source}: no version.`);
  if (!releaseDate) throw new Error(`${source}: no releaseDate.`);
  if (files.length === 0) throw new Error(`${source}: no files.`);
  return { version, releaseDate, files, extras };
}

/** Both manifests' files in one; the versions must match, and a file listed in both must be the same file. */
export function mergeUpdateManifests(primary, secondary) {
  if (primary.version !== secondary.version) {
    throw new Error(`Can't merge manifests of different versions (${primary.version} and ${secondary.version}).`);
  }
  const files = new Map();
  for (const file of [...primary.files, ...secondary.files]) {
    const seen = files.get(file.url);
    if (seen && (seen.sha512 !== file.sha512 || seen.size !== file.size)) throw new Error(`Both manifests list ${file.url}, differently.`);
    files.set(file.url, file);
  }
  const extras = { ...primary.extras };
  for (const [key, value] of Object.entries(secondary.extras)) {
    if (key in extras && extras[key] !== value) throw new Error(`Both manifests set ${key}, differently.`);
    extras[key] = value;
  }
  return {
    version: primary.version,
    releaseDate: primary.releaseDate >= secondary.releaseDate ? primary.releaseDate : secondary.releaseDate,
    files: [...files.values()],
    extras,
  };
}

const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;

export function serializeUpdateManifest(manifest) {
  const lines = [`version: ${quote(manifest.version)}`, "files:"];
  for (const file of manifest.files) {
    lines.push(`  - url: ${file.url}`, `    sha512: ${file.sha512}`, `    size: ${file.size}`);
    for (const [key, value] of Object.entries(file.more ?? {})) lines.push(`    ${key}: ${value}`);
  }
  for (const key of Object.keys(manifest.extras).sort()) {
    const value = manifest.extras[key];
    lines.push(`${key}: ${typeof value === "string" ? quote(value) : String(value)}`);
  }
  lines.push(`releaseDate: ${quote(manifest.releaseDate)}`, "");
  return lines.join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === "merge") {
  const [primaryPath, secondaryPath, outPath = primaryPath] = process.argv.slice(3);
  if (!primaryPath || !secondaryPath) {
    console.error("Usage: node scripts/update-manifest.mjs merge <primary.yml> <secondary.yml> [<out.yml>]");
    process.exit(1);
  }
  const read = (file) => parseUpdateManifest(fs.readFileSync(file, "utf8"), path.basename(file));
  const merged = mergeUpdateManifests(read(primaryPath), read(secondaryPath));
  fs.writeFileSync(outPath, serializeUpdateManifest(merged));
  console.log(`Merged ${path.basename(secondaryPath)} into ${path.basename(outPath)}: ${merged.files.map((f) => f.url).join(", ")}`);
}
