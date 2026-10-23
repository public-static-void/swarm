import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import pluginModule from "../../../plugins/protocol-gate/index.js";

// The liveness allowlist is one vocabulary and one parse (IC-1). This file
// pins the vocabulary row by row, then proves every consumer of "is this
// evidence still live?" reaches the same verdict from the same bytes — a second
// admission rule anywhere would show up as a disagreement here.
describe("Protocol-Gate liveness allowlist", () => {
  const pluginSourcePath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "plugins/protocol-gate/index.js");

  let tempRoot;
  let knowledgeDir;
  let stateDir;
  let logDir;
  let priorKnowledgeDir;
  let priorStateDir;
  let priorLogDir;
  let priorDebug;
  let hooks;

  beforeAll(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "pg-liveness-"));
    knowledgeDir = join(tempRoot, "knowledge");
    stateDir = join(tempRoot, "state");
    priorKnowledgeDir = process.env.PROTOCOL_GATE_KNOWLEDGE_DIR;
    priorStateDir = process.env.PROTOCOL_GATE_STATE_DIR;
    priorLogDir = process.env.PROTOCOL_GATE_LOG_DIR;
    priorDebug = process.env.PROTOCOL_GATE_DEBUG;
    process.env.PROTOCOL_GATE_KNOWLEDGE_DIR = knowledgeDir;
    process.env.PROTOCOL_GATE_STATE_DIR = stateDir;
    logDir = mkdtempSync(join(tmpdir(), "pg-liveness-log-"));
    process.env.PROTOCOL_GATE_LOG_DIR = logDir;
    delete process.env.PROTOCOL_GATE_DEBUG;
  });

  afterAll(() => {
    if (priorKnowledgeDir === undefined) delete process.env.PROTOCOL_GATE_KNOWLEDGE_DIR;
    else process.env.PROTOCOL_GATE_KNOWLEDGE_DIR = priorKnowledgeDir;
    if (priorStateDir === undefined) delete process.env.PROTOCOL_GATE_STATE_DIR;
    else process.env.PROTOCOL_GATE_STATE_DIR = priorStateDir;
    if (priorLogDir === undefined) delete process.env.PROTOCOL_GATE_LOG_DIR;
    else process.env.PROTOCOL_GATE_LOG_DIR = priorLogDir;
    if (priorDebug === undefined) delete process.env.PROTOCOL_GATE_DEBUG;
    else process.env.PROTOCOL_GATE_DEBUG = priorDebug;
    rmSync(logDir, { recursive: true, force: true });
    rmSync(tempRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    rmSync(knowledgeDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    mkdirSync(knowledgeDir, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    process.env.PROTOCOL_GATE_LOG_DIR = logDir;
    delete process.env.PROTOCOL_GATE_DEBUG;
    hooks = await pluginModule.server({}, {});
  });

  function kd(body) {
    return `---\ntitle: "IMPL: test"\nversion: 1.0.0\ntype: impl\nsession_id: "ses_test"\nauthor: Artisan\n${body}---\n\n# IMPL: test\n`;
  }

  function writeKD(filename, content) {
    writeFileSync(join(knowledgeDir, filename), content);
  }

  function registryContent(rows) {
    const yaml = rows.map(([id, state]) => `  ${id}: ${state}`).join("\n");
    const table = rows.map(([id, state]) => `| ${id} | desc | ${state} |`).join("\n");
    return `## Milestone States

\`\`\`yaml
milestones:
${yaml}
\`\`\`

## Milestone Details

| Milestone ID | Description | State |
| ------------ | ----------- | ----- |
${table}
`;
  }

  describe("liveness matrix", () => {
    it("admits every allowlisted status in every spelling the author may reach for", () => {
      const live = [
        ["plain", kd("status: draft\n")],
        ["review", kd("status: review\n")],
        ["approved", kd("status: approved\n")],
        ["amended", kd("status: amended\n")],
        ["double-quoted", kd('status: "draft"\n')],
        ["single-quoted", kd("status: 'review'\n")],
        ["uppercase", kd("status: APPROVED\n")],
        ["mixed-case key", kd("Status: draft\n")],
        ["trailing spaces", kd("status: draft   \n")],
        ["trailing comment", kd("status: amended # cleared by the gate\n")],
        ["CRLF endings", "---\r\ntitle: \"IMPL: test\"\r\nstatus: draft\r\n---\r\n\r\n# IMPL: test\r\n"],
        ["leading BOM", `\ufeff${kd("status: draft\n")}`]
      ];
      for (const [name, content] of live) {
        const verdict = hooks.evaluateLiveness(content);
        expect(verdict.live, `${name} must be live (got ${verdict.reason})`).toBe(true);
        expect(verdict.reason, name).toBeNull();
      }
    });

    it("refuses the superseded stamp in every spelling", () => {
      const stale = [
        ["plain", "superseded"],
        ["capitalized", "Superseded"],
        ["uppercase", "SUPERSEDED"],
        ["double-quoted", '"superseded"'],
        ["single-quoted", "'superseded'"],
        ["trailing spaces", "superseded   "],
        ["trailing comment", "superseded # invalidated by review"]
      ];
      for (const [name, value] of stale) {
        const verdict = hooks.evaluateLiveness(kd(`status: ${value}\n`));
        expect(verdict.live, `${name} must not be live`).toBe(false);
        expect(verdict.reason, name).toBe("stale-status");
        expect(verdict.declared, name).toBe("superseded");
        expect(verdict.raw, name).toBe(value.trim());
      }
      // The key is matched case-insensitively, so the stamp is refused however
      // the author spells the key — a live-branch-only proof would leave the
      // refusal path's key handling unpinned.
      for (const [name, line] of [["capitalized key", "Status: superseded"], ["uppercase key", "STATUS: superseded"]]) {
        const verdict = hooks.evaluateLiveness(kd(`${line}\n`));
        expect(verdict.live, `${name} must not be live`).toBe(false);
        expect(verdict.reason, name).toBe("stale-status");
        expect(verdict.declared, name).toBe("superseded");
      }
    });

    it("names every other status word unknown — the allowlist is exhaustive", () => {
      for (const value of ["superceded", "deprecated", "archived", "withdrawn", "wip", "done"]) {
        const verdict = hooks.evaluateLiveness(kd(`status: ${value}\n`));
        expect(verdict.live, `${value} must not be live`).toBe(false);
        expect(verdict.reason, value).toBe("unknown-status");
        expect(verdict.declared, value).toBe(value);
      }
    });

    it("treats an empty or missing status as undetermined, never as live", () => {
      const empty = [
        ["bare key", kd("status:\n")],
        ["empty quotes", kd('status: ""\n')],
        ["no status line", kd("status_hint: draft\n")]
      ];
      for (const [name, content] of empty) {
        const verdict = hooks.evaluateLiveness(content);
        expect(verdict.live, name).toBe(false);
        expect(verdict.reason, name).toBe("absent-status");
        expect(verdict.declared, name).toBeNull();
      }
    });

    it("refuses text whose frontmatter cannot be read as a block", () => {
      const unparsable = [
        ["no fence", "status: draft\n"],
        ["unterminated fence", "---\nstatus: draft\n"],
        ["body-only status", "# IMPL: test\n\nstatus: draft\n"],
        ["fence not at file start", "# IMPL: test\n\n---\nstatus: draft\n---\n"]
      ];
      for (const [name, content] of unparsable) {
        const verdict = hooks.evaluateLiveness(content);
        expect(verdict.live, name).toBe(false);
        expect(verdict.reason, name).toBe("unparsable-frontmatter");
      }
    });

    it("refuses two status declarations instead of picking one", () => {
      const verdict = hooks.evaluateLiveness(kd("status: draft\nstatus: superseded\n"));
      expect(verdict.live).toBe(false);
      expect(verdict.reason).toBe("ambiguous-status");
    });

    it("refuses empty content, and the file wrapper adds the missing-file verdict", () => {
      expect(hooks.evaluateLiveness("").reason).toBe("empty-content");
      expect(hooks.evaluateLiveness("   \n\t\n").reason).toBe("empty-content");
      expect(hooks.evaluateLiveness(undefined).reason).toBe("empty-content");
      expect(hooks.evaluateLivenessFile(knowledgeDir, "absent.md").reason).toBe("missing-file");
    });

    it("publishes one frozen vocabulary", () => {
      expect(Object.isFrozen(hooks.LIVE_STATUSES)).toBe(true);
      expect([...hooks.LIVE_STATUSES]).toEqual(["draft", "review", "approved", "amended"]);
      expect(hooks.LIVE_STATUSES).not.toContain("superseded");
    });

    it("records each refusal once, naming path, declared value and reason", () => {
      const logLines = () => {
        let log;
        try { log = readFileSync(join(logDir, "protocol-gate.log"), "utf8"); } catch (_) { return []; }
        return log.split("\n").filter((l) => l.includes("LIVENESS_REJECTED:"));
      };
      const before = logLines().length;

      writeKD("impl-M1-stamped-ses_lv_rec.md", kd("status: superseded\n"));
      writeKD("impl-M1-live-ses_lv_rec.md", kd("status: draft\n"));

      hooks.evaluateLivenessFile(knowledgeDir, "impl-M1-stamped-ses_lv_rec.md");
      // A live artifact is admitted silently — the record marks refusals.
      hooks.evaluateLivenessFile(knowledgeDir, "impl-M1-live-ses_lv_rec.md");
      // The same refusal twice is one event, not two.
      hooks.evaluateLivenessFile(knowledgeDir, "impl-M1-stamped-ses_lv_rec.md");
      const afterFirst = logLines();
      expect(afterFirst.length - before).toBe(1);
      expect(afterFirst[afterFirst.length - 1]).toContain("declared=superseded");
      expect(afterFirst[afterFirst.length - 1]).toContain("reason=stale-status");
      expect(afterFirst[afterFirst.length - 1]).toContain("impl-M1-stamped-ses_lv_rec.md");

      // A different verdict for the same path is a new event.
      writeKD("impl-M1-stamped-ses_lv_rec.md", "# frontmatter removed\n");
      hooks.evaluateLivenessFile(knowledgeDir, "impl-M1-stamped-ses_lv_rec.md");
      const afterSecond = logLines();
      expect(afterSecond.length - before).toBe(2);
      expect(afterSecond[afterSecond.length - 1]).toContain("reason=unparsable-frontmatter");
    });
  });

  describe("one parse, every consumer", () => {
    // Representative bytes per family: one live artifact, one of each refusal
    // reason. Every consumer below must reach the verdict this table states.
    const fixtures = [
      ["impl-M1-live-ses_lv.md", kd("status: draft\n"), true, null],
      ["impl-M1-amended-ses_lv.md", kd("status: amended\n"), true, null],
      ["impl-M1-stamped-ses_lv.md", kd("status: superseded\n"), false, "stale-status"],
      ["impl-M1-unknown-ses_lv.md", kd("status: archived\n"), false, "unknown-status"],
      ["impl-M1-absent-ses_lv.md", "---\ntitle: t\n---\n\n# body\n", false, "absent-status"],
      ["impl-M1-unparsable-ses_lv.md", "# no frontmatter\n", false, "unparsable-frontmatter"]
    ];

    it("agrees across the disk-reading consumers", () => {
      const s = "ses_lv";
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      for (const [filename, content, live, reason] of fixtures) {
        rmSync(knowledgeDir, { recursive: true, force: true });
        mkdirSync(knowledgeDir, { recursive: true });
        writeKD(filename, content);

        // The one parse, and its legacy negation.
        expect(hooks.evaluateLiveness(content).live, `${filename} parse`).toBe(live);
        expect(hooks.isStaleImplKDContent(content), `${filename} stale predicate`).toBe(!live);

        // File-level wrappers.
        const fileVerdict = hooks.evaluateLivenessFile(knowledgeDir, filename);
        expect(fileVerdict.live, `${filename} file verdict`).toBe(live);
        expect(fileVerdict.reason, `${filename} file reason`).toBe(reason);
        expect(hooks.isLiveEvidenceFile(knowledgeDir, filename), `${filename} evidence file`).toBe(live);
        expect(hooks.isSupersededByFrontmatter(knowledgeDir, filename), `${filename} superseded predicate`).toBe(!live);

        // The write-hook snapshot, which decides whether a stamp is behind the
        // incoming bytes.
        const snapshot = hooks.readImplKDSnapshot(`knowledge/${filename}`, s);
        expect(snapshot && snapshot.stale, `${filename} write snapshot`).toBe(!live);

        // Milestone evidence: pinned generation 0, same session.
        expect(
          hooks.isLiveMilestoneEvidence(knowledgeDir, filename, s, "M1", 0),
          `${filename} milestone evidence`
        ).toBe(live);
        expect(hooks.findMilestoneImplKD(s, hooks.sessionPhaseMap, "M1") === null, `${filename} findMilestoneImplKD`).toBe(!live);

        // Scoped deletion: live evidence is never deletable.
        const deletable = hooks.evaluateStaleKDDeletable(filename, s, 0, content);
        expect(deletable.deletable, `${filename} deletable`).toBe(!live);
        if (!live) {
          expect(["not-live", "superseded"], `${filename} delete reason`).toContain(deletable.reason);
        } else {
          expect(deletable.reason, `${filename} delete refusal`).toBe("live-evidence");
        }
      }
    });

    it("agrees at the deletion operator: live survives, stale is removable", () => {
      const s = "ses_lv_delete";
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      const liveName = "impl-M1-keep-ses_lv_delete.md";
      const staleName = "impl-M1-drop-ses_lv_delete.md";
      writeKD(liveName, kd("status: approved\n"));
      writeKD(staleName, kd("status: superseded\n"));

      const refused = hooks.deleteStaleMilestoneKD(s, hooks.sessionPhaseMap, liveName, "test");
      expect(refused.ok).toBe(false);
      expect(refused.reason).toBe("live-evidence");
      expect(readFileSync(join(knowledgeDir, liveName), "utf8")).toContain("status: approved");

      const removed = hooks.deleteStaleMilestoneKD(s, hooks.sessionPhaseMap, staleName, "test");
      expect(removed.ok).toBe(true);
      expect(removed.reason).toBe("superseded");
      expect(() => readFileSync(join(knowledgeDir, staleName), "utf8")).toThrow();
    });

    it("agrees at reopen: only live artifacts are stamped, stamped ones are already settled history", () => {
      const s = "ses_lv_supersede";
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      writeKD("impl-M1-live-ses_lv_supersede.md", kd("status: draft\n"));
      writeKD("impl-M1-stamped-ses_lv_supersede.md", kd("status: superseded\n"));
      writeKD("impl-M2-other-ses_lv_supersede.md", kd("status: draft\n"));

      const stamped = hooks.supersedeMilestoneImplKDs(s, hooks.sessionPhaseMap, "M1");
      expect(stamped).toEqual(["impl-M1-live-ses_lv_supersede.md"]);
      expect(readFileSync(join(knowledgeDir, "impl-M1-live-ses_lv_supersede.md"), "utf8")).toContain("status: superseded");
      expect(readFileSync(join(knowledgeDir, "impl-M1-stamped-ses_lv_supersede.md"), "utf8")).toContain("status: superseded");
      // The other milestone's evidence is untouched.
      expect(readFileSync(join(knowledgeDir, "impl-M2-other-ses_lv_supersede.md"), "utf8")).toContain("status: draft");
    });

    it("agrees at stuck-row reconciliation: only a live artifact promotes the row", () => {
      const s = "ses_lv_reconcile";
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      writeKD("milestones-feature-ses_lv_reconcile.md", registryContent([["M1", "in-progress"], ["M2", "in-progress"]]));
      writeKD("impl-M1-live-ses_lv_reconcile.md", kd("status: draft\n"));
      writeKD("impl-M2-stamped-ses_lv_reconcile.md", kd("status: superseded\n"));

      const registry = hooks.readMilestoneRegistry(s, hooks.sessionPhaseMap);
      const promoted = hooks.reconcileStuckRowsFromDiskEvidence(s, hooks.sessionPhaseMap, registry);
      expect(promoted).toBe(1);

      const after = readFileSync(join(knowledgeDir, "milestones-feature-ses_lv_reconcile.md"), "utf8");
      expect(after).toContain("  M1: checked-off");
      expect(after).toContain("  M2: in-progress");
    });

    it("agrees at the write hook: a non-live impl KD never promotes and names its reason", async () => {
      const s = "ses_lv_hook";
      const artisan = "ses_lv_hook_artisan";
      await hooks["chat.params"]({ sessionID: s, agent: "overseer" }, {});
      hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set(`${s}:sid`, s);
      writeKD(`milestones-feature-${s}.md`, registryContent([["M1", "in-progress"]]));
      await hooks["chat.params"]({ sessionID: artisan, agent: "artisan" }, {});

      await hooks["tool.execute.before"](
        { tool: "write", sessionID: artisan, callID: "lv-1" },
        { args: { filePath: `knowledge/impl-M1-stale-${s}.md`, content: kd("status: superseded\n") } }
      );
      expect(readFileSync(join(knowledgeDir, `milestones-feature-${s}.md`), "utf8")).toContain("  M1: in-progress");

      const log = readFileSync(join(logDir, "protocol-gate.log"), "utf8");
      expect(log).toContain(`CHECKOFF: milestone=M1 artifact=impl-M1-stale-${s}.md promoted=false reason=stale-status`);
    });

    it("has exactly one admission vocabulary in the plugin source", () => {
      const source = readFileSync(pluginSourcePath, "utf8");
      // The allowlist literal appears once — a second list would be a second
      // vocabulary, and the two would drift.
      const declarations = source.split('["draft", "review", "approved", "amended"]').length - 1;
      expect(declarations).toBe(1);
      // No consumer compares a status word directly instead of consulting the
      // parse.
      expect(source.match(/status\s*===\s*"(draft|review|approved|amended|superseded)"/g)).toBeNull();
      expect(source.match(/declared\s*===\s*"(draft|review|approved|amended)"/g)).toBeNull();
    });
  });

  describe("labelling migration", () => {
    it("labels a frontmatter-less artifact into the allowlist without touching its body", () => {
      const body = "# IMPLEMENTATION SUMMARY: old evidence\n\nProse the author wrote.\n";
      expect(hooks.evaluateLiveness(body).live).toBe(false);

      const labelled = hooks.labelEvidenceStatus(body, "draft");
      expect(labelled.changed).toBe(true);
      expect(labelled.content.startsWith("---\nstatus: draft\n---\n")).toBe(true);
      const verdict = hooks.evaluateLiveness(labelled.content);
      expect(verdict.live).toBe(true);
      expect(verdict.declared).toBe("draft");
      // The body survives byte-identical: labelling adds evidence, never rewrites it.
      expect(labelled.content.endsWith(body)).toBe(true);
    });

    it("refuses a label outside the allowlist and leaves a live artifact alone", () => {
      const body = "---\ntitle: t\n---\n\n# body\n";
      // A label may only move an artifact INTO the allowlist — writing the stale
      // stamp here would create the very state settlement exists to clear.
      const refused = hooks.labelEvidenceStatus(body, "superseded");
      expect(refused.changed).toBe(false);
      expect(refused.content).toBe(body);

      const alreadyLive = `---\ntitle: t\nstatus: approved\n---\n\n# body\n`;
      expect(hooks.labelEvidenceStatus(alreadyLive, "draft").changed).toBe(false);
      expect(hooks.labelEvidenceStatus(alreadyLive, "draft").content).toBe(alreadyLive);
    });

    it("audits the whole tree, not just the top level, and records each refusal once", () => {
      const nested = join(knowledgeDir, "projects", "sample");
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(nested, "impl-M9-nested-ses_lv_audit.md"), "# no frontmatter\n");
      writeKD("impl-M9-live-ses_lv_audit.md", kd("status: draft\n"));

      const logLines = () => {
        let log;
        try { log = readFileSync(join(logDir, "protocol-gate.log"), "utf8"); } catch (_) { return []; }
        return log.split("\n").filter((l) => l.includes("LIVENESS_STRICT_WOULD_REJECT:"));
      };
      const before = logLines().length;

      const rejected = hooks.auditStrictLivenessWouldReject(knowledgeDir);
      const paths = rejected.map((r) => r.path);
      // An audit that stops at the top level would leave the nested artifact
      // unexamined while reporting a clean tree.
      expect(paths).toContain("projects/sample/impl-M9-nested-ses_lv_audit.md");
      expect(paths).not.toContain("impl-M9-live-ses_lv_audit.md");
      const nestedVerdict = rejected.find((r) => r.path === "projects/sample/impl-M9-nested-ses_lv_audit.md");
      expect(nestedVerdict.reason).toBe("unparsable-frontmatter");

      expect(logLines().length - before).toBe(1);
      expect(logLines()[logLines().length - 1]).toContain("projects/sample/impl-M9-nested-ses_lv_audit.md");

      // A second audit of unchanged bytes is the same event, not a new one.
      hooks.auditStrictLivenessWouldReject(knowledgeDir);
      expect(logLines().length - before).toBe(1);
    });
  });
});
