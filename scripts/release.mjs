#!/usr/bin/env node
// Publish a new version to GitHub Releases; installed apps pick it up through their update button.
//   1. Bump "version" in the five package.json files (e.g. 0.1.0 -> 0.1.1) and commit.
//   2. pnpm release
// It tags the commit (vX.Y.Z) and pushes it. The tag starts .github/workflows/release.yml on
// GitHub, which checks the code, builds Windows and macOS (a Mac build needs a Mac), checks that
// each app starts, and publishes the release with every file installed apps need. This script
// waits for that run and checks the files on the release. It is safe to run again: a run that
// failed is tried again (its failed jobs), one that passed is only checked.
import { execSync, spawnSync } from "node:child_process";

import { ROOT, fail, rootVersion } from "./lib.mjs";

const REPO = "OtakuGamerAds/fancy-mail";
const WORKFLOW = "release.yml";
const version = rootVersion();
const tag = `v${version}`;

const sh = (command) => execSync(command, { cwd: ROOT, encoding: "utf8" }).trim();
const run = (command) => execSync(command, { cwd: ROOT, stdio: "inherit" });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (sh("git status --porcelain")) fail("Commit your changes before releasing.");
if (sh("git branch --show-current") !== "main") fail("Release from the main branch.");
try {
  if (!sh("gh auth token")) throw new Error();
} catch {
  fail("Sign in with `gh auth login` first.");
}

// A published GitHub release must point at an existing tag.
const head = sh("git rev-parse HEAD");
if (!sh(`git tag --list ${tag}`)) run(`git tag ${tag}`);
else if (sh(`git rev-list -n 1 ${tag}`) !== head) fail(`${tag} already exists on another commit. Bump the version first.`);
run(`git push origin main ${tag}`);

/** The workflow run the tag started (it shows up a few seconds after the push). */
async function findRun() {
  for (let i = 0; i < 40; i++) {
    const runs = JSON.parse(sh(`gh run list --repo ${REPO} --workflow ${WORKFLOW} --limit 30 --json databaseId,headBranch,headSha,event,status,conclusion`));
    const found = runs.find((r) => r.headBranch === tag && r.headSha === head && r.event === "push");
    if (found) return found;
    await sleep(3000);
  }
  fail(`No ${WORKFLOW} run started for ${tag}. See https://github.com/${REPO}/actions`);
}

const found = await findRun();
const url = `https://github.com/${REPO}/actions/runs/${found.databaseId}`;
if (found.status === "completed" && found.conclusion !== "success") {
  console.log(`\nThe last run for ${tag} ended with "${found.conclusion}": trying its failed jobs again.`);
  run(`gh run rerun ${found.databaseId} --repo ${REPO} --failed`);
  await sleep(5000);
}
console.log(`\nBuilding Windows and macOS on GitHub: ${url}\n`);
const watched = spawnSync("gh", ["run", "watch", String(found.databaseId), "--repo", REPO, "--exit-status", "--interval", "30"], { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32" });
if (watched.status !== 0) fail(`The release run failed: ${url}\nSee what failed with: gh run view ${found.databaseId} --repo ${REPO} --log-failed`);

// The files installed apps and new users need, on the published release.
const expected = [
  `Fancy-Mail-Setup-${version}.exe`,
  `Fancy-Mail-Setup-${version}.exe.blockmap`,
  "latest.yml",
  `Fancy-Mail-${version}-arm64.dmg`,
  `Fancy-Mail-${version}-arm64.zip`,
  `Fancy-Mail-${version}-x64.dmg`,
  `Fancy-Mail-${version}-x64.zip`,
  "latest-mac.yml",
];
const release = JSON.parse(sh(`gh release view ${tag} --repo ${REPO} --json assets,isDraft`));
if (release.isDraft) fail(`${tag} is still a draft: ${url}`);
const assets = release.assets.map((a) => a.name);
for (const name of expected) if (!assets.includes(name)) fail(`${name} is missing from the ${tag} release`);
console.log(`\nPublished ${tag}: ${assets.join(", ")}`);
console.log(`Feeds: https://github.com/${REPO}/releases/latest/download/latest.yml and …/latest-mac.yml`);
