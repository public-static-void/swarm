import { describe, it, expect } from "vitest";
import securityConfig, {
  noMetaMarker,
  noMetaMarkerProse,
  noMetadataComment,
} from "../eslint.security.config.mjs";

// Rule-level pins for the workflow-token guard: the JavaScript comment/label
// rule keeps its scope, the prose rule extends coverage to agent and skill
// docs with convention-line allowlisting, and the metadata-comment rule mirrors
// the metadata-purity guard over the leading frontmatter block. Fixture tokens
// below live in string literals, which the guard never scans.

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

  // The hyphen forms were covered from the start; the space-separated form a
  // person writes in a comment was not, so process trace survived in plugin
  // sources while the rule read as complete.
  it("flags the space-separated issue and fix citations", () => {
    const forms = [" silent-skip root cause, issue 71", " BUG 2 FIX: fail-closed"];
    for (const form of forms) {
      const reports = collectReports(noMetaMarker, jsSource({ comments: [comment(form)] }));
      expect(reports, `must flag ${form.trim()}`).toHaveLength(1);
    }
  });

  it("passes a comment that names the words without a citation number", () => {
    const reports = collectReports(
      noMetaMarker,
      jsSource({ comments: [comment(" the issue tracker is external; a bug needs a reproduction")] })
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

describe("metadata-comment guard for agent and skill frontmatter", () => {
  it("flags a comment line inside the leading metadata block", () => {
    const reports = collectReports(
      noMetadataComment,
      proseSource(["---", "# class rationale in prose", "name: x", "---", "Body text."])
    );
    expect(reports).toHaveLength(1);
    expect(reports[0].messageId).toBe("metadata-comment");
    expect(reports[0].loc.line).toBe(2);
  });

  it("flags an indented comment line inside the metadata block", () => {
    const reports = collectReports(
      noMetadataComment,
      proseSource(["---", "  # indented rationale", "---"])
    );
    expect(reports).toHaveLength(1);
    expect(reports[0].messageId).toBe("metadata-comment");
  });

  it("leaves body prose alone", () => {
    const reports = collectReports(
      noMetadataComment,
      proseSource(["---", "name: x", "---", "# Body heading", "## Section"])
    );
    expect(reports).toEqual([]);
  });

  it("leaves a second metadata region out of scope", () => {
    const reports = collectReports(
      noMetadataComment,
      proseSource(["---", "name: template", "---", "", "---", "# template comment", "---"])
    );
    expect(reports).toEqual([]);
  });

  it("passes a file with no leading metadata block", () => {
    const reports = collectReports(
      noMetadataComment,
      proseSource(["# Title", "## Section"])
    );
    expect(reports).toEqual([]);
  });

  it("ignores a hash that does not lead the line", () => {
    const reports = collectReports(
      noMetadataComment,
      proseSource(["---", 'description: "tracks issue #12"', "---"])
    );
    expect(reports).toEqual([]);
  });
});

// The wiring is asserted against the exported default config array, not the
// file text: a member is located by the rule id it registers, so dropping that
// member from the array fails here even while its const stays defined.
const DOC_SURFACES = ["agents/**/*.md", "skills/**/*.md", "AGENTS.md"];

function configEntryForRule(ruleId) {
  return securityConfig.find((entry) => entry.rules && entry.rules[ruleId] !== undefined);
}

describe("prose guard wiring in the security config", () => {
  it("covers the agent, skill, and root instruction surfaces", () => {
    const entry = configEntryForRule("meta-marker/no-meta-marker-prose");
    expect(entry, "the exported config carries the prose marker rule").toBeTruthy();
    for (const surface of DOC_SURFACES) {
      expect(entry.files).toContain(surface);
    }
  });

  it("carries no dead commands glob", () => {
    const globs = securityConfig.flatMap((entry) => (Array.isArray(entry.files) ? entry.files : []));
    expect(globs.filter((glob) => glob.includes("commands/"))).toEqual([]);
  });

  it("carries an explicit convention-line allowlist", () => {
    const entry = configEntryForRule("meta-marker/no-meta-marker-prose");
    const wiredRule = entry.plugins["meta-marker"].rules["no-meta-marker-prose"];
    expect(wiredRule).toBe(noMetaMarkerProse);
    const reports = collectReports(
      wiredRule,
      proseSource(["Code states its local contract; trace for AC001 lives in KDs."])
    );
    expect(reports).toEqual([]);
  });

  it("wires the metadata-comment mirror over the same docs surfaces", () => {
    const entry = configEntryForRule("metadata-purity/no-metadata-comment");
    expect(entry, "the exported config carries the metadata-comment rule").toBeTruthy();
    expect(entry.rules["metadata-purity/no-metadata-comment"]).toBe("error");
    expect(entry.plugins["metadata-purity"].rules["no-metadata-comment"]).toBe(noMetadataComment);
    for (const surface of DOC_SURFACES) {
      expect(entry.files).toContain(surface);
    }
  });
});
