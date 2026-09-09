import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Regression suite for the always-on trace channel (swarm/101). The trace
// channel writes injection events to a dedicated <plugin>-trace.log file
// unconditionally — independent of the debug env flags — so injection-failure
// triggers are provable in the default (debug-off) configuration. Each test
// redirects the trace output to a per-test temp dir via the <PLUGIN>_LOG_DIR
// env seam so production logs are never touched.
//
// Both plugins are loaded with dynamic import inside beforeAll so the
// knowledge-gate module-load-time dir seams (KNOWLEDGE_GATE_ISSUES_DIR etc.)
// bind to the temp dirs before the module evaluates.

describe("Trace Channel — protocol-gate", () => {
  let tempRoot;
  let logDir;
  let knowledgeDir;
  let stateDir;
  let hooks;
  let pluginModule;
  let priorLogDir;
  let priorDebug;
  let priorKnowledgeDir;
  let priorStateDir;

  const traceFile = () => join(logDir, "protocol-gate-trace.log");

  beforeAll(async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "pg-trace-"));
    logDir = join(tempRoot, "logs");
    knowledgeDir = join(tempRoot, "knowledge");
    stateDir = join(tempRoot, "state");
    priorLogDir = process.env.PROTOCOL_GATE_LOG_DIR;
    priorDebug = process.env.PROTOCOL_GATE_DEBUG;
    priorKnowledgeDir = process.env.PROTOCOL_GATE_KNOWLEDGE_DIR;
    priorStateDir = process.env.PROTOCOL_GATE_STATE_DIR;
    process.env.PROTOCOL_GATE_LOG_DIR = logDir;
    process.env.PROTOCOL_GATE_KNOWLEDGE_DIR = knowledgeDir;
    process.env.PROTOCOL_GATE_STATE_DIR = stateDir;
    pluginModule = await import("../../plugins/protocol-gate/index.js");
  });

  afterAll(() => {
    if (priorLogDir === undefined) delete process.env.PROTOCOL_GATE_LOG_DIR;
    else process.env.PROTOCOL_GATE_LOG_DIR = priorLogDir;
    if (priorDebug === undefined) delete process.env.PROTOCOL_GATE_DEBUG;
    else process.env.PROTOCOL_GATE_DEBUG = priorDebug;
    if (priorKnowledgeDir === undefined) delete process.env.PROTOCOL_GATE_KNOWLEDGE_DIR;
    else process.env.PROTOCOL_GATE_KNOWLEDGE_DIR = priorKnowledgeDir;
    if (priorStateDir === undefined) delete process.env.PROTOCOL_GATE_STATE_DIR;
    else process.env.PROTOCOL_GATE_STATE_DIR = priorStateDir;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    rmSync(logDir, { recursive: true, force: true });
    rmSync(knowledgeDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    mkdirSync(logDir, { recursive: true });
    mkdirSync(knowledgeDir, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    delete process.env.PROTOCOL_GATE_DEBUG;
    hooks = await pluginModule.default.server({}, {});
  });

  async function initOverseer(s) {
    await hooks["chat.params"]({ sessionID: s, agent: "overseer" }, {});
  }

  it("writes a trace line without the debug flag and leaves the debug log absent", async () => {
    const s = "trace-nodb-1";
    await initOverseer(s);
    hooks.sessionPhaseMap.set(s, hooks.STATES.INTENT);
    hooks.sessionPhaseMap.set(`${s}:sid`, s);
    hooks.sessionPhaseMap.set(`${s}:gen`, 0);

    const output = { system: [] };
    await hooks["experimental.chat.system.transform"]({ sessionID: s }, output);

    expect(existsSync(traceFile())).toBe(true);
    const trace = readFileSync(traceFile(), "utf8");
    expect(trace).toContain(`systemTransform: INTENT injected session=${s} gen=0`);
    expect(trace).toContain(`systemTransform: phase=INTENT injected for session=${s}`);
    // The debug channel stays silent when the debug flag is off.
    expect(existsSync(join(logDir, "protocol-gate.log"))).toBe(false);
  });

  it("traces the silent early-return guards when sessionID or phase is missing", async () => {
    // No sessionID at all — the first guard fires.
    const out1 = { system: [] };
    await hooks["experimental.chat.system.transform"]({}, out1);
    expect(readFileSync(traceFile(), "utf8")).toContain("systemTransform: skip — no sessionID");

    // A registered overseer session with no phase — the phase guard fires.
    const s = "trace-guard-1";
    await initOverseer(s);
    hooks.sessionPhaseMap.delete(s);
    const out2 = { system: [] };
    await hooks["experimental.chat.system.transform"]({ sessionID: s }, out2);
    expect(readFileSync(traceFile(), "utf8")).toContain(`systemTransform: skip — phase undefined for session=${s}`);
  });

  it("writes both the debug and trace channels when the debug flag is on", async () => {
    // The debug channel writes to its hardcoded plugins/logs/ location (it
    // does not honor the LOG_DIR seam — only the trace channel does), so the
    // real debug log path is asserted and cleaned up after.
    const realDebugFile = join(process.cwd(), "plugins", "logs", "protocol-gate.log");
    try { rmSync(realDebugFile); } catch (_) {}
    process.env.PROTOCOL_GATE_DEBUG = "1";
    const s = "trace-dbg-1";
    await initOverseer(s);
    hooks.sessionPhaseMap.set(s, hooks.STATES.INTENT);
    hooks.sessionPhaseMap.set(`${s}:sid`, s);
    hooks.sessionPhaseMap.set(`${s}:gen`, 1);

    const output = { system: [] };
    await hooks["experimental.chat.system.transform"]({ sessionID: s }, output);

    // Both channels coexist: the debug log keeps its existing format and the
    // trace log carries the new always-on format.
    expect(existsSync(realDebugFile)).toBe(true);
    expect(existsSync(traceFile())).toBe(true);
    const debug = readFileSync(realDebugFile, "utf8");
    const trace = readFileSync(traceFile(), "utf8");
    expect(debug).toContain("[protocol-gate]");
    expect(trace).toContain("[protocol-gate] TRACE:");
    expect(trace).toContain(`systemTransform: INTENT injected session=${s} gen=1`);
    try { rmSync(realDebugFile); } catch (_) {}
  });
});

