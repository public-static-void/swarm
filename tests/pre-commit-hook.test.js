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
    if (process.platform === "win32") {
      // The Windows filesystem cannot express the POSIX exec bit; the git
      // index mode is the portable record of the hook's executability and is
      // what makes POSIX checkouts (and git's own hook runner) see it.
      const entry = execFileSync("git", ["ls-files", "-s", "--", ".githooks/pre-commit"], {
        cwd: ROOT,
        encoding: "utf8",
      }).trim();
      expect(entry.split(" ")[0]).toBe("100755");
    } else {
      expect(stat.mode & 0o111).not.toBe(0);
    }
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

  // The stubbed hook is an sh script run by its shebang; Windows has no
  // shebang interpreter, so the spawn itself is POSIX-only. Both stub-runner
  // cases skip there — the non-zero-exit case would otherwise pass vacuously
  // on a spawn ENOENT rather than on a failing gate.
  it.skipIf(process.platform === "win32")("executes every repository gate it declares", () => {
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

  it.skipIf(process.platform === "win32")("exits non-zero when any gate slot fails", () => {
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