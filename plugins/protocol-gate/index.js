// Protocol-Gate Plugin — WHEN: state machine, phase advancement, agent routing
//
// Hooks: chat.params, permission.ask, tool.execute.before,
//        tool.definition, experimental.chat.system.transform
// Scope: Overseer-only. Other agents pass through unaffected.
//
// This plugin enforces which state the Overseer is in and what it can do
// in that state. It does NOT handle delegation prompt formatting — that
// responsibility belongs to delegation-gate (HOW).
//
// Debug logging: set PROTOCOL_GATE_DEBUG=1 in environment to enable.
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
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
  REPORT: 12,
  IDLE: 13
};

const ALL_KEYWORDS = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "COMMIT", "REPORT"];

// Behavioral constraints injected into the system prompt per phase.
// The Overseer sees these instead of a tool list — tells it WHAT to do and what NOT to do.
const PHASE_INSTRUCTIONS = {
  PROTOCOL_NOT_LOADED: "Call todowrite to load the 12-phase lifecycle protocol. Existing knowledge documents will be detected automatically.",
  // Absolute single-action directive: names the tool and content, no reasoning gap.
  // Positive framing per AGENTS.md — no negative "do NOT" instructions.
  INTENT: "Call write to create an intent KD with the user's exact words as the Raw Request. The Explorer handles all codebase details after dispatch.",
  PREFLIGHT: "Dispatch the Committer agent.",
  EXPLORE: "Dispatch the Explorer agent.",
  INVESTIGATE: "Dispatch the Analyzer agent.",
  ALIGN: "Dispatch the Spec Weaver agent.",
  DECOMPOSE: "Dispatch the Pathfinder agent.",
  SWARM: "Dispatch the Artisan agent.",
  VERIFY: "Dispatch the Inspector agent.",
  EXTRACT: "Dispatch the Scribe agent.",
  EVOLVE: "Dispatch the Habit Builder agent.",
  COMMIT: "Dispatch the Committer agent.",
  REPORT: "Write a report KD summarizing lifecycle results.",
  IDLE: "Lifecycle complete. Call todowrite with lifecycle keywords to begin a new lifecycle."
};

const TOOL_ALLOWLIST = {
  PROTOCOL_NOT_LOADED: ["todowrite"],
  INTENT: ["todowrite", "write", "read", "skill", "bash"],
  PREFLIGHT: ["task", "todowrite", "glob", "bash"],
  EXPLORE: ["task", "todowrite", "glob"],
  INVESTIGATE: ["task", "todowrite", "glob"],
  ALIGN: ["task", "todowrite", "glob"],
  DECOMPOSE: ["task", "todowrite", "glob"],
  SWARM: ["task", "todowrite", "glob"],
  VERIFY: ["task", "todowrite", "glob"],
  EXTRACT: ["task", "todowrite", "glob"],
  EVOLVE: ["task", "todowrite", "glob"],
  COMMIT: ["task", "todowrite", "glob", "bash"],
  REPORT: ["todowrite", "write", "read"],
  IDLE: ["todowrite"]
};

