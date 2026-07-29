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
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
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
  CLEANUP: 11,
  REPORT: 12
};

const ALL_KEYWORDS = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "CLEANUP", "REPORT"];

// KD type prefixes — maps phase constants to the prefix used in KD filenames.
// Must match the regex patterns in checkDiskAdvancement() (lines 220-232).
// Used by in-flight dispatch tracking so the R001 guard can correctly match
// pending KDs against the disk pattern. (BUG-001/BUG-002 fix)
// VERIFY phase produces TWO KDs (review + audit); stored as array. All other
// phases use a single string for backward compatibility.
const KD_TYPE_PREFIXES = {
  [STATES.INTENT]: "intent",
  [STATES.PREFLIGHT]: "preflight",
  [STATES.EXPLORE]: "exploration",
  [STATES.INVESTIGATE]: "analysis",
  [STATES.ALIGN]: "spec",
  [STATES.DECOMPOSE]: "plan",
  [STATES.SWARM]: "impl",
  [STATES.VERIFY]: ["review", "audit"],
  [STATES.EXTRACT]: "composed",
  [STATES.EVOLVE]: "process",
  [STATES.CLEANUP]: "cleanup"
};

// Normalize a prefix value from KD_TYPE_PREFIXES to always return an array.
// VERIFY phase stores ["review", "audit"]; all others store a single string.
// Consumers use this to uniformly iterate over expected prefixes.
function getPrefixes(phase) {
  const val = KD_TYPE_PREFIXES[phase];
  if (!val) return [];
  return Array.isArray(val) ? val : [val];
}

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
  CLEANUP: "Dispatch the Committer agent.",
  REPORT: "Write a report KD summarizing lifecycle results."
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
  CLEANUP: ["task", "todowrite", "glob", "bash"],
  REPORT: ["todowrite", "edit", "read", "write"]
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
  BLOCKED_NOT_LOADED: { code: "BLOCKED_NOT_LOADED", message: "❌ BLOCKED: Protocol not loaded. Call todowrite with lifecycle keywords first", guidance: "Call todowrite with lifecycle keywords first" },
  BLOCKED_WRONG_PHASE: { code: "BLOCKED_WRONG_PHASE", message: "❌ BLOCKED: Wrong phase. Use [tools] in [phases]", guidance: "Wait for the phase to advance" },
  BLOCKED_NO_LIFECYCLE: { code: "BLOCKED_NO_LIFECYCLE", message: "❌ ERROR: Missing lifecycle keywords. Include all 12 lifecycle keywords in todowrite", guidance: "Include all 12 lifecycle keywords in todowrite" },
  BLOCKED_UNINITIALIZED: { code: "BLOCKED_UNINITIALIZED", message: "⏳ WAIT: Awaiting chat.params initialization", guidance: "Wait for chat.params to initialize" },
  WRONG_AGENT: (agent) => ({ code: "WRONG_AGENT", message: `❌ WRONG AGENT: Incorrect agent dispatched. Expected: ${agent}`, guidance: `Dispatch to ${agent}` }),
  CYCLE_LIMIT_EXCEEDED: { code: "CYCLE_LIMIT_EXCEEDED", message: "❌ ERROR: Backward transition cycle limit exceeded. Escalate to user", guidance: "Escalate to user" },
  FABRICATED_SECTION: { code: "FABRICATED_SECTION", message: "❌ FABRICATED: Intent KD contains fabricated section. Follow the intent template exactly", guidance: "Follow the intent template exactly — Raw Request, Triage Notes, Next Steps, Process Friction only" }
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
      phases: ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "CLEANUP", "REPORT"],
      agents: { PREFLIGHT: "committer", EXPLORE: "explorer", INVESTIGATE: "analyzer", ALIGN: "spec-weaver", DECOMPOSE: "pathfinder", SWARM: "artisan", VERIFY: "inspector", EXTRACT: "scribe", EVOLVE: "habit-builder", CLEANUP: "committer" },
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
      const key = agentName.toLowerCase();
      if (!map[key]) map[key] = [];
      map[key].push(phaseId);
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
  // KD filenames embed the session ID (e.g. intent-foo-ses_abc123.md).
  // Without this, a plan-*.md from a different session instantly advances PREFLIGHT.
  const storedSID = sessionPhaseMap.get(`${sessionID}:sid`);
  if (!storedSID) {
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

  // Filter to only files matching the current session ID.
  // KD filenames embed the session ID as a suffix (e.g. preflight-workspace-ses_abc123.md).
  // Uses suffix matching to prevent substring collisions (ses_abc1 matching ses_abc123).
  const sessionFiles = files.filter(f => f.endsWith(`-${sessionID}.md`));

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
    [STATES.CLEANUP]: /^cleanup-/i
  };

  const pattern = patterns[phase];
  if (!pattern) return false;

  if (phase === STATES.VERIFY) {
    const hasReview = sessionFiles.some(f => /^review-/i.test(f));
    const hasAudit = sessionFiles.some(f => /^audit-/i.test(f));
    const result = hasReview || hasAudit;
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
    // Safety guard: use effectiveCount to prevent formula divergence after regression.
    // With R004 reset in place, dispatchCount is reconciled on each regression, but
    // this guard ensures even if dispatchCount is 0, we require at least 1 impl file.
    const effectiveCount = Math.max(1, dispatchCount);
    const result = dispatchCount > 0 && implFiles.length >= effectiveCount;
    debug(`Disk check SWARM: impl=${implFiles.length}, dispatched=${dispatchCount}, effective=${effectiveCount} → ${result}`);
    return result;
  }

  const result = sessionFiles.some(f => pattern.test(f));
  debug(`Disk check ${getPhaseName(phase)}: pattern=${pattern}, sessionID=${sessionID} → ${result}`);
  return result;
}

