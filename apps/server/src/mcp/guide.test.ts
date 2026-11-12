import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { McpInfo } from "@fancy-mail/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { CONNECTION_FILE, createAgentGuide, displayPath, GUIDE_FILE } from "./guide.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fancy-mail-guide-test-"));
  dirs.push(root);
  const info: McpInfo = { enabled: true, url: "http://127.0.0.1:47821/mcp", token: "fm_secret_token", guidePath: "", clients: [] };
  const warnings: string[] = [];
  const guide = createAgentGuide({ dir: path.join(root, "agent"), info: () => info, log: { warn: (m) => warnings.push(m) } });
  const read = (file: string) => fs.readFileSync(path.join(root, "agent", file), "utf8");
  const has = (file: string) => fs.existsSync(path.join(root, "agent", file));
  return { info, guide, read, has, warnings };
}

describe("the agent folder", () => {
  it("has the playbook without the token, and the connection beside it", () => {
    const { guide, read, warnings } = setup();
    guide.write();
    expect(read(GUIDE_FILE)).toContain("mail_overview");
    expect(read(GUIDE_FILE)).not.toContain("fm_");
    const connection = JSON.parse(read(CONNECTION_FILE));
    expect(connection).toEqual({
      url: "http://127.0.0.1:47821/mcp",
      token: "fm_secret_token",
      server: { type: "http", url: "http://127.0.0.1:47821/mcp", headers: { Authorization: "Bearer fm_secret_token" } },
    });
    expect(warnings).toEqual([]);
  });

  it("follows a new token and port, and drops the connection while agents are off", () => {
    const { info, guide, read, has } = setup();
    guide.write();
    info.token = "fm_new";
    info.url = "http://127.0.0.1:47822/mcp";
    guide.write();
    expect(JSON.parse(read(CONNECTION_FILE))).toMatchObject({ url: "http://127.0.0.1:47822/mcp", token: "fm_new" });
    info.enabled = false;
    guide.write();
    expect(has(CONNECTION_FILE)).toBe(false);
    expect(has(GUIDE_FILE)).toBe(true);
  });

  it("shows the path with the home folder as ~ and forward slashes", () => {
    const home = path.join(os.tmpdir(), "home-x");
    expect(displayPath(path.join(home, "AppData", "Roaming", "Fancy Mail", "agent", "README.md"), home)).toBe("~/AppData/Roaming/Fancy Mail/agent/README.md");
    const outside = path.join(os.tmpdir(), "elsewhere", "README.md");
    expect(displayPath(outside, home)).toBe(outside.replaceAll("\\", "/"));
  });
});
