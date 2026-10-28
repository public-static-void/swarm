import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import pluginModule from "../../../plugins/protocol-gate/index.js";
import { createWalkHarness, FRESH_MARGIN_MS, implKDContent, stampFresh } from "./walk-unification-fixture.js";

// Observability of the control gates: the dispatch refusal names the phase the
// lifecycle is actually in, and every walk mutation that exists today leaves an
// always-on record. Every assertion runs with PROTOCOL_GATE_DEBUG absent and
// the debug sentinel pointing at a path that does not exist.
describe("Protocol-Gate override walk observability", () => {
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
    tempRoot = mkdtempSync(join(tmpdir(), "pg-walk-"));
    knowledgeDir = join(tempRoot, "knowledge");
    stateDir = join(tempRoot, "state");
    priorKnowledgeDir = process.env.PROTOCOL_GATE_KNOWLEDGE_DIR;
    priorStateDir = process.env.PROTOCOL_GATE_STATE_DIR;
    priorLogDir = process.env.PROTOCOL_GATE_LOG_DIR;
    priorDebugFile = process.env.PROTOCOL_GATE_DEBUG_FILE;
    priorDebug = process.env.PROTOCOL_GATE_DEBUG;
    process.env.PROTOCOL_GATE_KNOWLEDGE_DIR = knowledgeDir;
    process.env.PROTOCOL_GATE_STATE_DIR = stateDir;
    protocolLogDir = mkdtempSync(join(tmpdir(), "pg-walk-log-"));
    process.env.PROTOCOL_GATE_LOG_DIR = protocolLogDir;
    logPath = join(protocolLogDir, "protocol-gate.log");
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

  // Same bytes as createKD, then stamped forward of the anchor the gate will
  // compare against. The gates read `mtimeMs >= anchor` where the anchor is an
  // integer millisecond value; the filesystem's mtime grid is coarser, so a
  // write issued after the anchor can be stored before it and no comparison can
  // recover the ordering. This inline harness keeps its own constructors
  // because it predates the shared one; the stamp itself is shared, never
  // re-implemented per site.
  function createFreshKD(filename, content = "test content") {
    createKD(filename, content);
    stampFresh(join(knowledgeDir, filename));
  }

  function clearLog() {
    try { rmSync(logPath, { force: true }); } catch (_) {}
  }

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

  // A FAIL states its reopen target in the review frontmatter (FR-11); the
  // finding body names the same row as inert prose.
  function reviewKD(verdict, target) {
    const targetLine = verdict === "FAIL" && target ? `reopen_target: [${target}]\n` : "";
    return `---
title: "REVIEW: test"
version: 1.0.0
status: draft
type: review
session_id: "ses_test"
author: Inspector
superseded_by: null
verdict: ${verdict}
${targetLine}---

# REVIEW: test

## Verdict

${verdict}

## Review Findings

### F001: defect

- **Milestone**: ${target}
- **Status**: ${verdict}
`;
  }

  async function initOverseer(s) {
    await hooks["chat.params"]({ sessionID: s, agent: "overseer" }, {});
  }

  // skill is allowlisted in every phase with no handler side effects, so its
  // calls purely re-evaluate lifecycle state against KD evidence on disk.
  async function tick(s, callID) {
    await hooks["tool.execute.before"]({ tool: "skill", sessionID: s, callID }, { args: {} });
  }

  // A plain write can never land FRESH_MARGIN_MS in the future, so this
  // assertion fails deterministically at every tick phase when the write goes
  // through the plain constructor.
  it("the inline harness's fresh constructor stamps ahead of a captured anchor", () => {
    const anchor = Date.now();
    createFreshKD("intent-pin-legacy.md");
    const mtime = statSync(join(knowledgeDir, "intent-pin-legacy.md")).mtimeMs;
    expect(mtime).toBeGreaterThanOrEqual(anchor + FRESH_MARGIN_MS - 1);
  });

  it("refusal names the actual phase", async () => {
    // REPORT (12): the refusal names REPORT and never INTENT.
    const s = "obs-t15-report";
    await initOverseer(s);
    hooks.sessionPhaseMap.set(s, hooks.STATES.REPORT);
    hooks.sessionPhaseMap.set(`${s}:sid`, s);
    clearLog();

    expect(hooks.getEnablementState().enabled, "the debug channel is on — the record below proves nothing").toBe(false);

    let atReport = null;
    try {
      await hooks["tool.execute.before"](
        { tool: "subagent", sessionID: s, callID: "t15-report" },
        { args: { subagent_type: "committer", prompt: "AGENT: committer\nMODE: cleanup" } }
      );
    } catch (e) {
      atReport = e;
    }
    expect(atReport, "the dispatch ran instead of being refused at REPORT").toBeTruthy();
    expect(atReport.message).toContain("REPORT (12)");
    expect(atReport.message).not.toContain("INTENT");
    expect(atReport.message).toContain("REPORT is the terminal phase");
    // Falsifiable form: no other phase's name-and-number pair appears.
    for (const [name, number] of Object.entries(hooks.STATES)) {
      if (name === "REPORT") continue;
      expect(atReport.message, `the refusal at REPORT also names ${name} (${number})`).not.toContain(`${name} (${number})`);
    }
    const refused = records("DISPATCH_REFUSED");
    expect(refused, "the refusal left no always-on record").toHaveLength(1);
    expect(parseRecord(refused[0]).fields.phase).toBe("REPORT");
    expect(parseRecord(refused[0]).fields.number).toBe("12");

    // INTENT (1): the refusal names INTENT, and no phase the lifecycle is not in.
    const s1 = "obs-t15-intent";
    await initOverseer(s1);
    hooks.sessionPhaseMap.set(s1, hooks.STATES.INTENT);
    hooks.sessionPhaseMap.set(`${s1}:sid`, s1);
    let atIntent = null;
    try {
      await hooks["tool.execute.before"](
        { tool: "subagent", sessionID: s1, callID: "t15-intent" },
        { args: { subagent_type: "committer", prompt: "AGENT: committer\nMODE: preflight" } }
      );
    } catch (e) {
      atIntent = e;
    }
    expect(atIntent, "the dispatch ran instead of being refused at INTENT").toBeTruthy();
    expect(atIntent.message).toContain("INTENT (1)");
    expect(atIntent.message).not.toContain("REPORT");
    for (const [name, number] of Object.entries(hooks.STATES)) {
      if (name === "INTENT") continue;
      expect(atIntent.message, `the refusal at INTENT also names ${name} (${number})`).not.toContain(`${name} (${number})`);
    }
  });

  it("existing walk mutations are always-on", async () => {
    const s = "obs-t16-walk";
    await initOverseer(s);
    hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
    hooks.sessionPhaseMap.set(`${s}:sid`, s);
    createKD(`milestones-feature-${s}.md`, registryContent([["M6", "in-progress"]]));
    clearLog();

    expect(hooks.getEnablementState().enabled, "the debug channel is on — the records below prove nothing").toBe(false);

    // Commit: one WALK_COMMIT naming session, from, to and the committed queue.
    const out = { parts: [] };
    await hooks["command.execute.before"]({ command: "phase", sessionID: s, arguments: "{3,4,5}" }, out);
    expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.EXPLORE);
    const commit = records("WALK_COMMIT");
    expect(commit, "no always-on WALK_COMMIT record").toHaveLength(1);
    expect(parseRecord(commit[0]).fields).toMatchObject({ session: s, from: "7", to: "3", queue: "[3,4,5]" });

    // No fresh evidence: repeated evaluations emit nothing further.
    await tick(s, "t16-hold-1");
    await tick(s, "t16-hold-2");
    expect(records("WALK_COMMIT")).toHaveLength(1);
    expect(records("WALK_HOP")).toHaveLength(0);

    // Hop: fresh exploration evidence consumes the head and re-arms the queue.
    createFreshKD(`exploration-fresh-${s}.md`);
    await tick(s, "t16-hop-1");
    expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.INVESTIGATE);
    expect(hooks.sessionPhaseMap.get(`${s}:overrideUntil`).phases).toEqual([4, 5]);
    const hop = records("WALK_HOP");
    expect(hop, "no always-on WALK_HOP record").toHaveLength(1);
    expect(parseRecord(hop[0]).fields).toMatchObject({ from: "3", to: "4", queue: "[4,5]" });

    // A repeated evaluation at the new head emits no further hop line.
    await tick(s, "t16-hop-2");
    await tick(s, "t16-hop-3");
    expect(records("WALK_HOP")).toHaveLength(1);

    // Backward clear of a legacy single-phase pin: a pin is the user's, so a
    // regression still drops it — and now records why. A queue is suspended
    // instead; that contract lands with the walk unification case below.
    const b = "obs-t16-backward";
    await initOverseer(b);
    hooks.sessionPhaseMap.set(b, hooks.STATES.SWARM);
    hooks.sessionPhaseMap.set(`${b}:sid`, b);
    createKD(`milestones-feature-${b}.md`, registryContent([["M1", "checked-off"]]));
    createKD(`impl-M1-seed-${b}-gen0.md`, implKDContent(b));
    const outB = { parts: [] };
    await hooks["command.execute.before"]({ command: "phase", sessionID: b, arguments: "VERIFY" }, outB);
    expect(hooks.sessionPhaseMap.get(b)).toBe(hooks.STATES.VERIFY);
    expect(hooks.sessionPhaseMap.get(`${b}:overrideUntil`).phase).toBe(hooks.STATES.VERIFY);

    createFreshKD(`review-fail-${b}.md`, reviewKD("FAIL", "M1"));
    await tick(b, "t16-backward-1");
    expect(hooks.sessionPhaseMap.get(b)).toBe(hooks.STATES.SWARM);
    expect(hooks.sessionPhaseMap.has(`${b}:overrideUntil`)).toBe(false);
    const cleared = records("WALK_CLEARED").filter((line) => line.includes(`session=${b}`));
    expect(cleared, "no always-on WALK_CLEARED record for the backward transition").toHaveLength(1);
    const clearedRecord = parseRecord(cleared[0]);
    expect(clearedRecord.fields.reason).toBe("backward-pin");
    expect(clearedRecord.fields.from).toBe("8");
    expect(clearedRecord.fields.to).toBe("7");
    expect(clearedRecord.fields.queue).toBe("[8]");
  });
});

