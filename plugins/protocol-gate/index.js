// Protocol-Gate Plugin — WHEN: state machine, phase advancement, agent routing
//
// Hooks: chat.params, permission.ask, tool.execute.before, command.execute.before,
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
// Must match the regex patterns in checkDiskAdvancement() (lines 349-361) and
// the dual-KD special cases (VERIFY, DECOMPOSE).
// Used by in-flight dispatch tracking so the R001 guard can correctly match
// pending KDs against the disk pattern. (BUG-001/BUG-002 fix)
// VERIFY produces TWO KDs (review + audit); DECOMPOSE produces the plan KD plus
// the milestone registry (milestones-). Multi-KD phases are stored as arrays;
// all other phases use a single string for backward compatibility.
const KD_TYPE_PREFIXES = {
  [STATES.INTENT]: "intent",
  [STATES.PREFLIGHT]: "preflight",
  [STATES.EXPLORE]: "exploration",
  [STATES.INVESTIGATE]: "analysis",
  [STATES.ALIGN]: "spec",
  [STATES.DECOMPOSE]: ["plan", "milestones"],
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
  REPORT: ["todowrite", "edit", "read", "write", "skill"]
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

// Current lifecycle generation for a session, read from the :gen map entry.
// Defaults to 0 when absent — legacy state files without a generation field
// behave as generation 0 (NFR001 backward compatibility).
// Module-level so checkDiskAdvancement can derive the generation from the
// sessionPhaseMap it already receives as a parameter.
function getCurrentGeneration(sessionPhaseMap, sessionID) {
  return sessionPhaseMap.get(`${sessionID}:gen`) || 0;
}

// Generation-aware session KD matcher. Accepts both naming variants:
//   - `...-${sessionID}.md`         (generation 0, legacy naming)
//   - `...-${sessionID}-gen${N}.md` (generation N naming)
// A file matches only when its generation equals the current state generation
// (R002, Option A). Gen-less files are treated as generation 0 and are NOT
// matched when the current generation is > 0 (EC-007) — they belong to a
// prior lifecycle and must not advance or suppress the new one.
function matchesSessionKD(filename, sessionID, generation) {
  if (typeof filename !== "string" || !sessionID) return false;
  // Generation N variant: `...-${sessionID}-gen${N}.md`
  const genMarker = `-${sessionID}-gen`;
  const genIdx = filename.lastIndexOf(genMarker);
  if (genIdx !== -1) {
    const tail = filename.slice(genIdx + genMarker.length);
    const genMatch = tail.match(/^(\d+)\.md$/);
    if (genMatch) {
      return parseInt(genMatch[1], 10) === generation;
    }
  }
  // Legacy variant: `...-${sessionID}.md`
  if (generation > 0) return false;
  return filename.endsWith(`-${sessionID}.md`);
}

// Deletes all knowledge KDs belonging to a session — both naming variants
// (legacy `-${sessionID}.md` and any `-${sessionID}-gen${N}.md`). Called at
// lifecycle end (REPORT→reset) so stale prior-lifecycle KDs cannot confuse a
// new generation (BUG-008). Single readdirSync + batch rmSync loop (NFR003 —
// no per-file glob). EC-005: a missing knowledge/ dir is not an error.
// R6: logs the count of removed files.
function cleanupLifecycleKDs(sessionID) {
  const knowledgeDir = join(process.cwd(), "knowledge");
  let files = [];
  try {
    files = readdirSync(knowledgeDir);
  } catch (e) {
    debug(`cleanupLifecycleKDs: knowledge/ dir not found for session ${sessionID} — nothing to clean (EC-005)`);
    return 0;
  }
  const genPattern = new RegExp(`-${sessionID}-gen\\d+\\.md$`, "i");
  const stale = files.filter(f => f.endsWith(`-${sessionID}.md`) || genPattern.test(f));
  for (const f of stale) {
    try {
      rmSync(join(knowledgeDir, f));
    } catch (e) {
      debug(`cleanupLifecycleKDs: failed to remove ${f}: ${e.message}`);
    }
  }
  debug(`Cleanup of ${stale.length} stale KDs for session ${sessionID}`);
  return stale.length;
}

// Override signal files (.state/.override-{sessionID}.json) expire after this
// window. A stale file must never apply a phase change long after the user
// (or the /phase command template) wrote it.
const OVERRIDE_TTL_MS = 5 * 60 * 1000;

// Parses a /phase command argument into a phase number. Accepts:
//   - a number string 0-12 (e.g. "5" → ALIGN)
//   - a phase name, case-insensitive (e.g. "INTENT", "preflight")
// Returns null when the argument is not a valid phase reference — the AC-R006
// rejection cases (99, INVALID, empty) all funnel through here.
function parsePhaseArg(arg) {
  if (typeof arg !== "string") return null;
  const trimmed = arg.trim().toUpperCase();
  if (trimmed === "") return null;
  if (/^\d+$/.test(trimmed)) {
    const n = parseInt(trimmed, 10);
    if (Number.isInteger(n) && n >= 0 && n <= 12) return n;
    return null;
  }
  return Object.prototype.hasOwnProperty.call(STATES, trimmed) ? STATES[trimmed] : null;
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
      maxCyclesPerTransition: 3,
      milestoneCount: 1
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

  // Filter to only files matching the current session ID AND generation.
  // KD filenames embed the session ID as a suffix (e.g. preflight-workspace-ses_abc123.md).
  // Uses suffix matching to prevent substring collisions (ses_abc1 matching ses_abc123).
  // Generation scoping (P003/R002): files from a prior lifecycle carry a
  // different `-genN-` suffix and must not advance the new lifecycle (BUG-008).
  // NFR005: generation defaults to 0 when the state was never loaded or the
  // file carried no generation field — session-ID-only matching is the fallback.
  const generation = getCurrentGeneration(sessionPhaseMap, sessionID);
  const sessionFiles = [];
  for (const f of files) {
    if (matchesSessionKD(f, sessionID, generation)) {
      sessionFiles.push(f);
    } else if (f.endsWith(`-${sessionID}.md`) || f.includes(`-${sessionID}-gen`)) {
      // Same session but different generation — stale prior-lifecycle KD.
      // Log the skip so generation mismatches are diagnosable (R006/R5).
      const fileGenMatch = f.match(/-gen(\d+)\.md$/);
      const fileGen = fileGenMatch ? parseInt(fileGenMatch[1], 10) : 0;
      debug(`Skipped KD ${f}: generation mismatch (file=${fileGen}, current=${generation})`);
    }
  }

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

  // DECOMPOSE advancement requires BOTH the plan KD and the milestone registry
  // (R003). The Pathfinder produces both at DECOMPOSE; SWARM must not start
  // until the registry (live state SSOT) is on disk. A plan- KD alone is the
  // EC03 case — fail-closed, no advancement.
  if (phase === STATES.DECOMPOSE) {
    const hasPlan = sessionFiles.some(f => /^plan-/i.test(f));
    const hasMilestones = sessionFiles.some(f => /^milestones-/i.test(f));
    const result = hasPlan && hasMilestones;
    debug(`Disk check DECOMPOSE: plan=${hasPlan}, milestones=${hasMilestones} → ${result}`);
    return result;
  }

  // SWARM advancement requires dispatch-count tracking (Issue 6).
  // When the Overseer dispatches multiple artisans, each must produce an `impl-` KD
  // before advancing to VERIFY. Without this, the first artisan's KD triggers
  // premature advancement while others are still working.
  if (phase === STATES.SWARM) {
    const implFiles = sessionFiles.filter(f => pattern.test(f));
    const dispatchCount = swarmDispatchCount.get(sessionID) || 0;
    // Use stored milestone count from dispatch prompt when available, then config.
    // This ensures when the dispatcher specifies MILESTONE_COUNT:N, all N impl KDs
    // must be on disk before advancing to VERIFY. Falls back to config then default 1.
    const storedMc = sessionPhaseMap.get(`${sessionID}:milestones`);
    const cfg = loadConfig();
    const milestoneCount = storedMc || cfg.milestoneCount || 1;
    const effectiveCount = Math.max(milestoneCount, dispatchCount, 1);
    // Require at least one dispatch OR milestoneCount > 1 to advance.
    // When milestoneCount > 1, the config requires N impl KDs regardless of dispatches.
    // When milestoneCount is 1 (default), dispatch-driven advancement still applies.
    const hasSufficientTrigger = dispatchCount > 0 || milestoneCount > 1;
    const result = hasSufficientTrigger && implFiles.length >= effectiveCount;
    debug(`Disk check SWARM: impl=${implFiles.length}, dispatched=${dispatchCount}, milestoneCount=${milestoneCount}, effective=${effectiveCount} → ${result}`);
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

  // Generation-scoped (P003): stale gen-N KDs from a prior lifecycle must not
  // suppress legitimate phase regression in the current lifecycle (R3 gap fix).
  const generation = getCurrentGeneration(sessionPhaseMap, sessionID);
  const sessionFiles = files.filter(f => matchesSessionKD(f, sessionID, generation));

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
      // P009: the phase entry is deleted at lifecycle end (REPORT reset).
      // Persist that state as phase 0 — the next loadState() restores
      // PROTOCOL_NOT_LOADED and honors any manual edit of this file (AC-R005).
      const phase = sessionPhaseMap.get(sessionID) ?? STATES.PROTOCOL_NOT_LOADED;
      const sid = sessionPhaseMap.get(`${sessionID}:sid`);
      try {
        // generation persists across lifecycle resets via the :gen map entry.
        // Written even at phase 0 so the counter survives restarts between
        // lifecycles (P001/R001). Returns boolean so callers can enforce the
        // NFR002 atomicity contract: revert in-memory :gen when save fails.
        const generation = sessionPhaseMap.get(`${sessionID}:gen`) || 0;
        // Fix M4: Omit sid from state JSON when it's null/undefined (deleted after REPORT).
        // Previously, sid: null was serialized, causing loadState to skip phase restoration
        // and producing artifacts in the state file.
        const state = { phase, generation, timestamp: Date.now() };
        if (sid) state.sid = sid;
        const stateDir = join(PLUGIN_DIR, ".state");
        mkdirSync(stateDir, { recursive: true });
        writeFileSync(getStatePath(sessionID), JSON.stringify(state));
        return true;
      } catch (e) { debug(`saveState error: ${e.message}`); return false; }
    }

    function loadState(sessionID) {
      const statePath = getStatePath(sessionID);
      debug(`loadState: checking ${statePath}`);
      try {
        const data = JSON.parse(readFileSync(statePath, "utf8"));
        // Generation restoration happens for ANY phase, including phase 0.
        // After REPORT→PROTOCOL_NOT_LOADED the file is {phase:0, generation:N}
        // and the counter must survive process restarts between lifecycles.
        if (data.generation !== undefined) {
          sessionPhaseMap.set(`${sessionID}:gen`, data.generation);
          debug(`loadState: restored generation=${data.generation} for ${sessionID}`);
        }
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

    // --- Phase override (M3, R005/AC-R006) ---
    // Two paths set a phase override for a session:
    //   1. The /phase command (command.execute.before hook) sets the phase
    //      directly in memory and persists it via saveState — deterministic,
    //      no filesystem round-trip.
    //   2. A signal file `.state/.override-{sessionID}.json` written by the
    //      command template (commands/phase.md) — fallback for runtimes where
    //      the hook is not invoked. Consumed exactly once by chat.params.
    // The file path carries a 5-minute TTL and refuses forward jumps larger
    // than 3 phases (defense against a stale or miswritten file; the explicit
    // /phase command bypasses this limit because the user typed it directly).
    function getOverridePath(sessionID) {
      return join(PLUGIN_DIR, ".state", `.override-${sessionID}.json`);
    }

    function applyPhaseOverride(sessionID) {
      const overridePath = getOverridePath(sessionID);
      let raw;
      try {
        raw = readFileSync(overridePath, "utf8");
      } catch (_) {
        return false; // no override file
      }
      try {
        const data = JSON.parse(raw);
        if (data.createdAt && Date.now() - new Date(data.createdAt).getTime() > OVERRIDE_TTL_MS) {
          debug(`Phase override: dropped expired override for session ${sessionID} (TTL ${OVERRIDE_TTL_MS}ms)`);
          rmSync(overridePath, { force: true });
          return false;
        }
        const n = Number(data.phase);
        if (!Number.isInteger(n) || n < STATES.PROTOCOL_NOT_LOADED || n > STATES.REPORT) {
          debug(`Phase override: invalid phase value ${data.phase} in override file for session ${sessionID}`);
          rmSync(overridePath, { force: true });
          return false;
        }
        const current = sessionPhaseMap.get(sessionID);
        if (current !== undefined && n > current + 3) {
          debug(`Phase override: REJECTED forward jump ${getPhaseName(current)}(${current}) → ${getPhaseName(n)}(${n}) for session ${sessionID} (max +3)`);
          rmSync(overridePath, { force: true });
          return false;
        }
        sessionPhaseMap.set(sessionID, n);
        // Re-capture the session ID so checkDiskAdvancement can filter KDs by
        // session — required when the override starts a fresh lifecycle.
        if (!sessionPhaseMap.has(`${sessionID}:sid`)) {
          sessionPhaseMap.set(`${sessionID}:sid`, sessionID);
        }
        saveState(sessionID);
        rmSync(overridePath, { force: true }); // consumed once
        debug(`Phase override: ${getPhaseName(n)} (${n}) for session ${sessionID}`);
        return true;
      } catch (e) {
        debug(`Phase override: malformed override file for session ${sessionID}: ${e.message}`);
        rmSync(overridePath, { force: true });
        return false;
      }
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
    // A phase-0 file that carries a `generation` field is a completed-lifecycle
    // marker (post-REPORT state) — it must survive restarts so the counter is
    // not lost between lifecycles (R4).
    try {
      const stateDir = join(PLUGIN_DIR, ".state");
      const stateFiles = readdirSync(stateDir).filter(f => f.startsWith(".protocol-state-") && f.endsWith(".json"));
      for (const sf of stateFiles) {
        try {
          const data = JSON.parse(readFileSync(join(stateDir, sf), "utf8"));
          if (data.sid === undefined && data.generation === undefined) {
            rmSync(join(stateDir, sf));
            debug(`Plugin init: cleaned orphaned state file ${sf} (no SID, no generation)`);
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
          implFiles = files.filter(f => matchesSessionKD(f, sessionID, getCurrentGeneration(sessionPhaseMap, sessionID)) && /^impl-/i.test(f));
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
        // M3: consume any pending /phase override file first. Runs before the
        // entry check so a file is honored even mid-lifecycle (the hook already
        // applied the value in memory — the file then re-applies the same value
        // and is deleted, which is idempotent).
        applyPhaseOverride(sessionID);
        // Only initialize when session isn't already tracked (opencode calls
        // chat.params on every tool invocation cycle, not once per session).
        if (!sessionPhaseMap.has(sessionID)) {
          if (!loadState(sessionID)) {
            debug(`chat.params: initializing overseer session ${sessionID}`);
            sessionPhaseMap.set(sessionID, STATES.PROTOCOL_NOT_LOADED);
            // BUG-004: Capture session ID at initialization, not at intent KD write.
            // checkDiskAdvancement requires :sid to filter KD files by session.
            sessionPhaseMap.set(`${sessionID}:sid`, sessionID);
            // saveState re-persists any :gen restored by loadState — a phase-0
            // post-REPORT state file's generation survives this re-initialization.
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

    // --- Hook: command.execute.before (M3, R005) ---
    // Implements the /phase slash command. Validates the argument against
    // STATES (AC-R006 rejection cases: 99, INVALID, empty) and applies the
    // override in memory + on disk. Registered alongside commands/phase.md;
    // the hook is the deterministic path and the command template's override
    // file is the fallback for runtimes that never invoke this hook.
    async function commandExecuteBefore(input, output) {
      const commandName = String(input.command || "").replace(/^\/+/, "");
      if (commandName !== "phase") return;
      const { sessionID, arguments: arg } = input;
      const trimmed = String(arg ?? "").trim();
      if (!trimmed) {
        output.parts = [{ type: "text", text: "Error: /phase requires an argument. Usage: /phase <0-12|PHASE_NAME>" }];
        return;
      }
      const n = parsePhaseArg(trimmed);
      if (n === null) {
        output.parts = [{ type: "text", text: `Error: invalid phase "${trimmed}". Valid: a number 0-12 or one of ${Object.keys(STATES).join(", ")}.` }];
        return;
      }
      sessionPhaseMap.set(sessionID, n);
      // Re-capture the session ID so checkDiskAdvancement can filter KDs by
      // session — required when /phase starts a fresh lifecycle.
      if (!sessionPhaseMap.has(`${sessionID}:sid`)) {
        sessionPhaseMap.set(`${sessionID}:sid`, sessionID);
      }
      overseerSessions.add(sessionID);
      saveState(sessionID);
      debug(`Phase override: ${getPhaseName(n)} (${n}) for session ${sessionID}`);
      output.parts = [{ type: "text", text: `Phase set to ${getPhaseName(n)} (${n}) for session ${sessionID}.` }];
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
              // Fix M2: Re-initialize :sid when entering INTENT after REPORT→PROTOCOL_NOT_LOADED cycle.
              // Without this, checkDiskAdvancement lacks :sid to filter KDs by session, preventing progression.
              sessionPhaseMap.set(`${sessionID}:sid`, sessionID);
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
          debug(`write: report KD written → transitioning lifecycle end`);
          // R001: increment generation on lifecycle end — the new generation
          // scopes all KDs written in the next lifecycle. NFR002/EC-003:
          // increment is atomic with saveState — revert on save failure.
          const currentGen = getCurrentGeneration(sessionPhaseMap, sessionID);
          const nextGen = currentGen + 1;
          sessionPhaseMap.set(`${sessionID}:gen`, nextGen);
          // R004/P009: delete the phase entry instead of setting PROTOCOL_NOT_LOADED.
          // chat.params only re-runs loadState() when the entry is absent, so a
          // 0 here would keep the in-memory map diverged from a manually edited
          // state file (BUG-009). Deleting forces loadState() on the next message.
          sessionPhaseMap.delete(sessionID);
          diskCheckFailures.set(sessionID, 0);
          sessionPhaseMap.delete(`${sessionID}:sid`);
          swarmDispatchCount.delete(sessionID);
          cycleMap.delete(sessionID);
          pendingVerification.delete(sessionID);
          pendingVerificationToolCount.delete(sessionID);
          if (!saveState(sessionID)) {
            sessionPhaseMap.set(`${sessionID}:gen`, currentGen);
            debug(`saveState failed — generation stays ${currentGen} for session ${sessionID} (NFR002)`);
          } else {
            debug(`Generation ${currentGen} → ${nextGen} for session ${sessionID}`);
          }
          // R003/P008: remove this lifecycle's KDs so stale files can never
          // advance or suppress the next generation. EC-008: cleanup failure
          // must not block the phase reset — wrapped in try-catch. EC-004
          // accepted race: any KD written between the REPORT trigger and this
          // cleanup belongs to the ending lifecycle; deletion is safe.
          try {
            cleanupLifecycleKDs(sessionID);
          } catch (e) {
            debug(`cleanupLifecycleKDs error for session ${sessionID}: ${e.message} (EC-008)`);
          }
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
          debug(`edit: report KD edited → transitioning lifecycle end`);
          // R001: generation increment — mirrors the write handler (see above
          // for the NFR002 atomicity rationale). R004/P009: delete the phase
          // entry so the next chat.params re-runs loadState() (BUG-009).
          const currentGen = getCurrentGeneration(sessionPhaseMap, sessionID);
          const nextGen = currentGen + 1;
          sessionPhaseMap.set(`${sessionID}:gen`, nextGen);
          sessionPhaseMap.delete(sessionID);
          diskCheckFailures.set(sessionID, 0);
          sessionPhaseMap.delete(`${sessionID}:sid`);
          swarmDispatchCount.delete(sessionID);
          cycleMap.delete(sessionID);
          pendingVerification.delete(sessionID);
          pendingVerificationToolCount.delete(sessionID);
          if (!saveState(sessionID)) {
            sessionPhaseMap.set(`${sessionID}:gen`, currentGen);
            debug(`saveState failed — generation stays ${currentGen} for session ${sessionID} (NFR002)`);
          } else {
            debug(`Generation ${currentGen} → ${nextGen} for session ${sessionID}`);
          }
          // R003/P008: cleanup stale session KDs; EC-008 try-catch (see write handler).
          try {
            cleanupLifecycleKDs(sessionID);
          } catch (e) {
            debug(`cleanupLifecycleKDs error for session ${sessionID}: ${e.message} (EC-008)`);
          }
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
            // P009: after lifecycle-end the phase entry was deleted; currentPhase
            // is undefined and there is nothing to check — skip the whole block
            // (getPhaseName(undefined).toLowerCase() would throw).
            if (currentPhase === undefined) {
              debug(`Disk advancement: no phase entry for ${sessionID} — skipping consistency block`);
            } else if (currentPhase !== STATES.REPORT) {
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
                      try { foundFiles = readdirSync(knowledgeDir).filter(f => matchesSessionKD(f, sessionID, getCurrentGeneration(sessionPhaseMap, sessionID))); } catch (_) {}
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
              // Extract MILESTONE_COUNT from dispatch prompt to track how many
              // impl KDs are expected before SWARM→VERIFY advancement.
              const milestoneMatch = prompt.match(/MILESTONE_COUNT:\s*(\d+)/i);
              if (milestoneMatch) {
                const mc = parseInt(milestoneMatch[1], 10);
                sessionPhaseMap.set(`${sessionID}:milestones`, mc);
                debug(`SWARM milestone count for ${sessionID}: ${mc} (from dispatch)`);
              }
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

        // During INTENT phase, inject session ID + generation so Overseer can
        // use them in the KD filename. The -gen{N} suffix (R002 Option A)
        // scopes this lifecycle's KDs so stale prior-lifecycle KDs never match.
        if (phase === STATES.INTENT && sessionID) {
          const generation = getCurrentGeneration(sessionPhaseMap, sessionID);
          systemMsg += `\n\nYour session ID is: ${sessionID}`;
          systemMsg += `\nUse this session ID and generation in the intent KD filename: knowledge/intent-{name}-${sessionID}-gen${generation}.md`;
        }

        output.system.push(systemMsg);
      }
      debug(`systemTransform: injected phase constraint for phase=${phaseName}`);
    }

    return {
      "chat.params": chatParams,
      "permission.ask": permissionAsk,
      "tool.execute.before": toolExecuteBefore,
      "command.execute.before": commandExecuteBefore,
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
      checkDiskAdvancement,
      cleanupLifecycleKDs,
      getCurrentGeneration: (sessionID) => getCurrentGeneration(sessionPhaseMap, sessionID),
      parsePhaseArg,
      applyPhaseOverride,
      getOverridePath,
      ProtocolGateError,
      ERRORS: ERROR_TEMPLATES,
      get lastSeenSession() { return lastSeenSession; }
    };
  }
};
