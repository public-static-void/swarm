/**
 * Protocol Gate Plugin — Overseer State Machine Enforcement
 *
 * 13-state closed-gate state machine that hooks all tools and enforces
 * phase progression, tool allowlists, and advancement criteria for
 * Overseer sessions only. Non-overseer agents pass through (fail-open).
 *
 * States: PROTOCOL_NOT_LOADED(0) → INTENT(1) → PREFLIGHT(2) → EXPLORE(3)
 *   → INVESTIGATE(4) → ALIGN(5) → DECOMPOSE(6) → SWARM(7) → VERIFY(8)
 *   → EXTRACT(9) → EVOLVE(10) → COMMIT(11) → REPORT(12)
 *
 * Hooks: chat.params (init), permission.ask (primary), tool.execute.before (safety net)
 *
 * Environment:
 *   PROTOCOL_GATE_DEBUG=true — file logging
 */

import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";

// ─── State Constants ─────────────────────────────────────────────────────────

const PROTOCOL_NOT_LOADED = 0;
const INTENT = 1;
const PREFLIGHT = 2;
const EXPLORE = 3;
const INVESTIGATE = 4;
const ALIGN = 5;
const DECOMPOSE = 6;
const SWARM = 7;
const VERIFY = 8;
const EXTRACT = 9;
const EVOLVE = 10;
const COMMIT = 11;
const REPORT = 12;

// ─── State Table ─────────────────────────────────────────────────────────────

const STATES = [
  // id,  name,                 allowedTools,                                    advanceOn,                    agent,           readAllowed
  { id: 0,  name: "PROTOCOL_NOT_LOADED", allowedTools: ["todowrite"],                              advanceOn: "todowrite-with-all-keywords" },
  { id: 1,  name: "INTENT",              allowedTools: ["todowrite", "write", "read", "question"], advanceOn: "write-intent-kd",            readAllowed: ["skills/kd-system/templates/template-intent.md"] },
  { id: 2,  name: "PREFLIGHT",           allowedTools: ["task", "todowrite", "glob"],              advanceOn: "glob-plan-preflight",        agent: "committer" },
  { id: 3,  name: "EXPLORE",             allowedTools: ["task", "todowrite", "glob"],              advanceOn: "glob-exploration",           agent: "explorer" },
  { id: 4,  name: "INVESTIGATE",         allowedTools: ["task", "todowrite", "glob"],              advanceOn: "glob-analysis",              agent: "analyzer" },
  { id: 5,  name: "ALIGN",               allowedTools: ["task", "todowrite", "glob"],              advanceOn: "glob-spec",                  agent: "spec-weaver" },
  { id: 6,  name: "DECOMPOSE",           allowedTools: ["task", "todowrite", "glob"],              advanceOn: "glob-plan",                  agent: "pathfinder" },
  { id: 7,  name: "SWARM",               allowedTools: ["task", "todowrite", "glob"],              advanceOn: "glob-impl",                  agent: "artisan" },
  { id: 8,  name: "VERIFY",              allowedTools: ["task", "todowrite", "glob"],              advanceOn: "glob-review-audit",          agent: "inspector" },
  { id: 9,  name: "EXTRACT",             allowedTools: ["task", "todowrite", "glob"],              advanceOn: "glob-composed",              agent: "scribe" },
  { id: 10, name: "EVOLVE",              allowedTools: ["task", "todowrite", "glob"],              advanceOn: "glob-process",               agent: "habit-builder" },
  { id: 11, name: "COMMIT",              allowedTools: ["task", "todowrite", "glob"],              advanceOn: "glob-clean-tree",            agent: "committer" },
  { id: 12, name: "REPORT",              allowedTools: ["todowrite", "write", "read"],             advanceOn: "write-report-kd",            readAllowed: ["skills/kd-system/templates/template-report.md"] },
];

// ─── Backward Transitions ────────────────────────────────────────────────────

