// Protocol-Gate Plugin — WHEN: state machine, phase advancement, agent routing, retry tracking
//
// Hooks: chat.params, permission.ask, tool.execute.before
// Scope: Overseer-only. Other agents pass through unaffected.
//
// This plugin enforces which state the Overseer is in and what it can do
// in that state. It does NOT handle delegation prompt formatting — that
// responsibility belongs to delegation-gate (HOW).
//
// Debug logging: set PROTOCOL_GATE_DEBUG=1 in environment to enable.
import { execFile } from "child_process";
import { appendFileSync, mkdirSync, readdirSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const PLUGIN_DIR = dirname(__filename);

const STATES = {
  PROTOCOL_NOT_LOADED: 0,
  INTENT: 1,
  PREFLIGHT: 2,
  EXPLORE: 3,
  INVESTIGATE: 4,
  ALIGN: 5,
  DECOMPOSE: 6,
  SWARM: 7,
  VERIFY: 8,
  EXTRACT: 9,
  EVOLVE: 10,
  COMMIT: 11,
  REPORT: 12
};

const ALL_KEYWORDS = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "COMMIT", "REPORT"];

const TOOL_ALLOWLIST = {
  PROTOCOL_NOT_LOADED: ["todowrite"],
  INTENT: ["todowrite", "write", "read", "question"],
  PREFLIGHT: ["task", "todowrite", "glob"],
  EXPLORE: ["task", "todowrite", "glob"],
  INVESTIGATE: ["task", "todowrite", "glob"],
  ALIGN: ["task", "todowrite", "glob"],
  DECOMPOSE: ["task", "todowrite", "glob"],
  SWARM: ["task", "todowrite", "glob"],
  VERIFY: ["task", "todowrite", "glob"],
  EXTRACT: ["task", "todowrite", "glob"],
  EVOLVE: ["task", "todowrite", "glob"],
  COMMIT: ["task", "todowrite", "glob"],
  REPORT: ["todowrite", "write", "read"]
};

class ProtocolGateError extends Error {
  constructor(code, message, guidance) {
    super(message);
    this.name = "ProtocolGateError";
    this.code = code;
    this.guidance = guidance;
  }
}

const ERROR_TEMPLATES = {
  BLOCKED_NOT_LOADED: { code: "BLOCKED_NOT_LOADED", message: "Protocol not loaded", guidance: "Call todowrite with lifecycle keywords first" },
  BLOCKED_WRONG_PHASE: { code: "BLOCKED_WRONG_PHASE", message: "Tool not allowed in current phase", guidance: "Wait for the phase to advance" },
  BLOCKED_NO_LIFECYCLE: { code: "BLOCKED_NO_LIFECYCLE", message: "Missing lifecycle keywords", guidance: "Include all 12 lifecycle keywords in todowrite" },
  BLOCKED_UNINITIALIZED: { code: "BLOCKED_UNINITIALIZED", message: "Session not initialized", guidance: "Wait for chat.params to initialize" },
  WRONG_AGENT: (agent) => ({ code: "WRONG_AGENT", message: `Incorrect agent dispatched. Expected: ${agent}`, guidance: `Dispatch to ${agent}` }),
  RETRY_LIMIT_EXCEEDED: (phase) => ({ code: "RETRY_LIMIT_EXCEEDED", message: `Retry limit exceeded for ${phase}`, guidance: "Escalate to user — do not auto-advance" }),
  CYCLE_LIMIT_EXCEEDED: { code: "CYCLE_LIMIT_EXCEEDED", message: "Backward transition cycle limit exceeded", guidance: "Escalate to user" }
};

function getPhaseName(phaseId) {
  return Object.entries(STATES).find(([, id]) => id === phaseId)?.[0];
}

let _logFile = null;

function getLogFile() {
  if (!_logFile) {
    const logDir = join(PLUGIN_DIR, "..", "logs");
    try { mkdirSync(logDir, { recursive: true }); } catch (_) {}
    _logFile = join(logDir, "protocol-gate.log");
  }
  return _logFile;
}

