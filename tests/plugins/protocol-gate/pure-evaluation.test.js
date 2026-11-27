import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import pluginModule from "../../../plugins/protocol-gate/index.js";

// swarm/11 mechanism fix: gate evaluation is pure,
// live evidence settles a row to the `evidence-landed` state, and exactly one
// writer — the VERIFY verdict-PASS commit — records `checked-off`. These
// fixtures drive the real gate paths (write hooks, reconcile scan, all-checked-off
// evaluation, override walk) and read the registry and override state back.
describe("Protocol-Gate pure evaluation and verdict-owned promotion", () => {
  let tempRoot;
  let knowledgeDir;
  let stateDir;
  let protocolLogDir;
  let logPath;
  let priorKnowledgeDir;
  let priorStateDir;
  let priorLogDir;
  let priorDebug;
  let hooks;

  beforeAll(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "pg-purity-"));
    knowledgeDir = join(tempRoot, "knowledge");
    stateDir = join(tempRoot, "state");
    protocolLogDir = mkdtempSync(join(tmpdir(), "pg-purity-log-"));
    priorKnowledgeDir = process.env.PROTOCOL_GATE_KNOWLEDGE_DIR;
    priorStateDir = process.env.PROTOCOL_GATE_STATE_DIR;
    priorLogDir = process.env.PROTOCOL_GATE_LOG_DIR;
    priorDebug = process.env.PROTOCOL_GATE_DEBUG;
    process.env.PROTOCOL_GATE_KNOWLEDGE_DIR = knowledgeDir;
    process.env.PROTOCOL_GATE_STATE_DIR = stateDir;
    process.env.PROTOCOL_GATE_LOG_DIR = protocolLogDir;
    logPath = join(protocolLogDir, "protocol-gate.log");
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
    rmSync(protocolLogDir, { recursive: true, force: true });
    rmSync(tempRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    rmSync(knowledgeDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(logPath, { force: true });
    mkdirSync(knowledgeDir, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    hooks = await pluginModule.server({}, {});
  });

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

  function reviewKD(verdict, sessionID) {
    return `---
title: "REVIEW: test"
version: 1.0.0
status: draft
type: review
session_id: "${sessionID}"
author: Inspector
superseded_by: null
verdict: ${verdict}
---

# REVIEW: test

## Verdict

${verdict}

## Review Findings

clean
`;
  }

  function registryContent(rows) {
    const yaml = rows.map(([id, state]) => `  ${id}: ${state}`).join("\n");
    return `## Milestone States

\`\`\`yaml
milestones:
${yaml}
\`\`\`

## Milestone Details

| Milestone ID | Description | State |
| ------------ | ----------- | ----- |
${rows.map(([id, state]) => `| ${id} | desc | ${state} |`).join("\n")}
`;
  }

  function registryPath(s) {
    return join(knowledgeDir, `milestones-feature-${s}.md`);
  }

  function createRegistry(s, rows) {
    writeFileSync(registryPath(s), registryContent(rows));
  }

  function rowState(s, id) {
    const match = readFileSync(registryPath(s), "utf8").match(
      new RegExp(`^\\s*${id}:\\s*([A-Za-z-]+)\\s*$`, "m")
    );
    return match ? match[1] : null;
  }

  async function startSwarm(s, rows) {
    await hooks["chat.params"]({ sessionID: s, agent: "overseer" }, {});
    hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
    hooks.sessionPhaseMap.set(`${s}:sid`, s);
    createRegistry(s, rows);
  }

  // One gate evaluation at the point a tool call runs it: the before-hook is
  // where disk advancement, reconciliation and the SWARM gate evaluate.
  async function gateEvaluate(s, callID) {
    await hooks["tool.execute.before"](
      { tool: "glob", sessionID: s, callID },
      { args: { pattern: "knowledge/*.md" } }
    );
  }

  async function artisanWrite(artisan, relPath, content, callID) {
    await hooks["chat.params"]({ sessionID: artisan, agent: "artisan" }, {});
    await hooks["tool.execute.before"](
      { tool: "write", sessionID: artisan, callID },
      { args: { filePath: relPath, content } }
    );
    writeFileSync(join(knowledgeDir, relPath.split("/").pop()), content);
    await hooks["tool.execute.after"]({ tool: "write", sessionID: artisan, callID }, {});
  }

  function records(token) {
    let log;
    try { log = readFileSync(logPath, "utf8"); } catch (_) { return []; }
    return log.split("\n").filter((line) => line.includes(`] [protocol-gate] ${token}:`));
  }

  function parseRecord(line) {
    const marker = "] [protocol-gate] ";
    const body = line.slice(line.indexOf(marker) + marker.length);
    const colonAt = body.indexOf(":");
    const rest = body.slice(colonAt + 1);
    const causeAt = rest.indexOf(" cause=");
    const head = causeAt === -1 ? rest : rest.slice(0, causeAt);
    const fields = {};
    for (const pair of head.split(" ").filter(Boolean)) {
      const eq = pair.indexOf("=");
      if (eq > 0) fields[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
    return fields;
  }

  // Evaluation purity: the all-checked-off gate and the
  // reconcile scan observe evidence without rewriting the registry.
  it("running the all-checked-off evaluation twice leaves the registry byte-identical", async () => {
    const s = "purity-eval";
    await startSwarm(s, [["M1", "in-progress"], ["M2", "in-progress"]]);
    writeFileSync(join(knowledgeDir, `impl-M1-evidence-${s}.md`), implKD(s));
    writeFileSync(join(knowledgeDir, `impl-M2-evidence-${s}.md`), implKD(s));

    const gate1 = hooks.checkAllMilestonesCheckedOff(s, hooks.sessionPhaseMap);
    expect(gate1.ok, "live evidence on every row must satisfy the SWARM gate").toBe(true);
    const first = readFileSync(registryPath(s));
    const gate2 = hooks.checkAllMilestonesCheckedOff(s, hooks.sessionPhaseMap);
    const second = readFileSync(registryPath(s));
    expect(Buffer.compare(first, second), "evaluation rewrote the registry bytes").toBe(0);
    expect(gate2.ok).toBe(true);
  });

  it("the reconcile scan reports live evidence on stuck rows without promoting them", async () => {
    const s = "purity-reconcile";
    await startSwarm(s, [["M1", "failed"]]);
    writeFileSync(join(knowledgeDir, `impl-M1-evidence-${s}.md`), implKD(s));

    const registry = hooks.readMilestoneRegistry(s, hooks.sessionPhaseMap);
    const before = readFileSync(registryPath(s));
    hooks.reconcileStuckRowsFromDiskEvidence(s, hooks.sessionPhaseMap, registry);

    expect(readFileSync(registryPath(s)), "the reconcile scan wrote the registry").toEqual(before);
    expect(rowState(s, "M1")).toBe("failed");
    expect(records("RECONCILE_CHECKOFF"), "the scan must report, not promote").toHaveLength(1);
    expect(parseRecord(records("RECONCILE_CHECKOFF")[0])).toMatchObject({
      milestone: "M1",
      file: `impl-M1-evidence-${s}.md`,
      promoted: "false"
    });
    // The scan's observation still feeds the gate: the row's evidence counts
    // for advancement even while the row keeps its state.
    expect(hooks.checkAllMilestonesCheckedOff(s, hooks.sessionPhaseMap).ok).toBe(true);
  });

  // Write-hook settle: live evidence lands a row at
  // `evidence-landed`, never at `checked-off`.
  it("an impl-KD write settles an in-progress row to evidence-landed — checked-off is not reachable from the write", async () => {
    const s = "settle-write";
    await startSwarm(s, [["M1", "in-progress"]]);
    await artisanWrite(`${s}-artisan`, `knowledge/impl-M1-feature-${s}.md`, implKD(s), "c-settle-1");

    expect(rowState(s, "M1")).toBe("evidence-landed");
    expect(readFileSync(registryPath(s), "utf8")).not.toContain("  M1: checked-off");

    const checkoff = records("CHECKOFF");
    expect(checkoff.length, "the settle must record one CHECKOFF line").toBeGreaterThan(0);
    const settled = checkoff.map(parseRecord).find((f) => f.milestone === "M1" && f.promoted === "true");
    expect(settled, "the settle record names the milestone").toBeTruthy();
    expect(settled.reason).toBe("live-evidence");

    // The SWARM gate advances on the evidence alone; the row stays evidence-landed.
    expect(hooks.checkAllMilestonesCheckedOff(s, hooks.sessionPhaseMap).ok).toBe(true);
    expect(rowState(s, "M1")).toBe("evidence-landed");
  });

  // The verdict-PASS commit is the sole `checked-off` writer.
  it("a VERIFY verdict-PASS evaluation flips every evidence-landed row to checked-off as the gate commits", async () => {
    const s = "verdict-pass";
    await startSwarm(s, [["M1", "in-progress"], ["M2", "in-progress"]]);
    await artisanWrite(`${s}-a1`, `knowledge/impl-M1-feature-${s}.md`, implKD(s), "c-pass-1");
    await artisanWrite(`${s}-a2`, `knowledge/impl-M2-feature-${s}.md`, implKD(s), "c-pass-2");
    expect(rowState(s, "M1")).toBe("evidence-landed");
    expect(rowState(s, "M2")).toBe("evidence-landed");

    await gateEvaluate(s, "c-pass-eval");
    expect(hooks.sessionPhaseMap.get(s), "the SWARM gate advances on evidence presence").toBe(hooks.STATES.VERIFY);
    expect(rowState(s, "M1"), "no evaluation commits checked-off").toBe("evidence-landed");

    writeFileSync(join(knowledgeDir, `review-pass-${s}.md`), reviewKD("PASS", s));
    await gateEvaluate(s, "c-pass-verdict");
    expect(hooks.sessionPhaseMap.get(s), "the PASS verdict commits VERIFY→EXTRACT").toBe(hooks.STATES.EXTRACT);
    expect(rowState(s, "M1"), "the PASS commit promotes every evidence-landed row").toBe("checked-off");
    expect(rowState(s, "M2")).toBe("checked-off");

    const passLines = records("CHECKOFF").map(parseRecord).filter((f) => f.reason === "verdict-pass");
    expect(passLines.map((f) => f.milestone).sort()).toEqual(["M1", "M2"]);
  });

  // The FAIL path: evidence-landed rows named by reopen_target
  // reopen to in-progress with their evidence supersede-stamped.
  it("a VERIFY verdict-FAIL reopens cited evidence-landed rows and stamps their evidence", async () => {
    const s = "verdict-fail";
    await startSwarm(s, [["M1", "in-progress"]]);
    await artisanWrite(`${s}-a1`, `knowledge/impl-M1-feature-${s}.md`, implKD(s), "c-fail-1");
    await gateEvaluate(s, "c-fail-eval");
    expect(hooks.sessionPhaseMap.get(s)).toBe(hooks.STATES.VERIFY);

    const review = reviewKD("FAIL", s).replace(
      "verdict: FAIL\n",
      "verdict: FAIL\nreopen_target: [M1]\n"
    );
    writeFileSync(join(knowledgeDir, `review-fail-${s}.md`), review);
    await gateEvaluate(s, "c-fail-verdict");

    expect(hooks.sessionPhaseMap.get(s), "FAIL regresses VERIFY→SWARM").toBe(hooks.STATES.SWARM);
    expect(rowState(s, "M1"), "the cited evidence-landed row reopens").toBe("in-progress");
    const stamped = readFileSync(join(knowledgeDir, `impl-M1-feature-${s}.md`), "utf8");
    expect(stamped, "the reopen stamps the invalidated evidence").toContain("status: superseded");
    expect(records("REOPEN").length).toBe(1);
  });

  // Override-state settlement keeps exactly one site: the walk's
  // three keys survive an impl-KD write plus a full evaluation pass; they change
  // only where the walk itself commits.
  it("the operator walk's three override keys survive an impl-KD write and a full evaluation pass", async () => {
    const s = "override-survive";
    await startSwarm(s, [["M1", "in-progress"], ["M2", "in-progress"]]);
    await hooks["command.execute.before"](
      { command: "phase", sessionID: s, arguments: "{7,10}" },
      { parts: [] }
    );
    expect(hooks.sessionPhaseMap.get(s), "the walk lands on its head hop").toBe(hooks.STATES.SWARM);
    const before = {
      until: hooks.sessionPhaseMap.get(`${s}:overrideUntil`),
      safePoint: hooks.sessionPhaseMap.get(`${s}:overrideSafePoint`),
      evals: hooks.sessionPhaseMap.get(`${s}:overrideEvals`)
    };
    expect(before.until).toBeTruthy();
    expect(before.safePoint).toBeTruthy();

    // The incident's reachability path: a file write plus a full gate
    // evaluation pass. M2 has no evidence, so the pass observes, parks, and
    // mutates nothing — no WALK_CLEARED, no key change.
    await artisanWrite(`${s}-a1`, `knowledge/impl-M1-feature-${s}.md`, implKD(s), "c-ovr-1");
    await gateEvaluate(s, "c-ovr-eval");

    expect(hooks.sessionPhaseMap.get(s), "the gate parks in SWARM while M2 lacks evidence").toBe(hooks.STATES.SWARM);
    expect(records("WALK_CLEARED"), "an evaluation pass must not sweep the walk state").toHaveLength(0);
    const after = hooks.sessionPhaseMap.get(`${s}:overrideUntil`);
    expect(after, "the walk marker survived the pass").toBe(before.until);
    expect(after.phases).toEqual([7, 10]);
    expect(hooks.sessionPhaseMap.get(`${s}:overrideSafePoint`)).toBe(before.safePoint);
    expect(hooks.sessionPhaseMap.has(`${s}:overrideSafePoint`)).toBe(true);

    // The paired leg: the keys change where the walk itself commits — the
    // next hop re-arms the marker at the applyForwardAdvance commit.
    await artisanWrite(`${s}-a2`, `knowledge/impl-M2-feature-${s}.md`, implKD(s), "c-ovr-2");
    expect(hooks.sessionPhaseMap.get(s), "the complete evidence carries the walk to its next hop").toBe(hooks.STATES.EVOLVE);
    const rearmed = hooks.sessionPhaseMap.get(`${s}:overrideUntil`);
    expect(rearmed.phases, "the committed hop popped the head and re-armed the marker").toEqual([10]);
    expect(records("WALK_CLEARED"), "a hop re-arms rather than sweeping").toHaveLength(0);
  });
});
