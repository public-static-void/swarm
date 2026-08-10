import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

// Static guard for the tracked root README (issue-45 reframe, M4). The README
// sets the swarm architecture in stone: focused agents, labor subdivision,
// permissions limited by design (enforcement, not a gap), dispatch semantics
// (git operations always go to the Committer), role boundaries, plugin
// structural enforcement, and layer discipline. Guards the R045-reframe
// contract: the architecture is documented at the repo root in positive
// framing so dispatch correctness, not permission widening, is the fix for
// role-deviation incidents.

const README_PATH = join(process.cwd(), "README.md");

describe("README.md architecture documentation (R045-reframe)", () => {
  it("exists at the repo root as a tracked file", () => {
    expect(existsSync(README_PATH)).toBe(true);
  });

  it("documents the focused-agent concept", () => {
    const readme = readFileSync(README_PATH, "utf8");
    expect(readme).toContain("one responsibility per agent");
    expect(readme).toContain("Focused Agents");
  });

  it("documents the labor subdivision across the agent roster", () => {
    const readme = readFileSync(README_PATH, "utf8");
    expect(readme).toContain("Labor Subdivision");
    for (const role of ["Overseer", "Explorer", "Analyzer", "Artisan", "Inspector", "Committer"]) {
      expect(readme).toContain(role);
    }
  });

  it("documents role boundaries with no capability overlap", () => {
    const readme = readFileSync(README_PATH, "utf8");
    expect(readme).toContain("Explorer");
    expect(readme).toContain("exploration");
    expect(readme).toContain("Analyzer");
    expect(readme).toContain("root cause");
    expect(readme).toContain("no capability overlap");
  });

  it("documents that permissions are limited by design — enforcement, not a gap", () => {
    const readme = readFileSync(README_PATH, "utf8");
    expect(readme).toContain("limited by design");
    expect(readme).toContain("enforcement");
    expect(readme).toContain("not a gap");
  });

  it("documents the dispatch semantics for git operations and checkpoints", () => {
    const readme = readFileSync(README_PATH, "utf8");
    expect(readme).toContain("Git operations always go to the Committer");
    expect(readme).toContain("dispatches the Committer");
  });

  it("documents plugin structural enforcement", () => {
    const readme = readFileSync(README_PATH, "utf8");
    expect(readme).toContain("Plugins");
    expect(readme).toContain("structural");
  });

  it("documents the layer discipline of the configuration", () => {
    const readme = readFileSync(README_PATH, "utf8");
    expect(readme).toContain("AGENTS.md");
    expect(readme).toContain("agents/");
    expect(readme).toContain("skills/");
    expect(readme).toContain("plugins/");
    expect(readme).toContain("ground rules");
    expect(readme).toContain("agent-specific");
    expect(readme).toContain("domain knowledge");
    expect(readme).toContain("structural constraints");
  });

  it("documents the architecture in positive framing", () => {
    const readme = readFileSync(README_PATH, "utf8");
    expect(readme).toContain("positive framing");
  });
});
