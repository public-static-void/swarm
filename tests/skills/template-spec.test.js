import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// Static guard for SPEC-template git hygiene (issue-43, R043-01/03, AC43-01/02/08/09).
// Issue-43 root cause: a SPEC acceptance criterion demanded git-diff evidence
// for gitignored knowledge/ artifacts — impossible without `git add -f` — so the
// SPEC template itself sanctioned force-adds (issue-42 incident). These
// assertions lock the corrected template: acceptance criteria for gitignored
// artifacts verify from disk (read/glob/grep), staging guidance is positive
// (stage only intended tracked files), AGENTS.md documents the tracked set, and
// the AC template never demands git-diff/staged-state evidence.

const BOILERPLATE = "Acceptance criteria for gitignored artifacts (`knowledge/`, `knowledge/issues/`, `knowledge/memory/`) are verified from disk via `read`/`glob`/`grep`. Stage only intended tracked files; use the standard git workflow. Rewrite any AC that cannot be verified from disk so it verifies from disk.";

describe("template-spec git hygiene (issue-43, R043-01/03)", () => {
  const skill = readFileSync(join(process.cwd(), "skills", "template-spec", "SKILL.md"), "utf8");
  const agents = readFileSync(join(process.cwd(), "AGENTS.md"), "utf8");
  const gitignore = readFileSync(join(process.cwd(), ".gitignore"), "utf8");

  it("contains the disk-verification + staging boilerplate after the AC checkbox list (AC43-01)", () => {
    expect(skill).toContain(BOILERPLATE);
  });

  it("requires no git-diff/staged-state evidence in the AC template (AC43-09)", () => {
    const acSection = skill.slice(skill.indexOf("## Acceptance Criteria"));
    expect(acSection).not.toContain("git diff");
    expect(acSection).not.toContain("staged");
  });

  it("documents the tracked-set ground rule in AGENTS.md (AC43-02)", () => {
    expect(agents).toContain("git tracks swarm config only: AGENTS.md, agents/, skills/, plugins/, tests/, commands/, opencode.json. knowledge/ is workflow meta and stays gitignored.");
  });

  it("keeps knowledge/ gitignored in .gitignore (AC43-08)", () => {
    expect(gitignore.split("\n")).toContain("knowledge/");
  });
});