// The queue is authoritative at every forward-advance site: one next-hop
// decision, one transition commit, freshness anchored per hop, and the walk
// survives a regression instead of being deleted.
describe("Protocol-Gate override walk unification", () => {
  const h = createWalkHarness(beforeAll, afterAll, beforeEach);

  // A session parked at SWARM. The registry and impl KDs are written AFTER the
  // walk commit in each case: a hop's evidence must postdate the walk anchor.
  async function swarmSession(s) {
    await h.initOverseer(s);
    h.hooks.sessionPhaseMap.set(s, h.hooks.STATES.SWARM);
    h.hooks.sessionPhaseMap.set(`${s}:sid`, s);
    return s;
  }

  // A checked-off registry whose rows carry their impl KDs on disk — the
  // evidence the SWARM hop advances on.
  function swarmEvidence(s, rows = [["M1", "checked-off"]]) {
    h.createFreshRegistry(s, rows);
    for (const [id] of rows) h.createFreshKD(`impl-${id}-${s}.md`, h.implKD(s));
  }

  // Closes a milestone row the FAIL regression reopened, backed by a fresh
  // impl KD so the all-checked-off gate sees disk evidence.
  function reclose(s, id = "M1") {
    h.createFreshKD(`impl-${id}-repair-${s}.md`, h.implKD(s));
    h.hooks.updateMilestoneRegistry(s, h.hooks.sessionPhaseMap, id, ["checked-off"]);
  }

  function walkHopRecords(s) {
    return h.records("WALK_HOP").map(h.parseRecord).filter((r) => r.fields.session === s);
  }

  // A plain write can never land FRESH_MARGIN_MS in the future, so this
  // assertion fails deterministically at every tick phase when the write goes
  // through the plain constructor.
  it("the shared harness's fresh constructor stamps ahead of a captured anchor", () => {
    const anchor = Date.now();
    h.createFreshKD("intent-pin-harness.md");
    const mtime = statSync(join(h.knowledgeDir(), "intent-pin-harness.md")).mtimeMs;
    expect(mtime).toBeGreaterThanOrEqual(anchor + FRESH_MARGIN_MS - 1);
  });

  it("SWARM hand-off follows the named hop", async () => {
    const s = await swarmSession("walk-t6");
    await h.commit(s, "{1,7,10}");
    expect(h.marker(s).phases, "the queue was not committed").toEqual([1, 7, 10]);
    // Evidence written after the walk commit — a hop is never satisfied by a
    // pre-walk artifact.
    swarmEvidence(s, [["M1", "checked-off"], ["M2", "in-progress"]]);

    // The fresh intent KD walks the head from INTENT to the SWARM hop.
    h.createFreshKD(`intent-fresh-${s}.md`);
    await h.tick(s, "t6-hop-1");
    expect(h.hooks.sessionPhaseMap.get(s)).toBe(h.hooks.STATES.SWARM);
    expect(h.marker(s).phases).toEqual([7, 10]);
    h.clearLog();

    // The artisan's final impl KD lands from a subagent session; the after-hook
    // advances the parent on the landed evidence.
    const artisan = `${s}-artisan`;
    await h.hooks["chat.params"]({ sessionID: artisan, agent: "artisan" }, {});
    await h.hooks["tool.execute.before"](
      { tool: "write", sessionID: artisan, callID: "t6-w" },
      { args: { filePath: `knowledge/impl-M2-${s}.md`, content: h.implKD(s) } }
    );
    expect(h.hooks.sessionPhaseMap.get(s), "the SWARM gate advanced before the KD landed").toBe(h.hooks.STATES.SWARM);
    h.createFreshKD(`impl-M2-${s}.md`, h.implKD(s));
    await h.hooks["tool.execute.after"](
      { tool: "write", sessionID: artisan, callID: "t6-w" },
      { output: "done", title: "impl" }
    );

    // The named hop is EVOLVE (10) — never the serial VERIFY (8).
    expect(h.hooks.sessionPhaseMap.get(s)).toBe(h.hooks.STATES.EVOLVE);
    expect(h.marker(s).phases).toEqual([10]);
    const hops = walkHopRecords(s);
    expect(hops, "no always-on WALK_HOP record for the parent hand-off").toHaveLength(1);
    expect(hops[0].fields).toMatchObject({ from: "7", to: "10", queue: "[10]" });
  });

  it("force-advance at the head follows the named hop", async () => {
    // Each of the three force mechanisms, driven at a walk head of EXPLORE (3)
    // with the plan [3,5]: the next named hop is ALIGN (5), never VERIFY (8).
    const setup = async (s) => {
      await swarmSession(s);
      await h.commit(s, "{3,5}");
      swarmEvidence(s);
      expect(h.hooks.sessionPhaseMap.get(s)).toBe(h.hooks.STATES.EXPLORE);
      h.clearLog();
    };

    // (a) 15 stuck disk checks.
    const a = "walk-t7-failures";
    await setup(a);
    for (let i = 0; i < 15; i++) await h.glob(a, `t7-a-${i}`);
    expect(h.hooks.sessionPhaseMap.get(a), "the 15-failure force-advance landed on the serial VERIFY").toBe(h.hooks.STATES.ALIGN);
    expect(h.marker(a).phases, "the force advance did not pop the queue head").toEqual([5]);

    // (b) re-dispatch cap.
    const b = "walk-t7-redispatch";
    await setup(b);
    h.hooks.phaseRedispatchCount.set(`${b}:${h.hooks.STATES.EXPLORE}`, 5);
    await expect(
      h.hooks["tool.execute.before"](
        { tool: "subagent", sessionID: b, callID: "t7-b" },
        { args: { subagent_type: "explorer", prompt: "DISPATCH TO: explorer\nMODE: explore" } }
      )
    ).rejects.toThrow();
    expect(h.hooks.sessionPhaseMap.get(b), "the redispatch-cap force-advance landed on the serial VERIFY").toBe(h.hooks.STATES.ALIGN);
    expect(h.marker(b).phases).toEqual([5]);

    // (c) pendingVerification tool-call timeout. The timeout fires at 15 tool
    // calls, so the counter is seeded to the call before it — the 15-failure
    // mechanism is re-zeroed per call so this leg proves this path alone.
    const c = "walk-t7-pending";
    await setup(c);
    h.hooks.pendingVerification.set(c, { expectedPrefixes: ["exploration"], toolType: "write", timestamp: Date.now(), toolCalls: 0 });
    h.hooks.pendingVerificationToolCount.set(c, 14);
    h.hooks.diskCheckFailures.set(c, 0);
    await h.glob(c, "t7-c-1");
    expect(h.hooks.sessionPhaseMap.get(c), "the pendingVerification force-advance landed on the serial VERIFY").toBe(h.hooks.STATES.ALIGN);
    expect(h.marker(c).phases).toEqual([5]);
  });

  it("FAIL suspends the walk and re-anchors the hop", async () => {
    const s = await swarmSession("walk-t11");
    await h.commit(s, "{7,8,10}");
    swarmEvidence(s);
    // The walk anchor. Artifacts written during the walk are placed just past
    // it rather than by the uniform forward margin: each must postdate `since`
    // and stay older than the re-entry anchor the resume installs later, and
    // the forward margin would overshoot the second bound.
    const walkSince = h.marker(s).since;

    // An EVOLVE artifact written during the walk, before the regression: it is
    // fresh against the walk's own `since` but older than any re-entry anchor.
    h.createKD(`process-early-${s}.md`, "process evidence");
    h.ageKD(`process-early-${s}.md`, walkSince + 1);
    await h.tick(s, "t11-hop");
    expect(h.hooks.sessionPhaseMap.get(s)).toBe(h.hooks.STATES.VERIFY);
    expect(h.marker(s).phases).toEqual([8, 10]);
    const earlyMtime = Date.now() - 1;

    // The 7 → 8 hop above is already on the log; clear it so the hop-count
    // assertions below mean "no hop was consumed by this evaluation".
    h.clearLog();
    // The FAIL must postdate the walk anchor (the override evaluates the verdict
    // only after freshness) and stay older than the re-entry anchor the resume
    // installs — the same two bounds as the EVOLVE artifact above.
    h.createKD(`review-fail-${s}.md`, h.reviewKD("FAIL", "M1"));
    h.ageKD(`review-fail-${s}.md`, walkSince + 1);
    await h.tick(s, "t11-fail");
    expect(h.hooks.sessionPhaseMap.get(s), "the FAIL did not regress to SWARM").toBe(h.hooks.STATES.SWARM);

    // The walk survives the regression: plan, anchor and safe point intact.
    const suspended = h.marker(s);
    expect(suspended, "the regression deleted the walk plan").toBeTruthy();
    expect(suspended.phases).toEqual([8, 10]);
    expect(suspended.state).toBe("suspended");
    expect(typeof suspended.suspendedAt).toBe("number");
    expect(h.safePoint(s)?.phase, "the regression dropped the walk safe point").toBe(h.hooks.STATES.SWARM);
    const suspendedRecords = h.records("WALK_SUSPENDED").map(h.parseRecord).filter((r) => r.fields.session === s);
    expect(suspendedRecords, "no always-on WALK_SUSPENDED record").toHaveLength(1);
    expect(suspendedRecords[0].fields).toMatchObject({ from: "8", to: "7", queue: "[8,10]" });

    // The repair re-closes the row; the head is re-entered and re-anchored.
    reclose(s);
    await h.tick(s, "t11-repair");
    expect(h.hooks.sessionPhaseMap.get(s), "the repair did not resume into the walk head").toBe(h.hooks.STATES.VERIFY);
    const resumed = h.marker(s);
    expect(resumed.phases).toEqual([8, 10]);
    expect(resumed.state).not.toBe("suspended");
    expect(typeof resumed.hopSince, "the re-entered hop carries no hopSince anchor").toBe("number");
    expect(resumed.hopSince).toBeGreaterThan(earlyMtime);
    const resumeRecords = h.records("WALK_RESUMED").map(h.parseRecord).filter((r) => r.fields.session === s);
    expect(resumeRecords, "no always-on WALK_RESUMED record").toHaveLength(1);
    expect(resumeRecords[0].fields).toMatchObject({ phase: "8", hopSince: String(resumed.hopSince) });

    // The pre-FAIL review cannot satisfy the re-entered hop.
    await h.tick(s, "t11-stale-pass");
    expect(h.hooks.sessionPhaseMap.get(s), "the pre-FAIL review satisfied the re-entered hop").toBe(h.hooks.STATES.VERIFY);
    expect(walkHopRecords(s), "the pre-FAIL review consumed the hop").toHaveLength(0);

    // A fresh PASS advances to the next named hop (EVOLVE 10, not EXTRACT 9).
    h.createFreshKD(`review-pass-${s}.md`, h.reviewKD("PASS"));
    await h.tick(s, "t11-pass");
    expect(h.hooks.sessionPhaseMap.get(s)).toBe(h.hooks.STATES.EVOLVE);
    expect(h.marker(s).phases).toEqual([10]);
    expect(h.marker(s).hopSince, "the consumed hop kept its re-entry anchor").toBeUndefined();

    // With the anchor back at the walk's `since`, the earlier EVOLVE artifact
    // still counts — the hop completes on evidence written during the walk.
    await h.tick(s, "t11-evolve");
    expect(h.hooks.sessionPhaseMap.get(s), "the earlier EVOLVE artifact no longer counted").toBe(h.hooks.STATES.CLEANUP);
    expect(h.marker(s), "the exhausted queue did not clear").toBeFalsy();
  });

  it("AC-22's queued walk lands the PASS at VERIFY on the named hop", async () => {
    // The reported crossing, instantiated literally: a walk queued from INTENT
    // naming SWARM, VERIFY, EVOLVE, CLEANUP and REPORT — EXTRACT (9) is absent
    // from the queue, so the PASS at VERIFY must take EVOLVE (10).
    const s = await swarmSession("walk-ac22");
    await h.commit(s, "{1,6,7,8,10,11,12}");
    expect(h.marker(s).phases, "the queue was not committed as given").toEqual([1, 6, 7, 8, 10, 11, 12]);

    // INTENT → DECOMPOSE on a fresh intent KD.
    h.createFreshKD(`intent-ac22-${s}.md`);
    await h.tick(s, "ac22-1");
    expect(h.hooks.sessionPhaseMap.get(s)).toBe(h.hooks.STATES.DECOMPOSE);
    expect(h.marker(s).phases).toEqual([6, 7, 8, 10, 11, 12]);

    // DECOMPOSE → SWARM on a fresh plan KD and the milestone registry (the
    // dual-KD gate).
    h.createFreshKD(`plan-ac22-${s}.md`);
    swarmEvidence(s);
    await h.tick(s, "ac22-2");
    expect(h.hooks.sessionPhaseMap.get(s)).toBe(h.hooks.STATES.SWARM);

    // SWARM → VERIFY on the all-checked-off gate, on evidence written after the
    // SWARM entry anchor.
    swarmEvidence(s);
    await h.tick(s, "ac22-3");
    expect(h.hooks.sessionPhaseMap.get(s)).toBe(h.hooks.STATES.VERIFY);
    expect(h.marker(s).phases).toEqual([8, 10, 11, 12]);
    h.clearLog();

    // The fresh PASS at VERIFY takes the named hop.
    h.createFreshKD(`review-pass-${s}.md`, h.reviewKD("PASS"));
    await h.tick(s, "ac22-4");
    expect(h.hooks.sessionPhaseMap.get(s), "the PASS landed on the serial EXTRACT instead of the named hop").toBe(h.hooks.STATES.EVOLVE);
    expect(h.marker(s).phases).toEqual([10, 11, 12]);
    const hops = walkHopRecords(s);
    expect(hops, "no always-on WALK_HOP record for the PASS crossing").toHaveLength(1);
    expect(hops[0].fields).toMatchObject({ from: "8", to: "10", queue: "[10,11,12]" });
  });

  it("REPORT terminal hop completes on arrival", async () => {
    // REPORT gains no KD prefix and no advancement predicate (FR-24 / AC-32).
    expect(h.hooks.KD_TYPE_PREFIXES[h.hooks.STATES.REPORT]).toBeUndefined();

    // (a) reached by a hop out of CLEANUP.
    const s = "walk-t10-hop";
    await h.initOverseer(s);
    h.hooks.sessionPhaseMap.set(s, h.hooks.STATES.EVOLVE);
    h.hooks.sessionPhaseMap.set(`${s}:sid`, s);
    await h.commit(s, "{10,11,12}");
    h.createFreshKD(`process-fresh-${s}.md`, "process evidence");
    await h.tick(s, "t10-1");
    expect(h.hooks.sessionPhaseMap.get(s)).toBe(h.hooks.STATES.CLEANUP);
    expect(h.marker(s).phases).toEqual([11, 12]);
    h.clearLog();

    h.createFreshKD(`cleanup-walk-${s}.md`, h.cleanupKD(s));
    await h.tick(s, "t10-2");
    expect(h.hooks.sessionPhaseMap.get(s), "the terminal REPORT hop did not complete").toBe(h.hooks.STATES.REPORT);
    expect(h.marker(s), "the completed walk left its marker behind").toBeFalsy();
    expect(h.safePoint(s), "the completed walk left its safe point behind").toBeFalsy();
    const complete = h.records("WALK_COMPLETE").map(h.parseRecord).filter((r) => r.fields.session === s);
    expect(complete, "no always-on WALK_COMPLETE record").toHaveLength(1);
    expect(complete[0].fields).toMatchObject({ terminal: "REPORT", kind: "hop" });
    expect(h.records("WALK_CLEARED").map(h.parseRecord).filter((r) => r.fields.session === s)).toHaveLength(0);

    // (b) a single-phase pin whose target is REPORT.
    const p = "walk-t10-pin";
    await h.initOverseer(p);
    h.hooks.sessionPhaseMap.set(p, h.hooks.STATES.EVOLVE);
    h.hooks.sessionPhaseMap.set(`${p}:sid`, p);
    h.clearLog();
    await h.commit(p, "REPORT");
    expect(h.hooks.sessionPhaseMap.get(p)).toBe(h.hooks.STATES.REPORT);
    expect(h.marker(p), "the REPORT pin left a live marker").toBeFalsy();
    const pinComplete = h.records("WALK_COMPLETE").map(h.parseRecord).filter((r) => r.fields.session === p);
    expect(pinComplete, "no always-on WALK_COMPLETE record for the pin").toHaveLength(1);
    expect(pinComplete[0].fields).toMatchObject({ terminal: "REPORT", kind: "pin" });
  });

  it("divergence refuses and records", async () => {
    const s = await swarmSession("walk-t9");
    const since = Date.now() - 1000;
    // A walk whose head (EXPLORE 3) sits behind the current phase (SWARM 7),
    // with SWARM's own gate fully satisfied — evidence must not win.
    h.seedWalk(s, [3, 5], since);
    h.hooks.sessionPhaseMap.set(`${s}:overrideSafePoint`, { phase: 7, marker: null });
    // SWARM's own gate is fully satisfied — the refusal cannot come from evidence.
    swarmEvidence(s);
    h.clearLog();

    await h.tick(s, "t9-1");
    expect(h.hooks.sessionPhaseMap.get(s), "a divergent walk advanced on presence evidence").toBe(h.hooks.STATES.SWARM);
    await h.tick(s, "t9-2");
    const diverged = h.records("WALK_DIVERGED").map(h.parseRecord).filter((r) => r.fields.session === s);
    expect(diverged, "no always-on WALK_DIVERGED record").toHaveLength(1);
    expect(diverged[0].fields).toMatchObject({ phase: "7", head: "3", queue: "[3,5]" });

    // A refusal at that phase names the divergence and the recovery.
    let refusal = null;
    try {
      await h.hooks["tool.execute.before"](
        { tool: "task", sessionID: s, callID: "t9-refuse" },
        { args: { subagent_type: "committer", prompt: "DISPATCH TO: committer\nMODE: preflight" } }
      );
    } catch (e) {
      refusal = e;
    }
    expect(refusal, "the dispatch at a divergent phase was allowed").toBeTruthy();
    expect(refusal.message).toContain("override divergence: phase=7 head=3 queue=[3,5]");
    expect(refusal.message).toContain("/phase clear or re-issue the walk to recover");
  });

  it("presence branch unreachable during a walk", async () => {
    // EXTRACT at the head with a pre-walk artifact: not evidence.
    const s = "walk-t17-extract";
    await h.initOverseer(s);
    h.hooks.sessionPhaseMap.set(s, h.hooks.STATES.EXTRACT);
    h.hooks.sessionPhaseMap.set(`${s}:sid`, s);
    h.createKD(`composed-old-${s}.md`, "composed evidence");
    h.ageKD(`composed-old-${s}.md`, Date.now() - 60000);
    await h.commit(s, "{9,10}");
    const anchor = h.marker(s).since;
    expect(anchor).toBeGreaterThan(0);
    h.clearLog();
    await h.tick(s, "t17-old");
    expect(h.hooks.sessionPhaseMap.get(s), "a pre-walk EXTRACT artifact completed the hop").toBe(h.hooks.STATES.EXTRACT);
    expect(walkHopRecords(s)).toHaveLength(0);

    // Positive control: an artifact at or after the anchor does complete it.
    h.createFreshKD(`composed-fresh-${s}.md`, "composed evidence");
    await h.tick(s, "t17-fresh");
    expect(h.hooks.sessionPhaseMap.get(s)).toBe(h.hooks.STATES.EVOLVE);
    expect(walkHopRecords(s)).toHaveLength(1);

    // EVOLVE at the head with a pre-walk artifact: not evidence either.
    const e = "walk-t17-evolve";
    await h.initOverseer(e);
    h.hooks.sessionPhaseMap.set(e, h.hooks.STATES.EVOLVE);
    h.hooks.sessionPhaseMap.set(`${e}:sid`, e);
    h.createKD(`process-old-${e}.md`, "process evidence");
    h.ageKD(`process-old-${e}.md`, Date.now() - 60000);
    await h.commit(e, "{10,11}");
    h.clearLog();
    await h.tick(e, "t17-evolve");
    expect(h.hooks.sessionPhaseMap.get(e)).toBe(h.hooks.STATES.EVOLVE);
    expect(walkHopRecords(e)).toHaveLength(0);

    // The presence branch is reachable today only where a walk exists and the
    // phase has run ahead of the head: there it consumes a pre-walk artifact
    // and advances. A live walk must refuse instead.
    const d = "walk-t17-diverged";
    await h.initOverseer(d);
    h.hooks.sessionPhaseMap.set(d, h.hooks.STATES.EVOLVE);
    h.hooks.sessionPhaseMap.set(`${d}:sid`, d);
    h.createKD(`process-pre-${d}.md`, "process evidence");
    h.ageKD(`process-pre-${d}.md`, Date.now() - 60000);
    h.seedWalk(d, [9, 10], Date.now() - 30000);
    h.clearLog();
    await h.tick(d, "t17-diverged");
    expect(h.hooks.sessionPhaseMap.get(d), "the presence branch consumed a pre-walk artifact mid-walk").toBe(h.hooks.STATES.EVOLVE);
    expect(walkHopRecords(d)).toHaveLength(0);

    // E1: a terminal SWARM hop completes on all-checked-off with a registry
    // mtime older than the walk anchor — SWARM never authors the registry.
    const w = "walk-t17-e1";
    await h.initOverseer(w);
    h.hooks.sessionPhaseMap.set(w, h.hooks.STATES.SWARM);
    h.hooks.sessionPhaseMap.set(`${w}:sid`, w);
    h.createRegistry(w, [["M1", "checked-off"]]);
    h.createKD(`impl-M1-${w}.md`, h.implKD(w));
    h.ageKD(`milestones-feature-${w}.md`, Date.now() - 60000);
    await h.commit(w, "{7}");
    expect(h.hooks.sessionPhaseMap.get(w)).toBe(h.hooks.STATES.SWARM);
    h.clearLog();
    await h.tick(w, "t17-e1");
    expect(h.hooks.sessionPhaseMap.get(w), "the terminal SWARM hop applied the registry-mtime anchor").not.toBe(h.hooks.STATES.SWARM);

    // E2: a CLEANUP hop completes on identity alone — the pre-walk artifact
    // advances because no clock is read on that branch.
    const c = "walk-t17-e2";
    await h.initOverseer(c);
    h.hooks.sessionPhaseMap.set(c, h.hooks.STATES.CLEANUP);
    h.hooks.sessionPhaseMap.set(`${c}:sid`, c);
    h.createKD(`cleanup-old-${c}.md`, h.cleanupKD(c));
    h.ageKD(`cleanup-old-${c}.md`, Date.now() - 60000);
    await h.commit(c, "{11}");
    h.clearLog();
    await h.tick(c, "t17-e2");
    expect(h.hooks.sessionPhaseMap.get(c), "the CLEANUP hop rejected a pre-walk artifact on a clock read").toBe(h.hooks.STATES.REPORT);
  });

  it("walk rejects a non-producible hop and a hop after REPORT", async () => {
    // A hop that passes the tool-scope and gate-type classes but has neither a
    // subagent dispatch nor an Overseer/terminal producer path.
    const tightAllowlist = { ...h.hooks.TOOL_ALLOWLIST, ALIGN: ["read"] };
    expect(tightAllowlist.ALIGN).toEqual(["read"]);
    const notProducible = h.hooks.validateMultiPhaseWalk([5], 7, undefined, { toolAllowlist: tightAllowlist });
    expect(notProducible, "a hop nothing can produce was admitted").toMatchObject({ to: 5, reason: "not-producible" });

    // Every live phase is producible — the class has no false positives.
    for (const [name, id] of Object.entries(h.hooks.STATES)) {
      const rejected = h.hooks.validateMultiPhaseWalk([id], 7);
      expect(rejected, `live phase ${name} (${id}) was rejected by commit-time validation`).toBeNull();
    }

    // A hop after REPORT is structurally impossible.
    const afterTerminal = h.hooks.validateMultiPhaseWalk([10, 11, 12, 9], 10);
    expect(afterTerminal, "a hop after REPORT was admitted").toMatchObject({ to: 9, reason: "hop-after-terminal" });

    // The commit-time rejection is atomic: phase, marker and state file are
    // byte-unchanged, and one always-on record names the hop and the reason.
    const s = "walk-t14";
    await h.initOverseer(s);
    h.hooks.sessionPhaseMap.set(s, h.hooks.STATES.EVOLVE);
    h.hooks.sessionPhaseMap.set(`${s}:sid`, s);
    h.hooks.saveState(s);
    const stateBefore = readFileSync(h.statePath(s), "utf8");
    const phaseBefore = h.hooks.sessionPhaseMap.get(s);
    h.clearLog();

    const out = await h.commit(s, "{10,11,12,9}");
    expect(out.phaseError, "the walk with a hop after REPORT was accepted").toMatchObject({ to: 9, reason: "hop-after-terminal" });
    expect(h.hooks.sessionPhaseMap.get(s), "the rejected walk moved the phase").toBe(phaseBefore);
    expect(h.marker(s), "the rejected walk left a marker").toBeFalsy();
    expect(readFileSync(h.statePath(s), "utf8"), "the rejected walk wrote state").toBe(stateBefore);
    const rejected = h.records("WALK_REJECTED").map(h.parseRecord).filter((r) => r.fields.session === s);
    expect(rejected, "no always-on WALK_REJECTED record").toHaveLength(1);
    expect(rejected[0].fields).toMatchObject({ hop: "9", reason: "hop-after-terminal" });

    // The rejection reader is not blind: a committable walk from the same
    // session reports no phase error, so the assertion above can fail.
    const okOut = await h.commit(s, "{11,12}");
    expect(okOut.phaseError, "a committable walk was reported as rejected").toBeUndefined();
  });

  it("refusal names the actual phase and its walk state", async () => {
    // A live walk at its head keeps the established at-head rendering.
    const s = await swarmSession("walk-t15-head");
    await h.commit(s, "{3,5}");
    swarmEvidence(s);
    let headRefusal = null;
    try {
      await h.hooks["tool.execute.before"](
        { tool: "task", sessionID: s, callID: "t15-head" },
        { args: { subagent_type: "committer", prompt: "DISPATCH TO: committer\nMODE: preflight" } }
      );
    } catch (e) {
      headRefusal = e;
    }
    expect(headRefusal, "the dispatch at the walk head was allowed").toBeTruthy();
    expect(headRefusal.message).toContain("EXPLORE (3)");
    expect(headRefusal.message).toContain("Override active: target EXPLORE (3), queue [3,5] — 2 hops remaining");

    // A suspended walk names its head, remaining plan and suspended status.
    const w = await swarmSession("walk-t15-suspended");
    await h.commit(w, "{7,8,10}");
    swarmEvidence(w);
    await h.tick(w, "t15-hop");
    expect(h.hooks.sessionPhaseMap.get(w)).toBe(h.hooks.STATES.VERIFY);
    h.createFreshKD(`review-fail-${w}.md`, h.reviewKD("FAIL", "M1"));
    await h.tick(w, "t15-fail");
    expect(h.hooks.sessionPhaseMap.get(w)).toBe(h.hooks.STATES.SWARM);

    let suspendedRefusal = null;
    try {
      await h.hooks["tool.execute.before"](
        { tool: "task", sessionID: w, callID: "t15-suspended" },
        { args: { subagent_type: "committer", prompt: "DISPATCH TO: committer\nMODE: preflight" } }
      );
    } catch (e) {
      suspendedRefusal = e;
    }
    expect(suspendedRefusal, "the dispatch during a suspended walk was allowed").toBeTruthy();
    expect(suspendedRefusal.message).toContain("SWARM (7)");
    expect(suspendedRefusal.message).toContain("head VERIFY (8)");
    expect(suspendedRefusal.message).toContain("queue [8,10]");
    expect(suspendedRefusal.message).toContain("suspended");
  });

  it("every walk event is recorded always-on", async () => {
    expect(h.hooks.getEnablementState().enabled, "the debug channel is on — these records prove nothing").toBe(false);

    // commit
    const s = await swarmSession("walk-t16-events");
    h.clearLog();
    await h.commit(s, "{7,8,10}");
    swarmEvidence(s);
    const commits = h.records("WALK_COMMIT").map(h.parseRecord).filter((r) => r.fields.session === s);
    expect(commits, "no always-on WALK_COMMIT record").toHaveLength(1);
    expect(commits[0].fields).toMatchObject({ from: "7", to: "7", queue: "[7,8,10]" });

    // hop
    await h.tick(s, "t16-hop");
    expect(walkHopRecords(s), "no always-on WALK_HOP record").toHaveLength(1);

    // suspend
    // The FAIL must postdate the walk anchor and stay older than the re-entry
    // anchor the resume below installs — a forward-margin stamp would overshoot
    // the second bound and re-regress the resumed hop on the repeat tick.
    h.createKD(`review-fail-${s}.md`, h.reviewKD("FAIL", "M1"));
    h.ageKD(`review-fail-${s}.md`, h.marker(s).since + 1);
    await h.tick(s, "t16-fail");
    const suspended = h.records("WALK_SUSPENDED").map(h.parseRecord).filter((r) => r.fields.session === s);
    expect(suspended, "no always-on WALK_SUSPENDED record").toHaveLength(1);
    expect(suspended[0].fields).toMatchObject({ from: "8", to: "7", queue: "[8,10]" });

    // A second regression while the walk is already suspended changes nothing
    // but still records its own event.
    const w = await swarmSession("walk-t16-resuspended");
    await h.commit(w, "{8,10}");
    swarmEvidence(w);
    // The walk already recorded one suspension before this one.
    h.seedWalk(w, [8, 10], Date.now() - 10000, { state: "suspended", suspendedAt: 111 });
    h.createFreshKD(`review-fail-${w}.md`, h.reviewKD("FAIL", "M1"));
    h.clearLog();
    await h.tick(w, "t16-resuspend");
    expect(h.hooks.sessionPhaseMap.get(w)).toBe(h.hooks.STATES.SWARM);
    expect(h.marker(w).phases).toEqual([8, 10]);
    expect(h.marker(w).suspendedAt, "the second suspension re-stamped the anchor").toBe(111);
    const resuspended = h.records("WALK_SUSPENDED").map(h.parseRecord).filter((r) => r.fields.session === w);
    expect(resuspended, "a backward transition while already suspended recorded nothing").toHaveLength(1);

    // resume
    reclose(s);
    await h.tick(s, "t16-resume");
    const resumed = h.records("WALK_RESUMED").map(h.parseRecord).filter((r) => r.fields.session === s);
    expect(resumed, "no always-on WALK_RESUMED record").toHaveLength(1);
    expect(resumed[0].fields.phase).toBe("8");
    expect(Number(resumed[0].fields.hopSince)).toBeGreaterThan(0);

    // diverge
    const d = await swarmSession("walk-t16-diverge");
    h.seedWalk(d, [3, 5], Date.now() - 1000);
    swarmEvidence(d);
    h.clearLog();
    await h.tick(d, "t16-diverge-1");
    await h.tick(d, "t16-diverge-2");
    const diverged = h.records("WALK_DIVERGED").map(h.parseRecord).filter((r) => r.fields.session === d);
    expect(diverged, "the divergence record repeated or went missing").toHaveLength(1);
    expect(diverged[0].fields).toMatchObject({ phase: "7", head: "3", queue: "[3,5]" });

    // clear (with a reason)
    const c = await swarmSession("walk-t16-clear");
    await h.commit(c, "{3,5}");
    swarmEvidence(c);
    h.createFreshKD(`exploration-fresh-${c}.md`);
    await h.tick(c, "t16-clear-hop");
    h.createFreshKD(`spec-fresh-${c}.md`);
    await h.tick(c, "t16-clear");
    const cleared = h.records("WALK_CLEARED").map(h.parseRecord).filter((r) => r.fields.session === c);
    expect(cleared, "no always-on WALK_CLEARED record").toHaveLength(1);
    expect(cleared[0].fields.reason).toBe("origin-return");

    // complete
    const r = "walk-t16-complete";
    await h.initOverseer(r);
    h.hooks.sessionPhaseMap.set(r, h.hooks.STATES.EVOLVE);
    h.hooks.sessionPhaseMap.set(`${r}:sid`, r);
    await h.commit(r, "{10,11,12}");
    h.createFreshKD(`process-fresh-${r}.md`, "process evidence");
    await h.tick(r, "t16-complete-1");
    h.createFreshKD(`cleanup-walk-${r}.md`, h.cleanupKD(r));
    await h.tick(r, "t16-complete-2");
    const completed = h.records("WALK_COMPLETE").map(h.parseRecord).filter((x) => x.fields.session === r);
    expect(completed, "no always-on WALK_COMPLETE record").toHaveLength(1);
    expect(completed[0].fields).toMatchObject({ terminal: "REPORT", kind: "hop" });

    // reject
    const j = "walk-t16-reject";
    await h.initOverseer(j);
    h.hooks.sessionPhaseMap.set(j, h.hooks.STATES.EVOLVE);
    h.hooks.sessionPhaseMap.set(`${j}:sid`, j);
    h.clearLog();
    await h.commit(j, "{12,9}");
    const rejected = h.records("WALK_REJECTED").map(h.parseRecord).filter((x) => x.fields.session === j);
    expect(rejected, "no always-on WALK_REJECTED record").toHaveLength(1);
    expect(rejected[0].fields).toMatchObject({ hop: "9", reason: "hop-after-terminal" });

    // A repeated identical evaluation adds nothing to any of the above.
    const counts = () => ["WALK_DIVERGED", "WALK_SUSPENDED", "WALK_RESUMED", "WALK_COMPLETE", "WALK_REJECTED"]
      .map((token) => h.records(token).length);
    const beforeRepeat = counts();
    await h.tick(d, "t16-diverge-3");
    await h.tick(s, "t16-repeat");
    expect(counts(), "a repeated identical evaluation emitted a duplicate walk record").toEqual(beforeRepeat);
  });

  it("state round-trip preserves suspension and anchors", async () => {
    const s = await swarmSession("walk-t18");
    await h.commit(s, "{7,8,10}");
    swarmEvidence(s);
    await h.tick(s, "t18-hop");
    expect(h.hooks.sessionPhaseMap.get(s)).toBe(h.hooks.STATES.VERIFY);
    h.createFreshKD(`review-fail-${s}.md`, h.reviewKD("FAIL", "M1"));
    await h.tick(s, "t18-fail");
    expect(h.hooks.sessionPhaseMap.get(s)).toBe(h.hooks.STATES.SWARM);
    const suspended = h.marker(s);
    expect(suspended.state).toBe("suspended");

    expect(h.hooks.saveState(s)).toBe(true);
    const persisted = JSON.parse(readFileSync(h.statePath(s), "utf8"));
    expect(persisted.overrideUntil).toMatchObject({ phases: [8, 10], since: suspended.since, state: "suspended" });
    expect(persisted.overrideUntil.suspendedAt).toBe(suspended.suspendedAt);
    expect(persisted.overrideSafePoint.phase).toBe(h.hooks.STATES.SWARM);

    // Restart: a fresh plugin instance restores the same walk and reaches the
    // same next-hop decision.
    h.hooks = await pluginModule.server({}, {});
    await h.initOverseer(s);
    const restored = h.marker(s);
    expect(restored, "the restart dropped the suspended walk").toBeTruthy();
    expect(restored.phases).toEqual([8, 10]);
    expect(restored.since).toBe(suspended.since);
    expect(restored.state).toBe("suspended");
    expect(restored.suspendedAt).toBe(suspended.suspendedAt);
    expect(h.safePoint(s).phase).toBe(h.hooks.STATES.SWARM);
    expect(h.hooks.nextForwardPhase(s, h.hooks.STATES.SWARM, h.hooks.STATES.VERIFY)).toMatchObject({ outcome: "resume", target: h.hooks.STATES.VERIFY });
  });

  it("all five forward-advance sites resolve through the shared decision", () => {
    const src = readFileSync(join(process.cwd(), "plugins", "protocol-gate", "index.js"), "utf8");
    const slice = (startMarker, endMarker) => {
      const start = src.indexOf(startMarker);
      expect(start, `missing ${startMarker}`).toBeGreaterThan(-1);
      const end = src.indexOf(endMarker, start);
      expect(end, `missing end marker ${endMarker}`).toBeGreaterThan(start);
      return src.slice(start, end);
    };

    const fromDisk = slice("async function advanceFromDiskEvidence(", "// --- Hook: tool.execute.before ---");
    expect(fromDisk).toContain("nextForwardPhase(");
    expect(fromDisk).toContain("applyForwardAdvance(");
    expect(fromDisk, "the disk site still commits a phase itself").not.toContain("enterPhase(");

    const parent = slice("function advanceParentSessionFromSwarm(", "// --- Hook: chat.params ---");
    expect(parent).toContain("nextForwardPhase(");
    expect(parent).toContain("applyForwardAdvance(");
    expect(parent, "the parent hand-off still hardcodes its target phase").not.toContain("STATES.VERIFY");
    expect(parent, "the parent hand-off still commits a phase itself").not.toContain("enterPhase(");

    const before = slice("async function toolExecuteBefore(", "// --- Hook: tool.execute.after ---");
    expect(before.match(/nextForwardPhase\(/g), "not every force-advance site consults the queue").toHaveLength(3);
    expect(before.match(/applyForwardAdvance\(/g)).toHaveLength(3);
    expect(before, "a force site still enters a hardcoded phase").not.toContain("enterPhase(sessionPhaseMap, sessionID, STATES.VERIFY)");
  });
});