// Per-tool restrictions for tools that ARE in the allowlist but have path/scope limits.
// tool.definition appends these to the description so the LLM sees the restriction
// instead of treating the tool as fully available.
const TOOL_RESTRICTIONS = {
  INTENT: { read: "ONLY templates and intent KDs", bash: "ONLY mkdir for knowledge directory creation" },
  REPORT: { read: "ONLY templates and knowledge KDs" }
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
  BLOCKED_NOT_LOADED: { code: "BLOCKED_NOT_LOADED", message: "Protocol loaded via todowrite", guidance: "Call todowrite with lifecycle keywords first" },
  BLOCKED_WRONG_PHASE: { code: "BLOCKED_WRONG_PHASE", message: "Use [tools] in [phases]", guidance: "Wait for the phase to advance" },
  BLOCKED_NO_LIFECYCLE: { code: "BLOCKED_NO_LIFECYCLE", message: "Missing lifecycle keywords", guidance: "Include all 12 lifecycle keywords in todowrite" },
  BLOCKED_UNINITIALIZED: { code: "BLOCKED_UNINITIALIZED", message: "Awaiting chat.params initialization", guidance: "Wait for chat.params to initialize" },
  WRONG_AGENT: (agent) => ({ code: "WRONG_AGENT", message: `Incorrect agent dispatched. Expected: ${agent}`, guidance: `Dispatch to ${agent}` }),
  CYCLE_LIMIT_EXCEEDED: { code: "CYCLE_LIMIT_EXCEEDED", message: "Backward transition cycle limit exceeded", guidance: "Escalate to user" },
  FABRICATED_SECTION: { code: "FABRICATED_SECTION", message: "Intent KD contains fabricated section", guidance: "Follow the intent template exactly — Raw Request, Triage Notes, Next Steps, Process Friction only" }
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
  const normalized = filePath.replace(/\\/g, "/");
  const cwd = process.cwd().replace(/\\/g, "/");
  if (normalized.startsWith(cwd + "/")) {
    return normalized.slice(cwd.length + 1);
  }
  return normalized;
}

