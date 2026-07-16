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
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

function protocolGatePlugin() {
  const config = loadConfig();
  const STATES = loadStates();
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

  class ProtocolGateError extends Error {
    constructor(code, message, guidance) {
      super(message);
      this.name = "ProtocolGateError";
      this.code = code;
      this.guidance = guidance;
    }
  }

  const ERRORS = {
    BLOCKED_NOT_LOADED: { code: "BLOCKED_NOT_LOADED", message: "Protocol not loaded", guidance: "Call todowrite with lifecycle keywords first" },
    BLOCKED_WRONG_PHASE: { code: "BLOCKED_WRONG_PHASE", message: "Tool not allowed in current phase", guidance: "Wait for the phase to advance" },
    BLOCKED_NO_LIFECYCLE: { code: "BLOCKED_NO_LIFECYCLE", message: "Missing lifecycle keywords", guidance: "Include all 12 lifecycle keywords in todowrite" },
    BLOCKED_UNINITIALIZED: { code: "BLOCKED_UNINITIALIZED", message: "Session not initialized", guidance: "Wait for chat.params to initialize" },
    WRONG_AGENT: (agent) => ({ code: "WRONG_AGENT", message: `Incorrect agent dispatched. Expected: ${agent}`, guidance: `Dispatch to ${agent}` }),
    RETRY_LIMIT_EXCEEDED: (phase) => ({ code: "RETRY_LIMIT_EXCEEDED", message: `Retry limit exceeded for ${phase}`, guidance: "Escalate to user — do not auto-advance" }),
    CYCLE_LIMIT_EXCEEDED: { code: "CYCLE_LIMIT_EXCEEDED", message: "Backward transition cycle limit exceeded", guidance: "Escalate to user" }
  };

  function debug(msg) {
    if (process.env.PROTOCOL_GATE_DEBUG) {
      console.log(`[protocol-gate] ${msg}`);
    }
  }

  function loadConfig() {
    try {
      const configPath = join(process.cwd(), "plugins", "protocol-gate", "lifecycle.json");
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

  function loadStates() {
    return {
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

  function getPhaseName(phaseId) {
    return Object.entries(STATES).find(([, id]) => id === phaseId)?.[0];
  }

  // Build reverse map: agent name → phase ID for backward transition detection
  function buildAgentToPhaseMap() {
    const map = {};
    for (const [phaseName, agentName] of Object.entries(PHASE_AGENT_MAP)) {
      const phaseId = STATES[phaseName];
      if (phaseId !== undefined) {
        map[agentName.toLowerCase()] = phaseId;
      }
    }
    return map;
  }

  const agentToPhaseMap = buildAgentToPhaseMap();

  function checkDiskAdvancement(sessionID) {
    const phase = sessionPhaseMap.get(sessionID);
    if (phase === undefined) return false;

    const knowledgeDir = join(process.cwd(), "knowledge");
    let files = [];
    try {
      files = readdirSync(knowledgeDir);
    } catch (e) {
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
      return hasReview && hasAudit;
    }

    return files.some(f => pattern.test(f));
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

  function handleBackwardTransition(sessionID, currentPhase, targetPhase) {
    const validTargets = BACKWARD_TRANSITIONS[currentPhase] || [];
    if (!validTargets.includes(targetPhase)) return false;

    const cycles = cycleMap.get(sessionID) || {};
    cycles[targetPhase] = (cycles[targetPhase] || 0) + 1;
    cycleMap.set(sessionID, cycles);

    if (cycles[targetPhase] > (config.maxCyclesPerTransition || 3)) {
      throw new ProtocolGateError(ERRORS.CYCLE_LIMIT_EXCEEDED.code, ERRORS.CYCLE_LIMIT_EXCEEDED.message, ERRORS.CYCLE_LIMIT_EXCEEDED.guidance);
    }

    const prevPhase = sessionPhaseMap.get(sessionID);
    sessionPhaseMap.set(sessionID, targetPhase);
    retryMap.set(sessionID, 0);
    delegationAttempted.set(sessionID, false);
    debug(`Backward transition: ${getPhaseName(prevPhase)} -> ${getPhaseName(targetPhase)}`);
    return true;
  }

  // Extracts agent name from raw prompt (AGENT: x) or rendered prompt (DISPATCH TO: x).
  // Handles both formats because hook execution order between protocol-gate and
  // delegation-gate is not guaranteed — delegation-gate may render before we run.
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

  function getAllowedTools(phaseName) {
    const map = {
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
    return map[phaseName] || [];
  }

  async function handler(ctx) {
    const { type } = ctx;

    if (type === "chat.params") {
      const { input } = ctx;
      const { sessionID, agent } = input;

      if (agent === "overseer") {
        sessionPhaseMap.set(sessionID, STATES.PROTOCOL_NOT_LOADED);
        retryMap.set(sessionID, 0);
        delegationAttempted.set(sessionID, false);
      } else {
        sessionPhaseMap.delete(sessionID);
        retryMap.delete(sessionID);
        cycleMap.delete(sessionID);
        delegationAttempted.delete(sessionID);
      }
    }

    else if (type === "permission.ask") {
      const { input, output } = ctx;
      const { sessionID, tool } = input;
      const phase = sessionPhaseMap.get(sessionID);

      if (phase === undefined) return;

      const phaseName = getPhaseName(phase);
      if (!phaseName) return;

      const allowedTools = getAllowedTools(phaseName);
      if (tool !== "task" && !allowedTools.includes(tool)) {
        output.status = "deny";
        // Per R026: non-task tool blocks set output.status = "deny" without throwing
      }
    }

    else if (type === "tool.execute.before") {
      const { input, output } = ctx;
      const { tool, sessionID, args } = input;

      const phase = sessionPhaseMap.get(sessionID);
      if (phase === undefined) throw new ProtocolGateError(ERRORS.BLOCKED_UNINITIALIZED.code, ERRORS.BLOCKED_UNINITIALIZED.message, ERRORS.BLOCKED_UNINITIALIZED.guidance);

      const phaseName = getPhaseName(phase);

      // --- todowrite handler ---
      if (tool === "todowrite") {
        if (phase === STATES.PROTOCOL_NOT_LOADED) {
          if (args && args.todos && Array.isArray(args.todos)) {
            const allKeywords = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "COMMIT", "REPORT"];
            const presentKeywords = args.todos.map(t => t.content.toUpperCase());
            const hasAll = allKeywords.every(k => presentKeywords.some(p => p.includes(k)));

            if (hasAll) {
              sessionPhaseMap.set(sessionID, STATES.INTENT);
            } else {
              throw new ProtocolGateError(ERRORS.BLOCKED_NO_LIFECYCLE.code, ERRORS.BLOCKED_NO_LIFECYCLE.message, ERRORS.BLOCKED_NO_LIFECYCLE.guidance);
            }
          }
        }
        // Phase advancement happens ONLY via checkDiskAdvancement() — not via todowrite content (R009)
      }

      // --- write handler ---
      else if (tool === "write") {
        const path = args?.filePath || "";
        if (phase === STATES.INTENT && !path.startsWith("knowledge/intent-")) {
          throw new ProtocolGateError(ERRORS.BLOCKED_WRONG_PHASE.code, "Writes restricted to intent KDs", "Write to knowledge/intent-*.md");
        }
        if (phase === STATES.REPORT && !path.startsWith("knowledge/report-")) {
          throw new ProtocolGateError(ERRORS.BLOCKED_WRONG_PHASE.code, "Writes restricted to report KDs", "Write to knowledge/report-*.md");
        }
      }

      // --- read handler ---
      else if (tool === "read") {
        const path = args?.filePath || "";
        if (phase === STATES.INTENT || phase === STATES.REPORT) {
          if (!path.includes("templates")) {
            throw new ProtocolGateError(ERRORS.BLOCKED_WRONG_PHASE.code, "Reads restricted to templates", "Read from template directory only");
          }
        }
      }

      // --- task handler ---
      else if (tool === "task") {
        if (phase < STATES.PREFLIGHT || phase > STATES.COMMIT) {
          throw new ProtocolGateError(ERRORS.BLOCKED_WRONG_PHASE.code, "Task not allowed in current phase", "Wait for delegation phase");
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
              if (retries > MAX_RETRIES) {
                throw new ProtocolGateError(ERRORS.RETRY_LIMIT_EXCEEDED(phaseName).code, ERRORS.RETRY_LIMIT_EXCEEDED(phaseName).message, ERRORS.RETRY_LIMIT_EXCEEDED(phaseName).guidance);
              }
            }
            delegationAttempted.set(sessionID, true);
          }
          // Check if agent matches a backward target → backward transition
          else {
            const targetPhaseId = agentToPhaseMap[agentName];
            const validTargets = BACKWARD_TRANSITIONS[phase] || [];

            if (targetPhaseId !== undefined && validTargets.includes(targetPhaseId)) {
              handleBackwardTransition(sessionID, phase, targetPhaseId);
              // After backward transition, the task proceeds to the new phase's agent
              // Retry counter was reset in handleBackwardTransition
              delegationAttempted.set(sessionID, false);
            } else {
              // Wrong agent — not current phase, not a valid backward target
              const expectedAgent = currentPhaseAgent || phaseName;
              throw new ProtocolGateError(ERRORS.WRONG_AGENT(expectedAgent).code, ERRORS.WRONG_AGENT(expectedAgent).message, ERRORS.WRONG_AGENT(expectedAgent).guidance);
            }
          }
        }
      }

      // --- disk-based advancement for non-task tools (R009) ---
      if (tool !== "task") {
        if (await checkDiskAdvancement(sessionID)) {
          const nextPhase = phase + 1;
          if (nextPhase <= STATES.REPORT) {
            sessionPhaseMap.set(sessionID, nextPhase);
            retryMap.set(sessionID, 0);
            delegationAttempted.set(sessionID, false);
            debug(`Advanced from ${phaseName} to ${getPhaseName(nextPhase)}`);
          }
        }
      }
    }
  }

  // Test-access properties on default export
  handler.STATES = STATES;
  handler.sessionPhaseMap = sessionPhaseMap;
  handler.retryMap = retryMap;
  handler.cycleMap = cycleMap;
  handler.delegationAttempted = delegationAttempted;
  handler.ProtocolGateError = ProtocolGateError;
  handler.ERRORS = ERRORS;

  return handler;
}

export default protocolGatePlugin;
