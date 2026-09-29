import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, statSync, existsSync } from "fs";
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

  // Gate identity is run-verified, never string-pinned: every declared gate
  // line is stubbed to announce itself, and the stub must print the mark.
  function gateLines() {
    const hook = readFileSync(HOOK_PATH, "utf8");
    return hook
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#") && !l.startsWith("set "));
  }

  function runStub(stubbed) {
    const dir = mkdtempSync(join(tmpdir(), "precommit-"));
    const stubPath = join(dir, "pre-commit");
    writeFileSync(stubPath, stubbed, { mode: 0o755 });
    try {
      return execFileSync(stubPath, { encoding: "utf8" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  function runStubExpectThrow(stubbed) {
    const dir = mkdtempSync(join(tmpdir(), "precommit-"));
    const stubPath = join(dir, "pre-commit");
    writeFileSync(stubPath, stubbed, { mode: 0o755 });
    try {
      expect(() => execFileSync(stubPath, { stdio: "pipe" })).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("executes every repository gate it declares", () => {
    const hook = readFileSync(HOOK_PATH, "utf8");
    const lines = gateLines();
    expect(lines.length).toBeGreaterThanOrEqual(2);
    lines.forEach((line, i) => {
      const stubbed = hook
        .split("\n")
        .map((l) => {
          const t = l.trim();
          if (t === line) return `echo GATE_${i}_RAN`;
          if (t && !t.startsWith("#") && !t.startsWith("set ")) return "true";
          return l;
        })
        .join("\n");
      expect(runStub(stubbed)).toContain(`GATE_${i}_RAN`);
    });
  });

  it("exits non-zero when any gate slot fails", () => {
    const hook = readFileSync(HOOK_PATH, "utf8");
    const lines = gateLines();
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const failing of lines) {
      const stubbed = hook
        .split("\n")
        .map((l) => (l.trim() === failing ? "false" : l.trim() === "" || l.trim().startsWith("#") || l.trim().startsWith("set ") ? l : "true"))
        .join("\n");
      runStubExpectThrow(stubbed);
    }
  });

  it("wires the version-controlled hook dir through the prepare script", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const prepare = pkg.scripts.prepare;
    expect(prepare).toContain("hooksPath");
    const dirToken = prepare.split("hooksPath")[1].trim().split(/\s+/)[0];
    expect(existsSync(join(ROOT, dirToken, "pre-commit"))).toBe(true);
  });
});