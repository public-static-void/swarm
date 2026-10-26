// Shared fixture for the walk-unification cases: a temporary knowledge dir, a
// temporary state dir, and a log dir seam so every assertion reads the gate's
// always-on channel without touching the operator's knowledge/ or default log.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import pluginModule from "../../../plugins/protocol-gate/index.js";

// Every freshness gate compares a file's `mtimeMs` against an integer
// millisecond anchor with `>=`. The filesystem stores mtime on a coarser grid
// than that anchor, so a write issued AFTER the anchor can be stored with a
// timestamp BEFORE it — and once that happens the ordering information is gone,
// no comparison can recover it. The gate's `>=` is its contract and must keep
// it, so the fix belongs where the write is made: a fixture whose write must
// advance a gate stamps it forward of the anchor. The margin is derived, not
// tuned: 500 × 10 ms covers the coarsest plausible local tick (HZ = 100), and
// it stays well under the 10 s stale interval the suite already uses, so a
// fresh and a stale artifact can never invert. A host with a coarser tick reds
// loudly rather than flaking quietly — do not raise it.
export const FRESH_MARGIN_MS = 5000;

// The offset is a parameter because two fixtures must keep a fresh write
// ORDERED ahead of a sibling written in the same tick — a single margin makes
// them tie, and a tie fails deterministically. An offset call keeps that
// ordering inside the one primitive; a per-site `utimesSync` would be the same
// stamp copied into the place the consolidation exists to remove.
export function stampFresh(fullPath, offsetMs = FRESH_MARGIN_MS) {
  utimesSync(fullPath, new Date(), new Date(Date.now() + offsetMs));
}

