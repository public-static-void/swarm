// Protocol-Gate Plugin — WHEN: state machine, phase advancement, agent routing
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

// Normalize absolute paths to project-relative for prefix matching.
// opencode passes absolute paths (e.g. /home/user/project/knowledge/intent-foo.md)
// but our checks use relative patterns (e.g. knowledge/intent-).
// Handles paths from different locations by checking if pattern exists anywhere.
function toProjectRelative(filePath) {
  const cwd = process.cwd();
  if (filePath.startsWith(cwd + "/")) {
    return filePath.slice(cwd.length + 1);
  }
  // Fallback: check if the pattern exists in the path (handles nested workspaces)
  return filePath;
}

function checkDiskAdvancement(sessionID, phase, sessionPhaseMap) {
  if (phase === undefined) return false;

  // Session date is required to filter out stale KDs from prior sessions.
  // Without this, a plan-*.md from last Tuesday instantly advances PREFLIGHT.
  const sessionDate = sessionPhaseMap.get(`${sessionID}:date`);
  if (!sessionDate) {
    debug(`Disk check: no session date set for ${sessionID} — skipping`);
    return false;
  }

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

  // Filter to only files created in the current session (date in filename).
  const sessionFiles = files.filter(f => f.includes(sessionDate));

  // PREFLIGHT and DECOMPOSE share `/^plan-/i` by design — both advance when
  // a plan KD exists. The session-date filter prevents stale plans from
  // prior sessions from triggering advancement.
  const patterns = {
    [STATES.INTENT]: /^intent-/i,
    [STATES.PREFLIGHT]: /^plan-/i,
    [STATES.EXPLORE]: /^exploration-/i,
    [STATES.INVESTIGATE]: /^analysis-/i,
    [STATES.ALIGN]: /^spec-/i,
    [STATES.DECOMPOSE]: /^plan-/i,
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
    const hasReview = sessionFiles.some(f => /^review-/i.test(f));
    const hasAudit = sessionFiles.some(f => /^audit-/i.test(f));
    const result = hasReview && hasAudit;
    debug(`Disk check VERIFY: review=${hasReview}, audit=${hasAudit} → ${result}`);
    return result;
  }

  const result = sessionFiles.some(f => pattern.test(f));
  debug(`Disk check ${getPhaseName(phase)}: pattern=${pattern}, date=${sessionDate} → ${result}`);
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

    const sessionPhaseMap = new Map();
    const overseerSessions = new Set();
    const cycleMap = new Map();
    // Prevents instant phase jump: when todowrite advances the phase,
    // skip the disk check in the same call. Without this, todowrite
    // advances PROTOCOL_NOT_LOADED → INTENT, then the disk check
    // immediately finds a pre-existing intent KD and jumps to PREFLIGHT.
    const skipDiskCheckAfterTodo = new Map();
    // Tracks consecutive disk check failures per session to detect stuck phases.
    // After 10 failed checks, logs a diagnostic suggesting the delegation is blocked.
    const diskCheckFailures = new Map();

    const agentToPhaseMap = buildAgentToPhaseMap(PHASE_AGENT_MAP);

    debug("Plugin initializing…");
    debug(`Loaded config: ${Object.keys(STATES).length} states, maxCycles=${config.maxCyclesPerTransition || 3}`);
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
      debug(`Backward transition complete: ${getPhaseName(prevPhase)} → ${getPhaseName(targetPhase)}`);
      return true;
    }

    // --- Hook: chat.params ---
    async function chatParams(input, output) {
      const { sessionID, agent } = input;

      if (agent === "overseer") {
        overseerSessions.add(sessionID);
        // Only initialize when session isn't already tracked (opencode calls
        // chat.params on every tool invocation cycle, not once per session).
        if (!sessionPhaseMap.has(sessionID)) {
          debug(`chat.params: initializing overseer session ${sessionID}`);
          sessionPhaseMap.set(sessionID, STATES.PROTOCOL_NOT_LOADED);
        }
      } else {
        // Non-overseer sessions pass through unaffected — don't touch the maps.
        // Protocol-gate is Overseer-only; subagent tool calls must not be blocked.
        debug(`chat.params: non-overseer session ${sessionID} (agent=${agent}) — passing through`);
        return;
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

    // --- Helper: overseer detection ---
    // Only sessions where chat.params received agent:"overseer" are tracked.
    // sessionPhaseMap alone is unreliable — a race between chat.params and
    // tool.execute.before could cause a newly-initialized overseer session
    // to have an undefined phase. The overseerSessions set is the source of truth.
    function isOverseerSession(sid) {
      return overseerSessions.has(sid);
    }

    // --- Hook: tool.execute.before ---
    async function toolExecuteBefore(input, output) {
      const { tool, sessionID, callID } = input;
      // opencode API: tool args live on output.args, not input.args
      const args = output.args || {};

      if (!isOverseerSession(sessionID)) {
        // Session never identified as overseer via chat.params — pass through.
        // Subagent sessions are never in overseerSessions.
        debug(`tool.execute.before: non-overseer session ${sessionID} tool=${tool} — passing through`);
        return;
      }

      const phase = sessionPhaseMap.get(sessionID);
      if (phase === undefined) {
        // BUG 2 FIX: fail-closed — overseer session exists but phase is missing.
        // This is an error state; block rather than silently allow.
        debug(`tool.execute.before: BLOCKED overseer session ${sessionID} has no phase entry (tool=${tool})`);
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
              skipDiskCheckAfterTodo.set(sessionID, true);
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
        const relPath = toProjectRelative(path);

        // Check if path matches the required pattern (handles both relative and absolute paths)
        const isIntentKD = relPath.startsWith("knowledge/intent-") || relPath.includes("/knowledge/intent-");
        const isReportKD = relPath.startsWith("knowledge/report-") || relPath.includes("/knowledge/report-");

        // Capture session date from the intent KD filename (YYYY-MM-DD suffix).
        // This date is used by checkDiskAdvancement to filter out stale KDs.
        if (isIntentKD && phase === STATES.INTENT) {
          const dateMatch = relPath.match(/(\d{4}-\d{2}-\d{2})\.md$/);
          if (dateMatch) {
            sessionPhaseMap.set(`${sessionID}:date`, dateMatch[1]);
            debug(`write: captured session date ${dateMatch[1]} for session ${sessionID}`);
          }
        }

        if (phase === STATES.INTENT && !isIntentKD) {
          debug(`write: BLOCKED phase=${phaseName} path=${path} (must start with knowledge/intent-)`);
          throw new ProtocolGateError(ERROR_TEMPLATES.BLOCKED_WRONG_PHASE.code, "Writes restricted to intent KDs", "Write to knowledge/intent-*.md");
        }
        if (phase === STATES.REPORT && !isReportKD) {
          debug(`write: BLOCKED phase=${phaseName} path=${path} (must start with knowledge/report-)`);
          throw new ProtocolGateError(ERROR_TEMPLATES.BLOCKED_WRONG_PHASE.code, "Writes restricted to report KDs", "Write to knowledge/report-*.md");
        }
      }

      // --- read handler ---
      else if (tool === "read") {
        const path = args?.filePath || "";
        if (phase === STATES.INTENT || phase === STATES.REPORT) {
          const relPath = toProjectRelative(path);
          const isTemplate = relPath.includes("templates");

          if (phase === STATES.INTENT) {
            // INTENT phase: only allow templates and the current session's intent KDs.
            // Restricting to intent KDs prevents the Overseer from reading prior-session
            // reports or other KDs and falling back to self-execution.
            const isIntentKD = /knowledge\/intent-/i.test(relPath);
            if (!isTemplate && !isIntentKD) {
              debug(`read: BLOCKED phase=${phaseName} path=${path} (INTENT reads restricted to templates and intent KDs)`);
              throw new ProtocolGateError(ERROR_TEMPLATES.BLOCKED_WRONG_PHASE.code, "Reads restricted to templates and intent KDs", "Read from template or knowledge/intent-*.md only");
            }
          } else {
            // REPORT phase: allow templates and any knowledge KD (needed to compose report)
            const isKnowledge = relPath.startsWith("knowledge/") || relPath.includes("/knowledge/");
            if (!isTemplate && !isKnowledge) {
              debug(`read: BLOCKED phase=${phaseName} path=${path} (reads restricted to templates and knowledge KDs)`);
              throw new ProtocolGateError(ERROR_TEMPLATES.BLOCKED_WRONG_PHASE.code, "Reads restricted to templates and knowledge KDs", "Read from template or knowledge directory only");
            }
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
        // Try prompt text first; fall back to subagent_type parameter.
        // When protocol-gate runs before delegation-gate, the raw prompt
        // has no structured fields — subagent_type is the reliable source.
        let agentName = extractAgentFromPrompt(prompt);
        if (!agentName && args?.subagent_type) {
          agentName = args.subagent_type.toLowerCase();
          debug(`task: agent from subagent_type fallback: ${agentName}`);
        }

        if (agentName) {
          const currentPhaseAgent = PHASE_AGENT_MAP[phaseName]?.toLowerCase();

          // Check if agent matches current phase → normal delegation
          if (agentName === currentPhaseAgent) {
            debug(`task: ALLOW agent=${agentName} for phase=${phaseName}`);
          }
          // Check if agent matches a backward target → backward transition
          else {
            const targetPhaseId = agentToPhaseMap[agentName];
            const validTargets = BACKWARD_TRANSITIONS[phase] || [];

            if (targetPhaseId !== undefined && validTargets.includes(targetPhaseId)) {
              debug(`task: BACKWARD TRANSITION agent=${agentName} from ${phaseName} → ${getPhaseName(targetPhaseId)}`);
              handleBackwardTransition(sessionID, phase, targetPhaseId);
            } else {
              // Wrong agent — not current phase, not a valid backward target
              const expectedAgent = currentPhaseAgent || phaseName;
              debug(`task: BLOCKED wrong agent=${agentName} in phase=${phaseName} (expected: ${expectedAgent})`);
              throw new ProtocolGateError(ERROR_TEMPLATES.WRONG_AGENT(expectedAgent).code, ERROR_TEMPLATES.WRONG_AGENT(expectedAgent).message, ERROR_TEMPLATES.WRONG_AGENT(expectedAgent).guidance);
            }
          }
        }
      }

      // --- disk-based advancement for lifecycle tools (R009) ---
      // Only write (creates KDs), glob (verifies KDs exist), and todowrite
      // (updates lifecycle state) should trigger disk advancement checks.
      // Other tools (skill, bash, read) are not part of the delegation lifecycle.
      const DISK_CHECK_TOOLS = ["write", "glob", "todowrite"];
      if (DISK_CHECK_TOOLS.includes(tool)) {
        // Skip disk check when todowrite just advanced the phase in this call.
        // Without this guard, todowrite advances to INTENT, then the disk check
        // immediately finds a pre-existing intent KD and jumps to PREFLIGHT.
        if (skipDiskCheckAfterTodo.get(sessionID)) {
          skipDiskCheckAfterTodo.set(sessionID, false);
          debug(`Disk advancement: skipped — phase just advanced by todowrite`);
        } else {
          const currentPhase = sessionPhaseMap.get(sessionID);
          const currentPhaseName = getPhaseName(currentPhase);
          if (await checkDiskAdvancement(sessionID, currentPhase, sessionPhaseMap)) {
            sessionPhaseMap.set(sessionID, currentPhase + 1);
            diskCheckFailures.set(sessionID, 0);
            debug(`Disk advancement: ${currentPhaseName} → ${getPhaseName(currentPhase + 1)}`);
          } else {
            // REPORT and COMMIT don't use disk-based advancement — skip stuck detection.
            // REPORT writes the KD directly; COMMIT checks git tree cleanliness.
            if (currentPhase !== STATES.REPORT && currentPhase !== STATES.COMMIT) {
              const failures = (diskCheckFailures.get(sessionID) || 0) + 1;
              diskCheckFailures.set(sessionID, failures);
              if (failures === 10) {
                debug(`STUCK WARNING: ${currentPhaseName} phase — no matching KD after ${failures} disk checks. Delegate to produce the required KD or check delegation-gate logs for extraction failures.`);
              }
            }
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
      overseerSessions,
      isOverseerSession,
      cycleMap,
      ProtocolGateError,
      ERRORS: ERROR_TEMPLATES
    };
  }
};
