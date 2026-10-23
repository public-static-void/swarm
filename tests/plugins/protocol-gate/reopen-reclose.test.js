import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import pluginModule from "../../../plugins/protocol-gate/index.js";

// Reopen/settlement observability: the diagnosis surface an operator reads with
// no debug flag set. Every assertion here runs with PROTOCOL_GATE_DEBUG absent
// and the debug sentinel pointed at a path that does not exist, so a record
// that is visible only on the debug channel fails this file.
describe("Protocol-Gate reopen and settlement records", () => {
  let tempRoot;
  let knowledgeDir;
  let stateDir;
  let protocolLogDir;
  let logPath;
  let debugSentinel;
  let priorKnowledgeDir;
  let priorStateDir;
  let priorLogDir;
  let priorDebugFile;
  let priorDebug;
  let hooks;

  beforeAll(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "pg-reopen-"));
    knowledgeDir = join(tempRoot, "knowledge");
    stateDir = join(tempRoot, "state");
    priorKnowledgeDir = process.env.PROTOCOL_GATE_KNOWLEDGE_DIR;
    priorStateDir = process.env.PROTOCOL_GATE_STATE_DIR;
    priorLogDir = process.env.PROTOCOL_GATE_LOG_DIR;
    priorDebugFile = process.env.PROTOCOL_GATE_DEBUG_FILE;
    priorDebug = process.env.PROTOCOL_GATE_DEBUG;
    process.env.PROTOCOL_GATE_KNOWLEDGE_DIR = knowledgeDir;
    process.env.PROTOCOL_GATE_STATE_DIR = stateDir;
    protocolLogDir = mkdtempSync(join(tmpdir(), "pg-reopen-log-"));
    process.env.PROTOCOL_GATE_LOG_DIR = protocolLogDir;
    logPath = join(protocolLogDir, "protocol-gate.log");
    // Debug off, in both of its forms: the env var is absent and the sentinel
    // file does not exist. A record that only reaches the debug channel is
    // therefore invisible to this file.
    debugSentinel = join(tempRoot, "no-debug-sentinel");
    process.env.PROTOCOL_GATE_DEBUG_FILE = debugSentinel;
    delete process.env.PROTOCOL_GATE_DEBUG;
  });

  afterAll(() => {
    if (priorKnowledgeDir === undefined) delete process.env.PROTOCOL_GATE_KNOWLEDGE_DIR;
    else process.env.PROTOCOL_GATE_KNOWLEDGE_DIR = priorKnowledgeDir;
    if (priorStateDir === undefined) delete process.env.PROTOCOL_GATE_STATE_DIR;
    else process.env.PROTOCOL_GATE_STATE_DIR = priorStateDir;
    if (priorLogDir === undefined) delete process.env.PROTOCOL_GATE_LOG_DIR;
    else process.env.PROTOCOL_GATE_LOG_DIR = priorLogDir;
    if (priorDebugFile === undefined) delete process.env.PROTOCOL_GATE_DEBUG_FILE;
    else process.env.PROTOCOL_GATE_DEBUG_FILE = priorDebugFile;
    if (priorDebug === undefined) delete process.env.PROTOCOL_GATE_DEBUG;
    else process.env.PROTOCOL_GATE_DEBUG = priorDebug;
    rmSync(protocolLogDir, { recursive: true, force: true });
    rmSync(tempRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    rmSync(knowledgeDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    mkdirSync(knowledgeDir, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    process.env.PROTOCOL_GATE_LOG_DIR = protocolLogDir;
    process.env.PROTOCOL_GATE_DEBUG_FILE = debugSentinel;
    delete process.env.PROTOCOL_GATE_DEBUG;
    hooks = await pluginModule.server({}, {});
  });

  function createKD(filename, content = "test content") {
    writeFileSync(join(knowledgeDir, filename), content);
  }

  function clearLog() {
    try { rmSync(logPath, { force: true }); } catch (_) {}
  }

  // Records are one line per event: `[ISO] [protocol-gate] TOKEN: k=v … cause=…`.
  function records(token) {
    let log;
    try { log = readFileSync(logPath, "utf8"); } catch (_) { return []; }
    const marker = `] [protocol-gate] ${token}:`;
    return log.split("\n").filter((line) => line.includes(marker));
  }

  function parseRecord(line) {
    const marker = "] [protocol-gate] ";
    const body = line.slice(line.indexOf(marker) + marker.length);
    const colonAt = body.indexOf(":");
    const token = body.slice(0, colonAt);
    const rest = body.slice(colonAt + 2);
    const causeAt = rest.indexOf(" cause=");
    const head = causeAt === -1 ? rest : rest.slice(0, causeAt);
    const cause = causeAt === -1 ? null : rest.slice(causeAt + " cause=".length);
    const fields = {};
    for (const pair of head.split(" ").filter(Boolean)) {
      const eq = pair.indexOf("=");
      if (eq > 0) fields[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
    return { token, fields, cause };
  }

  function implKD(sessionID, status = "draft") {
    return `---
title: "IMPLEMENTATION SUMMARY: test"
version: 1.0.0
status: ${status}
type: impl
session_id: "${sessionID}"
author: Artisan
superseded_by: null
---

# IMPLEMENTATION SUMMARY: test
`;
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

  async function startSwarm(s, rows) {
    await hooks["chat.params"]({ sessionID: s, agent: "overseer" }, {});
    hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
    hooks.sessionPhaseMap.set(`${s}:sid`, s);
    createKD(`milestones-feature-${s}.md`, registryContent(rows));
  }

  // Drives the artisan impl-KD write hook exactly as the runtime does: the
  // before-hook fires first, then the runtime materializes the file, then the
  // after-hook settles the deferred stamp clear and evaluates the SWARM gate.
  async function artisanWrite(artisan, relPath, content, callID) {
    await hooks["chat.params"]({ sessionID: artisan, agent: "artisan" }, {});
    await hooks["tool.execute.before"](
      { tool: "write", sessionID: artisan, callID },
      { args: { filePath: relPath, content } }
    );
  }

  async function landAndSettle(artisan, relPath, content, callID) {
    createKD(relPath.split("/").pop(), content);
    await hooks["tool.execute.after"](
      { tool: "write", sessionID: artisan, callID },
      {}
    );
  }

  function readRegistry(s) {
    return readFileSync(join(knowledgeDir, `milestones-feature-${s}.md`), "utf8");
  }

  function registryRows(s) {
    const rows = {};
    const re = /^\s*([A-Za-z0-9_-]+):\s*([A-Za-z-]+)\s*$/gm;
    let m;
    const content = readRegistry(s);
    while ((m = re.exec(content)) !== null) rows[m[1]] = m[2];
    return rows;
  }

  async function startVerify(s, rows) {
    await hooks["chat.params"]({ sessionID: s, agent: "overseer" }, {});
    hooks.sessionPhaseMap.set(s, hooks.STATES.VERIFY);
    hooks.sessionPhaseMap.set(`${s}:sid`, s);
    createKD(`milestones-feature-${s}.md`, registryContent(rows));
  }

  // One gate evaluation at the point a tool call would run: the before-hook is
  // where disk advancement, stamp settlement and verdict handling happen.
  async function gateEvaluate(s, callID) {
    await hooks["tool.execute.before"](
      { tool: "glob", sessionID: s, callID },
      { args: { pattern: "knowledge/*.md" } }
    );
  }

  // A review KD carrying the machine-readable verdict and the reopen target
  // field. `reopenTarget` is a raw field value ("M2", "[M2, M3]", '""'),
  // `null` to omit the field, or an array to emit the key once per element
  // (the duplicate-key case).
  function reviewKD(verdict, reopenTarget, escalation = "") {
    let field = "";
    if (typeof reopenTarget === "string") field = `reopen_target: ${reopenTarget}\n`;
    else if (Array.isArray(reopenTarget)) field = reopenTarget.map((v) => `reopen_target: ${v}\n`).join("");
    const escalationSection = escalation ? `\n## Escalation\n\n${escalation}\n` : "";
    return `---
title: "REVIEW: test"
version: 1.0.0
status: draft
type: review
session_id: "ses_test"
author: Inspector
superseded_by: null
verdict: ${verdict}
${field}---

# REVIEW: test

## Verdict

${verdict}

## Review Findings

### F001: defect

- **Status**: ${verdict}

## Audit

### Scope

audited
${escalationSection}`;
  }

  // The precondition of every settlement case: a checked-off row reopened, its
  // prior evidence stamped in place, and the stamped digest recorded.
  async function reopenWithStamp(s, base) {
    await startSwarm(s, [["M6", "checked-off"]]);
    createKD(base, implKD(s));
    const reopened = hooks.updateMilestoneRegistry(s, hooks.sessionPhaseMap, "M6", ["in-progress"], {
      reopen: true,
      trigger: `FAIL reopen_target=[M6] review KD review-fail-${s}.md`
    });
    expect(reopened.ok).toBe(true);
    expect(readFileSync(join(knowledgeDir, base), "utf8")).toContain("status: superseded");
    expect(readRegistry(s)).toContain("  M6: in-progress");
  }

  it("reopen and settlement records are always-on", async () => {
    const s = "obs-t3";
    const artisan = "obs-t3-artisan";
    const relPath = `knowledge/impl-M6-first-${s}-gen0.md`;
    await startSwarm(s, [["M6", "checked-off"]]);
    createKD(`impl-M6-first-${s}-gen0.md`, implKD(s));
    clearLog();

    // Precondition for every assertion below: logging is off in both forms.
    const enablement = hooks.getEnablementState();
    expect(enablement.enabled, "the debug channel is on — the records below prove nothing").toBe(false);

    // 1. Reopen: one always-on record naming session, milestone, invalidated
    //    artifact and the verdict that caused it.
    const reopened = hooks.updateMilestoneRegistry(s, hooks.sessionPhaseMap, "M6", ["in-progress"], {
      reopen: true,
      trigger: `FAIL reopen_target=[M6] review KD review-fail-${s}.md`
    });
    expect(reopened.ok).toBe(true);
    const reopen = records("REOPEN");
    expect(reopen, "no always-on REOPEN record").toHaveLength(1);
    const reopenFields = parseRecord(reopen[0]).fields;
    expect(reopenFields.session).toBe(s);
    expect(reopenFields.milestone).toBe("M6");
    expect(reopenFields.artifact).toBe(`impl-M6-first-${s}-gen0.md`);
    expect(parseRecord(reopen[0]).cause).toContain(`review-fail-${s}.md`);

    // 2. Pending stamp clear: the genuine fix-up rewrite over the stamped file
    //    is recorded before the file lands. A second identical evaluation of
    //    the same bytes emits nothing further (one line per event).
    const fixBody = `${implKD(s, "superseded")}\n# Fix evidence: addresses review findings\n`;
    await artisanWrite(artisan, relPath, fixBody, "c-obs-t3-a");
    await artisanWrite(artisan, relPath, fixBody, "c-obs-t3-b");
    const pending = records("STAMP_CLEAR_PENDING");
    expect(pending, "no always-on STAMP_CLEAR_PENDING record, or a duplicate per evaluation").toHaveLength(1);
    expect(parseRecord(pending[0]).fields).toMatchObject({
      milestone: "M6",
      artifact: `impl-M6-first-${s}-gen0.md`
    });

    // 3. Settlement and promotion: the clear and the check-off are recorded.
    await landAndSettle(artisan, relPath, fixBody, "c-obs-t3-b");
    const cleared = records("STAMP_CLEARED");
    expect(cleared, "no always-on STAMP_CLEARED record").toHaveLength(1);
    expect(parseRecord(cleared[0]).fields).toMatchObject({
      milestone: "M6",
      artifact: `impl-M6-first-${s}-gen0.md`
    });
    const checkoff = records("CHECKOFF");
    expect(checkoff, "no always-on CHECKOFF record").toHaveLength(1);
    expect(parseRecord(checkoff[0]).fields).toMatchObject({
      milestone: "M6",
      artifact: `impl-M6-first-${s}-gen0.md`,
      promoted: "true"
    });
    expect(readFileSync(join(knowledgeDir, `milestones-feature-${s}.md`), "utf8")).toContain("  M6: checked-off");

    // 4. An unchanged re-evaluation adds no line: the promotion path is
    //    re-driven with identical bytes and identical state.
    const liveBody = readFileSync(join(knowledgeDir, `impl-M6-first-${s}-gen0.md`), "utf8");
    await artisanWrite(artisan, relPath, liveBody, "c-obs-t3-c");
    await landAndSettle(artisan, relPath, liveBody, "c-obs-t3-c");
    const afterFirstRepeat = records("CHECKOFF").length;
    await artisanWrite(artisan, relPath, liveBody, "c-obs-t3-d");
    await landAndSettle(artisan, relPath, liveBody, "c-obs-t3-d");
    expect(records("CHECKOFF"), "a repeated identical evaluation emitted another record").toHaveLength(afterFirstRepeat);
  });

  // Settlement declines rather than guesses. Each token below is one reason the
  // gate refuses to promote, and each refusal is visible with no debug flag:
  // the row stays open, the artifact stays on disk, and one record says why.
  describe("settlement declines", () => {
    function declinedExactly(reason) {
      const declined = records("STAMP_DECLINED");
      expect(declined, `expected exactly one decline (${reason})`).toHaveLength(1);
      const parsed = parseRecord(declined[0]);
      expect(parsed.fields.reason).toBe(reason);
      expect(parsed.fields.milestone).toBe("M6");
      return parsed;
    }

    it("byte-identical: a re-write of the stamped bytes is not new work", async () => {
      const s = "decline-identical";
      const base = `impl-M6-first-${s}-gen0.md`;
      await reopenWithStamp(s, base);
      clearLog();

      const result = hooks.settleStampClearForArtifact(s, hooks.sessionPhaseMap, {
        dir: knowledgeDir,
        base,
        milestoneId: "M6"
      });
      expect(result.settled).toBe(false);
      expect(result.reason).toBe("byte-identical");
      declinedExactly("byte-identical");
      expect(readRegistry(s)).toContain("  M6: in-progress");
      // Nothing is deleted or rewritten: the stamped bytes stay as written.
      expect(readFileSync(join(knowledgeDir, base), "utf8")).toContain("status: superseded");
      expect(records("CHECKOFF")).toHaveLength(0);
    });

    it("not-in-progress: only a reopened row has a stamp to clear", async () => {
      const s = "decline-state";
      const base = `impl-M6-first-${s}-gen0.md`;
      await startSwarm(s, [["M6", "checked-off"]]);
      createKD(base, implKD(s));
      clearLog();

      const result = hooks.settleStampClearForArtifact(s, hooks.sessionPhaseMap, {
        dir: knowledgeDir,
        base,
        milestoneId: "M6"
      });
      expect(result.reason).toBe("not-in-progress");
      declinedExactly("not-in-progress");
      expect(readFileSync(join(knowledgeDir, base), "utf8")).toContain("status: draft");
    });

    it("not-cited-artifact: another milestone's evidence is outside this row", async () => {
      const s = "decline-cited";
      const base = `impl-M6-first-${s}-gen0.md`;
      await startSwarm(s, [["M6", "in-progress"]]);
      createKD(base, implKD(s));
      clearLog();

      const result = hooks.settleStampClearForArtifact(s, hooks.sessionPhaseMap, {
        dir: knowledgeDir,
        base: `impl-M7-other-${s}-gen0.md`,
        milestoneId: "M6"
      });
      expect(result.reason).toBe("not-cited-artifact");
      declinedExactly("not-cited-artifact");
      expect(readFileSync(join(knowledgeDir, base), "utf8")).toContain("status: draft");
    });

    it("no-stamp-snapshot: a stamp the gate did not write is never cleared", async () => {
      const s = "decline-snapshot";
      const base = `impl-M6-unstamped-${s}-gen0.md`;
      await startSwarm(s, [["M6", "in-progress"]]);
      createKD(base, implKD(s, "superseded"));
      clearLog();

      const result = hooks.settleStampClearForArtifact(s, hooks.sessionPhaseMap, {
        dir: knowledgeDir,
        base,
        milestoneId: "M6"
      });
      expect(result.reason).toBe("no-stamp-snapshot");
      declinedExactly("no-stamp-snapshot");
      expect(readFileSync(join(knowledgeDir, base), "utf8")).toContain("status: superseded");
    });

    it("write-failed: an artifact that is gone cannot be verified", async () => {
      const s = "decline-missing";
      const base = `impl-M6-first-${s}-gen0.md`;
      await reopenWithStamp(s, base);
      rmSync(join(knowledgeDir, base), { force: true });
      clearLog();

      const result = hooks.settleStampClearForArtifact(s, hooks.sessionPhaseMap, {
        dir: knowledgeDir,
        base,
        milestoneId: "M6"
      });
      expect(result.reason).toBe("write-failed");
      declinedExactly("write-failed");
      expect(readRegistry(s)).toContain("  M6: in-progress");
    });

    it("unparsable-frontmatter: bytes the gate cannot read are never amended", async () => {
      const s = "decline-unparsable";
      const base = `impl-M6-first-${s}-gen0.md`;
      await reopenWithStamp(s, base);
      createKD(base, "# Fix evidence with no frontmatter at all\n");
      clearLog();

      const result = hooks.settleStampClearForArtifact(s, hooks.sessionPhaseMap, {
        dir: knowledgeDir,
        base,
        milestoneId: "M6"
      });
      expect(result.reason).toBe("unparsable-frontmatter");
      declinedExactly("unparsable-frontmatter");
      // The author's bytes are left exactly as written — no invented status.
      expect(readFileSync(join(knowledgeDir, base), "utf8")).toBe("# Fix evidence with no frontmatter at all\n");
      expect(readRegistry(s)).toContain("  M6: in-progress");
    });
  });

  // A reopened row re-closes through the ordinary redispatch route: the fix-up
  // lands over the stamped artifact, the gate amends its own stamp, and the row
  // promotes only after the landed bytes are read back. Nothing here uses a
  // manual transition — the transports below are the ones a writer actually has.
  describe("re-close across write transports", () => {
    it("a full-content write that declares the sanctioned state re-closes the row", async () => {
      const s = "reclose-write-a";
      const artisan = "reclose-write-a-artisan";
      const base = `impl-M6-first-${s}-gen0.md`;
      const relPath = `knowledge/${base}`;
      await reopenWithStamp(s, base);
      clearLog();

      const fixBody = `${implKD(s, "amended")}\n# Fix evidence: rebuilt behavior\n`;
      await artisanWrite(artisan, relPath, fixBody, "c-a");
      // Before the bytes land, the stamp on disk still governs: no checked-off
      // row may sit over a superseded artifact.
      expect(readRegistry(s)).toContain("  M6: in-progress");
      expect(readFileSync(join(knowledgeDir, base), "utf8")).toContain("status: superseded");

      await landAndSettle(artisan, relPath, fixBody, "c-a");
      const landed = readFileSync(join(knowledgeDir, base), "utf8");
      expect(landed).toContain("status: amended");
      expect(landed).toContain(`superseded_by: ${base}`);
      expect(landed).toContain("# Fix evidence: rebuilt behavior");
      expect(readRegistry(s)).toContain("  M6: checked-off");
      // The author wrote a live status, so the gate recorded the lineage the
      // artifact gained rather than claiming it cleared its own stamp.
      expect(records("STAMP_LINEAGE_RECORDED")).toHaveLength(1);
      expect(records("STAMP_CLEARED")).toHaveLength(0);
      const checkoff = records("CHECKOFF");
      expect(checkoff).toHaveLength(1);
      expect(parseRecord(checkoff[0]).fields).toMatchObject({
        milestone: "M6",
        artifact: base,
        promoted: "true"
      });
    });

    it("an edit patch re-closes only after the landed bytes are verified", async () => {
      const s = "reclose-edit-b";
      const artisan = "reclose-edit-b-artisan";
      const base = `impl-M6-first-${s}-gen0.md`;
      const relPath = `knowledge/${base}`;
      await reopenWithStamp(s, base);
      clearLog();

      await hooks["chat.params"]({ sessionID: artisan, agent: "artisan" }, {});
      const callID = "c-b";
      // An edit carries a patch fragment, not a whole file: the hook cannot see
      // the resulting frontmatter, so it must defer to the landed bytes.
      await hooks["tool.execute.before"](
        { tool: "edit", sessionID: artisan, callID },
        { args: { filePath: relPath, newString: "# Fix evidence\n" } }
      );
      expect(readRegistry(s)).toContain("  M6: in-progress");
      expect(readRegistry(s)).not.toContain("  M6: checked-off");
      expect(readFileSync(join(knowledgeDir, base), "utf8")).toContain("status: superseded");

      // The patch applies: new body, stamp preserved — the case that used to
      // leave a checked-off row sitting over a superseded artifact.
      createKD(base, `${implKD(s, "superseded")}\n# Fix evidence\n`);
      await hooks["tool.execute.after"]({ tool: "edit", sessionID: artisan, callID }, {});

      const landed = readFileSync(join(knowledgeDir, base), "utf8");
      expect(landed).toContain("status: amended");
      expect(landed).not.toContain("status: superseded");
      expect(landed).toContain(`superseded_by: ${base}`);
      expect(landed).toContain("# Fix evidence");
      expect(readRegistry(s)).toContain("  M6: checked-off");
      expect(records("STAMP_CLEARED")).toHaveLength(1);
      expect(records("STAMP_DECLINED")).toHaveLength(0);
    });

    it("an absolute, dot-prefixed or nested write path all settle", async () => {
      const s = "reclose-paths-c";
      const artisan = "reclose-paths-c-artisan";
      const base = `impl-M6-first-${s}-gen0.md`;
      // The observed write path is a hint, never an admission gate: whatever
      // shape the writer's path takes, settlement evaluates the disk.
      const pathForms = [
        ["plain", `knowledge/${base}`],
        ["dot-prefixed", `./knowledge/${base}`],
        ["absolute", join(knowledgeDir, base)],
        ["nested", `knowledge/nested/${base}`]
      ];
      for (const [name, relPath] of pathForms) {
        await reopenWithStamp(s, base);
        const fixBody = `${implKD(s, "superseded")}\n# Fix evidence: ${name}\n`;
        await artisanWrite(artisan, relPath, fixBody, `c-c-${name}`);
        await landAndSettle(artisan, relPath, fixBody, `c-c-${name}`);
        expect(readRegistry(s), name).toContain("  M6: checked-off");
        const landed = readFileSync(join(knowledgeDir, base), "utf8");
        expect(landed, name).toContain("status: amended");
        expect(landed, name).toContain("# Fix evidence: " + name);
      }
    });

    it("an amendment delivered outside the write hook settles at the next gate evaluation", async () => {
      const s = "reclose-shell-d";
      const base = `impl-M6-first-${s}-gen0.md`;
      await reopenWithStamp(s, base);
      clearLog();

      // The fix-up lands by another transport (a shell heredoc, an editor, a
      // restore) — no write hook ever sees the bytes.
      createKD(base, `${implKD(s, "superseded")}\n# Fix evidence: delivered out of band\n`);
      expect(readRegistry(s)).toContain("  M6: in-progress");

      await gateEvaluate(s, "c-d");
      expect(records("STAMP_CLEARED")).toHaveLength(1);
      expect(readFileSync(join(knowledgeDir, base), "utf8")).toContain("status: amended");
      expect(readRegistry(s)).toContain("  M6: checked-off");
      expect(hooks.checkAllMilestonesCheckedOff(s, hooks.sessionPhaseMap).ok).toBe(true);
    });
  });

  // The reopen target lives in the review frontmatter and nowhere else: the
  // prose a review KD carries is provenance the gate never scans. These cases
  // pin the accepted forms and every refusal, each with the reason it records.
  describe("reopen target field", () => {
    const threeRows = [["M1", "checked-off"], ["M2", "checked-off"], ["M3", "checked-off"]];

    it("a scalar target reopens exactly that row", async () => {
      const s = "target-scalar";
      await startVerify(s, threeRows);
      createKD(`review-fail-${s}.md`, reviewKD("FAIL", "M2"));
      clearLog();
      await gateEvaluate(s, "c-target-scalar");
      expect(registryRows(s)).toEqual({ M1: "checked-off", M2: "in-progress", M3: "checked-off" });
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.SWARM);
      expect(records("REOPEN")).toHaveLength(1);
      expect(parseRecord(records("REOPEN")[0]).fields.milestone).toBe("M2");
    });

    it("a flow-sequence target reopens exactly the named rows", async () => {
      const s = "target-sequence";
      await startVerify(s, threeRows);
      createKD(`review-fail-${s}.md`, reviewKD("FAIL", "[M2, M3]"));
      clearLog();
      await gateEvaluate(s, "c-target-sequence");
      expect(registryRows(s)).toEqual({ M1: "checked-off", M2: "in-progress", M3: "in-progress" });
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.SWARM);
      expect(records("REOPEN")).toHaveLength(2);
    });

    it("prose milestone tokens never reopen anything — only the field does", async () => {
      const s = "target-prose-inert";
      await startVerify(s, threeRows);
      // The findings, the traceability matrix and a References list all name
      // impl KDs. Those are provenance: the gate reads the field, not the prose.
      const prose = `---
title: "REVIEW: test"
version: 1.0.0
status: draft
type: review
session_id: "ses_test"
author: Inspector
superseded_by: null
verdict: FAIL
reopen_target: [M1]
---

# REVIEW: test

## Verdict

FAIL

## Review Findings

### F001: defect

- **Milestone citation**: impl-M2-broken
- **Status**: FAIL

### Traceability Matrix

| Req ID | Plan Step | Artifact                 | Test/Check | Status |
| ------ | --------- | ------------------------ | ---------- | ------ |
| R001   | P001      | impl-M3-also-broken      | test       | FAIL   |

## Audit

### Scope

audited

## References

- \`knowledge/impl-M1-one-${s}.md\`
- \`knowledge/impl-M2-two-${s}.md\`
- \`knowledge/impl-M3-three-${s}.md\`
`;
      createKD(`review-fail-${s}.md`, prose);
      clearLog();
      await gateEvaluate(s, "c-target-prose");
      expect(registryRows(s)).toEqual({ M1: "in-progress", M2: "checked-off", M3: "checked-off" });
    });

    for (const [label, value, reason] of [
      ["absent", null, "no-reopen-target"],
      ["empty sequence", "[]", "no-reopen-target"],
      ["empty string", '""', "no-reopen-target"],
      ["null literal", "null", "no-reopen-target"],
      ["malformed token", "[M2!, M3]", "invalid-reopen-target"],
      ["unresolvable id", "[M9]", "unresolvable-reopen-target"]
    ]) {
      it(`refuses a ${label} target, naming the reason and regressing nothing`, async () => {
        const s = `target-refuse-${reason}-${label.replace(/\s+/g, "-")}`;
        await startVerify(s, threeRows);
        createKD(`review-fail-${s}.md`, reviewKD("FAIL", value));
        clearLog();
        await gateEvaluate(s, `c-target-${label}`);
        // Blocked in VERIFY: no regression, no reopen, and the refusal is on
        // the always-on channel with the field to write back.
        expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.VERIFY);
        expect(registryRows(s)).toEqual({ M1: "checked-off", M2: "checked-off", M3: "checked-off" });
        const invalid = records("REOPEN_TARGET_INVALID");
        expect(invalid).toHaveLength(1);
        expect(parseRecord(invalid[0]).fields).toMatchObject({ session: s, reason });
        expect(parseRecord(invalid[0]).cause).toContain("reopen_target");
      });
    }

    it("refuses a duplicate target key instead of picking one", async () => {
      const s = "target-duplicate";
      await startVerify(s, threeRows);
      createKD(`review-fail-${s}.md`, reviewKD("FAIL", ["[M1]", "[M2]"]));
      clearLog();
      await gateEvaluate(s, "c-target-duplicate");
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.VERIFY);
      expect(registryRows(s)).toEqual({ M1: "checked-off", M2: "checked-off", M3: "checked-off" });
      const invalid = records("REOPEN_TARGET_INVALID");
      expect(invalid).toHaveLength(1);
      expect(parseRecord(invalid[0]).fields.reason).toBe("ambiguous-target");
    });

    it("a target that is already in-progress records the no-op rather than reopening", async () => {
      const s = "target-noop";
      await startVerify(s, [["M1", "checked-off"], ["M2", "in-progress"]]);
      createKD(`review-fail-${s}.md`, reviewKD("FAIL", "[M2]"));
      clearLog();
      await gateEvaluate(s, "c-target-noop");
      const noop = records("REOPEN_NOOP");
      expect(noop).toHaveLength(1);
      expect(parseRecord(noop[0]).fields).toMatchObject({ milestone: "M2", reason: "not-checked-off" });
      // A FAIL that names only a non-checked-off row still blocks SWARM→VERIFY.
      expect(registryRows(s)).toEqual({ M1: "checked-off", M2: "in-progress" });
    });

    it("an escalation without a target blocks and says to escalate", async () => {
      const s = "target-escalation";
      await startVerify(s, threeRows);
      createKD(
        `review-fail-${s}.md`,
        reviewKD("FAIL", null, "The fix loop cannot address this: the upstream contract is ambiguous.")
      );
      clearLog();
      await gateEvaluate(s, "c-target-escalation");
      expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.VERIFY);
      expect(registryRows(s)).toEqual({ M1: "checked-off", M2: "checked-off", M3: "checked-off" });
      const invalid = records("REOPEN_TARGET_INVALID");
      expect(invalid).toHaveLength(1);
      expect(parseRecord(invalid[0]).fields.reason).toBe("no-reopen-target");
      expect(parseRecord(invalid[0]).cause).toContain("escalate");
    });

    it("a PASS carrying the field records that it was ignored and reopens nothing", async () => {
      const s = "target-pass";
      await startVerify(s, threeRows);
      createKD(`review-pass-${s}.md`, reviewKD("PASS", "[M2]"));
      clearLog();
      await gateEvaluate(s, "c-target-pass");
      const ignored = records("REOPEN_TARGET_IGNORED");
      expect(ignored).toHaveLength(1);
      expect(parseRecord(ignored[0]).fields).toMatchObject({ session: s, target: "M2" });
      expect(registryRows(s)).toEqual({ M1: "checked-off", M2: "checked-off", M3: "checked-off" });
      expect(records("REOPEN")).toHaveLength(0);
    });
  });

  // A suspended row survives a restart. The digest is persisted with the rest of
  // the phase state, so a gate that comes back up can still tell a genuine
  // fix-up from the stamp it wrote — losing it would strand the row forever,
  // forgetting it would promote over a stamp the gate no longer recognises.
  it("stamp digests survive a restart and still settle", async () => {
    const s = "reclose-restart";
    const base = `impl-M6-first-${s}-gen0.md`;
    await reopenWithStamp(s, base);

    const stateFile = readdirSync(stateDir).find((f) => f.startsWith(".protocol-state-") && f.endsWith(".json"));
    expect(stateFile, "no state file was written").toBeTruthy();
    const persisted = JSON.parse(readFileSync(join(stateDir, stateFile), "utf8"));
    const key = `M6|${base}`;
    expect(Object.keys(persisted.stampSnapshots || {})).toContain(key);
    const digest = persisted.stampSnapshots[key];
    expect(typeof digest).toBe("string");
    expect(digest.length).toBeGreaterThan(0);

    // A second plugin instance stands in for the restarted gate: it reconciles
    // from the state file and nothing else.
    const restarted = await pluginModule.server({}, {});
    await restarted["chat.params"]({ sessionID: s, agent: "overseer" }, {});
    expect(restarted.sessionPhaseMap.get(s)).toBe(hooks.STATES.SWARM);
    const restored = restarted.sessionPhaseMap.get(`${s}:stampSnapshots`);
    expect(restored && restored[key], "the stamp suspension was lost across the restart").toBe(digest);

    // The fix-up landed while the gate was down; the restarted instance settles
    // it from the persisted digest.
    createKD(base, `${implKD(s, "superseded")}\n# Fix evidence: landed during the restart\n`);
    await restarted["tool.execute.before"](
      { tool: "glob", sessionID: s, callID: "c-restart" },
      { args: { pattern: "knowledge/*.md" } }
    );
    const landed = readFileSync(join(knowledgeDir, base), "utf8");
    expect(landed).toContain("status: amended");
    expect(readRegistry(s)).toContain("  M6: checked-off");
  });
});