describe("Trace Channel — knowledge-gate", () => {
  let tempRoot;
  let logDir;
  let memoryDir;
  let issuesDir;
  let shortTermDir;
  let hooks;
  let pluginModule;
  let priorLogDir;
  let priorDebug;
  let priorMemoryDir;
  let priorIssuesDir;
  let priorShortTermDir;

  const traceFile = () => join(logDir, "knowledge-gate-trace.log");

  function addIssueFile(id, overrides = {}) {
    const defaultIssue = {
      id: `ISSUE-${String(id).padStart(3, "0")}`,
      title: `Test Issue ${id}`,
      severity: "high",
      status: "open",
      created: "2026-07-29",
      session: "ses_trace",
      assigned_to: "habit-builder",
      tags: "[test, mock]"
    };
    const frontmatter = Object.entries({ ...defaultIssue, ...overrides })
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n");
    writeFileSync(join(issuesDir, `issue-${String(id).padStart(3, "0")}.md`), `---\n${frontmatter}\n---\n\nIssue body for ${id}.`);
  }

  beforeAll(async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "kg-trace-"));
    logDir = join(tempRoot, "logs");
    memoryDir = join(tempRoot, "memory");
    issuesDir = join(tempRoot, "issues");
    shortTermDir = join(tempRoot, "short-term");
    priorLogDir = process.env.KNOWLEDGE_GATE_LOG_DIR;
    priorDebug = process.env.KNOWLEDGE_GATE_DEBUG;
    priorMemoryDir = process.env.KNOWLEDGE_GATE_MEMORY_DIR;
    priorIssuesDir = process.env.KNOWLEDGE_GATE_ISSUES_DIR;
    priorShortTermDir = process.env.KNOWLEDGE_GATE_SHORT_TERM_DIR;
    process.env.KNOWLEDGE_GATE_LOG_DIR = logDir;
    process.env.KNOWLEDGE_GATE_MEMORY_DIR = memoryDir;
    process.env.KNOWLEDGE_GATE_ISSUES_DIR = issuesDir;
    process.env.KNOWLEDGE_GATE_SHORT_TERM_DIR = shortTermDir;
    pluginModule = await import("../../plugins/knowledge-gate/index.js");
  });

  afterAll(() => {
    if (priorLogDir === undefined) delete process.env.KNOWLEDGE_GATE_LOG_DIR;
    else process.env.KNOWLEDGE_GATE_LOG_DIR = priorLogDir;
    if (priorDebug === undefined) delete process.env.KNOWLEDGE_GATE_DEBUG;
    else process.env.KNOWLEDGE_GATE_DEBUG = priorDebug;
    if (priorMemoryDir === undefined) delete process.env.KNOWLEDGE_GATE_MEMORY_DIR;
    else process.env.KNOWLEDGE_GATE_MEMORY_DIR = priorMemoryDir;
    if (priorIssuesDir === undefined) delete process.env.KNOWLEDGE_GATE_ISSUES_DIR;
    else process.env.KNOWLEDGE_GATE_ISSUES_DIR = priorIssuesDir;
    if (priorShortTermDir === undefined) delete process.env.KNOWLEDGE_GATE_SHORT_TERM_DIR;
    else process.env.KNOWLEDGE_GATE_SHORT_TERM_DIR = priorShortTermDir;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    rmSync(logDir, { recursive: true, force: true });
    rmSync(memoryDir, { recursive: true, force: true });
    rmSync(issuesDir, { recursive: true, force: true });
    rmSync(shortTermDir, { recursive: true, force: true });
    mkdirSync(logDir, { recursive: true });
    mkdirSync(memoryDir, { recursive: true });
    mkdirSync(issuesDir, { recursive: true });
    mkdirSync(shortTermDir, { recursive: true });
    delete process.env.KNOWLEDGE_GATE_DEBUG;
    delete process.env.KNOWLEDGE_GATE_MAX_OPEN_ISSUES;
    delete process.env.KNOWLEDGE_GATE_ISSUE_AUDIENCE;
    hooks = await pluginModule.default.server({}, {});
  });

  it("writes a trace line without the debug flag and leaves the debug log absent", async () => {
    const output = { system: [] };
    await hooks["experimental.chat.system.transform"](
      { sessionID: "trace-session", agent: "overseer" },
      output
    );

    expect(existsSync(traceFile())).toBe(true);
    const trace = readFileSync(traceFile(), "utf8");
    expect(trace).toContain("systemTransform: Overseer issue scan — scanned=0 filtered=0 capped=0 injected=0");
    expect(existsSync(join(logDir, "knowledge-gate.log"))).toBe(false);
  });

  it("traces the zero-issue injection with scanned=0 injected=0", async () => {
    // Only a resolved issue exists — the open scan yields zero.
    addIssueFile(1, { status: "resolved", title: "Closed item" });

    const output = { system: [] };
    await hooks["experimental.chat.system.transform"](
      { sessionID: "trace-session", agent: "overseer" },
      output
    );

    const trace = readFileSync(traceFile(), "utf8");
    expect(trace).toContain("systemTransform: Overseer issue scan — scanned=0 filtered=0 capped=0 injected=0");
  });

  it("traces the filter/cap reduction from scanned to injected", async () => {
    // 5 open issues, audience-filtered to 2, capped to 1.
    process.env.KNOWLEDGE_GATE_ISSUE_AUDIENCE = "inspector";
    process.env.KNOWLEDGE_GATE_MAX_OPEN_ISSUES = "1";
    addIssueFile(1, { assigned_to: "inspector", title: "Inspector item" });
    addIssueFile(2, { assigned_to: "inspector", title: "Inspector item 2" });
    addIssueFile(3, { assigned_to: "permission", title: "Permission item" });
    addIssueFile(4, { assigned_to: "permission", title: "Permission item 2" });
    addIssueFile(5, { assigned_to: "permission", title: "Permission item 3" });

    const output = { system: [] };
    await hooks["experimental.chat.system.transform"](
      { sessionID: "trace-session", agent: "overseer" },
      output
    );

    const trace = readFileSync(traceFile(), "utf8");
    // Workspace-aware: config dir scans swarm+generic (2 stores), so 5 open
    // issues → scanned=10; audience filter keeps 2 inspector issues × 2 = 4;
    // cap 1 → 1 injected.
    expect(trace).toContain("systemTransform: Overseer issue scan — scanned=10 filtered=4 capped=1 injected=1");
  });

  it("writes both the debug and trace channels when the debug flag is on", async () => {
    // The debug channel writes to its hardcoded plugins/logs/ location (it
    // does not honor the LOG_DIR seam — only the trace channel does), so the
    // real debug log path is asserted and cleaned up after.
    const realDebugFile = join(process.cwd(), "plugins", "logs", "knowledge-gate.log");
    try { rmSync(realDebugFile); } catch (_) {}
    process.env.KNOWLEDGE_GATE_DEBUG = "1";
    addIssueFile(1, { severity: "high", title: "Open item" });

    const output = { system: [] };
    await hooks["experimental.chat.system.transform"](
      { sessionID: "trace-session", agent: "overseer" },
      output
    );

    expect(existsSync(realDebugFile)).toBe(true);
    expect(existsSync(traceFile())).toBe(true);
    const debug = readFileSync(realDebugFile, "utf8");
    const trace = readFileSync(traceFile(), "utf8");
    expect(debug).toContain("[knowledge-gate]");
    expect(trace).toContain("[knowledge-gate] TRACE:");
    expect(trace).toContain("systemTransform: Overseer issue scan —");
    try { rmSync(realDebugFile); } catch (_) {}
  });
});

