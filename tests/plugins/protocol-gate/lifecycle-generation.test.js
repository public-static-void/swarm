import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import pluginModule from "../../../plugins/protocol-gate/index.js";

// A lifecycle is identified by the generation its own artifacts carry. The
// persisted counter moves at lifecycle end, so a lifecycle that begins while an
// earlier one is unfinished can carry a label the counter has already passed.
// These cases pin the resolution and the observability that makes it
// diagnosable: a skip, a mismatch and an unmatched path each leave a record
// with the flag unset, a patch fragment is never judged as a document, and a
// write at the lifecycle's own generation promotes end-to-end.
describe("Protocol-Gate lifecycle generation resolution", () => {
  let tempRoot;
  let knowledgeDir;
  let stateDir;
  let protocolLogDir;
  let priorKnowledgeDir;
  let priorStateDir;
  let priorLogDir;
  let priorDebug;
  let hooks;

  beforeAll(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "pg-lcgen-"));
    knowledgeDir = join(tempRoot, "knowledge");
    stateDir = join(tempRoot, "state");
    priorKnowledgeDir = process.env.PROTOCOL_GATE_KNOWLEDGE_DIR;
    priorStateDir = process.env.PROTOCOL_GATE_STATE_DIR;
    priorLogDir = process.env.PROTOCOL_GATE_LOG_DIR;
    priorDebug = process.env.PROTOCOL_GATE_DEBUG;
    process.env.PROTOCOL_GATE_KNOWLEDGE_DIR = knowledgeDir;
    process.env.PROTOCOL_GATE_STATE_DIR = stateDir;
    protocolLogDir = mkdtempSync(join(tmpdir(), "pg-lcgen-log-"));
    process.env.PROTOCOL_GATE_LOG_DIR = protocolLogDir;
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
    mkdirSync(knowledgeDir, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    // The always-on channel is the subject: every case runs with the debug
    // flag unset, so a record that only appears when debugging is enabled
    // fails the assertion instead of hiding the defect.
    delete process.env.PROTOCOL_GATE_DEBUG;
    hooks = await pluginModule.server({}, {});
  });

  function createKD(filename, content = "test content") {
    writeFileSync(join(knowledgeDir, filename), content);
  }

  function readLog() {
    try { return readFileSync(join(protocolLogDir, "protocol-gate.log"), "utf8"); } catch (_) { return ""; }
  }

  function clearLog() {
    try { rmSync(join(protocolLogDir, "protocol-gate.log")); } catch (_) {}
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

  function implKD(sessionID, status = "draft") {
    return `---\ntitle: "IMPLEMENTATION SUMMARY: test"\nversion: 1.0.0\nstatus: ${status}\ntype: impl\nsession_id: "${sessionID}"\nauthor: Artisan\nsuperseded_by: null\n---\n\n# IMPLEMENTATION SUMMARY: test\n`;
  }

  function intentKD(sessionID) {
    return `---\ntitle: "INTENT: test"\nversion: 1.0.0\nstatus: draft\ntype: intent\nsession_id: "${sessionID}"\nauthor: Overseer\nsuperseded_by: null\n---\n\n# INTENT: test\n`;
  }

  function registryPath(s, generation) {
    return join(knowledgeDir, `milestones-feature-${s}-gen${generation}.md`);
  }

  function registryBody(s, generation) {
    return readFileSync(registryPath(s, generation), "utf8");
  }

  // The shape the incident produced: the persisted counter sits one generation
  // ahead of the lifecycle's own artifacts, because an earlier lifecycle ended
  // and moved it while this one was being labelled from the prior label.
  async function openLifecycle(s, { persistedGen, anchorGen }) {
    await hooks["chat.params"]({ sessionID: s, agent: "overseer" }, {});
    hooks.sessionPhaseMap.set(s, hooks.STATES.SWARM);
    hooks.sessionPhaseMap.set(`${s}:sid`, s);
    hooks.sessionPhaseMap.set(`${s}:gen`, persistedGen);
    writeFileSync(
      join(stateDir, `.protocol-state-${s}.json`),
      JSON.stringify({ phase: hooks.STATES.SWARM, generation: persistedGen, sid: s, timestamp: Date.now() })
    );
    createKD(`intent-feature-${s}-gen${anchorGen}.md`, intentKD(s));
    createKD(`milestones-feature-${s}-gen${anchorGen}.md`, registryContent([["M1", "in-progress"], ["M2", "in-progress"]]));
  }

  async function writeAsArtisan(sessionID, filePath, content) {
    await hooks["chat.params"]({ sessionID, agent: "artisan" }, {});
    await hooks["tool.execute.before"](
      { tool: "write", sessionID, callID: `c-${filePath}` },
      { args: { filePath, content } }
    );
  }

  async function editAsArtisan(sessionID, filePath, newString) {
    await hooks["chat.params"]({ sessionID, agent: "artisan" }, {});
    await hooks["tool.execute.before"](
      { tool: "edit", sessionID, callID: `e-${filePath}` },
      { args: { filePath, oldString: "# IMPLEMENTATION SUMMARY: test\n", newString } }
    );
  }

  it("resolves evidence against the generation the lifecycle's artifacts carry, not the persisted counter", async () => {
    const s = "lcgen-anchor-1";
    await openLifecycle(s, { persistedGen: 6, anchorGen: 5 });
    clearLog();

    // Evidence at the counter's generation is not this lifecycle's evidence:
    // no row promotes, and the skip names both generations with the flag unset.
    await writeAsArtisan(`${s}-art`, `knowledge/impl-M1-feat-${s}-gen6.md`, implKD(s));

    expect(registryBody(s, 5)).toContain("  M1: in-progress");
    const skipped = readLog();
    expect(skipped).toContain("GEN_MISMATCH_SKIP");
    expect(skipped).toContain(`impl-M1-feat-${s}-gen6.md`);
    expect(skipped).toContain("fileGen=6");
    expect(skipped).toContain("activeGen=5");
    expect(skipped).toContain("persistedGen=6");
    expect(skipped).toContain("promoted=false");
    // The reconciliation itself is a record, so a lifecycle running under a
    // moved counter is diagnosable without reading the state file.
    expect(skipped).toContain("LIFECYCLE_GENERATION_RECONCILED");
    expect(skipped).toContain(`intent-feature-${s}-gen5.md`);

    // Paired positive: the same bytes at the lifecycle's own generation
    // promote — the refusal above keys on generation, not on the artifact.
    createKD(`impl-M1-feat-${s}-gen6.md`, implKD(s));
    await writeAsArtisan(`${s}-art`, `knowledge/impl-M1-feat-${s}-gen5.md`, implKD(s));
    createKD(`impl-M1-feat-${s}-gen5.md`, implKD(s));

    expect(registryBody(s, 5)).toContain("  M1: checked-off");
    expect(readLog()).toContain("CHECKOFF");
    expect(readLog()).toContain("promoted=true");
    expect(readLog()).toContain("reason=live-evidence");
  });

  it("promotes a row end-to-end on a document written at the active generation, and the gate reads it back", async () => {
    const s = "lcgen-promote-1";
    await openLifecycle(s, { persistedGen: 6, anchorGen: 5 });
    clearLog();

    await writeAsArtisan(`${s}-art`, `knowledge/impl-M1-feat-${s}-gen5.md`, implKD(s));
    createKD(`impl-M1-feat-${s}-gen5.md`, implKD(s));

    // The promotion record names the artifact and the reason.
    const log = readLog();
    expect(log).toContain(`CHECKOFF: milestone=M1 artifact=impl-M1-feat-${s}-gen5.md promoted=true reason=live-evidence`);
    // The registry write is the gate's, not a caller's: the row reads
    // checked-off after the write hook ran.
    expect(registryBody(s, 5)).toContain("  M1: checked-off");
    // And the disk predicate the SWARM gate consumes agrees — registry state
    // plus the landed artifact, both resolved at the lifecycle's generation.
    const row = hooks.checkMilestoneCheckedOff(s, hooks.sessionPhaseMap, "M1");
    expect(row.state).toBe("checked-off");
    expect(row.implKDOnDisk).toBe(true);
    expect(row.implKD).toBe(`impl-M1-feat-${s}-gen5.md`);
  });

  it("does not judge a patch fragment as a document, and defers it to the landed file", async () => {
    const s = "lcgen-fragment-1";
    await openLifecycle(s, { persistedGen: 6, anchorGen: 5 });
    clearLog();

    // An edit carries a patch, not a KD. Parsing it as a document rejects it
    // as unparsable frontmatter, which reads as a verdict about the artifact
    // the writer never touched.
    await editAsArtisan(`${s}-art`, `knowledge/impl-M1-feat-${s}-gen5.md`, "- delivered step one\n");

    const log = readLog();
    expect(log).toContain("CHECKOFF_DEFERRED");
    expect(log).toContain("payload=fragment");
    expect(log).not.toContain("reason=unparsable-frontmatter");
    // Deferral is not a promotion: the row waits for the landed bytes.
    expect(registryBody(s, 5)).toContain("  M1: in-progress");

    // Paired positive: an edit that carries a whole document is a document, so
    // it promotes — the deferral keys on payload shape, not on the tool name.
    await editAsArtisan(`${s}-art`, `knowledge/impl-M2-feat-${s}-gen5.md`, implKD(s));

    expect(readLog()).toContain(`CHECKOFF: milestone=M2 artifact=impl-M2-feat-${s}-gen5.md promoted=true reason=live-evidence`);
    expect(registryBody(s, 5)).toContain("  M2: checked-off");
  });

  it("names an unmatched impl-KD path whose filename carries no generation for any candidate", async () => {
    const s = "lcgen-unmatched-1";
    await openLifecycle(s, { persistedGen: 6, anchorGen: 5 });
    clearLog();

    const orphan = `knowledge/impl-M1-orphan-ses_foreign0000000000-gen7.md`;
    await writeAsArtisan(`${s}-art`, orphan, implKD(s));

    const log = readLog();
    expect(log).toContain(`AUTO_CHECKOFF_UNMATCHED: ${orphan}`);
    expect(log).toContain("reason=no-generation-token");
    expect(registryBody(s, 5)).toContain("  M1: in-progress");

    // Paired positive: the same milestone at the session's own generation is
    // matched and promoted, so the unmatched record above is about the token.
    await writeAsArtisan(`${s}-art`, `knowledge/impl-M1-orphan-${s}-gen5.md`, implKD(s));

    expect(registryBody(s, 5)).toContain("  M1: checked-off");
  });

  it("anchors the running lifecycle on its newest INTENT when two lifecycles are on disk", async () => {
    const s = "lcgen-ambiguous-1";
    await openLifecycle(s, { persistedGen: 6, anchorGen: 5 });
    // An earlier, unfinished lifecycle of the same session left its INTENT and
    // registry behind at the counter's own generation. Its artifact is older,
    // so it does not name the lifecycle in force.
    const older = join(knowledgeDir, `intent-feature-${s}-gen6.md`);
    createKD(`intent-feature-${s}-gen6.md`, intentKD(s));
    createKD(`milestones-feature-${s}-gen6.md`, registryContent([["M1", "in-progress"]]));
    const now = Date.now() / 1000;
    utimesSync(older, now - 120, now - 120);
    utimesSync(join(knowledgeDir, `intent-feature-${s}-gen5.md`), now, now);
    clearLog();

    await writeAsArtisan(`${s}-art`, `knowledge/impl-M1-feat-${s}-gen5.md`, implKD(s));
    createKD(`impl-M1-feat-${s}-gen5.md`, implKD(s));

    const log = readLog();
    expect(log).toContain("LIFECYCLE_ANCHOR_AMBIGUOUS");
    expect(log).toContain(`activeGen=5`);
    expect(log).toContain(`intent-feature-${s}-gen5.md`);
    expect(log).toContain(`intent-feature-${s}-gen6.md`);
    // The live lifecycle's row promotes; the abandoned lifecycle's row does not
    // — the two lifecycles share a session but not a generation.
    expect(registryBody(s, 5)).toContain("  M1: checked-off");
    expect(registryBody(s, 6)).toContain("  M1: in-progress");
  });

  it("allocates the next lifecycle above every label already on disk, not just above the counter", async () => {
    const s = "lcgen-alloc-1";
    await openLifecycle(s, { persistedGen: 6, anchorGen: 5 });
    clearLog();

    // An unfinished lifecycle left artifacts at the counter's own number: the
    // counter alone would hand the next lifecycle 7, which is free, so this
    // alone does not discriminate. A held label ABOVE the counter does.
    createKD(`impl-M1-held-${s}-gen6.md`, implKD(s));
    expect(hooks.allocateLifecycleGeneration(s)).toBe(7);
    createKD(`impl-M9-held-${s}-gen9.md`, implKD(s));
    clearLog();

    // Counter 6 would allocate 7 — a number the disk does not use. The
    // allocator reads the disk, so it takes 10 and leaves 7 and 8 to no
    // lifecycle rather than reusing a label an unfinished lifecycle holds.
    expect(hooks.allocateLifecycleGeneration(s)).toBe(10);
    const log = readLog();
    expect(log).toContain("LIFECYCLE_GENERATION_ALLOCATED");
    expect(log).toContain("counter=6");
    expect(log).toContain("highestOnDisk=9");
    expect(log).toContain("allocated=10");
  });

  it("adopts the INTENT's own generation into the persisted counter when the lifecycle starts", async () => {
    const s = "lcgen-adopt-1";
    await openLifecycle(s, { persistedGen: 6, anchorGen: 5 });
    clearLog();

    // The counter sits at 6 (an earlier lifecycle's REPORT moved it); this
    // lifecycle's INTENT is gen5. Adoption is what stops the two disagreeing
    // for the whole lifecycle.
    expect(hooks.adoptLifecycleGenerationOnIntent(s, `knowledge/intent-feature-${s}-gen5.md`))
      .toEqual({ ok: true, generation: 5 });

    const log = readLog();
    expect(log).toContain("LIFECYCLE_GENERATION_ADOPTED");
    expect(log).toContain("persistedGen=6");
    expect(log).toContain("activeGen=5");
    // The state file is the SSOT across restarts, so the adopted number is on
    // disk, not only in the map.
    const state = JSON.parse(readFileSync(join(stateDir, `.protocol-state-${s}.json`), "utf8"));
    expect(state.generation).toBe(5);

    // Paired negative: a second INTENT of the same session already holds the
    // number. At equal generation the filename carries no discriminator, so the
    // two lifecycles' artifacts would be one evidence set — the start is
    // refused rather than recorded and merged.
    createKD(`intent-other-${s}-gen5.md`, intentKD(s));
    clearLog();
    const refused = hooks.adoptLifecycleGenerationOnIntent(s, `knowledge/intent-feature-${s}-gen5.md`);
    expect(refused.ok).toBe(false);
    expect(refused.reason).toBe("generation-held");
    expect(readLog()).toContain("LIFECYCLE_GENERATION_COLLISION");
    expect(readLog()).toContain(`intent-other-${s}-gen5.md`);
  });

  it("records an impl file that carries no generation marker for the session instead of skipping it silently", async () => {
    const s = "lcgen-notoken-1";
    await openLifecycle(s, { persistedGen: 6, anchorGen: 5 });
    // A file for the same milestone whose name carries another session's
    // marker — on disk, visibly this lifecycle's milestone, and invisible to
    // every matcher.
    createKD(`impl-M1-feat-ses_foreign0000000000-gen5.md`, implKD(s));
    clearLog();

    const gate = hooks.checkAllMilestonesCheckedOff(s, hooks.sessionPhaseMap);
    expect(gate.ok).toBe(false);

    const log = readLog();
    expect(log).toContain("GEN_MISMATCH_SKIP");
    expect(log).toContain("impl-M1-feat-ses_foreign0000000000-gen5.md");
    expect(log).toContain("reason=no-generation-token");
    expect(log).toContain("promoted=false");

    // Paired positive: the same artifact under this session's marker promotes
    // the row, so the record above is about the missing token.
    await writeAsArtisan(`${s}-art`, `knowledge/impl-M1-feat-${s}-gen5.md`, implKD(s));
    createKD(`impl-M1-feat-${s}-gen5.md`, implKD(s));
    expect(registryBody(s, 5)).toContain("  M1: checked-off");
  });

  it("records a SWARM gate parked by a pin whose freshness anchor no rewrite can satisfy", async () => {
    const s = "lcgen-parked-1";
    await openLifecycle(s, { persistedGen: 6, anchorGen: 5 });
    // Every row complete and every artifact on disk: the gate's own evidence
    // passes. The pin is what refuses the transition.
    createKD(`impl-M1-feat-${s}-gen5.md`, implKD(s));
    createKD(`impl-M2-feat-${s}-gen5.md`, implKD(s));
    writeFileSync(
      registryPath(s, 5),
      registryContent([["M1", "checked-off"], ["M2", "checked-off"]])
    );
    // A pin taken after the registry was last written: a checked-off row is
    // never rewritten, so the registry mtime can never reach the anchor.
    hooks.sessionPhaseMap.set(`${s}:overrideUntil`, { phase: hooks.STATES.SWARM, since: Date.now() + 60_000 });
    clearLog();

    const advanced = hooks.checkDiskAdvancement(s, hooks.STATES.SWARM, hooks.sessionPhaseMap, new Map());
    expect(advanced).toBe(false);

    const log = readLog();
    expect(log).toContain("SWARM_GATE_PARKED");
    expect(log).toContain("reason=stale-registry");
    // The record carries both timestamps, so the park is diagnosable from the
    // log alone rather than reading as a gate that never ran.
    expect(log).toContain("registryMtime=");
    expect(log).toContain("since=");

    // Paired positive: with the pin cleared the same evidence advances — the
    // park keys on the pin, not on the gate's evidence.
    hooks.sessionPhaseMap.delete(`${s}:overrideUntil`);
    clearLog();
    expect(hooks.checkDiskAdvancement(s, hooks.STATES.SWARM, hooks.sessionPhaseMap, new Map())).toBe(true);
    expect(readLog()).not.toContain("SWARM_GATE_PARKED");
  });

  it("settles a deferred fragment on the landed bytes in a process that is not standing in SWARM", async () => {
    const s = "lcgen-defer-settle-1";
    await openLifecycle(s, { persistedGen: 6, anchorGen: 5 });
    // The parent is not in SWARM in this process. That is the condition under
    // which the deferral's only consumer returned silently, leaving a deferred
    // row with a deferral line and no evaluation.
    hooks.sessionPhaseMap.set(s, hooks.STATES.VERIFY);
    createKD(`impl-M1-feat-${s}-gen5.md`, implKD(s));
    clearLog();

    await editAsArtisan(`${s}-art`, `knowledge/impl-M1-feat-${s}-gen5.md`, "- delivered step one\n");
    expect(readLog()).toContain("CHECKOFF_DEFERRED");
    expect(registryBody(s, 5)).toContain("  M1: in-progress");

    // The runtime materializes the edit. The after-hook is the terminal
    // evaluation, so it reads the bytes that landed rather than the fragment.
    writeFileSync(join(knowledgeDir, `impl-M1-feat-${s}-gen5.md`), `${implKD(s)}\n- delivered step one\n`);
    await hooks["tool.execute.after"]({ tool: "edit", sessionID: `${s}-art` }, {});

    const log = readLog();
    expect(log).toContain(`CHECKOFF: milestone=M1 artifact=impl-M1-feat-${s}-gen5.md promoted=true reason=live-evidence transport=after-hook`);
    expect(registryBody(s, 5)).toContain("  M1: checked-off");
  });

  it("declines the deferred settlement when the landed bytes are not live", async () => {
    const s = "lcgen-defer-decline-1";
    await openLifecycle(s, { persistedGen: 6, anchorGen: 5 });
    hooks.sessionPhaseMap.set(s, hooks.STATES.VERIFY);
    createKD(`impl-M1-feat-${s}-gen5.md`, implKD(s));
    clearLog();

    await editAsArtisan(`${s}-art`, `knowledge/impl-M1-feat-${s}-gen5.md`, "- delivered step one\n");
    // The landing decides. A document whose status is not allowlisted is not
    // evidence, and the settlement says so instead of promoting on the fragment
    // that preceded it.
    writeFileSync(join(knowledgeDir, `impl-M1-feat-${s}-gen5.md`), implKD(s, "retired"));
    await hooks["tool.execute.after"]({ tool: "edit", sessionID: `${s}-art` }, {});

    const log = readLog();
    expect(log).toContain(`CHECKOFF: milestone=M1 artifact=impl-M1-feat-${s}-gen5.md promoted=false reason=unknown-status transport=after-hook`);
    expect(registryBody(s, 5)).toContain("  M1: in-progress");
  });

  it("promotes on the landed bytes when a live document replaces a stamp and the stamp loop finds nothing to clear", async () => {
    const s = "lcgen-stamp-landed-1";
    await openLifecycle(s, { persistedGen: 6, anchorGen: 5 });
    // The prior evidence was stamped superseded by a reopen, so the write hook
    // sees a stale file and defers the check-off to the landed bytes.
    createKD(`impl-M1-feat-${s}-gen5.md`, implKD(s, "superseded"));
    clearLog();

    await writeAsArtisan(`${s}-art`, `knowledge/impl-M1-feat-${s}-gen5.md`, implKD(s));
    expect(readLog()).toContain("STAMP_CLEAR_PENDING");
    expect(registryBody(s, 5)).toContain("  M1: in-progress");

    // The runtime lands the author's live document, which is no longer stamped:
    // the stamp loop has nothing to clear, so only the deferred check-off can
    // evaluate what landed.
    writeFileSync(join(knowledgeDir, `impl-M1-feat-${s}-gen5.md`), implKD(s));
    await hooks["tool.execute.after"]({ tool: "write", sessionID: `${s}-art` }, {});

    const log = readLog();
    expect(log).toContain(`CHECKOFF: milestone=M1 artifact=impl-M1-feat-${s}-gen5.md promoted=true reason=live-evidence transport=after-hook`);
    expect(registryBody(s, 5)).toContain("  M1: checked-off");
  });

  it("refuses to start a lifecycle at a generation another unfinished lifecycle holds", async () => {
    const s = "lcgen-collide-1";
    await hooks["chat.params"]({ sessionID: s, agent: "overseer" }, {});
    hooks.sessionPhaseMap.set(s, hooks.STATES.INTENT);
    hooks.sessionPhaseMap.set(`${s}:sid`, s);
    hooks.sessionPhaseMap.set(`${s}:gen`, 4);
    // An unfinished lifecycle of this session already holds 5.
    createKD(`intent-earlier-${s}-gen5.md`, intentKD(s));
    clearLog();

    await expect(
      hooks["tool.execute.before"](
        { tool: "write", sessionID: s, callID: "c-intent-held" },
        { args: { filePath: `knowledge/intent-later-${s}-gen5.md`, content: intentKD(s) } }
      )
    ).rejects.toThrow(/GENERATION_HELD/);

    const log = readLog();
    expect(log).toContain("LIFECYCLE_GENERATION_COLLISION");
    expect(log).toContain(`intent-earlier-${s}-gen5.md`);
    // The counter did not adopt a held number: uniqueness is the gate's
    // guarantee, not a note in the log.
    expect(hooks.getCurrentGeneration(s)).toBe(4);

    // Paired positive: a free number starts the lifecycle and is adopted, so
    // the refusal above is about the collision and not about INTENT writes.
    await hooks["tool.execute.before"](
      { tool: "write", sessionID: s, callID: "c-intent-free" },
      { args: { filePath: `knowledge/intent-later-${s}-gen6.md`, content: intentKD(s) } }
    );
    expect(hooks.getCurrentGeneration(s)).toBe(6);
    expect(readLog()).toContain("LIFECYCLE_GENERATION_ADOPTED");
  });
});