const BACKWARD_TRANSITIONS = {
  8:  { from: "VERIFY",    to: 7,  toName: "SWARM",    description: "Inspector found issues → Artisan fixes" },
  5:  { from: "ALIGN",     to: 3,  toName: "EXPLORE",   description: "Spec Weaver needs more exploration" },
  6:  { from: "DECOMPOSE", to: 5,  toName: "ALIGN",     description: "Pathfinder needs spec clarification" },
  7:  { from: "SWARM",     to: 6,  toName: "DECOMPOSE", description: "Artisan needs better decomposition" },
};

// ─── Phase → Agent Mapping (built from config) ─────────────────────────────

const PHASE_AGENT_MAP = {};
for (const s of STATES) {
  if (s.agent) PHASE_AGENT_MAP[s.id] = s.agent;
}

// Agents loaded from lifecycle.json config; fallback to STATES table defaults
let AGENT_NAMES = [
  "committer", "explorer", "analyzer", "spec-weaver", "pathfinder",
  "artisan", "inspector", "scribe", "habit-builder",
];

// ─── Config Loading ──────────────────────────────────────────────────────────

const DEFAULT_CONFIG = {
  phases: [
    "INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE",
    "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "COMMIT", "REPORT",
  ],
  agents: {},
  maxCyclesPerTransition: 3,
  maxRetriesPerPhase: 5,
};

function loadConfig() {
  try {
    const configPath = path.join(
      process.env._PROTOCOL_GATE_CONFIG_DIR ||
        path.dirname(new URL(import.meta.url).pathname),
      "lifecycle.json",
    );
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed.phases || !Array.isArray(parsed.phases) || parsed.phases.length === 0) {
      log("CONFIG_FALLBACK", "empty or missing phases array — using defaults");
      return DEFAULT_CONFIG;
    }
    return {
      phases: parsed.phases,
      agents: parsed.agents || {},
      maxCyclesPerTransition: parsed.maxCyclesPerTransition ?? DEFAULT_CONFIG.maxCyclesPerTransition,
      maxRetriesPerPhase: parsed.maxRetriesPerPhase ?? DEFAULT_CONFIG.maxRetriesPerPhase,
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

// ─── Logging ─────────────────────────────────────────────────────────────────

const LOG_DIR =
  process.env._PROTOCOL_GATE_LOG_DIR ||
  path.join(os.homedir(), ".config", "opencode", "logs");
const LOG_FILE = path.join(LOG_DIR, "protocol-gate.log");

function log(event, details) {
  if (!process.env.PROTOCOL_GATE_DEBUG) return;
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, `[PROTOCOL-GATE] ${new Date().toISOString()} | ${event} | ${details}\n`);
  } catch (_) {}
}

// ─── Session State ───────────────────────────────────────────────────────────

const sessionAgentMap = new Map();
const sessionPhaseMap = new Map();
const cycleMap = new Map();       // sessionID → Map<"from→to", count>
const retryMap = new Map();       // sessionID → count (consecutive retries per phase)

// ─── Config (loaded once at startup, R036) ───────────────────────────────────

let config = loadConfig();