describe("Trace Channel — cross-plugin format consistency", () => {
  let pgRoot;
  let kgRoot;
  let pgLogDir;
  let kgLogDir;
  let pgKnowledgeDir;
  let pgStateDir;
  let kgMemoryDir;
  let kgIssuesDir;
  let kgShortTermDir;
  let pgHooks;
  let kgHooks;
  let pgModule;
  let kgModule;
  let priorPgLogDir;
  let priorKgLogDir;
  let priorPgDebug;
  let priorKgDebug;
  let priorPgKnowledgeDir;
  let priorPgStateDir;
  let priorKgMemoryDir;
  let priorKgIssuesDir;
  let priorKgShortTermDir;

  beforeAll(async () => {
    pgRoot = mkdtempSync(join(tmpdir(), "pg-fmt-"));
    kgRoot = mkdtempSync(join(tmpdir(), "kg-fmt-"));
    pgLogDir = join(pgRoot, "logs");
    kgLogDir = join(kgRoot, "logs");
    pgKnowledgeDir = join(pgRoot, "knowledge");
    pgStateDir = join(pgRoot, "state");
    kgMemoryDir = join(kgRoot, "memory");
    kgIssuesDir = join(kgRoot, "issues");
    kgShortTermDir = join(kgRoot, "short-term");
    priorPgLogDir = process.env.PROTOCOL_GATE_LOG_DIR;
    priorKgLogDir = process.env.KNOWLEDGE_GATE_LOG_DIR;
    priorPgDebug = process.env.PROTOCOL_GATE_DEBUG;
    priorKgDebug = process.env.KNOWLEDGE_GATE_DEBUG;
    priorPgKnowledgeDir = process.env.PROTOCOL_GATE_KNOWLEDGE_DIR;
    priorPgStateDir = process.env.PROTOCOL_GATE_STATE_DIR;
    priorKgMemoryDir = process.env.KNOWLEDGE_GATE_MEMORY_DIR;
    priorKgIssuesDir = process.env.KNOWLEDGE_GATE_ISSUES_DIR;
    priorKgShortTermDir = process.env.KNOWLEDGE_GATE_SHORT_TERM_DIR;
    process.env.PROTOCOL_GATE_LOG_DIR = pgLogDir;
    process.env.KNOWLEDGE_GATE_LOG_DIR = kgLogDir;
    process.env.PROTOCOL_GATE_KNOWLEDGE_DIR = pgKnowledgeDir;
    process.env.PROTOCOL_GATE_STATE_DIR = pgStateDir;
    process.env.KNOWLEDGE_GATE_MEMORY_DIR = kgMemoryDir;
    process.env.KNOWLEDGE_GATE_ISSUES_DIR = kgIssuesDir;
    process.env.KNOWLEDGE_GATE_SHORT_TERM_DIR = kgShortTermDir;
    pgModule = await import("../../plugins/protocol-gate/index.js");
    kgModule = await import("../../plugins/knowledge-gate/index.js");
  });

  afterAll(() => {
    if (priorPgLogDir === undefined) delete process.env.PROTOCOL_GATE_LOG_DIR;
    else process.env.PROTOCOL_GATE_LOG_DIR = priorPgLogDir;
    if (priorKgLogDir === undefined) delete process.env.KNOWLEDGE_GATE_LOG_DIR;
    else process.env.KNOWLEDGE_GATE_LOG_DIR = priorKgLogDir;
    if (priorPgDebug === undefined) delete process.env.PROTOCOL_GATE_DEBUG;
    else process.env.PROTOCOL_GATE_DEBUG = priorPgDebug;
    if (priorKgDebug === undefined) delete process.env.KNOWLEDGE_GATE_DEBUG;
    else process.env.KNOWLEDGE_GATE_DEBUG = priorKgDebug;
    if (priorPgKnowledgeDir === undefined) delete process.env.PROTOCOL_GATE_KNOWLEDGE_DIR;
    else process.env.PROTOCOL_GATE_KNOWLEDGE_DIR = priorPgKnowledgeDir;
    if (priorPgStateDir === undefined) delete process.env.PROTOCOL_GATE_STATE_DIR;
    else process.env.PROTOCOL_GATE_STATE_DIR = priorPgStateDir;
    if (priorKgMemoryDir === undefined) delete process.env.KNOWLEDGE_GATE_MEMORY_DIR;
    else process.env.KNOWLEDGE_GATE_MEMORY_DIR = priorKgMemoryDir;
    if (priorKgIssuesDir === undefined) delete process.env.KNOWLEDGE_GATE_ISSUES_DIR;
    else process.env.KNOWLEDGE_GATE_ISSUES_DIR = priorKgIssuesDir;
    if (priorKgShortTermDir === undefined) delete process.env.KNOWLEDGE_GATE_SHORT_TERM_DIR;
    else process.env.KNOWLEDGE_GATE_SHORT_TERM_DIR = priorKgShortTermDir;
    rmSync(pgRoot, { recursive: true, force: true });
    rmSync(kgRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    rmSync(pgLogDir, { recursive: true, force: true });
    rmSync(kgLogDir, { recursive: true, force: true });
    rmSync(pgKnowledgeDir, { recursive: true, force: true });
    rmSync(pgStateDir, { recursive: true, force: true });
    rmSync(kgMemoryDir, { recursive: true, force: true });
    rmSync(kgIssuesDir, { recursive: true, force: true });
    rmSync(kgShortTermDir, { recursive: true, force: true });
    mkdirSync(pgLogDir, { recursive: true });
    mkdirSync(kgLogDir, { recursive: true });
    mkdirSync(pgKnowledgeDir, { recursive: true });
    mkdirSync(pgStateDir, { recursive: true });
    mkdirSync(kgMemoryDir, { recursive: true });
    mkdirSync(kgIssuesDir, { recursive: true });
    mkdirSync(kgShortTermDir, { recursive: true });
    delete process.env.PROTOCOL_GATE_DEBUG;
    delete process.env.KNOWLEDGE_GATE_DEBUG;
    pgHooks = await pgModule.default.server({}, {});
    kgHooks = await kgModule.default.server({}, {});
  });

  it("emits the same [ISO-8601] [plugin] TRACE: format from both plugins", async () => {
    // Protocol-gate: drive an INTENT injection.
    const s = "fmt-pg";
    await pgHooks["chat.params"]({ sessionID: s, agent: "overseer" }, {});
    pgHooks.sessionPhaseMap.set(s, pgHooks.STATES.INTENT);
    pgHooks.sessionPhaseMap.set(`${s}:sid`, s);
    pgHooks.sessionPhaseMap.set(`${s}:gen`, 0);
    await pgHooks["experimental.chat.system.transform"]({ sessionID: s }, { system: [] });

    // Knowledge-gate: drive an overseer issue scan.
    await kgHooks["experimental.chat.system.transform"](
      { sessionID: "fmt-kg", agent: "overseer" },
      { system: [] }
    );

    const pgTrace = readFileSync(join(pgLogDir, "protocol-gate-trace.log"), "utf8");
    const kgTrace = readFileSync(join(kgLogDir, "knowledge-gate-trace.log"), "utf8");

    // Both channels produce the canonical line shape: an ISO-8601 timestamp,
    // the plugin name in brackets, and the TRACE: marker.
    const lineShape = /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] \[(protocol-gate|knowledge-gate)\] TRACE: /;
    for (const line of pgTrace.trim().split("\n")) {
      expect(line).toMatch(lineShape);
    }
    for (const line of kgTrace.trim().split("\n")) {
      expect(line).toMatch(lineShape);
    }
    expect(pgTrace).toContain("[protocol-gate] TRACE:");
    expect(kgTrace).toContain("[knowledge-gate] TRACE:");
  });
});
