import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
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
      trigger: `FAIL citations in review KD review-fail-${s}.md`
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
});