function debug(msg) {
  if (process.env.PROTOCOL_GATE_DEBUG) {
    try {
      appendFileSync(getLogFile(), `[${new Date().toISOString()}] [protocol-gate] ${msg}\n`);
    } catch (_) {
      process.stderr.write(`[protocol-gate] ${msg}\n`);
    }
  }
}

function loadConfig() {
  try {
    const configPath = join(PLUGIN_DIR, "lifecycle.json");
    return JSON.parse(readFileSync(configPath, "utf8"));
  } catch (e) {
    debug("Config load failed, using defaults");
    return {
      phases: ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "COMMIT", "REPORT"],
      agents: { PREFLIGHT: "committer", EXPLORE: "explorer", INVESTIGATE: "analyzer", ALIGN: "spec-weaver", DECOMPOSE: "pathfinder", SWARM: "artisan", VERIFY: "inspector", EXTRACT: "scribe", EVOLVE: "habit-builder", COMMIT: "committer" },
      backwardTransitions: { VERIFY: ["SWARM"] },
      maxRetriesPerPhase: 5,
      maxCyclesPerTransition: 3
    };
  }
}

function loadBackwardTransitions(config) {
  const transitions = {};
  const map = config.backwardTransitions || {};
  for (const [phase, targets] of Object.entries(map)) {
    const phaseId = STATES[phase];
    if (phaseId !== undefined) {
      transitions[phaseId] = targets.map(t => STATES[t]).filter(id => id !== undefined);
    }
  }
  return transitions;
}

function buildAgentToPhaseMap(PHASE_AGENT_MAP) {
  const map = {};
  for (const [phaseName, agentName] of Object.entries(PHASE_AGENT_MAP)) {
    const phaseId = STATES[phaseName];
    if (phaseId !== undefined) {
      map[agentName.toLowerCase()] = phaseId;
    }
  }
  return map;
}

function extractAgentFromPrompt(prompt) {
  const lines = prompt.split("\n");
  for (const line of lines) {
    const rawMatch = line.match(/^AGENT:\s*(.*)/i);
    if (rawMatch) return rawMatch[1].trim().toLowerCase();
    const renderedMatch = line.match(/^DISPATCH TO:\s*(.*)/i);
    if (renderedMatch) return renderedMatch[1].trim().toLowerCase();
  }
  return null;
}

function checkDiskAdvancement(sessionID, phase, sessionPhaseMap) {
  if (phase === undefined) return false;

  // Knowledge directory is project-relative (cwd), not plugin-relative.
  // PLUGIN_DIR stays for log paths which ARE relative to plugin location.
  const knowledgeDir = join(process.cwd(), "knowledge");
  let files = [];
  try {
    files = readdirSync(knowledgeDir);
  } catch (e) {
    debug(`Disk check: knowledge/ dir not found for session ${sessionID}`);
    return false;
  }

  const patterns = {
    [STATES.PREFLIGHT]: /^plan-.*preflight-/i,
    [STATES.EXPLORE]: /^exploration-/i,
    [STATES.INVESTIGATE]: /^analysis-/i,
    [STATES.ALIGN]: /^spec-/i,
    [STATES.DECOMPOSE]: /^plan-(?!.*preflight)/i,
    [STATES.SWARM]: /^impl-/i,
    [STATES.VERIFY]: /^review-|^audit-/i,
    [STATES.EXTRACT]: /^composed-/i,
    [STATES.EVOLVE]: /^process-/i,
    [STATES.COMMIT]: null
  };

  if (phase === STATES.COMMIT) {
    return hasCleanTree();
  }

  const pattern = patterns[phase];
  if (!pattern) return false;

  if (phase === STATES.VERIFY) {
    const hasReview = files.some(f => /^review-/i.test(f));
    const hasAudit = files.some(f => /^audit-/i.test(f));
    const result = hasReview && hasAudit;
    debug(`Disk check VERIFY: review=${hasReview}, audit=${hasAudit} → ${result}`);
    return result;
  }

  const result = files.some(f => pattern.test(f));
  debug(`Disk check ${getPhaseName(phase)}: pattern=${pattern} → ${result}`);
  return result;
}

