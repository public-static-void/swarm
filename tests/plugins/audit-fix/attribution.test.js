import { describe, it, expect, beforeEach } from "vitest";
import {
  adviseDenial,
  clearAttributionCache,
  loadAgentShellAllowlist,
  parseAgentShellAllowlist,
} from "../../../plugins/protocol-gate/attribution.js";

// Denial attribution reads the calling agent's shell allowlist straight from
// its agent definition file, so feedback names the exact denied stage and
// the allowlisted variants that share its prefix.

const nonEmptyLineCount = (message) =>
  message.split("\n").filter((line) => line.trim().length > 0).length;

function realPatterns(agent) {
  const loaded = loadAgentShellAllowlist(agent);
  expect(loaded.patterns).not.toBeNull();
  return loaded.patterns;
}

beforeEach(() => {
  clearAttributionCache();
});

describe("calling-agent allowlist loading", () => {
  it("loads both make variants for the builder role", () => {
    const patterns = realPatterns("artisan");
    expect(patterns).toContain("make test*");
    expect(patterns).toContain("make build*");
  });

  it("loads the test-only make variant for the analysis role", () => {
    const patterns = realPatterns("analyzer");
    expect(patterns).toContain("make test*");
    expect(patterns).not.toContain("make build*");
  });

  it("finds no make variants for the exploration role", () => {
    const patterns = realPatterns("explorer");
    expect(patterns.filter((entry) => entry.startsWith("make"))).toEqual([]);
  });

  it("finds no file-read shell for the commit role", () => {
    const patterns = realPatterns("committer");
    expect(
      patterns.filter((entry) =>
        ["cat", "head", "tail", "wc"].some((prefix) =>
          entry.startsWith(prefix)
        )
      )
    ).toEqual([]);
  });

  it("reports an unknown agent as unreadable instead of guessing entries", () => {
    const loaded = loadAgentShellAllowlist("no-such-agent");
    expect(loaded.patterns).toBeNull();
    expect(loaded.reason.length).toBeGreaterThan(0);
  });

  it("keeps allow-effect entries and drops deny-effect entries", () => {
    const patterns = parseAgentShellAllowlist(
      [
        "---",
        "request:",
        "  permissions:",
        '    - action: shell\n      resource: "make test*"\n      effect: allow',
        '    - action: shell\n      resource: "make lint*"\n      effect: deny',
        '    - action: read\n      resource: "*"\n      effect: allow',
        "---",
      ].join("\n")
    );
    expect(patterns).toEqual(["make test*"]);
  });
});

describe("make-target denial feedback", () => {
  it("names the denied builder target with both variants and a concrete retry", () => {
    const advice = adviseDenial({
      agent: "artisan",
      rawCommand: "make lint",
      patterns: realPatterns("artisan"),
    });
    expect(advice.allowed).toBe(false);
    expect(advice.result.deniedSegments).toEqual(["make lint"]);
    expect(advice.result.deniedPrefix).toBe("make");
    expect(advice.result.fallbackUsed).toBe(false);
    expect(advice.message).toContain("`make lint`");
    expect(advice.message).toContain("make test*");
    expect(advice.message).toContain("make build*");
    expect(advice.message).toContain("`make test`");
    expect(advice.message).toContain("this target only");
    expect(nonEmptyLineCount(advice.message)).toBeLessThanOrEqual(5);
  });

  it("offers the analysis role its single test variant and nothing else", () => {
    const advice = adviseDenial({
      agent: "analyzer",
      rawCommand: "make build",
      patterns: realPatterns("analyzer"),
    });
    expect(advice.allowed).toBe(false);
    expect(advice.message).toContain("`make build`");
    expect(advice.message).toContain("make test*");
    expect(advice.message).not.toContain("make build*");
    expect(nonEmptyLineCount(advice.message)).toBeLessThanOrEqual(5);
  });

  it("tells the exploration role no make variants exist and routes the work", () => {
    const advice = adviseDenial({
      agent: "explorer",
      rawCommand: "make test",
      patterns: realPatterns("explorer"),
    });
    expect(advice.allowed).toBe(false);
    expect(advice.message).toContain("none");
    expect(advice.message).toContain("artisan");
    expect(advice.result.suggestedRetry).toBeUndefined();
    expect(nonEmptyLineCount(advice.message)).toBeLessThanOrEqual(5);
  });

  it("tells the commit role no make variants exist and routes the work", () => {
    const advice = adviseDenial({
      agent: "committer",
      rawCommand: "make test",
      patterns: realPatterns("committer"),
    });
    expect(advice.allowed).toBe(false);
    expect(advice.message).toContain("none");
    expect(advice.message).toContain("artisan");
    expect(nonEmptyLineCount(advice.message)).toBeLessThanOrEqual(5);
  });

  it("routes the commit role file reads through the file-reading tool", () => {
    const advice = adviseDenial({
      agent: "committer",
      rawCommand: "cat notes.txt",
      patterns: realPatterns("committer"),
    });
    expect(advice.allowed).toBe(false);
    expect(advice.message).toContain("`cat notes.txt`");
    expect(advice.message).toContain("Read tool");
    expect(nonEmptyLineCount(advice.message)).toBeLessThanOrEqual(5);
  });

  it("lets an allowlisted builder target pass through silently", () => {
    const advice = adviseDenial({
      agent: "artisan",
      rawCommand: "make test",
      patterns: realPatterns("artisan"),
    });
    expect(advice.allowed).toBe(true);
    expect(advice.result.deniedSegments).toEqual([]);
  });
});