// Completion evidence is live only with an allowlisted frontmatter status, so
// every fixture that expects a row to close states one. A body-only artifact is
// non-evidence by design (FR-03) and would leave the gates closed for a reason
// that has nothing to do with the behavior under test.
export function implKDContent(sessionID, status = "draft") {
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

export function createWalkHarness(beforeAll, afterAll, beforeEach) {
  const env = {};

  beforeAll(() => {
    env.tempRoot = mkdtempSync(join(tmpdir(), "pg-walku-"));
    env.knowledgeDir = join(env.tempRoot, "knowledge");
    env.stateDir = join(env.tempRoot, "state");
    env.prior = {
      knowledge: process.env.PROTOCOL_GATE_KNOWLEDGE_DIR,
      state: process.env.PROTOCOL_GATE_STATE_DIR,
      log: process.env.PROTOCOL_GATE_LOG_DIR,
      debugFile: process.env.PROTOCOL_GATE_DEBUG_FILE,
      debug: process.env.PROTOCOL_GATE_DEBUG
    };
    process.env.PROTOCOL_GATE_KNOWLEDGE_DIR = env.knowledgeDir;
    process.env.PROTOCOL_GATE_STATE_DIR = env.stateDir;
    env.logDir = mkdtempSync(join(tmpdir(), "pg-walku-log-"));
    process.env.PROTOCOL_GATE_LOG_DIR = env.logDir;
    env.logPath = join(env.logDir, "protocol-gate.log");
    env.debugSentinel = join(env.tempRoot, "no-debug-sentinel");
    process.env.PROTOCOL_GATE_DEBUG_FILE = env.debugSentinel;
    delete process.env.PROTOCOL_GATE_DEBUG;
  });

  afterAll(() => {
    const restore = (key, value) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore("PROTOCOL_GATE_KNOWLEDGE_DIR", env.prior.knowledge);
    restore("PROTOCOL_GATE_STATE_DIR", env.prior.state);
    restore("PROTOCOL_GATE_LOG_DIR", env.prior.log);
    restore("PROTOCOL_GATE_DEBUG_FILE", env.prior.debugFile);
    restore("PROTOCOL_GATE_DEBUG", env.prior.debug);
    rmSync(env.logDir, { recursive: true, force: true });
    rmSync(env.tempRoot, { recursive: true, force: true });
  });

  const api = {
    get hooks() { return env.hooks; },
    set hooks(value) { env.hooks = value; },
    knowledgeDir: () => env.knowledgeDir,
    stateDir: () => env.stateDir,
    logPath: () => env.logPath
  };

  beforeEach(async () => {
    rmSync(env.knowledgeDir, { recursive: true, force: true });
    rmSync(env.stateDir, { recursive: true, force: true });
    mkdirSync(env.knowledgeDir, { recursive: true });
    mkdirSync(env.stateDir, { recursive: true });
    process.env.PROTOCOL_GATE_LOG_DIR = env.logDir;
    process.env.PROTOCOL_GATE_DEBUG_FILE = env.debugSentinel;
    delete process.env.PROTOCOL_GATE_DEBUG;
    api.hooks = await pluginModule.server({}, {});
  });

  api.createKD = (filename, content = "test content") => {
    writeFileSync(join(env.knowledgeDir, filename), content);
  };
  // Same bytes as createKD, then stamped forward of the anchor the gate will
  // compare against (see stampFresh). Any write a test expects to advance a
  // freshness gate uses this constructor, never a per-site utimes call.
  api.createFreshKD = (filename, content = "test content") => {
    api.createKD(filename, content);
    stampFresh(join(env.knowledgeDir, filename));
  };
  api.implKD = implKDContent;
  api.removeKD = (filename) => {
    try { rmSync(join(env.knowledgeDir, filename)); } catch (_) {}
  };
  api.ageKD = (filename, mtimeMs) => {
    const when = new Date(mtimeMs);
    utimesSync(join(env.knowledgeDir, filename), when, when);
  };
  api.statePath = (s) => join(env.stateDir, `.protocol-state-${s}.json`);
  api.clearLog = () => {
    try { rmSync(env.logPath, { force: true }); } catch (_) {}
  };
  api.logText = () => {
    try { return readFileSync(env.logPath, "utf8"); } catch (_) { return ""; }
  };
  api.records = (token) => {
    const marker = `] [protocol-gate] ${token}:`;
    return api.logText().split("\n").filter((line) => line.includes(marker));
  };
  api.parseRecord = (line) => {
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
  };

  api.registryContent = (rows) => {
    const yaml = rows.map(([id, state]) => `  ${id}: ${state}`).join("\n");
    const table = rows.map(([id, state]) => `| ${id} | desc | ${state} |`).join("\n");
    return `---
title: "MILESTONE REGISTRY: test"
version: 1.0.0
status: approved
type: milestones
author: Pathfinder
superseded_by: null
---

## Milestone States

\`\`\`yaml
milestones:
${yaml}
\`\`\`

## Milestone Details

| Milestone ID | Description | State |
| ------------ | ----------- | ----- |
${table}
`;
  };

  api.createRegistry = (s, rows) => {
    api.createKD(`milestones-feature-${s}.md`, api.registryContent(rows));
  };

  // A registry write expected to advance a gate — the SWARM registry-mtime
  // anchor and the DECOMPOSE dual-KD gate both read it — so it carries the same
  // forward stamp through createFreshKD rather than duplicating it.
  api.createFreshRegistry = (s, rows) => {
    api.createFreshKD(`milestones-feature-${s}.md`, api.registryContent(rows));
  };

  // The reopen target is a structured frontmatter field (FR-11), so a FAIL
  // fixture states its row there; prose mentions of a milestone are inert.
  api.reviewKD = (verdict, target = "") => {
    const targetLine = verdict === "FAIL" && target ? `reopen_target: [${target}]\n` : "";
    const body = verdict === "FAIL" && target
      ? `### F001: defect\n\n- **Milestone**: ${target}\n- **Status**: FAIL\n`
      : "";
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

${body}`;
  };

  api.cleanupKD = (s) => `---
title: "CLEANUP: test"
version: 1.0.0
status: draft
type: cleanup
session_id: "${s}"
author: Committer
superseded_by: null
---

# CLEANUP: test
`;

  api.initOverseer = async (s) => {
    await api.hooks["chat.params"]({ sessionID: s, agent: "overseer" }, {});
  };

  // skill is allowlisted in every phase with no handler side effects, so its
  // calls purely re-evaluate lifecycle state against KD evidence on disk.
  api.tick = async (s, callID) => {
    await api.hooks["tool.execute.before"]({ tool: "skill", sessionID: s, callID }, { args: {} });
  };

  api.glob = async (s, callID) => {
    await api.hooks["tool.execute.before"]({ tool: "glob", sessionID: s, callID }, { args: { pattern: "knowledge/*.md" } });
  };

  api.commit = async (s, arg) => {
    const out = { parts: [] };
    await api.hooks["command.execute.before"]({ command: "phase", sessionID: s, arguments: arg }, out);
    return out;
  };

  api.marker = (s) => api.hooks.sessionPhaseMap.get(`${s}:overrideUntil`);
  api.safePoint = (s) => api.hooks.sessionPhaseMap.get(`${s}:overrideSafePoint`);
  api.seedWalk = (s, phases, since, extra = {}) => {
    api.hooks.sessionPhaseMap.set(`${s}:overrideUntil`, { phases: [...phases], since, ...extra });
  };

  return api;
}