function hasCleanTree() {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), 5000);
    execFile("git", ["status", "--porcelain"], (error, stdout) => {
      clearTimeout(timeout);
      if (error) return resolve(false);
      resolve(stdout.trim() === "");
    });
  });
}

export default {
  id: "protocol-gate",
  server: async function protocolGateServer(input, options) {
    const config = loadConfig();
    const BACKWARD_TRANSITIONS = loadBackwardTransitions(config);
    const PHASE_AGENT_MAP = config.agents || {};
    const MAX_RETRIES = config.maxRetriesPerPhase || 5;

    const sessionPhaseMap = new Map();
    const retryMap = new Map();
    const cycleMap = new Map();
    // Tracks whether a delegation was attempted in the current phase entry.
    // When true and task is called again in same phase → retry.
    // Reset on disk advancement (success) or backward transition.
    const delegationAttempted = new Map();

    const agentToPhaseMap = buildAgentToPhaseMap(PHASE_AGENT_MAP);

    debug("Plugin initializing…");
    debug(`Loaded config: ${Object.keys(STATES).length} states, maxRetries=${MAX_RETRIES}, maxCycles=${config.maxCyclesPerTransition || 3}`);
    debug(`Backward transitions: ${JSON.stringify(BACKWARD_TRANSITIONS)}`);
    debug(`Phase→agent map: ${JSON.stringify(PHASE_AGENT_MAP)}`);

    function handleBackwardTransition(sessionID, currentPhase, targetPhase) {
      const validTargets = BACKWARD_TRANSITIONS[currentPhase] || [];
      if (!validTargets.includes(targetPhase)) return false;

      const cycles = cycleMap.get(sessionID) || {};
      cycles[targetPhase] = (cycles[targetPhase] || 0) + 1;
      cycleMap.set(sessionID, cycles);

      const cycleCount = cycles[targetPhase];
      const maxCycles = config.maxCyclesPerTransition || 3;
      debug(`Backward transition: ${getPhaseName(currentPhase)} → ${getPhaseName(targetPhase)} (cycle ${cycleCount}/${maxCycles})`);

      if (cycleCount > maxCycles) {
        debug(`ERROR: Cycle limit exceeded for ${getPhaseName(targetPhase)}: ${cycleCount} > ${maxCycles}`);
        throw new ProtocolGateError(ERROR_TEMPLATES.CYCLE_LIMIT_EXCEEDED.code, ERROR_TEMPLATES.CYCLE_LIMIT_EXCEEDED.message, ERROR_TEMPLATES.CYCLE_LIMIT_EXCEEDED.guidance);
      }

      const prevPhase = sessionPhaseMap.get(sessionID);
      sessionPhaseMap.set(sessionID, targetPhase);
      retryMap.set(sessionID, 0);
      delegationAttempted.set(sessionID, false);
      debug(`Backward transition complete: ${getPhaseName(prevPhase)} → ${getPhaseName(targetPhase)}, retry counter reset`);
      return true;
    }

    // --- Hook: chat.params ---
    async function chatParams(input, output) {
      const { sessionID, agent } = input;

      if (agent === "overseer") {
        debug(`chat.params: initializing overseer session ${sessionID}`);
        sessionPhaseMap.set(sessionID, STATES.PROTOCOL_NOT_LOADED);
        retryMap.set(sessionID, 0);
        delegationAttempted.set(sessionID, false);
      } else {
        debug(`chat.params: cleaning up non-overseer session ${sessionID} (agent=${agent})`);
        sessionPhaseMap.delete(sessionID);
        retryMap.delete(sessionID);
        cycleMap.delete(sessionID);
        delegationAttempted.delete(sessionID);
      }
    }

    // --- Hook: permission.ask ---
    async function permissionAsk(input, output) {
      // Permission type: input.type is the tool name
      const { sessionID, type: tool } = input;
      const phase = sessionPhaseMap.get(sessionID);

      if (phase === undefined) return;

      const phaseName = getPhaseName(phase);
      if (!phaseName) return;

      const allowedTools = TOOL_ALLOWLIST[phaseName] || [];
      if (tool !== "task" && !allowedTools.includes(tool)) {
        debug(`permission.ask: DENY tool=${tool} in phase=${phaseName} (allowed: ${allowedTools.join(", ")})`);
        output.status = "deny";
        // Per R026: non-task tool blocks set output.status = "deny" without throwing
      } else {
        debug(`permission.ask: ALLOW tool=${tool} in phase=${phaseName}`);
      }
    }

    // --- Hook: tool.execute.before ---
    async function toolExecuteBefore(input, output) {
      const { tool, sessionID, callID } = input;
      // opencode API: tool args live on output.args, not input.args
      const args = output.args || {};

      const phase = sessionPhaseMap.get(sessionID);
      if (phase === undefined) {
        debug(`tool.execute.before: BLOCKED_UNINITIALIZED session=${sessionID} tool=${tool}`);
        throw new ProtocolGateError(ERROR_TEMPLATES.BLOCKED_UNINITIALIZED.code, ERROR_TEMPLATES.BLOCKED_UNINITIALIZED.message, ERROR_TEMPLATES.BLOCKED_UNINITIALIZED.guidance);
      }

      const phaseName = getPhaseName(phase);

      // --- todowrite handler ---
      if (tool === "todowrite") {
        if (phase === STATES.PROTOCOL_NOT_LOADED) {
          if (args && args.todos && Array.isArray(args.todos)) {
            const presentKeywords = args.todos.map(t => t.content.toUpperCase());
            const hasAll = ALL_KEYWORDS.every(k => presentKeywords.some(p => p.includes(k)));

            if (hasAll) {
              debug(`todowrite: all lifecycle keywords present → advancing to INTENT`);
              sessionPhaseMap.set(sessionID, STATES.INTENT);
            } else {
              debug(`todowrite: missing lifecycle keywords in PROTOCOL_NOT_LOADED`);
              throw new ProtocolGateError(ERROR_TEMPLATES.BLOCKED_NO_LIFECYCLE.code, ERROR_TEMPLATES.BLOCKED_NO_LIFECYCLE.message, ERROR_TEMPLATES.BLOCKED_NO_LIFECYCLE.guidance);
            }
          }
        }
        // Phase advancement happens ONLY via checkDiskAdvancement() — not via todowrite content (R009)
      }

      // --- write handler ---
      else if (tool === "write") {
        const path = args?.filePath || "";
        if (phase === STATES.INTENT && !path.startsWith("knowledge/intent-")) {
          debug(`write: BLOCKED phase=${phaseName} path=${path} (must start with knowledge/intent-)`);
          throw new ProtocolGateError(ERROR_TEMPLATES.BLOCKED_WRONG_PHASE.code, "Writes restricted to intent KDs", "Write to knowledge/intent-*.md");
        }
        if (phase === STATES.REPORT && !path.startsWith("knowledge/report-")) {
          debug(`write: BLOCKED phase=${phaseName} path=${path} (must start with knowledge/report-)`);
          throw new ProtocolGateError(ERROR_TEMPLATES.BLOCKED_WRONG_PHASE.code, "Writes restricted to report KDs", "Write to knowledge/report-*.md");
        }
      }

      // --- read handler ---
      else if (tool === "read") {
        const path = args?.filePath || "";
        if (phase === STATES.INTENT || phase === STATES.REPORT) {
          if (!path.includes("templates")) {
            debug(`read: BLOCKED phase=${phaseName} path=${path} (reads restricted to templates)`);
            throw new ProtocolGateError(ERROR_TEMPLATES.BLOCKED_WRONG_PHASE.code, "Reads restricted to templates", "Read from template directory only");
          }
        }
      }

      // --- task handler ---
      else if (tool === "task") {
        if (phase < STATES.PREFLIGHT || phase > STATES.COMMIT) {
          debug(`task: BLOCKED phase=${phaseName} (task not allowed outside delegation phases)`);
          throw new ProtocolGateError(ERROR_TEMPLATES.BLOCKED_WRONG_PHASE.code, "Task not allowed in current phase", "Wait for delegation phase");
        }

        const prompt = args?.prompt || "";
        const agentName = extractAgentFromPrompt(prompt);

        if (agentName) {
          const currentPhaseAgent = PHASE_AGENT_MAP[phaseName]?.toLowerCase();

          // Check if agent matches current phase → normal delegation
          if (agentName === currentPhaseAgent) {
            // Retry tracking: if delegation was already attempted in this phase, increment counter
            if (delegationAttempted.get(sessionID)) {
              const retries = (retryMap.get(sessionID) || 0) + 1;
              retryMap.set(sessionID, retries);
              debug(`task: RETRY #${retries} in phase=${phaseName} (max=${MAX_RETRIES})`);
              if (retries > MAX_RETRIES) {
                debug(`task: BLOCKED retry limit exceeded for ${phaseName}: ${retries} > ${MAX_RETRIES}`);
                throw new ProtocolGateError(ERROR_TEMPLATES.RETRY_LIMIT_EXCEEDED(phaseName).code, ERROR_TEMPLATES.RETRY_LIMIT_EXCEEDED(phaseName).message, ERROR_TEMPLATES.RETRY_LIMIT_EXCEEDED(phaseName).guidance);
              }
            }
            delegationAttempted.set(sessionID, true);
            debug(`task: ALLOW agent=${agentName} for phase=${phaseName}`);
          }
          // Check if agent matches a backward target → backward transition
          else {
            const targetPhaseId = agentToPhaseMap[agentName];
            const validTargets = BACKWARD_TRANSITIONS[phase] || [];

            if (targetPhaseId !== undefined && validTargets.includes(targetPhaseId)) {
              debug(`task: BACKWARD TRANSITION agent=${agentName} from ${phaseName} → ${getPhaseName(targetPhaseId)}`);
              handleBackwardTransition(sessionID, phase, targetPhaseId);
              // After backward transition, the task proceeds to the new phase's agent
              // Retry counter was reset in handleBackwardTransition
              delegationAttempted.set(sessionID, false);
            } else {
              // Wrong agent — not current phase, not a valid backward target
              const expectedAgent = currentPhaseAgent || phaseName;
              debug(`task: BLOCKED wrong agent=${agentName} in phase=${phaseName} (expected: ${expectedAgent})`);
              throw new ProtocolGateError(ERROR_TEMPLATES.WRONG_AGENT(expectedAgent).code, ERROR_TEMPLATES.WRONG_AGENT(expectedAgent).message, ERROR_TEMPLATES.WRONG_AGENT(expectedAgent).guidance);
            }
          }
        }
      }

      // --- disk-based advancement for non-task tools (R009) ---
      if (tool !== "task") {
        if (await checkDiskAdvancement(sessionID, phase, sessionPhaseMap)) {
          const nextPhase = phase + 1;
          if (nextPhase <= STATES.REPORT) {
            sessionPhaseMap.set(sessionID, nextPhase);
            retryMap.set(sessionID, 0);
            delegationAttempted.set(sessionID, false);
            debug(`Disk advancement: ${phaseName} → ${getPhaseName(nextPhase)}`);
          }
        }
      }
    }

    return {
      "chat.params": chatParams,
      "permission.ask": permissionAsk,
      "tool.execute.before": toolExecuteBefore,
      // Test-access properties
      STATES,
      sessionPhaseMap,
      retryMap,
      cycleMap,
      delegationAttempted,
      ProtocolGateError,
      ERRORS: ERROR_TEMPLATES
    };
  }
};