// Detects when the current phase's prerequisite KD is missing from knowledge/.
// When undo deletes KDs, in-memory phase state diverges from disk reality.
// This function resets phase to the highest phase whose KD still exists on disk
// for the current session. Returns true if phase was regressed.
function checkPhaseStateConsistency(sessionID, currentPhase, sessionPhaseMap, saveState, diskCheckFailures, phaseRedispatchCount, swarmDispatchCount, inFlightDispatches, freshAdvancement) {
  if (currentPhase === undefined || currentPhase <= STATES.PROTOCOL_NOT_LOADED) return false;

  const storedSID = sessionPhaseMap.get(`${sessionID}:sid`);
  if (!storedSID) return false;

  const knowledgeDir = join(process.cwd(), "knowledge");
  let files = [];
  try { files = readdirSync(knowledgeDir); } catch (_) { return false; }

  const sessionFiles = files.filter(f => f.endsWith(`-${sessionID}.md`));

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
    [STATES.CLEANUP]: /^cleanup-/i
  };

  const currentPattern = patterns[currentPhase];
  if (!currentPattern) return false;

  // R004: Skip regression when a subagent dispatch is in-flight for this phase.
  // The KD is pending creation, not deleted — false regression would loop.
  // inFlightDispatches stores an array of prefixes (e.g., ["review", "audit"] for VERIFY).
  const inFlightPrefixes = inFlightDispatches?.get(sessionID);
  if (inFlightPrefixes && Array.isArray(inFlightPrefixes) && inFlightPrefixes.some(p => currentPattern.test(`${p}-`))) {
    debug(`Consistency check: skipped — in-flight dispatch for ${getPhaseName(currentPhase)} KD (prefixes=${JSON.stringify(inFlightPrefixes)})`);
    return false;
  }

  // R002: Grace period for fresh phase advancement.
  // When a phase just advanced via disk check (e.g., SWARM→VERIFY), the new phase's
  // KD hasn't been produced yet. Skip regression for the first 3 disk checks to
  // avoid false regression back to the previous phase.
  // After the grace period expires, normal regression behavior resumes.
  const faEntry = freshAdvancement?.get(sessionID);
  if (faEntry && faEntry.phase === currentPhase) {
    faEntry.diskCheckCount = (faEntry.diskCheckCount || 0) + 1;
    if (faEntry.diskCheckCount < 3) {
      debug(`GRACE_SKIP: ${getPhaseName(currentPhase)} phase — skipping consistency check during grace period (diskCheck ${faEntry.diskCheckCount}/3) for session ${sessionID}`);
      return false;
    } else {
      // Grace period expired — delete entry and allow normal regression
      freshAdvancement.delete(sessionID);
      debug(`GRACE_EXPIRED: ${getPhaseName(currentPhase)} phase — grace period over, normal regression resumes for session ${sessionID}`);
    }
  }

  // Check if current phase's KD is still present on disk
  if (currentPhase === STATES.VERIFY) {
    const hasReview = sessionFiles.some(f => /^review-/i.test(f));
    const hasAudit = sessionFiles.some(f => /^audit-/i.test(f));
    if (hasReview || hasAudit) return false; // current phase is fine
  } else {
    if (sessionFiles.some(f => currentPattern.test(f))) return false; // current phase is fine
  }

  // Current phase's KD is missing — walk backward to find highest surviving phase
  debug(`Consistency check: ${getPhaseName(currentPhase)} KD missing for session ${sessionID}`);

  // Only regress if an earlier phase's KD exists — this indicates the lifecycle
  // was progressing and the current phase's KD was deleted (e.g., by undo).
  // If no KDs exist at all, the phase was set directly (not via lifecycle)
  // and regression would be incorrect.
  let foundEarlierKD = false;
  let regressedPhase = currentPhase; // default: no regression

  for (let phase = currentPhase - 1; phase >= STATES.PREFLIGHT; phase--) {
    const pattern = patterns[phase];
    if (!pattern) continue;

    if (phase === STATES.VERIFY) {
      const hasReview = sessionFiles.some(f => /^review-/i.test(f));
      const hasAudit = sessionFiles.some(f => /^audit-/i.test(f));
      if (hasReview || hasAudit) {
        regressedPhase = phase;
        foundEarlierKD = true;
        break;
      }
    } else {
      if (sessionFiles.some(f => pattern.test(f))) {
        regressedPhase = phase;
        foundEarlierKD = true;
        break;
      }
    }
  }

  // Also handle INTENT phase: if intent KD is missing but session ID was captured
  // (meaning the lifecycle started), regress to PROTOCOL_NOT_LOADED
  if (!foundEarlierKD && currentPhase === STATES.INTENT) {
    regressedPhase = STATES.PROTOCOL_NOT_LOADED;
    foundEarlierKD = true; // intent phase with captured SID counts as lifecycle evidence
  }

  if (!foundEarlierKD) return false; // no regression — phase set directly, not via lifecycle

  debug(`Consistency regression: ${getPhaseName(currentPhase)} → ${getPhaseName(regressedPhase)}`);
  sessionPhaseMap.set(sessionID, regressedPhase);

  // R003: Counters persist across regressions — safety mechanisms (force-advance,
  // re-dispatch cap) must remain effective. Only clear swarmDispatchCount when
  // regressing past SWARM, as that is phase-dependent cleanup, not counter reset.
  // Clear dispatch count if regressing past SWARM phase
  if (regressedPhase < STATES.SWARM) {
    swarmDispatchCount.delete(sessionID);
  }

  // R004: Persist regressed phase
  saveState(sessionID);
  return true;
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
    // R004/R005: Tracks active subagent dispatches per session.
    // When a task call dispatches the current phase's expected agent, the
    // expected KD prefix is stored here. checkPhaseStateConsistency skips
    // regression when an in-flight dispatch exists — the KD is pending, not deleted.
    const inFlightDispatches = new Map();
    // BUG-003 fix: Event-driven phase advancement verification.
    // When a task dispatch or write triggers a phase advancement, pendingVerification
    // is set. While active, checkPhaseStateConsistency is skipped (preventing false
    // regression) and diskCheckFailures is not incremented (preventing premature stuck
    // detection). Cleared when KD appears on disk, session ends, or safety timeout fires.
    // Replaces the time-based REGRESSION_COOLDOWN_MS mechanism.
    const pendingVerification = new Map();
    // Tracks tool calls made while pendingVerification is active per session.
    // Used by R007 safety timeout: warning at 10, force-advance at 15.
    const pendingVerificationToolCount = new Map();
    // R002: Fresh advancement tracking — records when a phase was just advanced via
    // disk check. Used by checkPhaseStateConsistency to grant a grace period before
    // allowing regression. Prevents false regression when SWARM→VERIFY advancement
    // occurs and VERIFY's KD hasn't been produced yet.
    // In-memory only — not persisted to .state files (NFR003).
    const freshAdvancement = new Map(); // sessionID → {phase, diskCheckCount}
    // R100: Track agent type for ALL sessions (including subagents) to enforce
    // checkpoint KD restrictions. Populated in chatParams for every session.
    const sessionAgentMap = new Map();
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

    // AC012: Clean up orphaned state files with missing SID on plugin load.
    // These accumulate when sessions are interrupted mid-lifecycle.
    // Only delete files where sid is missing from the JSON, not where sid is null
    // (null sid is valid for INTENT-phase state before intent KD is written).
    try {
      const stateDir = join(PLUGIN_DIR, ".state");
      const stateFiles = readdirSync(stateDir).filter(f => f.startsWith(".protocol-state-") && f.endsWith(".json"));
      for (const sf of stateFiles) {
        try {
          const data = JSON.parse(readFileSync(join(stateDir, sf), "utf8"));
          if (data.sid === undefined) {
            rmSync(join(stateDir, sf));
            debug(`Plugin init: cleaned orphaned state file ${sf} (no SID)`);
          }
        } catch (_) {}
      }
    } catch (_) {}

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
      pendingVerification.delete(sessionID);
      pendingVerificationToolCount.delete(sessionID);
      debug(`pendingVerification: CLEARED (backward transition) for session ${sessionID}`);

      // R004: Reset counters when regressing to a target phase.
      // This prevents stale dispatch counts from causing formula divergence (BUG-005)
      // and allows fresh tracking of re-dispatches for the new phase entry.
      // T-R004-1: Reset swarmDispatchCount when regressing TO SWARM
      if (targetPhase === STATES.SWARM) {
        const knowledgeDir = join(process.cwd(), "knowledge");
        let implFiles = [];
        try {
          const files = readdirSync(knowledgeDir);
          implFiles = files.filter(f => f.endsWith(`-${sessionID}.md`) && /^impl-/i.test(f));
        } catch (_) {}
        const reconciliedCount = Math.max(1, implFiles.length);
        swarmDispatchCount.set(sessionID, reconciliedCount);
        debug(`COUNTER_RESET: swarmDispatchCount set to ${reconciliedCount} (${implFiles.length} impl files found) for session ${sessionID}`);
      }
      // T-R004-2: Reset phaseRedispatchCount for the target phase
      phaseRedispatchCount.delete(`${sessionID}:${targetPhase}`);
      debug(`COUNTER_RESET: phaseRedispatchCount deleted for ${getPhaseName(targetPhase)} (session ${sessionID})`);
      return true;
    }

    // --- Hook: chat.params ---
    async function chatParams(input, output) {
      const { sessionID, agent } = input;
      lastSeenSession = sessionID;

      // R100: Track agent for ALL sessions (overseer and subagents).
      // Used by checkpoint KD enforcement to verify the writing agent.
      if (agent) sessionAgentMap.set(sessionID, agent);

      if (agent === "overseer") {
        overseerSessions.add(sessionID);
        // Only initialize when session isn't already tracked (opencode calls
        // chat.params on every tool invocation cycle, not once per session).
        if (!sessionPhaseMap.has(sessionID)) {
          if (!loadState(sessionID)) {
            debug(`chat.params: initializing overseer session ${sessionID}`);
            sessionPhaseMap.set(sessionID, STATES.PROTOCOL_NOT_LOADED);
            // BUG-004: Capture session ID at initialization, not at intent KD write.
            // checkDiskAdvancement requires :sid to filter KD files by session.
            sessionPhaseMap.set(`${sessionID}:sid`, sessionID);
            saveState(sessionID);
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
        // R100: Checkpoint KD enforcement for subagent writes/edits.
        // Only the committer should write checkpoint KDs during SWARM phase.
        // If a non-committer subagent (e.g. artisan) writes or edits a
        // checkpoint KD directly, flag it. Check ALL overseer sessions for
        // SWARM phase to find the parent lifecycle context.
        if (tool === "write" || tool === "edit") {
          const path = args?.filePath || "";
          const relPath = toProjectRelative(path);
          const isCheckpointKD = /^knowledge\/checkpoint-/i.test(relPath) || /\/knowledge\/checkpoint-/i.test(relPath);
          if (isCheckpointKD) {
            const writingAgent = sessionAgentMap.get(sessionID)?.toLowerCase() || "unknown";
            if (writingAgent !== "committer") {
              // Check if any overseer session is in SWARM phase
              let isInSwarm = false;
              for (const sid of overseerSessions) {
                if (sessionPhaseMap.get(sid) === STATES.SWARM) {
                  isInSwarm = true;
                  break;
                }
              }
              if (writingAgent !== "unknown") {
                if (isInSwarm) {
                  // Known non-committer agent wrote checkpoint KD during SWARM — block
                  debug(`CHECKPOINT VIOLATION: agent=${writingAgent} ${tool} checkpoint KD during SWARM (path=${relPath})`);
                  throw new ProtocolGateError(
                    ERROR_TEMPLATES.WRONG_AGENT("committer").code,
                    `❌ CHECKPOINT VIOLATION: Only committer may write checkpoint KDs during SWARM. Agent "${writingAgent}" attempted to ${tool} checkpoint KD. Dispatch the committer agent for checkpoint commits.`,
                    "Dispatch the committer agent for checkpoint commits"
                  );
                } else {
                  // Non-committer wrote checkpoint KD but not during SWARM — warn only
                  debug(`CHECKPOINT WARNING: agent=${writingAgent} ${tool} checkpoint KD outside SWARM phase — allowed but unusual`);
                }
              } else {
                // Cannot determine writing agent — emit warning and defer to review
                if (isInSwarm) {
                  debug(`CHECKPOINT WARNING: unknown agent ${tool} checkpoint KD during SWARM (path=${relPath}) — deferring to manual review`);
                }
              }
            }
          }
        }
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
            `❌ BLOCKED: Wrong phase. Available tools in ${phaseName}: ${allowedTools.join(", ")}`,
            `Allowed tools: ${allowedTools.join(", ")}`
          );
        }
      }

      // --- todowrite handler ---
      if (tool === "todowrite") {
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
        // R100: Checkpoint KD enforcement — Overseer should not write checkpoint KDs.
        // Check BEFORE phase-specific restrictions (INTENT, REPORT) to provide the
        // more specific error: checkpoint KDs are only for committers.
        const isCheckpointKD = relPath.startsWith("knowledge/checkpoint-") || relPath.includes("/knowledge/checkpoint-");
        if (isCheckpointKD) {
          debug(`CHECKPOINT VIOLATION: overseer session ${sessionID} wrote checkpoint KD during ${phaseName} phase`);
          throw new ProtocolGateError(
            ERROR_TEMPLATES.WRONG_AGENT("committer").code,
            `❌ CHECKPOINT VIOLATION: Only committer may write checkpoint KDs. Overseer attempted to write checkpoint KD during ${phaseName} phase.`,
            "Dispatch the committer agent for checkpoint commits"
          );
        }

        if (phase === STATES.INTENT && !isIntentKD) {
          debug(`write: BLOCKED phase=${phaseName} path=${path} (must start with knowledge/intent-)`);
          throw new ProtocolGateError(ERROR_TEMPLATES.BLOCKED_WRONG_PHASE.code, "❌ BLOCKED: Wrong phase. Write to knowledge/intent-*.md", "Write to knowledge/intent-*.md");
        }
        if (phase === STATES.REPORT && !isReportKD) {
          debug(`write: BLOCKED phase=${phaseName} path=${path} (must start with knowledge/report-)`);
          throw new ProtocolGateError(ERROR_TEMPLATES.BLOCKED_WRONG_PHASE.code, "❌ BLOCKED: Wrong phase. Write to knowledge/report-*.md", "Write to knowledge/report-*.md");
        }

        // REPORT → PROTOCOL_NOT_LOADED: report KD written means lifecycle is complete.
        // Reset to phase 0 so the Overseer can start a new lifecycle with todowrite.
        if (phase === STATES.REPORT && isReportKD) {
          debug(`write: report KD written → transitioning to PROTOCOL_NOT_LOADED`);
          sessionPhaseMap.set(sessionID, STATES.PROTOCOL_NOT_LOADED);
          diskCheckFailures.set(sessionID, 0);
          sessionPhaseMap.delete(`${sessionID}:sid`);
          swarmDispatchCount.delete(sessionID);
          cycleMap.delete(sessionID);
          pendingVerification.delete(sessionID);
          pendingVerificationToolCount.delete(sessionID);
          saveState(sessionID);
          phase = STATES.PROTOCOL_NOT_LOADED;
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
                `❌ FABRICATED: Intent KD valid sections: Raw Request, Triage Notes, Next Steps, Process Friction`,
                ERROR_TEMPLATES.FABRICATED_SECTION.guidance
              );
            }
          }
        }

        // BUG-003: Trigger pendingVerification when write creates a KD matching
        // the current phase's expected prefix. This prevents false regression
        // while the KD is being finalized and written to disk.
        if (phase > STATES.INTENT && phase <= STATES.CLEANUP) {
          const prefixes = getPrefixes(phase);
          const matchedPrefix = prefixes.find(p => relPath.includes(`${p}-`));
          if (matchedPrefix) {
            pendingVerification.set(sessionID, {
              expectedPrefixes: prefixes,
              toolType: 'write',
              timestamp: Date.now(),
              toolCalls: 0
            });
            pendingVerificationToolCount.set(sessionID, 0);
            debug(`pendingVerification: SET (write) for session ${sessionID} — matchedPrefix=${matchedPrefix}, expectedPrefixes=${JSON.stringify(prefixes)}`);
          }
        }
      }

      // --- read handler ---
      else if (tool === "read") {
        const path = args?.filePath || "";
        if (phase === STATES.INTENT || phase === STATES.REPORT) {
          const relPath = toProjectRelative(path);
          const isTemplate = relPath.includes("templates");
          const isSkillFile = relPath.endsWith("/SKILL.md") || relPath.includes("/skills/");

          if (phase === STATES.INTENT) {
            // INTENT phase: only allow templates, skill files, and the current session's intent KDs.
            // Restricting to intent KDs prevents the Overseer from reading prior-session
            // reports or other KDs and falling back to self-execution.
            const isIntentKD = /knowledge\/intent-/i.test(relPath);
            if (!isTemplate && !isSkillFile && !isIntentKD) {
              debug(`read: BLOCKED phase=${phaseName} path=${path} (INTENT reads restricted to templates, skills, and intent KDs)`);
              throw new ProtocolGateError(ERROR_TEMPLATES.BLOCKED_WRONG_PHASE.code, "❌ BLOCKED: Wrong phase. Read from template, skill, or knowledge/intent-*.md", "Read from template, skill, or knowledge/intent-*.md only");
            }
          } else {
            // REPORT phase: allow templates and any knowledge KD (needed to compose report)
            const isKnowledge = relPath.startsWith("knowledge/") || relPath.includes("/knowledge/");
            if (!isTemplate && !isKnowledge) {
              debug(`read: BLOCKED phase=${phaseName} path=${path} (reads restricted to templates and knowledge KDs)`);
              throw new ProtocolGateError(ERROR_TEMPLATES.BLOCKED_WRONG_PHASE.code, "❌ BLOCKED: Wrong phase. Read from template or knowledge directory", "Read from template or knowledge directory only");
            }
          }
        }
      }

      // --- edit handler ---
      // Handles REPORT → PROTOCOL_NOT_LOADED transition when report KD is edited.
      // The write handler already covers this for `write` tool; `edit` is also
      // allowed in REPORT phase and needs the same lifecycle reset.
      else if (tool === "edit") {
        const path = args?.filePath || "";
        const relPath = toProjectRelative(path);
        const isReportKD = relPath.startsWith("knowledge/report-") || relPath.includes("/knowledge/report-");

        if (phase === STATES.REPORT && isReportKD) {
          debug(`edit: report KD edited → transitioning to PROTOCOL_NOT_LOADED`);
          sessionPhaseMap.set(sessionID, STATES.PROTOCOL_NOT_LOADED);
          diskCheckFailures.set(sessionID, 0);
          sessionPhaseMap.delete(`${sessionID}:sid`);
          swarmDispatchCount.delete(sessionID);
          cycleMap.delete(sessionID);
          pendingVerification.delete(sessionID);
          pendingVerificationToolCount.delete(sessionID);
          saveState(sessionID);
          phase = STATES.PROTOCOL_NOT_LOADED;
          phaseName = getPhaseName(phase);
        } else if (phase === STATES.REPORT && !isReportKD) {
          debug(`edit: BLOCKED phase=${phaseName} path=${path} (must edit knowledge/report-*.md)`);
          throw new ProtocolGateError(ERROR_TEMPLATES.BLOCKED_WRONG_PHASE.code, "❌ BLOCKED: Wrong phase. Edit knowledge/report-*.md", "Edit knowledge/report-*.md");
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
            // R005: Clear in-flight tracking — KD appeared on disk, dispatch is complete
            inFlightDispatches.delete(sessionID);
            pendingVerification.delete(sessionID);
            pendingVerificationToolCount.delete(sessionID);
            debug(`pendingVerification: CLEARED (disk advancement) for session ${sessionID}`);
            // Reset re-dispatch counter for the phase we just advanced from
            phaseRedispatchCount.delete(`${sessionID}:${currentPhase}`);
            const newPhase = currentPhase + 1;
            // R002: Record fresh advancement to prevent false regression.
            // checkPhaseStateConsistency uses this to grant a grace period before
            // allowing regression from the new phase back to the old one.
            freshAdvancement.set(sessionID, { phase: newPhase, diskCheckCount: 0 });
            debug(`FRESH_ADVANCEMENT: ${currentPhaseName} → ${getPhaseName(newPhase)} recorded for session ${sessionID}`);
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
              const currentPhasePrefixes = getPrefixes(currentPhase);
              if (currentPhasePrefixes.length === 0) {
                currentPhasePrefixes.push(currentPhaseName.toLowerCase());
              }

              // R001 guard: skip consistency check when write/task is creating expected KD.
              // For VERIFY phase, match against ANY prefix in the array (review OR audit).
              let isCreatingExpectedKD = tool === "write" && currentPhasePrefixes.some(p =>
                (args?.filePath || "").includes(`${p}-`) || (args?.content || "").includes(`${p}-`)
              );
              if (!isCreatingExpectedKD && tool === "task") {
                const taskPrompt = args?.prompt || "";
                let taskAgent = extractAgentFromPrompt(taskPrompt);
                if (!taskAgent && args?.subagent_type) {
                  taskAgent = args.subagent_type.toLowerCase();
                }
                const expectedAgent = PHASE_AGENT_MAP[currentPhaseName]?.toLowerCase();
                if (taskAgent && expectedAgent && taskAgent === expectedAgent) {
                  isCreatingExpectedKD = true;
                  // Store all expected prefixes for this phase (array for VERIFY, single for others)
                  inFlightDispatches.set(sessionID, currentPhasePrefixes);
                  debug(`KD_IN_FLIGHT: task dispatching ${taskAgent} for phase ${currentPhaseName} — prefixes=${JSON.stringify(currentPhasePrefixes)}`);
                }
              }

              // R003: Always increment diskCheckFailures — even during
              // pendingVerification — so safety mechanisms (force-advance at 15,
              // re-dispatch cap at 5) can fire regardless of pendingVerification state.
              // Previously, pendingVerification suppressed all stuck detection,
              // causing the infinite loop to run indefinitely. (BUG-007 fix)
              const currentFailures = (diskCheckFailures.get(sessionID) || 0) + 1;
              diskCheckFailures.set(sessionID, currentFailures);

              // R003: Check force-advance safety mechanism BEFORE pendingVerification guard.
              // When pendingVerification is active but the subagent is stuck and not
              // producing the expected KD, this ensures the force-advance still fires.
              let safetyTriggered = false;
              if (currentFailures >= 15) {
                debug(`SAFETY_OVERRIDE: FORCE ADVANCE — ${currentPhaseName} → VERIFY after ${currentFailures} stuck failures (pendingVerification active=${!!pendingVerification.get(sessionID)})`);
                sessionPhaseMap.set(sessionID, STATES.VERIFY);
                diskCheckFailures.set(sessionID, 0);
                phaseRedispatchCount.delete(`${sessionID}:${currentPhase}`);
                pendingVerification.delete(sessionID);
                pendingVerificationToolCount.delete(sessionID);
                inFlightDispatches.delete(sessionID);
                saveState(sessionID);
                safetyTriggered = true;
              } else {
                // R003: Check re-dispatch cap BEFORE pendingVerification guard
                const redispatchKey = `${sessionID}:${currentPhase}`;
                const redispatches = phaseRedispatchCount.get(redispatchKey) || 0;
                if (redispatches >= 5 && tool === "task") {
                  debug(`SAFETY_OVERRIDE: REDISPATCH CAP — ${currentPhaseName} phase — ${redispatches} re-dispatches used. Advancing to VERIFY (pendingVerification active=${!!pendingVerification.get(sessionID)})`);
                  sessionPhaseMap.set(sessionID, STATES.VERIFY);
                  diskCheckFailures.set(sessionID, 0);
                  phaseRedispatchCount.delete(`${sessionID}:${currentPhase}`);
                  pendingVerification.delete(sessionID);
                  pendingVerificationToolCount.delete(sessionID);
                  inFlightDispatches.delete(sessionID);
                  saveState(sessionID);
                  safetyTriggered = true;
                }
              }

              // If neither safety mechanism fired, run normal logic.
              // This may be pendingVerification (skip consistency check) or
              // normal checking (run consistency check + stuck warning).
              if (!safetyTriggered) {
                const pvState = pendingVerification.get(sessionID);
                if (pvState) {
                  // pendingVerification active — subagent is expected to produce KD.
                  // Skip consistency check and stuck counter; only track tool calls
                  // for the safety timeout mechanism.
                  const toolCalls = (pendingVerificationToolCount.get(sessionID) || 0) + 1;
                  pendingVerificationToolCount.set(sessionID, toolCalls);

                  // Safety timeout: warn at 10, force-advance at 15 tool calls
                  if (toolCalls >= 15) {
                    debug(`pendingVerification SAFETY: force-advance after ${toolCalls} tool calls — expectedPrefixes=${JSON.stringify(pvState.expectedPrefixes)}`);
                    pendingVerification.delete(sessionID);
                    pendingVerificationToolCount.delete(sessionID);
                    sessionPhaseMap.set(sessionID, STATES.VERIFY);
                    diskCheckFailures.set(sessionID, 0);
                    inFlightDispatches.delete(sessionID);
                    saveState(sessionID);
                  } else if (toolCalls >= 10) {
                    debug(`pendingVerification WARNING: ${toolCalls} tool calls without expected KD — clearing pendingVerification (expectedPrefixes=${JSON.stringify(pvState.expectedPrefixes)})`);
                    pendingVerification.delete(sessionID);
                    pendingVerificationToolCount.delete(sessionID);
                  } else {
                    debug(`pendingVerification: active for ${sessionID} — skipping consistency check and stuck counter (toolCalls=${toolCalls}, expectedPrefixes=${JSON.stringify(pvState.expectedPrefixes)})`);
                  }
                } else if (!isCreatingExpectedKD) {
                  // No pendingVerification: run normal consistency check + stuck detection
                  const didRegress = checkPhaseStateConsistency(
                    sessionID, currentPhase, sessionPhaseMap,
                    saveState, diskCheckFailures, phaseRedispatchCount, swarmDispatchCount,
                    inFlightDispatches, freshAdvancement
                  );

                  if (didRegress) {
                    phase = sessionPhaseMap.get(sessionID) ?? phase;
                    phaseName = getPhaseName(phase);
                  } else {
                    // Stuck warning at 10 failures (informational, not a safety mechanism)
                    if (currentFailures === 10) {
                      const knowledgeDir = join(process.cwd(), "knowledge");
                      let foundFiles = [];
                      try { foundFiles = readdirSync(knowledgeDir).filter(f => f.endsWith(`-${sessionID}.md`)); } catch (_) {}
                      debug(`STUCK WARNING: ${currentPhaseName} phase — no matching KD after ${currentFailures} disk checks. Expected prefixes: ${JSON.stringify(currentPhasePrefixes)}. Files found: ${JSON.stringify(foundFiles)}. Delegate to produce the required KD or check delegation-gate logs for extraction failures.`);
                    }
                  }
                } else {
                  debug(`Consistency check: skipped — write creating current phase KD (prefixes=${JSON.stringify(currentPhasePrefixes)})`);
                }
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
        // Task is only allowed during delegation phases (PREFLIGHT through CLEANUP)
        if (phase < STATES.PREFLIGHT || phase > STATES.CLEANUP) {
          debug(`task: BLOCKED phase=${phaseName} (task not allowed outside delegation phases)`);
          throw new ProtocolGateError(ERROR_TEMPLATES.BLOCKED_WRONG_PHASE.code, "❌ BLOCKED: Task dispatch not allowed in INTENT phase. Task is only available in PREFLIGHT through CLEANUP phases", "Wait for delegation phase");
        }

        const prompt = args?.prompt || "";

        // --- Memory injection: query prior insights for dispatch context ---
        // Injects top-3 relevant memory entries into the dispatch prompt so the
        // subagent receives relevant cross-session context at dispatch time.
        try {
          const memoryModule = await import('../knowledge-gate/index.js');
          if (typeof memoryModule.searchMemory === 'function') {
            // Extract topic from SCOPE, MODE, or fall back to phase name
            const scopeMatch = prompt.match(/SCOPE:\s*(.+)/i);
            const modeMatch = prompt.match(/MODE:\s*(\S+)/i);
            const topic = scopeMatch?.[1]?.trim() || modeMatch?.[1] || phaseName;

            const memoryResults = memoryModule.searchMemory({ tags: [], topic, limit: 3 });
            if (memoryResults && memoryResults.length > 0) {
              const memoryBlock = memoryResults.map(m =>
                `- [${m.id}] ${m.topic}: ${m.insight} (source: ${m.source_kd})`
              ).join('\n');
              output.args.prompt = prompt + `\n\n## Relevant Prior Insights\n${memoryBlock}`;
              debug(`Memory injection: added ${memoryResults.length} results for topic="${topic.substring(0, 50)}"`);
            }
          }
        } catch (e) {
          // Non-blocking: dispatch proceeds without memory if injection fails
          debug(`Memory injection skipped (non-blocking): ${e.message}`);
        }

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
            // BUG-003: Trigger pendingVerification when task dispatches the current phase's
            // expected agent. The expected KD will be produced by the subagent.
            const prefixes = getPrefixes(phase);
            if (prefixes.length > 0) {
              pendingVerification.set(sessionID, {
                expectedPrefixes: prefixes,
                toolType: 'task',
                timestamp: Date.now(),
                toolCalls: 0
              });
              pendingVerificationToolCount.set(sessionID, 0);
              debug(`pendingVerification: SET (task dispatch) for session ${sessionID} — agent=${agentName}, expectedPrefixes=${JSON.stringify(prefixes)}`);
            }
          }
          // Check if agent matches a backward target → backward transition
          else {
            const agentPhases = agentToPhaseMap[agentName] || [];
            const validTargets = BACKWARD_TRANSITIONS[phase] || [];
            const targetPhaseId = agentPhases.find(pid => validTargets.includes(pid));

            if (targetPhaseId !== undefined) {
              // R011: Require explicit BACKWARD: true flag for backward transitions
              // Without the flag, dispatching a non-current-phase agent is a wrong-agent
              // error even if the agent could theoretically trigger a backward transition.
              const hasBackwardFlag = /\bBACKWARD:\s*true\b/i.test(prompt);
              if (hasBackwardFlag) {
                debug(`task: BACKWARD TRANSITION agent=${agentName} from ${phaseName} → ${getPhaseName(targetPhaseId)}`);
                handleBackwardTransition(sessionID, phase, targetPhaseId);
              } else {
                // Agent matches a backward target but BACKWARD: true flag is missing.
                // Treat as wrong agent — prevents accidental phase regression.
                const expectedAgent = currentPhaseAgent || phaseName;
                debug(`task: BLOCKED wrong agent=${agentName} in phase=${phaseName} (expected: ${expectedAgent}) — BACKWARD: true required for backward transition`);
                throw new ProtocolGateError(ERROR_TEMPLATES.WRONG_AGENT(expectedAgent).code, ERROR_TEMPLATES.WRONG_AGENT(expectedAgent).message, ERROR_TEMPLATES.WRONG_AGENT(expectedAgent).guidance);
              }
            } else {
              // Wrong agent — not current phase, not a valid backward target
              // NOTE: Checkpoint commits during SWARM (artisan → committer) are handled
              // by the subagent bypass — artisan sessions are not in overseerSessions,
              // so committer dispatches from artisan pass through protocol-gate untouched.
              // The Overseer dispatching committer during SWARM without BACKWARD: true
              // is now blocked (R011) — which is correct because checkpoint commits are
              // the artisan's responsibility, not the overseer's.
              const expectedAgent = currentPhaseAgent || phaseName;
              debug(`task: BLOCKED wrong agent=${agentName} in phase=${phaseName} (expected: ${expectedAgent})`);
              throw new ProtocolGateError(ERROR_TEMPLATES.WRONG_AGENT(expectedAgent).code, ERROR_TEMPLATES.WRONG_AGENT(expectedAgent).message, ERROR_TEMPLATES.WRONG_AGENT(expectedAgent).guidance);
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
        let systemMsg = `[Protocol Gate] Phase ${phaseName}: ${instructions}`;

        // During INTENT phase, inject session ID so Overseer can use it in filename
        if (phase === STATES.INTENT && sessionID) {
          systemMsg += `\n\nYour session ID is: ${sessionID}`;
          systemMsg += `\nUse this session ID in the intent KD filename: knowledge/intent-{name}-${sessionID}.md`;
        }

        output.system.push(systemMsg);
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
      diskCheckFailures,
      inFlightDispatches,
      pendingVerification,
      pendingVerificationToolCount,
      freshAdvancement,
      KD_TYPE_PREFIXES,
      checkPhaseStateConsistency,
      ProtocolGateError,
      ERRORS: ERROR_TEMPLATES,
      get lastSeenSession() { return lastSeenSession; }
    };
  }
};
