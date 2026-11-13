import { describe, expect, it } from "vitest";

// @ts-expect-error -- a plain .mjs script, no types
import { mergeUpdateManifests, parseUpdateManifest, serializeUpdateManifest } from "./update-manifest.mjs";

// What electron-builder writes for each Mac architecture.
const ARM64 = `version: 0.1.21
files:
  - url: Fancy-Mail-0.1.21-arm64.zip
    sha512: aaa==
    size: 101
    blockMapSize: 11
path: Fancy-Mail-0.1.21-arm64.zip
sha512: aaa==
releaseDate: '2026-11-13T10:00:00.000Z'
`;
const X64 = `version: 0.1.21
files:
  - url: Fancy-Mail-0.1.21-x64.zip
    sha512: bbb==
    size: 202
path: Fancy-Mail-0.1.21-x64.zip
sha512: bbb==
releaseDate: '2026-11-13T10:05:00.000Z'
`;

describe("update manifests", () => {
  it("merges the two Mac builds into one latest-mac.yml", () => {
    const merged = mergeUpdateManifests(parseUpdateManifest(ARM64), parseUpdateManifest(X64));
    expect(merged.version).toBe("0.1.21");
    expect(merged.releaseDate).toBe("2026-11-13T10:05:00.000Z");
    expect(merged.files.map((f: { url: string }) => f.url)).toEqual(["Fancy-Mail-0.1.21-arm64.zip", "Fancy-Mail-0.1.21-x64.zip"]);
    const text = serializeUpdateManifest(merged);
    expect(text).toBe(`version: '0.1.21'
files:
  - url: Fancy-Mail-0.1.21-arm64.zip
    sha512: aaa==
    size: 101
    blockMapSize: 11
  - url: Fancy-Mail-0.1.21-x64.zip
    sha512: bbb==
    size: 202
releaseDate: '2026-11-13T10:05:00.000Z'
`);
    // What it writes reads back the same.
    expect(parseUpdateManifest(text)).toEqual(merged);
  });

  it("refuses manifests of different versions", () => {
    expect(() => mergeUpdateManifests(parseUpdateManifest(ARM64), parseUpdateManifest(X64.replace(/0\.1\.21/g, "0.1.22")))).toThrow(/different versions/);
  });

  it("refuses the same file listed twice with different contents", () => {
    const other = ARM64.replace("aaa==\n    size: 101", "ccc==\n    size: 101");
    expect(() => mergeUpdateManifests(parseUpdateManifest(ARM64), parseUpdateManifest(other))).toThrow(/differently/);
  });

  it("rejects a manifest without files", () => {
    expect(() => parseUpdateManifest("version: 0.1.21\nreleaseDate: '2026-11-13'\n")).toThrow(/no files/);
  });
});
