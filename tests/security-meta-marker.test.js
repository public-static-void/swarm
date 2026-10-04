import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  noMetaMarker,
  noMetaMarkerProse,
} from "../eslint.security.config.mjs";

// Rule-level pins for the workflow-token guard: the JavaScript comment/label
// rule keeps its scope, and the prose rule extends coverage to agent and skill
// docs with convention-line allowlisting. Fixture tokens below live in string
// literals, which the guard never scans.

const ROOT = process.cwd();

function collectReports(rule, sourceCode) {
  const reports = [];
  const context = { sourceCode, report: (entry) => reports.push(entry) };
  const visitors = rule.create(context);
  if (typeof visitors.Program === "function") visitors.Program();
  return reports;
}

function jsSource({ comments = [], lines = [] }) {
  return { getAllComments: () => comments, lines };
}

function comment(value, line = 1) {
  return { value, loc: { start: { line } } };
}

function proseSource(lines) {
  return { lines };
}

describe("comment and label marker guard", () => {
  it("flags a bare workflow token in a code comment", () => {
    const reports = collectReports(
      noMetaMarker,
      jsSource({ comments: [comment(" status references AC001 today")] })
    );
    expect(reports).toHaveLength(1);
    expect(reports[0].messageId).toBe("marker");
  });

  it("leaves string-literal fixture data alone", () => {
    const reports = collectReports(
      noMetaMarker,
      jsSource({ lines: ['const fixture = "AC001";'] })
    );
    expect(reports).toEqual([]);
  });

  it("flags a milestone-prefixed test label", () => {
    const reports = collectReports(
      noMetaMarker,
      jsSource({ lines: ["describe('M1: resume guard', () => {"] })
    );
    expect(reports).toHaveLength(1);
    expect(reports[0].messageId).toBe("marker");
  });

  it("passes the uppercase issue-contract form", () => {
    const reports = collectReports(
      noMetaMarker,
      jsSource({ comments: [comment(" contract ISSUE-001 parsed")] })
    );
    expect(reports).toEqual([]);
  });
});

describe("prose marker guard for agent and skill docs", () => {
  it("flags a bare workflow token in docs prose", () => {
    const reports = collectReports(
      noMetaMarkerProse,
      proseSource(["The status for AC001 is green."])
    );
    expect(reports).toHaveLength(1);
    expect(reports[0].messageId).toBe("marker");
  });

  it("flags a bare issue token in docs prose", () => {
    const reports = collectReports(
      noMetaMarkerProse,
      proseSource(["see issue-29 for background"])
    );
    expect(reports).toHaveLength(1);
  });

  it("passes convention lines that carry a token", () => {
    const reports = collectReports(
      noMetaMarkerProse,
      proseSource(["Code states its local contract; trace for AC001 lives in KDs."])
    );
    expect(reports).toEqual([]);
  });

  it("passes template placeholder lines", () => {
    const reports = collectReports(
      noMetaMarkerProse,
      proseSource(["- [ ] AC001: {{verifiable criterion referencing R001}}"])
    );
    expect(reports).toEqual([]);
  });

  it("passes fenced example blocks", () => {
    const reports = collectReports(
      noMetaMarkerProse,
      proseSource(["```mermaid", "P001 --> P002", "```"])
    );
    expect(reports).toEqual([]);
  });

  it("leaves frontmatter alone", () => {
    const reports = collectReports(
      noMetaMarkerProse,
      proseSource(["---", "title: AC001 draft", "---", "Body text."])
    );
    expect(reports).toEqual([]);
  });

  it("passes pattern-form references", () => {
    const reports = collectReports(
      noMetaMarkerProse,
      proseSource(["codes (R/AC/M) and tokens (`issue-\\d+`) live in KDs"])
    );
    expect(reports).toEqual([]);
  });
});

describe("prose guard wiring in the security config", () => {
  const configText = readFileSync(join(ROOT, "eslint.security.config.mjs"), "utf8");

  it("covers the agent, skill, and root instruction surfaces", () => {
    for (const surface of ["agents/**/*.md", "skills/**/*.md", "AGENTS.md"]) {
      expect(configText).toContain(surface);
    }
    expect(configText).toContain("no-meta-marker-prose");
  });

  it("carries no dead commands glob", () => {
    expect(configText).not.toContain("commands/");
  });

  it("carries an explicit convention-line allowlist", () => {
    expect(configText).toContain("local contract");
  });
});