// Override PHASE_AGENT_MAP and AGENT_NAMES from lifecycle.json config.
// Config agents take precedence over STATES table defaults.
if (config.agents && Object.keys(config.agents).length > 0) {
  for (const [phaseName, agentName] of Object.entries(config.agents)) {
    const state = STATES.find((s) => s.name === phaseName);
    if (state) PHASE_AGENT_MAP[state.id] = agentName;
  }
  // Rebuild AGENT_NAMES from the merged map (unique values only)
  AGENT_NAMES = [...new Set(Object.values(PHASE_AGENT_MAP))];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function containsAllLifecycleKeywords(items, lifecyclePhases) {
  if (!Array.isArray(items) || items.length === 0) return false;
  const text = items
    .map((i) => (typeof i === "string" ? i : i?.content || ""))
    .join(" ")
    .toUpperCase();
  return lifecyclePhases.every((kw) => text.includes(kw));
}

function extractTodoItems(args) {
  if (!args || typeof args !== "object") return null;
  for (const key of ["items", "todos", "tasks", "entries"]) {
    if (Array.isArray(args[key])) return args[key];
  }
  for (const key of Object.keys(args)) {
    if (Array.isArray(args[key])) return args[key];
  }
  return null;
}

function isIntentKD(filePath) {
  return /knowledge\/intent-.+\.md$/.test((filePath || "").replace(/^\.\//, ""));
}

function isReportKD(filePath) {
  return /knowledge\/report-.+\.md$/.test((filePath || "").replace(/^\.\//, ""));
}

function isTemplateRead(filePath, templateSuffix) {
  return (filePath || "").includes(`skills/kd-system/templates/${templateSuffix}`);
}

// Disk verification using fs (synchronous, R042-R044)
function globMatches(pattern) {
  try {
    const knowledgeDir = path.resolve("knowledge");
    if (!fs.existsSync(knowledgeDir)) return false;
    const files = fs.readdirSync(knowledgeDir);
    const regex = patternToRegex(pattern);
    return files.some((f) => regex.test(`knowledge/${f}`));
  } catch {
    return false;
  }
}

function patternToRegex(pattern) {
  // Convert glob pattern to regex: knowledge/*.md → knowledge\/[^/]+\.md
  // knowledge/plan-*-preflight-* → knowledge\/plan-.*-preflight-.*
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "§§GLOBSTAR§§")
    .replace(/\*/g, "[^/]*")
    .replace(/§§GLOBSTAR§§/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function hasCleanTree() {
  try {
    const knowledgeDir = path.resolve("knowledge");
    if (!fs.existsSync(knowledgeDir)) return false;
    const result = execSync("git status --porcelain knowledge/", {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
    return result.length === 0;
  } catch {
    return false;
  }
}

// ─── Error Classes ───────────────────────────────────────────────────────────

class ProtocolGateError extends Error {
  constructor({ code, message, guidance }) {
    super(message);
    this.name = "ProtocolGateError";
    this.code = code;
    this.guidance = guidance;
  }
}

const ERRORS = Object.freeze({
  BLOCKED_NOT_LOADED: Object.freeze({
    code: "BLOCKED_NOT_LOADED",
    message: "STOP. Call todowrite now.",
    guidance: "Load the 12-phase protocol by calling todowrite with all lifecycle keywords before using any tool.",
  }),
  BLOCKED_UNINITIALIZED: Object.freeze({
    code: "BLOCKED_UNINITIALIZED",
    message: "Session not initialized. Wait for chat.params.",
    guidance: "The state machine is initializing. This tool call was blocked to prevent access before initialization.",
  }),
  BLOCKED_NO_LIFECYCLE: Object.freeze({
    code: "BLOCKED_NO_LIFECYCLE",
    message: "todowrite must contain all 12 lifecycle keywords.",
    guidance: "Include all keywords: INTENT, PREFLIGHT, EXPLORE, INVESTIGATE, ALIGN, DECOMPOSE, SWARM, VERIFY, EXTRACT, EVOLVE, COMMIT, REPORT.",
  }),
  BLOCKED_WRONG_PHASE: Object.freeze({
    code: "BLOCKED_WRONG_PHASE",
    message: "Tool not allowed in current phase.",
    guidance: "Check the current phase and use only allowed tools for this phase.",
  }),
  BLOCKED_INTENT_ONLY: Object.freeze({
    code: "BLOCKED_INTENT_ONLY",
    message: "Only INTENT KD writes allowed in INTENT phase.",
    guidance: "Write to knowledge/intent-*.md only. Complete the intent phase before accessing other files.",
  }),
  BLOCKED_REPORT_ONLY: Object.freeze({
    code: "BLOCKED_REPORT_ONLY",
    message: "Only REPORT KD writes allowed in REPORT phase.",
    guidance: "Write to knowledge/report-*.md only.",
  }),
  WRONG_AGENT: Object.freeze({
    code: "WRONG_AGENT",
    message: "Wrong agent for current phase.",
    guidance: "", // dynamically filled with correct agent name
  }),
  CYCLE_LIMIT_REACHED: Object.freeze({
    code: "CYCLE_LIMIT_REACHED",
    message: "Backward transition cycle limit reached.",
    guidance: "Escalate to user. The maximum number of backward transitions for this state pair has been reached.",
  }),
  BLOCKED_DISALLOWED_BACKWARD: Object.freeze({
    code: "BLOCKED_DISALLOWED_BACKWARD",
    message: "This backward transition is not allowed.",
    guidance: "Only specific backward transitions are permitted. Check the allowed transitions.",
  }),
});

function reject(ctx, output, errorKey, extraGuidance) {
  const errDef = ERRORS[errorKey];
  const err = extraGuidance
    ? { ...errDef, guidance: extraGuidance }
    : errDef;
  log("BLOCKED", `session=${ctx.sessionID} tool=${ctx.tool} code=${err.code}`);
  if (ctx.tool === "task") {
    throw new ProtocolGateError(err);
  }
  output.error = { code: err.code, message: err.message, guidance: err.guidance };
}

// ─── Agent Routing ───────────────────────────────────────────────────────────

function extractAgentFromPrompt(prompt) {
  if (!prompt || typeof prompt !== "string") return null;
  const lower = prompt.toLowerCase();
  for (const name of AGENT_NAMES) {
    // Match agent name with word boundaries — standalone or in "DISPATCH TO: <name>"
    const idx = lower.indexOf(name);
    if (idx !== -1) {
      const before = idx === 0 ? " " : lower[idx - 1];
      const after = idx + name.length < lower.length ? lower[idx + name.length] : " ";
      if (/[\s:,\-]/.test(before) && /[\s:,\-]/.test(after)) {
        return name;
      }
    }
  }
  return null;
}

// ─── Plugin ──────────────────────────────────────────────────────────────────

export default async function protocolGatePlugin() {
  log("PLUGIN_LOADED", `config: phases=${config.phases.length}, maxCycles=${config.maxCyclesPerTransition}, maxRetries=${config.maxRetriesPerPhase}`);

  return {
    // ─── chat.params Hook ────────────────────────────────────────────────
    "chat.params": async (input, _output) => {
      if (!input.sessionID || !input.agent) return;
      sessionAgentMap.set(input.sessionID, input.agent);
      if (input.agent === "overseer") {
        if (!sessionPhaseMap.has(input.sessionID)) {
          sessionPhaseMap.set(input.sessionID, PROTOCOL_NOT_LOADED);
          retryMap.set(input.sessionID, 0);
          log("PHASE_INIT", `session=${input.sessionID} phase=PROTOCOL_NOT_LOADED`);
        }
      } else {
        sessionPhaseMap.delete(input.sessionID);
        retryMap.delete(input.sessionID);
        cycleMap.delete(input.sessionID);
      }
    },

    // ─── permission.ask Hook (Primary Enforcement) ───────────────────────
    "permission.ask": async (input, output) => {
      const { type: tool, sessionID } = input;
      const agent = sessionAgentMap.get(sessionID);
      const phase = sessionPhaseMap.get(sessionID);

      // R004: Non-overseer — fail-open
      if (agent !== "overseer") return;
      // R005b: Overseer with no phase entry — handled by tool.execute.before
      if (phase === undefined) return;

      // R010b: Return early for task/todowrite — handled by tool.execute.before
      if (tool === "task" || tool === "todowrite") return;

      const state = STATES[phase];
      if (!state) return;

      const pattern = input.pattern || "";

      // Check if tool is in allowlist for current state
      if (!state.allowedTools.includes(tool)) {
        output.status = "deny";
        log("PERM_DENY", `session=${sessionID} tool=${tool} phase=${state.name} reason=tool-not-in-allowlist`);
        return;
      }

      // For pattern-based tools (read, write, glob, bash, edit, webfetch, websearch),
      // validate the pattern against state-specific rules
      if (tool === "read" && state.readAllowed) {
        const allowed = state.readAllowed.some((tpl) => pattern.includes(tpl));
        if (!allowed) {
          output.status = "deny";
          log("PERM_DENY", `session=${sessionID} tool=read phase=${state.name} pattern=${pattern} reason=not-template-path`);
          return;
        }
      }

      if (tool === "write") {
        const valid =
          (state.name === "INTENT" && isIntentKD(pattern)) ||
          (state.name === "REPORT" && isReportKD(pattern));
        if (!valid) {
          output.status = "deny";
          log("PERM_DENY", `session=${sessionID} tool=write phase=${state.name} pattern=${pattern} reason=wrong-kd-path`);
          return;
        }
      }

      // All other pattern-based tools in allowlist — allow
    },

    // ─── tool.execute.before Hook (Safety Net + Task/Todowrite Handler) ─
    "tool.execute.before": async (ctx, output) => {
      const { tool, sessionID } = ctx;
      const agent = sessionAgentMap.get(sessionID);
      const phase = sessionPhaseMap.get(sessionID);

      // R004: Non-overseer — fail-open
      if (agent !== "overseer") return;

      // R005b: Overseer with no phase entry — BLOCK (race condition:
      // tool.execute.before fired before chat.params initialized the session)
      // Must throw for ALL tools — security-critical block.
      if (phase === undefined) {
        const errDef = ERRORS.BLOCKED_UNINITIALIZED;
        log("BLOCKED", `session=${sessionID} tool=${tool} code=${errDef.code}`);
        throw new ProtocolGateError(errDef);
      }

      const state = STATES[phase];
      if (!state) return;

      // Extract items once for todowrite handling
      const items = tool === "todowrite" ? extractTodoItems(output.args) : null;

      // ── R033: Backward transitions checked BEFORE disk advancement ────
      // This ensures the phase is still in the "from" state when the
      // backward handler validates it.
      if (tool === "todowrite") {
        if (items) {
          const backwardItem = items.find(
            (i) => typeof i === "string"
              ? i.startsWith("BACKWARD:")
              : (i?.content || "").startsWith("BACKWARD:"),
          );
          if (backwardItem) {
            handleBackwardTransition(ctx, output, backwardItem, sessionID, phase);
            return;
          }
        }
      }

      // ── R023: Check disk advancement on every allowed tool call ────────
      checkDiskAdvancement(sessionID, phase);

      // Re-read phase after potential advancement
      const currentPhase = sessionPhaseMap.get(sessionID) ?? phase;
      const currentState = STATES[currentPhase];

      // ── todowrite: always allowed (R052) ──────────────────────────────
      if (tool === "todowrite") {
        // R006: PROTOCOL_NOT_LOADED — validate lifecycle keywords
        if (currentPhase === PROTOCOL_NOT_LOADED) {
          if (containsAllLifecycleKeywords(items, config.phases)) {
            sessionPhaseMap.set(sessionID, INTENT);
            retryMap.set(sessionID, 0);
            log("PHASE_ADVANCE", `session=${sessionID} → INTENT`);
            return;
          }
          reject(ctx, output, "BLOCKED_NO_LIFECYCLE");
          return;
        }

        return; // todowrite always passes in other phases
      }

      // ── task tool ──────────────────────────────────────────────────────
      if (tool === "task") {
        // R006: PROTOCOL_NOT_LOADED blocks task with specific error
        if (currentPhase === PROTOCOL_NOT_LOADED) {
          reject(ctx, output, "BLOCKED_NOT_LOADED");
          return;
        }
        if (!currentState.allowedTools.includes("task")) {
          reject(ctx, output, "BLOCKED_WRONG_PHASE");
          return;
        }

        // R024-R027: Agent routing for delegation states (2-11)
        if (currentPhase >= PREFLIGHT && currentPhase <= COMMIT) {
          const expectedAgent = PHASE_AGENT_MAP[currentPhase];
          const targetAgent = extractAgentFromPrompt(output.args?.prompt);
          if (expectedAgent && targetAgent !== expectedAgent) {
            const detail = targetAgent
              ? `Expected ${expectedAgent}, got ${targetAgent}`
              : `Expected ${expectedAgent}, no agent name found in prompt`;
            const guidance = `Phase ${currentState.name} requires dispatching to ${expectedAgent}. ${detail}.`;
            reject(ctx, output, "WRONG_AGENT", guidance);
            return;
          }
        }

        // Reset retry count on new task dispatch
        retryMap.set(sessionID, 0);
        return;
      }

      // ── All other tools: check allowlist ───────────────────────────────
      // R006: PROTOCOL_NOT_LOADED blocks all non-todowrite tools
      if (currentPhase === PROTOCOL_NOT_LOADED) {
        reject(ctx, output, "BLOCKED_NOT_LOADED");
        return;
      }
      if (!currentState.allowedTools.includes(tool)) {
        reject(ctx, output, "BLOCKED_WRONG_PHASE");
        return;
      }

      // ── write: validate path for INTENT/REPORT phases ──────────────────
      if (tool === "write") {
        const filePath = output.args?.filePath || "";
        if (currentState.name === "INTENT" && !isIntentKD(filePath)) {
          reject(ctx, output, "BLOCKED_INTENT_ONLY");
          return;
        }
        if (currentState.name === "REPORT" && !isReportKD(filePath)) {
          reject(ctx, output, "BLOCKED_REPORT_ONLY");
          return;
        }
      }

      // ── read: validate path for INTENT/REPORT phases ───────────────────
      if (tool === "read") {
        const filePath = output.args?.filePath || "";
        if (currentState.readAllowed) {
          const allowed = currentState.readAllowed.some((tpl) => filePath.includes(tpl));
          if (!allowed) {
            reject(ctx, output, "BLOCKED_WRONG_PHASE");
            return;
          }
        }
      }
    },
  };
}

// ─── Disk Advancement ────────────────────────────────────────────────────────

function checkDiskAdvancement(sessionID, currentPhase) {
  if (currentPhase < INTENT || currentPhase >= REPORT) return;

  let advanced = false;

  if (currentPhase === INTENT) {
    // R012: INTENT → PREFLIGHT: intent KD exists on disk
    if (globMatches("knowledge/intent-*.md")) {
      sessionPhaseMap.set(sessionID, PREFLIGHT);
      advanced = true;
    }
  } else if (currentPhase >= PREFLIGHT && currentPhase <= EVOLVE) {
    // R013-R021: Delegation states — check for expected KD
    const patterns = {
      [PREFLIGHT]:   ["knowledge/plan-*-preflight-*", "knowledge/plan-*preflight*.md"],
      [EXPLORE]:     ["knowledge/exploration-*.md"],
      [INVESTIGATE]: ["knowledge/analysis-*.md"],
      [ALIGN]:       ["knowledge/spec-*.md"],
      [DECOMPOSE]:   ["knowledge/plan-*.md"],  // excluding preflight (handled by timing)
      [SWARM]:       ["knowledge/impl-*.md"],
      [VERIFY]:      ["knowledge/review-*.md", "knowledge/audit-*.md"],
      [EXTRACT]:     ["knowledge/composed-*.md"],
      [EVOLVE]:      ["knowledge/process-*.md"],
    };
    const pats = patterns[currentPhase];
    if (pats) {
      if (currentPhase === VERIFY) {
        // R019: BOTH must exist
        if (pats.every((p) => globMatches(p))) {
          sessionPhaseMap.set(sessionID, currentPhase + 1);
          advanced = true;
        }
      } else if (currentPhase === DECOMPOSE) {
        // R017: plan-*.md exists, but NOT preflight pattern
        if (globMatches("knowledge/plan-*.md") &&
            !globMatches("knowledge/plan-*-preflight-*") &&
            !globMatches("knowledge/plan-*preflight*.md")) {
          sessionPhaseMap.set(sessionID, currentPhase + 1);
          advanced = true;
        }
      } else {
        if (pats.some((p) => globMatches(p))) {
          sessionPhaseMap.set(sessionID, currentPhase + 1);
          advanced = true;
        }
      }
    }
  } else if (currentPhase === COMMIT) {
    // R022: COMMIT → REPORT: clean working tree
    if (hasCleanTree()) {
      sessionPhaseMap.set(sessionID, REPORT);
      advanced = true;
    }
  }

  if (advanced) {
    const newState = STATES[sessionPhaseMap.get(sessionID)];
    log("PHASE_ADVANCE", `session=${sessionID} → ${newState.name}`);
    // Reset retry and cycle counts on forward advancement (R039, R030)
    retryMap.set(sessionID, 0);
    cycleMap.delete(sessionID);
  }
}

// ─── Backward Transitions ────────────────────────────────────────────────────

function handleBackwardTransition(ctx, output, backwardItem, sessionID, currentPhase) {
  const content = typeof backwardItem === "string" ? backwardItem : backwardItem?.content || "";
  const match = content.match(/^BACKWARD:(\w+)→(\w+)$/);
  if (!match) {
    reject(ctx, output, "BLOCKED_WRONG_PHASE");
    return;
  }

  const [, fromName, toName] = match;
  const fromState = STATES.find((s) => s.name === fromName);
  const toState = STATES.find((s) => s.name === toName);

  if (!fromState || !toState) {
    reject(ctx, output, "BLOCKED_WRONG_PHASE");
    return;
  }

  // Must be in the "from" state
  if (currentPhase !== fromState.id) {
    reject(ctx, output, "BLOCKED_WRONG_PHASE");
    return;
  }

  // Must be an allowed backward transition (R029)
  const transition = BACKWARD_TRANSITIONS[fromState.id];
  if (!transition || transition.to !== toState.id) {
    reject(ctx, output, "BLOCKED_DISALLOWED_BACKWARD");
    return;
  }

  // Check cycle limit (R031)
  if (!cycleMap.has(sessionID)) cycleMap.set(sessionID, new Map());
  const sessionCycles = cycleMap.get(sessionID);
  const key = `${fromState.id}→${toState.id}`;
  const count = sessionCycles.get(key) || 0;
  if (count >= config.maxCyclesPerTransition) {
    reject(ctx, output, "CYCLE_LIMIT_REACHED");
    return;
  }

  // Execute backward transition
  sessionCycles.set(key, count + 1);
  sessionPhaseMap.set(sessionID, toState.id);
  retryMap.set(sessionID, 0);
  log("BACKWARD", `session=${sessionID} ${fromName} → ${toName} (cycle ${count + 1}/${config.maxCyclesPerTransition})`);
}

// ─── Attach for Test Access ──────────────────────────────────────────────────

protocolGatePlugin.STATES = STATES;
protocolGatePlugin.BACKWARD_TRANSITIONS = BACKWARD_TRANSITIONS;
protocolGatePlugin.PHASE_AGENT_MAP = PHASE_AGENT_MAP;
protocolGatePlugin.AGENT_NAMES = AGENT_NAMES;
protocolGatePlugin.DEFAULT_CONFIG = DEFAULT_CONFIG;
protocolGatePlugin.config = config;
protocolGatePlugin.sessionAgentMap = sessionAgentMap;
protocolGatePlugin.sessionPhaseMap = sessionPhaseMap;
protocolGatePlugin.cycleMap = cycleMap;
protocolGatePlugin.retryMap = retryMap;
protocolGatePlugin.ProtocolGateError = ProtocolGateError;
protocolGatePlugin.ERRORS = ERRORS;
protocolGatePlugin.extractAgentFromPrompt = extractAgentFromPrompt;
protocolGatePlugin.containsAllLifecycleKeywords = containsAllLifecycleKeywords;
protocolGatePlugin.extractTodoItems = extractTodoItems;
protocolGatePlugin.isIntentKD = isIntentKD;
protocolGatePlugin.isReportKD = isReportKD;
protocolGatePlugin.globMatches = globMatches;
protocolGatePlugin.hasCleanTree = hasCleanTree;

// State constants for test access
protocolGatePlugin.PROTOCOL_NOT_LOADED = PROTOCOL_NOT_LOADED;
protocolGatePlugin.INTENT = INTENT;
protocolGatePlugin.PREFLIGHT = PREFLIGHT;
protocolGatePlugin.EXPLORE = EXPLORE;
protocolGatePlugin.INVESTIGATE = INVESTIGATE;
protocolGatePlugin.ALIGN = ALIGN;
protocolGatePlugin.DECOMPOSE = DECOMPOSE;
protocolGatePlugin.SWARM = SWARM;
protocolGatePlugin.VERIFY = VERIFY;
protocolGatePlugin.EXTRACT = EXTRACT;
protocolGatePlugin.EVOLVE = EVOLVE;
protocolGatePlugin.COMMIT = COMMIT;
protocolGatePlugin.REPORT = REPORT;
