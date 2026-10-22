// Shared fixture for the walk-unification cases: a temporary knowledge dir, a
// temporary state dir, and a log dir seam so every assertion reads the gate's
// always-on channel without touching the operator's knowledge/ or default log.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import pluginModule from "../../../plugins/protocol-gate/index.js";

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

  api.reviewKD = (verdict, citation = "") => {
    const body = verdict === "FAIL" && citation
      ? `### F001: defect\n\n- **Milestone citation**: ${citation}\n- **Status**: FAIL\n`
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
---

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