describe("compound-command attribution", () => {
  it("blames the search stage of a builder pipeline and routes it to the search tool", () => {
    const advice = adviseDenial({
      agent: "artisan",
      rawCommand: "cat notes.txt | grep error",
      patterns: realPatterns("artisan"),
    });
    expect(advice.allowed).toBe(false);
    expect(advice.result.deniedSegments).toEqual(["grep error"]);
    expect(advice.message).toContain("`grep error`");
    expect(advice.message).not.toContain("`cat notes.txt`");
    expect(advice.message).toContain("Grep tool");
    expect(advice.message).toContain("*.log");
    expect(nonEmptyLineCount(advice.message)).toBeLessThanOrEqual(5);
  });

  it("names only the unlisted stage of a pipeline under a fixture allowlist", () => {
    // No shipped agent grants shell search while withholding file reads,
    // so this split is proven against an injected allowlist; the case
    // above proves the same split against real agent files.
    const advice = adviseDenial({
      agent: "fixture-agent",
      rawCommand: "cat notes.txt | grep error",
      patterns: ["grep*", "head*"],
    });
    expect(advice.allowed).toBe(false);
    expect(advice.result.deniedSegments).toEqual(["cat notes.txt"]);
    expect(advice.message).toContain("`cat notes.txt`");
    expect(advice.message).not.toContain("`grep error`");
  });
});

describe("suggestion traceability", () => {
  it("traces every suggested variant to a literal line in the calling role file", async () => {
    const { readFile } = await import("node:fs/promises");
    const { dirname, join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const agentsDir = join(
      dirname(fileURLToPath(import.meta.url)),
      "../../../agents"
    );
    for (const agent of ["artisan", "analyzer", "explorer", "committer"]) {
      const fileText = await readFile(join(agentsDir, `${agent}.md`), "utf8");
      const advice = adviseDenial({
        agent,
        rawCommand: "make lint",
        patterns: realPatterns(agent),
      });
      expect(advice.allowed).toBe(false);
      for (const variant of advice.result.allowedVariants) {
        expect(fileText).toContain(`"${variant}"`);
      }
    }
  });

  describe("zero-variant echo denial", () => {
    it("carries no availability claim and names the restructure path", () => {
      const advice = adviseDenial({
        agent: "pathfinder",
        rawCommand: "echo ----",
        patterns: realPatterns("pathfinder"),
      });
      expect(advice.allowed).toBe(false);
      expect(advice.result.deniedSegments).toEqual(["echo ----"]);
      expect(advice.message).not.toContain("stays available");
      expect(advice.message).toContain("drop the segment");
      expect(nonEmptyLineCount(advice.message)).toBeLessThanOrEqual(5);
    });

    it("routes to dedicated tools instead of another role", () => {
      const advice = adviseDenial({
        agent: "pathfinder",
        rawCommand: "echo ----",
        patterns: realPatterns("pathfinder"),
      });
      expect(advice.allowed).toBe(false);
      expect(advice.message).not.toContain(
        "route the task to a role granting it"
      );
      expect(advice.message).toContain("routed tools");
    });

    it("points Try-next at the restructure action", () => {
      const advice = adviseDenial({
        agent: "pathfinder",
        rawCommand: "echo ----",
        patterns: realPatterns("pathfinder"),
      });
      expect(advice.allowed).toBe(false);
      expect(advice.message).toContain("Try next: drop `echo ----`");
    });

    it("keeps the availability clause when variants exist", () => {
      const advice = adviseDenial({
        agent: "artisan",
        rawCommand: "make lint",
        patterns: realPatterns("artisan"),
      });
      expect(advice.allowed).toBe(false);
      expect(advice.message).toContain("this target only");
      expect(advice.message).toContain("stays available");
    });
  });
});
