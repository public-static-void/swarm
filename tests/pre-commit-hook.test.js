import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execFileSync } from "node:child_process";

// Static guards for the version-controlled pre-commit hook: the hook file
// exists at the committed path, is executable, invokes the repository gates,
// and fails the commit when a gate fails. The fail-closed check executes a
// stubbed copy of the hook so the real gates never run inside the suite.

const ROOT = process.cwd();
const HOOK_PATH = join(ROOT, ".githooks", "pre-commit");

describe("pre-commit hook", () => {
  it("exists at the version-controlled path and is executable", () => {
    const stat = statSync(HOOK_PATH);
    expect(stat.isFile()).toBe(true);
    expect(stat.mode & 0o111).not.toBe(0);
  });

  it("invokes the repository gates", () => {
    const hook = readFileSync(HOOK_PATH, "utf8");
    expect(hook).toContain("npx vitest run");
    expect(hook).toContain("npx eslint -c eslint.security.config.mjs");
  });

  it("exits non-zero when a gate fails", () => {
    const hook = readFileSync(HOOK_PATH, "utf8");
    const failingStubs = [
      hook
        .replace("npx vitest run", "false")
        .replace("npx eslint -c eslint.security.config.mjs", "true"),
      hook
        .replace("npx vitest run", "true")
        .replace("npx eslint -c eslint.security.config.mjs", "false"),
    ];
    for (const stubbed of failingStubs) {
      const dir = mkdtempSync(join(tmpdir(), "precommit-"));
      const stubPath = join(dir, "pre-commit");
      writeFileSync(stubPath, stubbed, { mode: 0o755 });
      try {
        expect(() => execFileSync(stubPath, { stdio: "pipe" })).toThrow();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("wires the hook through the prepare script", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    expect(pkg.scripts.prepare).toContain("core.hooksPath");
  });
});