function checkDiskAdvancement(sessionID, phase, sessionPhaseMap, swarmDispatchCount) {
  if (phase === undefined) return false;

  // Session ID is required to filter out stale KDs from prior sessions.
  // Without this, a plan-*.md from a different session instantly advances PREFLIGHT.
  const storedSessionID = sessionPhaseMap.get(`${sessionID}:sid`);
  if (!storedSessionID) {
    debug(`Disk check: no session ID set for ${sessionID} — skipping`);
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

  // Filter to only files created in the current session (session ID in filename).
  const sessionFiles = files.filter(f => new RegExp(`-${sessionID}\\.md$`).test(f));

  // DECOMPOSE uses `/^plan-/i` to advance when a plan KD exists.
  // PREFLIGHT advances when a `preflight-` KD is written by the Committer.
  // The session-ID filter prevents stale KDs from prior sessions from triggering advancement.
  const patterns = {
    [STATES.INTENT]: /^intent-/i,
    [STATES.PREFLIGHT]: /^preflight-/i,
    [STATES.EXPLORE]: /^exploration-/i,
    [STATES.INVESTIGATE]: /^analysis-/i,
    [STATES.ALIGN]: /^spec-/i,
    [STATES.DECOMPOSE]: /^plan-/i,
    [STATES.SWARM]: /^impl-/i,
    [STATES.VERIFY]: /^review-|^audit-/i,
    [STATES.EXTRACT]: /^composed-/i,
    [STATES.EVOLVE]: /^process-/i,
    [STATES.COMMIT]: /^commit-/i
  };

  const pattern = patterns[phase];
  if (!pattern) return false;

  if (phase === STATES.VERIFY) {
    const hasReview = sessionFiles.some(f => /^review-/i.test(f));
    const hasAudit = sessionFiles.some(f => /^audit-/i.test(f));
    const result = hasReview && hasAudit;
    debug(`Disk check VERIFY: review=${hasReview}, audit=${hasAudit} → ${result}`);
    return result;
  }

  // SWARM advancement requires dispatch-count tracking (Issue 6).
  // When the Overseer dispatches multiple artisans, each must produce an `impl-` KD
  // before advancing to VERIFY. Without this, the first artisan's KD triggers
  // premature advancement while others are still working.
  if (phase === STATES.SWARM) {
    const implFiles = sessionFiles.filter(f => pattern.test(f));
    const dispatchCount = swarmDispatchCount.get(sessionID) || 0;
    const result = dispatchCount > 0 && implFiles.length >= dispatchCount;
    debug(`Disk check SWARM: impl=${implFiles.length}, dispatched=${dispatchCount} → ${result}`);
    return result;
  }

  const result = sessionFiles.some(f => pattern.test(f));
  debug(`Disk check ${getPhaseName(phase)}: pattern=${pattern}, sessionID=${sessionID} → ${result}`);
  return result;
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
    // SWARM completion counter: tracks how many artisan dispatches the Overseer
    // has initiated in SWARM phase. checkDiskAdvancement() compares this against
    // the number of `impl-` KDs on disk — only advances to VERIFY when all
    // dispatched artisans have produced their implementation KDs.
    const swarmDispatchCount = new Map();
    // Prevents instant phase jump: when todowrite advances the phase,
    // skip the disk check in the same call. Without this, todowrite
    // advances PROTOCOL_NOT_LOADED → INTENT, then the disk check
    // immediately finds a pre-existing intent KD and jumps to PREFLIGHT.
    const skipDiskCheckAfterTodo = new Map();
    // Tracks consecutive disk check failures per session to detect stuck phases.
    // After 10 failed checks, logs a diagnostic suggesting the delegation is blocked.
    const diskCheckFailures = new Map();
    // Tracks re-dispatch attempts per session-phase pair to cap retries at 5.
    const phaseRedispatchCount = new Map();
    // tool.definition doesn't receive sessionID — track the most recent session
    // so it knows which phase to enforce. Updated in chat.params and tool.execute.before.
    let lastSeenSession = null;

    // --- State persistence ---
    // Persists phase + session ID to disk so opencode --continue restores state.
    // Without this, restarting the plugin server loses all in-memory state.
    // State files live in the plugin's .state/ directory, not .opencode/ which
    // may have special purpose in opencode's config hierarchy.
    function getStatePath(sessionID) {
      return join(PLUGIN_DIR, ".state", `.protocol-state-${sessionID}.json`);
    }

    function saveState(sessionID) {
      const phase = sessionPhaseMap.get(sessionID);
      const sid = sessionPhaseMap.get(`${sessionID}:sid`);
      if (phase === undefined) return;
      try {
        const state = { phase, sid: sid || null, timestamp: Date.now() };
        const stateDir = join(PLUGIN_DIR, ".state");
        mkdirSync(stateDir, { recursive: true });
        writeFileSync(getStatePath(sessionID), JSON.stringify(state));
      } catch (e) { debug(`saveState error: ${e.message}`); }
    }

    function loadState(sessionID) {
      const statePath = getStatePath(sessionID);
      debug(`loadState: checking ${statePath}`);
      try {
        const data = JSON.parse(readFileSync(statePath, "utf8"));
        if (data.phase !== undefined && data.phase > STATES.PROTOCOL_NOT_LOADED) {
          sessionPhaseMap.set(sessionID, data.phase);
          if (data.sid) {
            sessionPhaseMap.set(`${sessionID}:sid`, data.sid);
          }
          overseerSessions.add(sessionID);
          lastSeenSession = sessionID;
          debug(`loadState: restored phase=${getPhaseName(data.phase)} sid=${data.sid}`);
          return true;
        }
      } catch (e) { debug(`loadState: failed for ${sessionID}: ${e.message}`); }
      return false;
    }

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
      saveState(sessionID);
      return true;
    }

    // --- Hook: chat.params ---
    async function chatParams(input, output) {
      const { sessionID, agent } = input;
      lastSeenSession = sessionID;

      if (agent === "overseer") {
        overseerSessions.add(sessionID);
        // Only initialize when session isn't already tracked (opencode calls
        // chat.params on every tool invocation cycle, not once per session).
        if (!sessionPhaseMap.has(sessionID)) {
          if (!loadState(sessionID)) {
            debug(`chat.params: initializing overseer session ${sessionID}`);
            sessionPhaseMap.set(sessionID, STATES.PROTOCOL_NOT_LOADED);
          }
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
      lastSeenSession = sessionID;
      // opencode API: tool args live on output.args, not input.args
      const args = output.args || {};

      if (!isOverseerSession(sessionID)) {
        // Session never identified as overseer via chat.params — pass through.
        // Subagent sessions are never in overseerSessions.
        debug(`tool.execute.before: non-overseer session ${sessionID} tool=${tool} — passing through`);
        return;
      }

      let phase = sessionPhaseMap.get(sessionID);
      if (phase === undefined) {
        // BUG 2 FIX: fail-closed — overseer session exists but phase is missing.
        // This is an error state; block rather than silently allow.
        debug(`tool.execute.before: BLOCKED overseer session ${sessionID} has no phase entry (tool=${tool})`);
        throw new ProtocolGateError(ERROR_TEMPLATES.BLOCKED_UNINITIALIZED.code, ERROR_TEMPLATES.BLOCKED_UNINITIALIZED.message, ERROR_TEMPLATES.BLOCKED_UNINITIALIZED.guidance);
      }

      let phaseName = getPhaseName(phase);

      // Enforce tool allowlist — safety net for tools not gated by permission.ask
      if (tool !== "task") {
        const allowedTools = TOOL_ALLOWLIST[phaseName] || [];
        if (!allowedTools.includes(tool)) {
          debug(`tool.execute.before: BLOCKED tool=${tool} in phase=${phaseName} (allowed: ${allowedTools.join(", ")})`);
          throw new ProtocolGateError(
            ERROR_TEMPLATES.BLOCKED_WRONG_PHASE.code,
            `Available tools in ${phaseName}: ${allowedTools.join(", ")}`,
            `Allowed tools: ${allowedTools.join(", ")}`
          );
        }
      }

      // --- todowrite handler ---
      if (tool === "todowrite") {
        // IDLE lifecycle restart: detect new lifecycle keywords in IDLE state.
        // After REPORT → IDLE transition, a todowrite with all keywords
        // starts a new lifecycle by transitioning to INTENT.
        if (phase === STATES.IDLE && args?.todos && Array.isArray(args.todos)) {
          const presentKeywords = args.todos.map(t => t.content.toUpperCase());
          const hasAll = ALL_KEYWORDS.every(k => presentKeywords.some(p => p.includes(k)));
          if (hasAll) {
            debug(`todowrite: lifecycle restart in IDLE → advancing to INTENT`);
            sessionPhaseMap.set(sessionID, STATES.INTENT);
            diskCheckFailures.set(sessionID, 0);
            sessionPhaseMap.delete(`${sessionID}:sid`);
            swarmDispatchCount.delete(sessionID);
            cycleMap.delete(sessionID);
            skipDiskCheckAfterTodo.set(sessionID, true);
            saveState(sessionID);
            phase = STATES.INTENT;
            phaseName = getPhaseName(phase);
          }
        }

        if (phase === STATES.PROTOCOL_NOT_LOADED) {
          if (args && args.todos && Array.isArray(args.todos)) {
            const presentKeywords = args.todos.map(t => t.content.toUpperCase());
            const hasAll = ALL_KEYWORDS.every(k => presentKeywords.some(p => p.includes(k)));

            if (hasAll) {
              debug(`todowrite: all lifecycle keywords present → advancing to INTENT`);
              sessionPhaseMap.set(sessionID, STATES.INTENT);
              debug("INTENT phase: write intent KD with raw user request. No file reading or exploration needed.");
              skipDiskCheckAfterTodo.set(sessionID, true);
              saveState(sessionID);
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

        // Capture session ID from intent KD write.
        // This ID is used by checkDiskAdvancement to filter out stale KDs.
        if (isIntentKD && phase === STATES.INTENT) {
          sessionPhaseMap.set(`${sessionID}:sid`, sessionID);
          debug(`write: captured session ID ${sessionID}`);
          saveState(sessionID);
        }

        if (phase === STATES.INTENT && !isIntentKD) {
          debug(`write: BLOCKED phase=${phaseName} path=${path} (must start with knowledge/intent-)`);
          throw new ProtocolGateError(ERROR_TEMPLATES.BLOCKED_WRONG_PHASE.code, "Write to knowledge/intent-*.md", "Write to knowledge/intent-*.md");
        }
        if (phase === STATES.REPORT && !isReportKD) {
          debug(`write: BLOCKED phase=${phaseName} path=${path} (must start with knowledge/report-)`);
          throw new ProtocolGateError(ERROR_TEMPLATES.BLOCKED_WRONG_PHASE.code, "Write to knowledge/report-*.md", "Write to knowledge/report-*.md");
        }

        // REPORT → IDLE: report KD written means lifecycle is complete.
        // IDLE restores full tool access so the Overseer can investigate new issues.
        if (phase === STATES.REPORT && isReportKD) {
          debug(`write: report KD written → transitioning to IDLE`);
          sessionPhaseMap.set(sessionID, STATES.IDLE);
          diskCheckFailures.set(sessionID, 0);
          saveState(sessionID);
          phase = STATES.IDLE;
          phaseName = getPhaseName(phase);
        }

        // Content validation — reject fabricated sections in intent KDs.
        // The intent template defines exactly: Raw Request, Triage Notes, Next Steps, Process Friction.
        // The LLM fabricates extra sections when it can't resolve a user instruction (e.g., reading a
        // roadmap it's blocked from). This catches that at write time instead of letting it propagate downstream.
        if (phase === STATES.INTENT && isIntentKD) {
          const content = args?.content || "";
          const ALLOWED_SECTIONS = [
            /^##\s*Raw Request/i,
            /^##\s*Triage Notes/i,
            /^##\s*Next Steps/i,
            /^##\s*Process Friction/i
          ];
          const sectionHeaders = content.match(/^##\s+.+$/gm) || [];
          for (const header of sectionHeaders) {
            const isAllowed = ALLOWED_SECTIONS.some(re => re.test(header));
            if (!isAllowed) {
              debug(`write: BLOCKED fabricated section in intent KD: ${header}`);
              throw new ProtocolGateError(
                ERROR_TEMPLATES.FABRICATED_SECTION.code,
                `Intent KD valid sections: Raw Request, Triage Notes, Next Steps, Process Friction`,
                ERROR_TEMPLATES.FABRICATED_SECTION.guidance
              );
            }
          }
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
              throw new ProtocolGateError(ERROR_TEMPLATES.BLOCKED_WRONG_PHASE.code, "Read from template or knowledge/intent-*.md", "Read from template or knowledge/intent-*.md only");
            }
          } else {
            // REPORT phase: allow templates and any knowledge KD (needed to compose report)
            const isKnowledge = relPath.startsWith("knowledge/") || relPath.includes("/knowledge/");
            if (!isTemplate && !isKnowledge) {
              debug(`read: BLOCKED phase=${phaseName} path=${path} (reads restricted to templates and knowledge KDs)`);
              throw new ProtocolGateError(ERROR_TEMPLATES.BLOCKED_WRONG_PHASE.code, "Read from template or knowledge directory", "Read from template or knowledge directory only");
            }
          }
        }
      }

      // --- disk-based advancement for lifecycle tools (R009) ---
      // Runs BEFORE the task handler so the phase is current when agent routing
      // validates the dispatched agent. Without this, task calls in PREFLIGHT
      // check against the stale pre-advancement phase and throw WRONG_AGENT.
      const DISK_CHECK_TOOLS = ["write", "glob", "todowrite", "task"];
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
          if (await checkDiskAdvancement(sessionID, currentPhase, sessionPhaseMap, swarmDispatchCount)) {
            sessionPhaseMap.set(sessionID, currentPhase + 1);
            diskCheckFailures.set(sessionID, 0);
            // Reset re-dispatch counter for the phase we just advanced from
            phaseRedispatchCount.delete(`${sessionID}:${currentPhase}`);
            const newPhase = currentPhase + 1;
            debug(`Disk advancement: ${currentPhaseName} → ${getPhaseName(newPhase)}`);
            saveState(sessionID);
            // When entering PREFLIGHT, skip the next disk check to give the Overseer
            // time to dispatch the committer before advancement to EXPLORE.
            if (newPhase === STATES.PREFLIGHT) {
              skipDiskCheckAfterTodo.set(sessionID, true);
              debug(`Disk advancement: skipping next disk check for PREFLIGHT`);
            }
          } else {
            // REPORT doesn't use disk-based advancement — skip stuck detection.
            // REPORT writes the KD directly; other phases rely on KD file existence.
            if (currentPhase !== STATES.REPORT) {
              const failures = (diskCheckFailures.get(sessionID) || 0) + 1;
              diskCheckFailures.set(sessionID, failures);
              if (failures === 10) {
                // Diagnostic output: list files found so user knows what's missing
                const knowledgeDir = join(process.cwd(), "knowledge");
                let foundFiles = [];
                try { foundFiles = readdirSync(knowledgeDir).filter(f => f.includes(sessionID)); } catch (_) {}
                debug(`STUCK WARNING: ${currentPhaseName} phase — no matching KD after ${failures} disk checks. Expected prefix: ${currentPhaseName.toLowerCase()}-*. Files found: ${JSON.stringify(foundFiles)}. Delegate to produce the required KD or check delegation-gate logs for extraction failures.`);
              }
              // Force-advance to VERIFY after 15 stuck cycles to unblock the lifecycle
              if (failures >= 15) {
                debug(`FORCE ADVANCE: ${currentPhaseName} → VERIFY after ${failures} stuck cycles`);
                sessionPhaseMap.set(sessionID, STATES.VERIFY);
                diskCheckFailures.set(sessionID, 0);
                phaseRedispatchCount.delete(`${sessionID}:${currentPhase}`);
                saveState(sessionID);
              }
              // Cap re-dispatches per phase at 5
              const redispatchKey = `${sessionID}:${currentPhase}`;
              const redispatches = phaseRedispatchCount.get(redispatchKey) || 0;
              if (redispatches >= 5 && tool === "task") {
                debug(`REDISPATCH CAP: ${currentPhaseName} phase — ${redispatches} re-dispatches already used. Advancing to VERIFY.`);
                sessionPhaseMap.set(sessionID, STATES.VERIFY);
                diskCheckFailures.set(sessionID, 0);
                phaseRedispatchCount.delete(`${sessionID}:${currentPhase}`);
                saveState(sessionID);
              }
            }
          }
        }
      }

      // Re-read phase after disk check — it may have advanced via
      // checkDiskAdvancement above. Without this, the task handler
      // validates agent routing against the stale pre-advancement phase.
      phase = sessionPhaseMap.get(sessionID) ?? phase;
      phaseName = getPhaseName(phase);

      // --- task handler ---
      if (tool === "task") {
        // IDLE allows task (all tools available post-lifecycle)
        if (phase < STATES.PREFLIGHT || phase > STATES.COMMIT) {
          debug(`task: BLOCKED phase=${phaseName} (task not allowed outside delegation phases)`);
          throw new ProtocolGateError(ERROR_TEMPLATES.BLOCKED_WRONG_PHASE.code, "Task available in PREFLIGHT through COMMIT phases", "Wait for delegation phase");
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
            // Track SWARM dispatches to prevent premature VERIFY advancement.
            // Each dispatched artisan must produce an `impl-` KD before all are considered complete.
            if (phase === STATES.SWARM) {
              const count = (swarmDispatchCount.get(sessionID) || 0) + 1;
              swarmDispatchCount.set(sessionID, count);
              debug(`SWARM dispatch count for ${sessionID}: ${count}`);
            }
            // Track re-dispatches per phase to cap retries
            const redispatchKey = `${sessionID}:${phase}`;
            phaseRedispatchCount.set(redispatchKey, (phaseRedispatchCount.get(redispatchKey) || 0) + 1);
          }
          // Check if agent matches a backward target → backward transition
          else {
            const targetPhaseId = agentToPhaseMap[agentName];
            const validTargets = BACKWARD_TRANSITIONS[phase] || [];

            if (targetPhaseId !== undefined && validTargets.includes(targetPhaseId)) {
              debug(`task: BACKWARD TRANSITION agent=${agentName} from ${phaseName} → ${getPhaseName(targetPhaseId)}`);
              handleBackwardTransition(sessionID, phase, targetPhaseId);
            } else {
              // Committer is dispatched by artisan for checkpoint commits during SWARM phase
              if (agentName === 'committer' && phase === STATES.SWARM) {
                debug(`task: ALLOW committer dispatch in SWARM phase (checkpoint commit)`);
              } else {
                // Wrong agent — not current phase, not a valid backward target
                const expectedAgent = currentPhaseAgent || phaseName;
                debug(`task: BLOCKED wrong agent=${agentName} in phase=${phaseName} (expected: ${expectedAgent})`);
                throw new ProtocolGateError(ERROR_TEMPLATES.WRONG_AGENT(expectedAgent).code, ERROR_TEMPLATES.WRONG_AGENT(expectedAgent).message, ERROR_TEMPLATES.WRONG_AGENT(expectedAgent).guidance);
              }
            }
          }
        }
      }
    }

    // --- Hook: tool.definition ---
    // Layer 1 prevention: modify descriptions of blocked tools so the LLM
    // sees them as unavailable. Runs for EVERY tool on EVERY LLM call.
    // Uses lastSeenSession since the hook doesn't receive sessionID.
    async function toolDefinition(input, output) {
      const { toolID } = input;
      const sessionID = lastSeenSession;
      if (!sessionID) return;
      if (!isOverseerSession(sessionID)) return;
      const phase = sessionPhaseMap.get(sessionID);
      if (phase === undefined) return;
      const phaseName = getPhaseName(phase);
      if (!phaseName) return;
      const allowedTools = TOOL_ALLOWLIST[phaseName] || [];
      // task is always allowed (delegation mechanism) — never block it
      if (toolID === "task") return;
      // Allowed tool — check if it has per-tool restrictions to display
      if (allowedTools.includes(toolID)) {
        const restriction = TOOL_RESTRICTIONS[phaseName]?.[toolID];
        if (restriction) {
          output.description = `[${phaseName} phase restriction: ${restriction}] ${output.description}`;
          debug(`tool.definition: restricted tool=${toolID} in phase=${phaseName} — ${restriction}`);
        }
        return;
      }
      // Prepend blocking notice — LLM sees this as the tool's availability status
      output.description = `⛔ Use only: ${allowedTools.join(", ")} in ${phaseName} phase. ${output.description}`;
      debug(`tool.definition: blocked tool=${toolID} in phase=${phaseName}`);
    }

    // --- Hook: experimental.chat.system.transform ---
    // Layer 2 prevention: inject a hard constraint into the system prompt
    // telling the LLM exactly which tools it may use in the current phase.
    // The SDK passes output.system as an array of strings.
    async function systemTransform(input, output) {
      const sessionID = lastSeenSession;
      if (!sessionID) return;
      if (!isOverseerSession(sessionID)) return;
      const phase = sessionPhaseMap.get(sessionID);
      if (phase === undefined) return;
      const phaseName = getPhaseName(phase);
      if (!phaseName) return;
      const instructions = PHASE_INSTRUCTIONS[phaseName];
      if (instructions) {
        output.system.push(`[Protocol Gate] Phase ${phaseName}: ${instructions}`);
      }
      debug(`systemTransform: injected phase constraint for phase=${phaseName}`);
    }

    return {
      "chat.params": chatParams,
      "permission.ask": permissionAsk,
      "tool.execute.before": toolExecuteBefore,
      "tool.definition": toolDefinition,
      "experimental.chat.system.transform": systemTransform,
      // Test-access properties
      STATES,
      sessionPhaseMap,
      overseerSessions,
      isOverseerSession,
      cycleMap,
      swarmDispatchCount,
      phaseRedispatchCount,
      ProtocolGateError,
      ERRORS: ERROR_TEMPLATES,
      get lastSeenSession() { return lastSeenSession; }
    };
  }
};
