import { describe, it, expect } from "vitest";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { readdirSync, readFileSync, existsSync } from "fs";

// Backfill integrity guard over the REAL swarm store (precedent:
// tests/config-guard.test.js). The three-tier isolation work backfilled
// scope onto every legacy entry (memory JSON) and issue (frontmatter);
// these static checks keep the invariant from silently regressing — a
// hand-edit or tooling bug that drops the scope field turns the suite red.
// Writes always go through memory_write/issue_write, which inject scope,
// so every legitimate new entry satisfies the same contract.

const CONFIG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const MEMORY_DIR = join(CONFIG_ROOT, "knowledge", "memory");
const ISSUES_DIR = join(CONFIG_ROOT, "knowledge", "issues");
const VALID_SCOPES = ["project", "generic", "swarm"];

describe("swarm store backfill integrity", () => {
  it("carries a valid scope field in every memory entry JSON", () => {
    const files = existsSync(MEMORY_DIR)
      ? readdirSync(MEMORY_DIR).filter(f => f.startsWith("entry-") && f.endsWith(".json"))
      : [];
    // Vacuous on a fresh clone (gitignored store) — the invariant guards
    // whatever data exists, not its volume.
    const missing = [];
    for (const f of files) {
      const entry = JSON.parse(readFileSync(join(MEMORY_DIR, f), "utf8"));
      if (!VALID_SCOPES.includes(entry.scope)) missing.push(`${f}: ${JSON.stringify(entry.scope)}`);
    }
    expect(missing).toEqual([]);
  });

  it("carries a scope field in every issue frontmatter", () => {
    const files = existsSync(ISSUES_DIR)
      ? readdirSync(ISSUES_DIR).filter(f => f.startsWith("issue-") && f.endsWith(".md"))
      : [];
    const missing = [];
    for (const f of files) {
      const raw = readFileSync(join(ISSUES_DIR, f), "utf8");
      const fm = raw.match(/^---\n([\s\S]*?)\n---/);
      const scopeLine = fm && fm[1].split("\n").find(l => /^scope:\s*/.test(l));
      const value = scopeLine && scopeLine.replace(/^scope:\s*/, "").trim();
      if (!VALID_SCOPES.includes(value)) missing.push(`${f}: ${value ?? "none"}`);
    }
    expect(missing).toEqual([]);
  });

  it("has a physical generic store directory under the config root", () => {
    expect(existsSync(join(CONFIG_ROOT, "knowledge", "generic"))).toBe(true);
  });
});
