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
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const PLUGIN_DIR = dirname(__filename);

// Directory seams: call-time helpers, not module-load constants, so tests can
// flip PROTOCOL_GATE_STATE_DIR / PROTOCOL_GATE_KNOWLEDGE_DIR between tests
// without re-importing the module. Defaults: state lives under the plugin dir,
// knowledge is project-relative (cwd).
function getStateDir() {
  return process.env.PROTOCOL_GATE_STATE_DIR
    ? resolve(process.env.PROTOCOL_GATE_STATE_DIR)
    : join(PLUGIN_DIR, ".state");
}

function getKnowledgeDir() {
  // R008: shared project-root seam with knowledge-gate. The precedence is:
  // 1. PROTOCOL_GATE_KNOWLEDGE_DIR — explicit override (tests, production seam)
  // 2. KNOWLEDGE_GATE_PROJECT_ROOT — shared env seam with knowledge-gate so
  //    a session's lifecycle KDs and its issues/memories resolve to the same root
  // 3. join(process.cwd(), "knowledge") — cwd fallback (unchanged default)
  if (process.env.PROTOCOL_GATE_KNOWLEDGE_DIR) {
    return resolve(process.env.PROTOCOL_GATE_KNOWLEDGE_DIR);
  }
  if (process.env.KNOWLEDGE_GATE_PROJECT_ROOT) {
    return join(resolve(process.env.KNOWLEDGE_GATE_PROJECT_ROOT), "knowledge");
  }
  return join(process.cwd(), "knowledge");
}

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

// Retention cap for the per-session verbatim raw-intent capture. The
// chat.message hook keeps only the latest RAW_INTENT_MAX_MESSAGES overseer
// messages so the INTENT-phase systemTransform injection stays bounded.
// Named constant, exported as a test-access property.
const RAW_INTENT_MAX_MESSAGES = 10;

// KD type prefixes — maps phase constants to the prefix used in KD filenames.
// Must match the regex patterns in checkDiskAdvancement() and the dual-KD
// special cases (VERIFY, DECOMPOSE).
// Used by in-flight dispatch tracking so the guard can correctly match pending
// KDs against the disk pattern.
// VERIFY produces ONE KD (review — the audit is a section of the review KD);
// DECOMPOSE produces the plan KD plus the milestone registry (milestones-).
// Multi-KD phases are stored as arrays; all other phases use a single string
// for backward compatibility.
const KD_TYPE_PREFIXES = {
  [STATES.INTENT]: "intent",
  [STATES.PREFLIGHT]: "preflight",
  [STATES.EXPLORE]: "exploration",
  [STATES.INVESTIGATE]: "analysis",
  [STATES.ALIGN]: "spec",
  [STATES.DECOMPOSE]: ["plan", "milestones"],
  [STATES.SWARM]: "impl",
  [STATES.VERIFY]: ["review"],
  [STATES.EXTRACT]: "composed",
  [STATES.EVOLVE]: "process",
  [STATES.CLEANUP]: "cleanup"
};

// Normalize a prefix value from KD_TYPE_PREFIXES to always return an array.
// VERIFY phase stores ["review"]; all others store a single string.
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
  SWARM: "Dispatch the Artisan agent. Read the milestone registry KD to track milestone state before each dispatch. Include exactly one MILESTONE ID: matching the registry row you are dispatching. Name the dispatch's RESULT KD milestone-scoped — knowledge/impl-<milestone_id>-<name>-<session_id>-gen<N>.md — so the impl KD checks that milestone off on write.",
  VERIFY: "Dispatch the Inspector agent.",
  EXTRACT: "Dispatch the Scribe agent.",
  EVOLVE: "Dispatch the Habit Builder agent.",
  CLEANUP: "Dispatch the Committer agent.",
  REPORT: "Write a report KD summarizing lifecycle results."
};

const TOOL_ALLOWLIST = {
  PROTOCOL_NOT_LOADED: ["todowrite"],
  INTENT: ["todowrite", "write", "edit", "read", "skill", "bash"],
  PREFLIGHT: ["task", "todowrite", "glob", "bash"],
  EXPLORE: ["task", "todowrite", "glob"],
  INVESTIGATE: ["task", "todowrite", "glob"],
  ALIGN: ["task", "todowrite", "glob"],
  DECOMPOSE: ["task", "todowrite", "glob"],
  SWARM: ["task", "todowrite", "glob", "read"],
  VERIFY: ["task", "todowrite", "glob"],
  EXTRACT: ["task", "todowrite", "glob"],
  EVOLVE: ["task", "todowrite", "glob"],
  CLEANUP: ["task", "todowrite", "glob", "bash"],
  REPORT: ["todowrite", "edit", "read", "write", "skill"]
};

// Per-tool restrictions for tools that ARE in the allowlist but have path/scope limits.
// tool.definition appends these to the description so the LLM sees the restriction
// instead of treating the tool as fully available.
// Delegation templates are JSON files auto-injected by delegation-gate at
// dispatch — never read by the Overseer. KD-format templates are auto-loaded
// skills loaded via the skill tool. The read restrictions below scope the read
// tool to skill files + phase KDs; neither string instructs reading templates.
const TOOL_RESTRICTIONS = {
  INTENT: { read: "ONLY skill files and intent KDs — delegation templates are JSON files auto-injected by delegation-gate at dispatch, never read; KD-format templates are auto-loaded skills (load via the skill tool)", edit: "ONLY knowledge/intent-*.md files — the intent KD is the phase deliverable; other files are not editable in INTENT phase", bash: "ONLY mkdir for knowledge directory creation" },
  SWARM: { read: "ONLY milestone registry KDs" },
  REPORT: { read: "ONLY skill files and knowledge KDs — delegation templates are JSON files auto-injected by delegation-gate at dispatch, never read; KD-format templates are auto-loaded skills (load via the skill tool)" }
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
  FABRICATED_SECTION: { code: "FABRICATED_SECTION", message: "❌ FABRICATED: Intent KD contains fabricated section. Follow the intent template exactly", guidance: "Follow the intent template exactly — Raw Request, Triage Notes, Next Steps, Process Friction only" },
  MULTI_MILESTONE: { code: "MULTI_MILESTONE", message: "❌ MULTI_MILESTONE: Multiple milestones in single dispatch", guidance: "Include exactly one MILESTONE ID: <milestone-id> field per dispatch" },
  GITIGNORED_STAGE_REJECTED: { code: "GITIGNORED_STAGE_REJECTED", message: "❌ GITIGNORED_STAGE_REJECTED: git add would stage gitignored knowledge/ paths — knowledge/ is workflow meta and stays out of the commit set", guidance: "Stage only intended tracked files — run `git add <tracked-path>` (AGENTS.md, agents/, skills/, plugins/, tests/, commands/, opencode.json) or `git add .` to stage all non-ignored changes" }
};

function getPhaseName(phaseId) {
  return Object.entries(STATES).find(([, id]) => id === phaseId)?.[0];
}

// Current lifecycle generation for a session, read from the :gen map entry.
// Defaults to 0 when absent — legacy state files without a generation field
// behave as generation 0 (backward compatibility).
// Module-level so checkDiskAdvancement can derive the generation from the
// sessionPhaseMap it already receives as a parameter.
function getCurrentGeneration(sessionPhaseMap, sessionID) {
  return sessionPhaseMap.get(`${sessionID}:gen`) || 0;
}

// Generation-aware session KD matcher. Accepts both naming variants:
//   - `...-${sessionID}.md`         (generation 0, legacy naming)
//   - `...-${sessionID}-gen${N}.md` (generation N naming)
// A file matches only when its generation equals the current state generation.
// Gen-less files are treated as generation 0 and are NOT matched when the
// current generation is > 0 — they belong to a prior lifecycle and must not
// advance or suppress the new one.
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

// Resolves the session IDs whose KDs belong to the current lifecycle for
// READ/scan purposes. Cross-session adoption was removed — a session never
// inherits another lifecycle's phase or `:sid` — and stale `:sid` entries are
// healed at reconcile, so the lookup set is exactly [current sessionID]. No
// read path can ever scan a prior lifecycle's KDs.
function getKDLookupSIDs(sessionPhaseMap, sessionID) {
  return [sessionID];
}

// Generation-scoped KD matcher against the session's single-session lookup set
// ([current sessionID] only — cross-session adoption removed). True when the
// file belongs to the lifecycle at the given generation under the current
// session id.
function matchesSessionKDForSession(filename, sessionPhaseMap, sessionID, generation) {
  return getKDLookupSIDs(sessionPhaseMap, sessionID).some(sid => matchesSessionKD(filename, sid, generation));
}

// Session match independent of the persisted lifecycle generation — used by
// disk-evidence reconciliation, where the FILENAME's own embedded `-gen{N}`
// (any N, including one that differs from the persisted generation — the
// observed gen0/gen1 divergence behind Issue 64) or the legacy
// `-{sessionID}.md` suffix is the evidence. The session-id match remains
// mandatory: a foreign lifecycle's impl KD never promotes a row.
function matchesSessionKDAnyGeneration(filename, sessionID) {
  if (typeof filename !== "string" || !sessionID) return false;
  const genMarker = `-${sessionID}-gen`;
  const genIdx = filename.lastIndexOf(genMarker);
  if (genIdx !== -1 && /^(\d+)\.md$/.test(filename.slice(genIdx + genMarker.length))) {
    return true;
  }
  return filename.endsWith(`-${sessionID}.md`);
}

// Deletes ONLY the knowledge KDs of a session's ENDING lifecycle generation:
// for generation 0 the legacy `-${sessionID}.md` variant plus the `-gen0.md`
// suffix; for generation N only the `-gen${N}.md` variant. Files of any other
// generation are never touched — a reused session ID spans lifecycles
// (opencode --continue), so a stray/duplicate REPORT write or edit fired after
// the next lifecycle began must not wipe the new lifecycle's KDs.
// Semantics mirror the generation-scoped read path matchesSessionKD.
// Single readdirSync + batch rmSync loop (no per-file glob).
// A missing knowledge/ dir is not an error — returns 0.
// Logs the count of removed files.
function cleanupLifecycleKDs(sessionID, generation = 0) {
  const knowledgeDir = getKnowledgeDir();
  let files = [];
  try {
    files = readdirSync(knowledgeDir);
  } catch (e) {
    debug(`cleanupLifecycleKDs: knowledge/ dir not found for session ${sessionID} — nothing to clean`);
    return 0;
  }
  const gen = Number(generation) || 0;
  // Regex construction over the raw session ID keeps the historical failure
  // mode: a malformed ID throws, and the REPORT call sites' try/catch turns it
  // into a logged, non-blocking cleanup.
  const genPattern = new RegExp(`-${sessionID}-gen${gen}\\.md$`, "i");
  const stale = files.filter(f => (gen === 0 && f.endsWith(`-${sessionID}.md`)) || genPattern.test(f));
  for (const f of stale) {
    try {
      rmSync(join(knowledgeDir, f));
    } catch (e) {
      debug(`cleanupLifecycleKDs: failed to remove ${f}: ${e.message}`);
    }
  }
  debug(`Cleanup of ${stale.length} stale KDs for session ${sessionID} (generation ${gen})`);
  // Lifecycle-end cleanup also clears the session's short-term memory store
  // (R020/R006): promotion already copies selected notes to long-term memory
  // at EXTRACT, so the scratch notes are disposable here. Recursive + force,
  // failure non-blocking (mirrors the KD cleanup loop above). Long-term
  // knowledge/memory/ is untouched.
  const shortTermDir = join(knowledgeDir, "short-term", sessionID);
  try {
    if (existsSync(shortTermDir)) {
      rmSync(shortTermDir, { recursive: true, force: true });
      debug(`Cleanup of short-term store for session ${sessionID} (generation ${gen})`);
    }
  } catch (e) {
    debug(`cleanupLifecycleKDs: failed to remove short-term store for ${sessionID}: ${e.message}`);
  }
  // Store-aware scratch cleanup (R005): generic and project-scoped notes live
  // outside the legacy short-term dir. Only in-config-store locations are
  // reachable here — project workspaces outside the config root own their
  // scratch dirs and are out of reach by design.
  const genericShortTermDir = join(knowledgeDir, "generic", "short-term", sessionID);
  try {
    if (existsSync(genericShortTermDir)) {
      rmSync(genericShortTermDir, { recursive: true, force: true });
      debug(`Cleanup of generic short-term store for session ${sessionID} (generation ${gen})`);
    }
  } catch (e) {
    debug(`cleanupLifecycleKDs: failed to remove generic short-term store for ${sessionID}: ${e.message}`);
  }
  const projectsRoot = join(knowledgeDir, "projects");
  try {
    if (existsSync(projectsRoot)) {
      for (const project of readdirSync(projectsRoot)) {
        const projShortTermDir = join(projectsRoot, project, "short-term", sessionID);
        if (existsSync(projShortTermDir)) {
          rmSync(projShortTermDir, { recursive: true, force: true });
          debug(`Cleanup of project (${project}) short-term store for session ${sessionID} (generation ${gen})`);
        }
      }
    }
  } catch (e) {
    debug(`cleanupLifecycleKDs: failed to remove project short-term stores for ${sessionID}: ${e.message}`);
  }
  return stale.length;
}

// Parses a /phase command argument into a phase number. Accepts:
//   - a number string 0-12 (e.g. "5" → ALIGN)
//   - a phase name, case-insensitive (e.g. "INTENT", "preflight")
// Returns null when the argument is not a valid phase reference — the
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

// Session IDs reach file paths and can be attacker-influenced. Reject path
// separators, NUL, and the traversal entries so a crafted ID can never escape
// the plugin's .state directory. opencode session IDs (ses_...) pass.
function sanitizeSessionID(sessionID) {
  if (typeof sessionID !== "string" || sessionID.length === 0) return null;
  if (sessionID === "." || sessionID === "..") return null;
  if (/[\\/\0]/.test(sessionID)) return null;
  return sessionID;
}

// Atomic durable write — tmp file + fsync + rename. The rename is atomic on
// the same filesystem, so a crash mid-write can never leave a torn file at the
// target path. Throws on failure; callers surface the error.
function atomicWriteFileSync(targetPath, data) {
  const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    const fd = openSync(tmpPath, "w");
    try {
      writeSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmpPath, targetPath);
  } catch (e) {
    try { rmSync(tmpPath, { force: true }); } catch (_) {}
    throw e;
  }
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

// Loud channel — diagnostics that must be visible WITHOUT PROTOCOL_GATE_DEBUG
// (Issue 64 / NFR001): silent auto-checkoff failures left registries stuck in
// SWARM and forced manual repair. Emissions are per-event and rare by nature;
// the write is best-effort and never blocks tool execution.
function loud(msg) {
  try {
    process.stderr.write(`[protocol-gate] ${msg}\n`);
  } catch (_) {}
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

// Collects every MILESTONE ID field value from a dispatch prompt — one entry
// per `MILESTONE ID:` / `MILESTONE_ID:` / `MILESTONE.ID:` line, with Markdown
// bold markers stripped. Mirrors delegation-gate's collectMilestoneIds so both
// gates agree on cardinality. A comma inside a single value means multiple
// milestones were crammed into one field; the caller rejects that as
// MULTI_MILESTONE.
function collectMilestoneIds(prompt) {
  if (typeof prompt !== "string") return [];
  const ids = [];
  for (const line of prompt.split("\n")) {
    const match = line.match(/^(?:#{1,6}\s*)?(?:\*\*)?MILESTONE[. _]ID(?:\*\*)?:\s*(.*)/i);
    if (match) {
      const value = match[1].trim().replace(/\*\*/g, "").trim();
      if (value) ids.push(value);
    }
  }
  return ids;
}

// Extracts the single MILESTONE ID from a raw dispatch prompt. protocol-gate
// runs BEFORE delegation-gate, so the raw prompt (not the rendered template)
// is the source of truth. Cardinality (exactly one) is validated at the
// dispatch call site BEFORE any registry mutation — this helper only surfaces
// the first value for callers that already know cardinality holds.
function extractMilestoneIdFromPrompt(prompt) {
  const ids = collectMilestoneIds(prompt);
  return ids.length > 0 ? ids[0] : null;
}

// Extracts the `RESULT KD:` path from a raw dispatch prompt. protocol-gate
// runs BEFORE delegation-gate, so the raw prompt (not the rendered template)
// is the source of truth — the same pattern as extractMilestoneIdFromPrompt.
// Returns null when the prompt carries no RESULT KD line (e.g. legacy
// dispatches without a declared result artifact).
function parseResultKdFromPrompt(prompt) {
  const match = String(prompt || "").match(/^\s*RESULT KD:\s*(.+?)\s*$/m);
  return match ? match[1] : null;
}

// Per-milestone redispatch counter key. The SAFETY_STUCK 5-redispatch cap
// counts a milestone's OWN attempts, not the whole lifecycle — one milestone's
// transient retries must never consume another milestone's budget. The key is
// case-normalized to uppercase so lower/upper milestone ids map to the same
// budget, matching the registry's case-insensitive row matching (an
// `impl-<milestone-id>` check-off resets the same key that the matching
// `MILESTONE ID: <milestone-id>` dispatch increments).
function milestoneRedispatchKey(sessionID, milestoneId) {
  return `${sessionID}:${String(milestoneId).toUpperCase()}`;
}

// Clears every per-milestone redispatch key for a session. Per-milestone keys
// are `${sessionID}:<milestone-id>` while phase keys are
// `${sessionID}:<phase-constant>` (a number) — deleting the non-numeric
// suffixes removes all milestone budgets without touching phase counters.
// Called on regress-to-SWARM and SWARM FORCE ADVANCE so milestone budgets
// never accumulate unboundedly across lifecycle transitions.
function clearPerMilestoneRedispatchKeys(phaseRedispatchCount, sessionID) {
  const prefix = `${sessionID}:`;
  for (const key of [...phaseRedispatchCount.keys()]) {
    if (!key.startsWith(prefix)) continue;
    const suffix = key.slice(prefix.length);
    if (!/^\d+$/.test(suffix)) {
      phaseRedispatchCount.delete(key);
    }
  }
}

// Advances a milestone row in the session's milestone registry KD through the
// given state chain (e.g. ["assigned", "in-progress"]) on a SWARM dispatch.
// Only the machine-readable `## Milestone States` YAML block is rewritten — the
// human-readable Milestone Details table stays untouched. A row already at the
// final state is left alone (idempotent). Reaching checked-off is restricted to
// in-progress milestones — the artisan checks off only after its impl KD lands,
// so pending/assigned/failed rows are rejected with invalid-transition. Row
// matching is case-insensitive (impl KDs may carry any casing for the milestone
// token) and the replacement preserves the registry row's own casing.
// The write is atomic (tmp + fsync + rename) so a crash mid-write can never
// leave a torn registry YAML on disk.
// A checked-off row is immutable for every caller EXCEPT the SWARM re-dispatch
// path (opts.reopen). When the Overseer re-dispatches a checked-off milestone
// after inspector findings, the row re-opens to a non-terminal state so the
// SWARM→VERIFY gate fails closed again until the fix is re-verified.
// Returns { ok, path, changed } on success or { ok: false, reason } otherwise.
function updateMilestoneRegistry(sessionID, sessionPhaseMap, milestoneId, states, opts = {}) {
  const located = locateMilestoneRegistry(sessionID, sessionPhaseMap);
  if (!located) return { ok: false, reason: "no-registry" };

  // `[ \t]*$` (not `\s*$`) so the trailing newline is never part of the match:
  // when the row being updated is the LAST line in the block, `\s*$` consumes
  // the newline at end-of-input and the replacement glues the closing ``` fence
  // to the row (`M1: in-progress```) — malformed registry YAML. `[ \t]*` stays
  // on the row line, `$` matches before the line terminator (multiline) or at
  // end of input, and the newline survives the replace.
  const rowPattern = new RegExp(`^\\s*${escapeRegExp(milestoneId)}:\\s*([A-Za-z-]+)[ \\t]*$`, "mi");
  const rowMatch = located.block.match(rowPattern);
  if (!rowMatch) return { ok: false, reason: "milestone-not-found" };

  const current = rowMatch[1];
  const finalState = Array.isArray(states) && states.length > 0 ? states[states.length - 1] : "in-progress";
  if (current === finalState) {
    return { ok: true, path: located.path, changed: false };
  }
  if (finalState === "checked-off" && current !== "in-progress") {
    return { ok: false, reason: "invalid-transition" };
  }
  if (current === "checked-off") {
    // Only the SWARM re-dispatch path re-opens completed rows; every other
    // writer leaves them immutable so evidence is never silently lost.
    if (!opts.reopen || finalState === "checked-off") {
      return { ok: true, path: located.path, changed: false };
    }
  }

  const rowId = rowMatch[0].slice(0, rowMatch[0].indexOf(":")).trim();
  const newBlock = located.block.replace(rowPattern, `  ${rowId}: ${finalState}`);
  const newContent = located.content.slice(0, located.fenceStart) + newBlock + located.content.slice(located.fenceEnd);
  try {
    // Atomic durable registry write — no torn YAML after a crash.
    atomicWriteFileSync(located.path, newContent);
    // A successful re-open invalidates the milestone's prior completion
    // evidence (supersedeMilestoneImplKDs) — otherwise the next SWARM→VERIFY
    // evaluation would instantly re-check-off the row from the stale impl KD
    // the Inspector just found deficient.
    if (opts.reopen && current === "checked-off") {
      supersedeMilestoneImplKDs(sessionID, sessionPhaseMap, milestoneId);
    }
    debug(`Registry ${located.path}: ${milestoneId} ${current} → ${finalState} (session ${sessionID})`);
    return { ok: true, path: located.path, changed: true };
  } catch (e) {
    debug(`Registry write failed for ${located.path}: ${e.message}`);
    return { ok: false, reason: "write-failed" };
  }
}

// Locates and parses the session's milestone registry KD. Shared by
// updateMilestoneRegistry and readMilestoneState so both helpers agree on the
// machine-readable `## Milestone States` YAML block as the SSOT.
// Returns { path, content, block, fenceStart, fenceEnd } or null when the
// registry file or YAML block is missing.
// Anchored fence parsing: the heading is accepted either bare
// (`^## Milestone States$`) or glued to the opening fence
// (`^## Milestone States```yaml`). In the non-glued form the opening ```yaml
// fence is accepted only when the lines between the heading and the fence are
// empty/whitespace-only — a foreign fence or embedded content there fails
// closed (null) instead of being silently skipped. The closing ``` fence must
// occur before the next `## ` heading — an embedded or late fence fails closed
// rather than mis-parsing. Failure surfaces as { ok:false, reason:"no-registry" }
// from updateMilestoneRegistry (fails closed, never wrong-advances).
function locateMilestoneRegistry(sessionID, sessionPhaseMap) {
  const generation = getCurrentGeneration(sessionPhaseMap, sessionID);
  const knowledgeDir = getKnowledgeDir();
  let files = [];
  try { files = readdirSync(knowledgeDir); } catch (_) { return null; }
  // Registry lookup is scoped to the current session only — no cross-session
  // adoption means a prior lifecycle's registry never gates a fresh session's
  // SWARM.
  const registry = files.find(f => /^milestones-/i.test(f) && matchesSessionKDForSession(f, sessionPhaseMap, sessionID, generation));
  if (!registry) return null;

  const path = join(knowledgeDir, registry);
  let content;
  try { content = readFileSync(path, "utf8"); } catch (_) { return null; }

  // [ \t]* (not \s*) keeps the match on one line: `\s` would cross the newline
  // and mis-classify the non-glued form (fence on a later line) as glued,
  // bypassing the whitespace-only-gap rule below.
  const headingMatch = content.match(/^##[ \t]*Milestone States[ \t]*(```yaml)?[ \t]*$/m);
  if (!headingMatch) return null;
  const heading = headingMatch.index;

  let fenceStart;
  if (headingMatch[1]) {
    // Glued form: the opening fence is on the heading line itself.
    fenceStart = content.indexOf("```yaml", heading);
  } else {
    // Non-glued form: the first ```yaml after the heading, accepted only when
    // the intervening lines are empty/whitespace-only.
    fenceStart = content.indexOf("```yaml", heading + headingMatch[0].length);
    if (fenceStart === -1) return null;
    const gap = content.slice(heading + headingMatch[0].length, fenceStart);
    if (!/^\s*$/.test(gap)) return null;
  }

  // Closing fence: the next ``` after the opening fence, located before the
  // next `## ` heading.
  const fenceEnd = content.indexOf("```", fenceStart + 7);
  if (fenceEnd === -1) return null;
  const afterOpening = content.slice(fenceStart + 7);
  const nextHeading = afterOpening.search(/^##[ \t]/m);
  if (nextHeading !== -1 && fenceEnd > fenceStart + 7 + nextHeading) return null;

  return { path, content, block: content.slice(fenceStart, fenceEnd), fenceStart, fenceEnd };
}

// Reads the current state of a milestone row from the registry YAML block.
// Returns the state string or null when the registry/row is missing.
function readMilestoneState(sessionID, sessionPhaseMap, milestoneId) {
  const located = locateMilestoneRegistry(sessionID, sessionPhaseMap);
  if (!located) return null;
  const rowPattern = new RegExp(`^\\s*${escapeRegExp(milestoneId)}:\\s*([A-Za-z-]+)\\s*$`, "mi");
  const rowMatch = located.block.match(rowPattern);
  return rowMatch ? rowMatch[1] : null;
}

// Finds the milestone-scoped impl KD on disk for a milestone. Evidence
// predicate (Issue 64): the FILENAME's own embedded `-gen{N}` (any N,
// including one that differs from the persisted lifecycle generation — the
// observed gen0/gen1 divergence) or the legacy `-<session>.md` suffix counts;
// the session-id match stays mandatory, so a foreign session's impl KD is
// never evidence. Staleness within the session is handled by
// supersedeMilestoneImplKDs (re-open) and cleanupLifecycleKDs (REPORT), not by
// generation-scoping here — a strict persisted-generation match would reconcile
// the registry yet still block the gate on exactly the divergence Issue 64
// must recover from. The milestone prefix match is case-insensitive. Returns
// the filename or null.
function findMilestoneImplKD(sessionID, sessionPhaseMap, milestoneId) {
  if (!milestoneId) return null;
  const knowledgeDir = getKnowledgeDir();
  let files = [];
  try { files = readdirSync(knowledgeDir); } catch (_) { return null; }
  const prefix = `impl-${milestoneId}-`;
  // Impl-KD evidence is scoped to the current session only — a prior
  // lifecycle's impl KDs (under another session id) never check off a fresh
  // session's milestone rows.
  const found = files.find(f => f.toLowerCase().startsWith(prefix.toLowerCase()) && matchesSessionKDAnyGeneration(f, sessionID));
  return found || null;
}

// Re-opening a checked-off milestone invalidates its prior completion
// evidence: the Inspector's findings mean the delivered work no longer
// passes, so the old impl KD must not re-check-off the row at the next gate
// evaluation. Filenames are the evidence SSOT, so staleness is recorded ON
// DISK by renaming the milestone's same-session impl KDs (any embedded
// generation — reconciliation accepts any N, so staleness must cover any N)
// to `*.superseded.md`, a suffix that no longer matches the session-KD
// evidence predicate. Renames survive restarts — plugins load once per
// process (MEM-059), so no in-memory epoch marker would. Best-effort: a
// failed rename leaves the file in place and is logged.
function supersedeMilestoneImplKDs(sessionID, sessionPhaseMap, milestoneId) {
  const knowledgeDir = getKnowledgeDir();
  let files = [];
  try { files = readdirSync(knowledgeDir); } catch (_) { return; }
  const prefix = `impl-${milestoneId}-`;
  for (const f of files) {
    if (!f.toLowerCase().startsWith(prefix.toLowerCase())) continue;
    if (!matchesSessionKDAnyGeneration(f, sessionID)) continue;
    try {
      renameSync(join(knowledgeDir, f), join(knowledgeDir, `${f}.superseded.md`));
      debug(`supersede: stale impl KD ${f} → ${f}.superseded.md (milestone ${milestoneId} re-opened)`);
    } catch (e) {
      debug(`supersede: rename failed for ${f}: ${e.message}`);
    }
  }
}

// Cross-checks a milestone's registry state against its impl KD on disk — the
// verifiable check-off semantics the all-checked-off gate consumes. A row is
// genuinely checked-off only when BOTH the registry row says checked-off AND
// the milestone-scoped impl KD exists on disk.
function checkMilestoneCheckedOff(sessionID, sessionPhaseMap, milestoneId) {
  const state = readMilestoneState(sessionID, sessionPhaseMap, milestoneId);
  const implKD = findMilestoneImplKD(sessionID, sessionPhaseMap, milestoneId);
  return {
    checkedOff: state === "checked-off" && implKD !== null,
    implKDOnDisk: implKD !== null,
    state,
    implKD
  };
}

// Parses the session's milestone registry rows from the machine-readable
// `## Milestone States` YAML block (the same SSOT the registry helpers use).
// Returns { rows: [{ id, state }], path, content, block, fenceStart, fenceEnd }
// or null when the registry file or YAML block is missing/unparsable.
function readMilestoneRegistry(sessionID, sessionPhaseMap) {
  const located = locateMilestoneRegistry(sessionID, sessionPhaseMap);
  if (!located) return null;
  const rows = [];
  const rowPattern = /^\s*([A-Za-z0-9_-]+):\s*([A-Za-z-]+)\s*$/gm;
  let match;
  while ((match = rowPattern.exec(located.block)) !== null) {
    rows.push({ id: match[1], state: match[2] });
  }
  return { rows, ...located };
}

// Disk-evidence reconciliation (Issue 64 / R001): before the all-checked-off
// verdict is computed, every non-checked-off row (`in-progress`, `assigned`,
// `pending`, `failed`) whose milestone-scoped impl KD exists on disk under the
// SAME session id is promoted to checked-off. Evidence matching takes the
// generation from the FILENAME (any N, including ≠ persisted generation);
// rows without evidence are never promoted and keep blocking the gate.
//
// RESTART REQUIRED (MEM-059): plugins load once per opencode process, so this
// gate-logic change — reconciliation and the loud auto-checkoff diagnostics —
// takes effect only after opencode restarts. Live behavior lags disk until
// then; operators should restart after pulling gate-logic fixes.
//
// Promotion goes through the existing strict registry writer as two audited
// steps (<stuck> → in-progress → checked-off): updateMilestoneRegistry's
// transition rules stay untouched (SPEC A1 — the reconcile path is separate).
// Single top-level readdir shared across rows (NFR004); idempotent — once all
// rows are checked-off there are no stuck rows and the scan is skipped
// entirely (NFR003). A missing/unparsable registry never reaches here (the
// caller fails closed first); reconciliation never fabricates rows.
function reconcileStuckRowsFromDiskEvidence(sessionID, sessionPhaseMap, registry) {
  const stuck = registry.rows.filter(r => r.state !== "checked-off");
  if (stuck.length === 0) return 0;
  const knowledgeDir = getKnowledgeDir();
  let files = [];
  try { files = readdirSync(knowledgeDir); } catch (_) { return 0; }
  let promoted = 0;
  for (const row of stuck) {
    const prefix = `impl-${row.id}-`;
    const evidence = files.find(f => f.toLowerCase().startsWith(prefix.toLowerCase()) && matchesSessionKDAnyGeneration(f, sessionID));
    if (!evidence) continue;
    const opened = updateMilestoneRegistry(sessionID, sessionPhaseMap, row.id, ["in-progress"]);
    if (!opened.ok) {
      loud(`AUTO_CHECKOFF_FAILED: milestone ${row.id} (reconcile ${row.state} → in-progress) — ${opened.reason}`);
      continue;
    }
    const result = updateMilestoneRegistry(sessionID, sessionPhaseMap, row.id, ["checked-off"]);
    if (!result.ok) {
      loud(`AUTO_CHECKOFF_FAILED: milestone ${row.id} (reconcile in-progress → checked-off) — ${result.reason}`);
      continue;
    }
    loud(`RECONCILE_CHECKOFF: milestone ${row.id} promoted ${row.state} → checked-off (impl KD ${evidence})`);
    promoted++;
  }
  return promoted;
}

// The all-checked-off gate — SWARM→VERIFY advances ONLY when every registry
// row is checked-off AND its milestone-scoped impl KD is on disk
// (checkMilestoneCheckedOff semantics: registry state + disk evidence).
// Fails closed on missing (REGISTRY_MISSING) and empty (REGISTRY_EMPTY)
// registries. Before the verdict is computed, evidence-backed stuck rows are
// reconciled to checked-off (reconcileStuckRowsFromDiskEvidence) and the
// registry is re-read after any promotion. Returns { ok, total, checkedOff, rows }.
function checkAllMilestonesCheckedOff(sessionID, sessionPhaseMap) {
  let registry = readMilestoneRegistry(sessionID, sessionPhaseMap);
  if (!registry) {
    debug(`REGISTRY_MISSING: no milestone registry for session ${sessionID} — SWARM cannot advance`);
    return { ok: false, total: 0, checkedOff: 0, rows: [] };
  }
  if (registry.rows.length === 0) {
    debug(`REGISTRY_EMPTY: milestone registry has no rows for session ${sessionID} — SWARM cannot advance`);
    return { ok: false, total: 0, checkedOff: 0, rows: [] };
  }
  // Reconcile evidence-backed stuck rows BEFORE computing ok (R001) — the
  // promotion writes land in the registry, so re-read it when rows changed.
  if (reconcileStuckRowsFromDiskEvidence(sessionID, sessionPhaseMap, registry) > 0) {
    registry = readMilestoneRegistry(sessionID, sessionPhaseMap);
    if (!registry) {
      debug(`REGISTRY_MISSING: milestone registry lost after reconciliation for session ${sessionID} — SWARM cannot advance`);
      return { ok: false, total: 0, checkedOff: 0, rows: [] };
    }
  }
  const rows = registry.rows.map(r => ({
    id: r.id,
    state: r.state,
    checkedOff: checkMilestoneCheckedOff(sessionID, sessionPhaseMap, r.id).checkedOff
  }));
  const checkedOff = rows.filter(r => r.checkedOff).length;
  const ok = checkedOff === rows.length;
  if (!ok) {
    const stuck = rows.filter(r => !r.checkedOff);
    debug(`SWARM gate: ${checkedOff}/${rows.length} milestones checked-off — blocked by: ${stuck.map(r => `${r.id}=${r.state}`).join(", ")}`);
  }
  return { ok, total: rows.length, checkedOff, rows };
}

// Repurposes the legacy SWARM safety force-advances. A stuck SWARM session
// never auto-advances to VERIFY — it marks stuck milestone(s) failed in the
// registry, logs SAFETY_STUCK, and stays in SWARM.
// The only escape hatch is the user's /phase override (SAFETY_ESCAPE).
// The optional milestoneId scopes the failure to ONE registry row — the
// REDISPATCH CAP path fails only the offending milestone, while the FORCE
// ADVANCE path omits it and keeps the legacy global all-rows behavior. The two
// mechanisms guard different failure modes: the cap is a milestone-level
// "genuinely attempted ≥5 times" guard; FORCE ADVANCE is the lifecycle-level
// deadlock escape. Row matching is case-insensitive to mirror registry
// semantics.
function markStuckMilestonesFailed(sessionID, sessionPhaseMap, trigger, milestoneId) {
  const registry = readMilestoneRegistry(sessionID, sessionPhaseMap);
  if (!registry) {
    debug(`SAFETY_STUCK: ${trigger} for session ${sessionID} — no registry to mark`);
    return;
  }
  const rows = milestoneId
    ? registry.rows.filter(r => r.id.toUpperCase() === String(milestoneId).toUpperCase())
    : registry.rows;
  for (const row of rows) {
    if (row.state !== "checked-off" && row.state !== "failed") {
      const result = updateMilestoneRegistry(sessionID, sessionPhaseMap, row.id, ["failed"]);
      debug(`SAFETY_STUCK: marked ${row.id} failed (${trigger}) — ${JSON.stringify(result)}`);
    }
  }
  debug(`SAFETY_STUCK: ${trigger} for session ${sessionID} — staying in SWARM (no auto-advance)`);
}

// Extracts the milestone ID from an impl KD filename per the milestone-scoped
// naming contract `impl-<milestone-id>-<name>-<session>[-gen{N}].md`. The first
// token after the `impl-` prefix is the milestone ID. Returns null for non-impl
// filenames (other KD types) and invalid input — a legacy unscoped impl KD
// yields its first name token, which never matches a registry row.
function extractMilestoneIdFromImplKD(filename) {
  if (typeof filename !== "string") return null;
  const base = filename.replace(/\\/g, "/").split("/").pop();
  if (!/^impl-/i.test(base)) return null;
  const name = base.replace(/\.md$/, "");
  const token = name.replace(/^impl-/i, "").split("-")[0];
  return token || null;
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

// Reads the `verdict` field from a KD file's YAML frontmatter — the machine
// source for the verdict-aware VERIFY gate. Only the first frontmatter block
// (between the leading `---` and the next `---` line) is inspected; a body
// Verdict section is human-readable and never read. Returns "PASS", "FAIL", or
// "FUNDAMENTAL", or null when the field is absent or its value is not one of
// the three valid verdicts (missing/invalid blocks advancement — the MISSING
// rule in evaluateVerifyVerdict, never treated as PASS).
function readVerdictFrontmatter(filePath) {
  try {
    const content = readFileSync(filePath, "utf8");
    const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!frontmatter) return null;
    const verdictMatch = frontmatter[1].match(/^verdict\s*:\s*([A-Za-z]+)\s*$/m);
    if (!verdictMatch) return null;
    const verdict = verdictMatch[1].toUpperCase();
    return ["PASS", "FAIL", "FUNDAMENTAL"].includes(verdict) ? verdict : null;
  } catch (_) {
    return null;
  }
}

// Finds the newest review KD among the session's KDs. "Newest" is
// deterministic: greatest file mtime, tie-break by greatest filename. Returns
// { filename, verdict } (verdict read from the newest KD's frontmatter) or
// null when no review KD exists — the caller then falls back to the
// presence-based result (false). Legacy audit- KDs are inert: the merged
// review+audit surface reads verdicts from review- only.
function findNewestVerdictKD(sessionFiles) {
  const reviewFiles = sessionFiles.filter(f => /^review-/i.test(f));
  if (reviewFiles.length === 0) return null;
  const knowledgeDir = getKnowledgeDir();
  reviewFiles.sort((a, b) => {
    let mtimeDiff = 0;
    try { mtimeDiff = statSync(join(knowledgeDir, b)).mtimeMs - statSync(join(knowledgeDir, a)).mtimeMs; } catch (_) {}
    if (mtimeDiff !== 0) return mtimeDiff;
    return b > a ? 1 : b < a ? -1 : 0;
  });
  const filename = reviewFiles[0];
  return { filename, verdict: readVerdictFrontmatter(join(knowledgeDir, filename)) };
}

// Re-derives the evidence KD for a phase's disk-advancement pattern.
// checkDiskAdvancement returns boolean only, so the RESTART_CATCH_UP
// diagnostic re-derives the newest session-scoped, generation-scoped KD that
// would have driven the advance. Returns the filename or null when none is
// determinable (diagnostic skipped). Single readdir + bounded stat
// (getFileMtimeMs); consumed only by the log-only diagnostic, never by the
// advancement gate itself.
function findNewestEvidenceKD(sessionPhaseMap, sessionID, phase) {
  if (phase === undefined || phase === STATES.PROTOCOL_NOT_LOADED || phase === STATES.REPORT) return null;
  const patterns = {
    [STATES.INTENT]: /^intent-/i,
    [STATES.PREFLIGHT]: /^preflight-/i,
    [STATES.EXPLORE]: /^exploration-/i,
    [STATES.INVESTIGATE]: /^analysis-/i,
    [STATES.ALIGN]: /^spec-/i,
    [STATES.DECOMPOSE]: /^plan-|^milestones-/i,
    [STATES.SWARM]: /^impl-/i,
    [STATES.VERIFY]: /^review-/i,
    [STATES.EXTRACT]: /^composed-/i,
    [STATES.EVOLVE]: /^process-/i,
    [STATES.CLEANUP]: /^cleanup-/i
  };
  const pattern = patterns[phase];
  if (!pattern) return null;
  const knowledgeDir = getKnowledgeDir();
  let files = [];
  try { files = readdirSync(knowledgeDir); } catch (_) { return null; }
  const generation = getCurrentGeneration(sessionPhaseMap, sessionID);
  const matches = files.filter(f => matchesSessionKDForSession(f, sessionPhaseMap, sessionID, generation) && pattern.test(f));
  if (matches.length === 0) return null;
  let newest = matches[0];
  let newestMtime = getFileMtimeMs(join(knowledgeDir, newest));
  for (const f of matches.slice(1)) {
    const m = getFileMtimeMs(join(knowledgeDir, f));
    if (m > newestMtime) { newest = f; newestMtime = m; }
  }
  return newest;
}

// On a FAIL auto-regression the milestone rows CITED by the review KD re-open
// to in-progress, so the all-checked-off gate cannot re-advance SWARM→VERIFY
// before fresh impl KDs land. Scoped reopen (R012): citedMilestoneIds are the
// registry-resolvable milestone tokens parsed from the review KD's Findings
// section — the intersection with registry row ids reopens exactly; unrelated
// checked-off rows are untouched. Idempotent for rows already in-progress; a
// missing/empty registry is a no-op and the SWARM gate fails closed on
// REGISTRY_EMPTY/MISSING. updateMilestoneRegistry's reopen semantics preserve
// the registry row's own casing.
function reopenCheckedOffMilestones(sessionID, sessionPhaseMap, citedMilestoneIds) {
  const registry = readMilestoneRegistry(sessionID, sessionPhaseMap);
  if (!registry) {
    debug(`reopen: no milestone registry for session ${sessionID} — nothing to reopen`);
    return;
  }
  const cited = new Set((citedMilestoneIds || []).map(id => String(id).toUpperCase()));
  for (const row of registry.rows) {
    if (row.state === "checked-off" && cited.has(String(row.id).toUpperCase())) {
      const result = updateMilestoneRegistry(sessionID, sessionPhaseMap, row.id, ["in-progress"], { reopen: true });
      debug(`reopen: milestone ${row.id} checked-off → in-progress (${JSON.stringify(result)})`);
    }
  }
}

// Parses milestone tokens from a review KD's Findings section — the provenance
// for scoped reopen (R012): `impl-<milestone-id>-` path tokens and bare
// `M\d+` milestone ids. Tokens are deduplicated and case-preserved; a KD with
// no Findings section yields zero citations (fail-closed for the malformed-FAIL
// rule). The heading regex accepts both the template-conformant
// `## Review Findings` header (skills/template-review/SKILL.md, inspector.md)
// and the legacy `## Findings` header — a template-conformant FAIL review KD
// must parse or the OQ-4 FAIL contract is machine-inert (regression guard).
function extractMilestoneCitationsFromReviewKD(content) {
  if (typeof content !== "string") return [];
  const headingMatch = content.match(/^## (?:Review )?Findings[^\n]*\n?/m);
  if (!headingMatch) return [];
  // Search the next `## ` heading AFTER the Findings heading itself — starting
  // from the heading line would match the heading at index 0 and yield an
  // empty section.
  const rest = content.slice(headingMatch.index + headingMatch[0].length);
  const nextHeading = rest.search(/^## /m);
  const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading);
  const tokens = new Set();
  // Split the Findings section into `### ` subsections so the Traceability
  // Matrix can be excluded: the merged template places the matrix inside the
  // Review Findings section, and a bare milestone token in a PASS-row matrix
  // cell is provenance, not a FAIL citation — scanning it would reopen that
  // row on a FAIL verdict. The matrix block is identified by its own header,
  // so excluding it never drops tokens from real FAIL findings (which live in
  // `### F\d+` subsections or raw body text).
  for (const sub of section.split(/^### /m)) {
    if (/^Traceability Matrix/i.test(sub)) continue;
    let m;
    const implPattern = /impl-([A-Za-z0-9_-]+)-/gi;
    while ((m = implPattern.exec(sub)) !== null) tokens.add(m[1]);
    const idPattern = /\bM\d+\b/g;
    while ((m = idPattern.exec(sub)) !== null) tokens.add(m[0]);
  }
  return [...tokens];
}

// Filters cited milestone tokens down to the registry's row ids
// (case-insensitive) — tokens not in the registry are dropped so only real
// milestones can reopen. A missing registry yields an empty list.
function registryResolvableMilestones(sessionID, sessionPhaseMap, citedMilestoneIds) {
  const registry = readMilestoneRegistry(sessionID, sessionPhaseMap);
  if (!registry || !Array.isArray(citedMilestoneIds)) return [];
  return citedMilestoneIds.filter(id => registry.rows.some(r => String(r.id).toUpperCase() === String(id).toUpperCase()));
}

// Newest session-scoped impl KD mtime — the freshness baseline for the
// fresh-PASS-after-fix and fix-cycle-tied regression rules. -Infinity when no
// impl KD exists (no fix cycle has ever landed, so freshness is trivially met).
function newestImplMtimeMs(sessionFiles) {
  const implFiles = sessionFiles.filter(f => /^impl-/i.test(f));
  if (implFiles.length === 0) return -Infinity;
  const knowledgeDir = getKnowledgeDir();
  let newest = -Infinity;
  for (const f of implFiles) {
    const m = getFileMtimeMs(join(knowledgeDir, f));
    if (m > newest) newest = m;
  }
  return newest;
}

// Reads a review KD's full content for citation parsing. Returns "" on read
// failure — the malformed-FAIL rule then fails closed (zero citations).
function readReviewKdContent(filename) {
  try {
    return readFileSync(join(getKnowledgeDir(), filename), "utf8");
  } catch (_) {
    return "";
  }
}

// FAIL-verdict auto-regression. Regresses VERIFY→SWARM via the existing
// backward-transition path — no `BACKWARD: true` flag and no explicit dispatch
// — then re-opens the cited checked-off milestone rows. The fix-cycle-tied
// guard records { kdFilename, regressedAt } per session: an absent guard or a
// different kdFilename always regresses (a NEW FAIL KD); the same KD regresses
// again only when a fix cycle landed after regressedAt (newest impl-* KD mtime
// > regressedAt). The cycle cap in backwardTransition bounds repeated fix
// cycles. Returns true when a regression fired, false when the same KD has no
// new fix cycle.
function regressVerifyOnFail(sessionID, kdFilename, sessionFiles, sessionPhaseMap, citedMilestoneIds, verdictRegressedKDs, backwardTransition) {
  const guard = verdictRegressedKDs.get(sessionID);
  // Monotonic regressedAt: two regressions may land in the same millisecond
  // (fast local writes), but the fix-cycle guard needs the second regression's
  // timestamp to be strictly greater — bump by 1ms when Date.now() ties.
  const now = Math.max(Date.now(), (guard && typeof guard.regressedAt === "number" ? guard.regressedAt + 1 : 0));
  if (guard && guard.kdFilename === kdFilename) {
    const newestImpl = newestImplMtimeMs(sessionFiles);
    if (!(newestImpl > guard.regressedAt)) {
      debug(`FAIL current, no new fix cycle — same KD ${kdFilename} blocked (regressedAt=${guard.regressedAt}, newest impl mtime=${newestImpl})`);
      return false;
    }
  }
  verdictRegressedKDs.set(sessionID, { kdFilename, regressedAt: now });
  debug(`VERDICT_FAIL: KD ${kdFilename} verdict=FAIL — auto-regressing VERIFY→SWARM (no BACKWARD flag)`);
  backwardTransition(sessionID, STATES.VERIFY, STATES.SWARM);
  reopenCheckedOffMilestones(sessionID, sessionPhaseMap, citedMilestoneIds);
  return true;
}

// Module-level verdict-aware VERIFY gate body. checkDiskAdvancement delegates
// the VERIFY verdict here; f1Options carries the server-local regression
// dependencies ({ verdictRegressedKDs, backwardTransition }) so direct unit-test
// calls without a handler stay blocked-but-safe (no regression side effect).
function evaluateVerifyVerdict(sessionID, sessionFiles, sessionPhaseMap, f1Options) {
  const hasReview = sessionFiles.some(f => /^review-/i.test(f));
  const verdictInfo = findNewestVerdictKD(sessionFiles);
  if (verdictInfo && verdictInfo.verdict === "FAIL") {
    // OQ-4 malformed-FAIL rule: a FAIL review must cite at least one
    // registry-resolvable milestone token in its Findings section, or it is
    // malformed — blocked with NO regression and NO reopen. A citation-less
    // FAIL never enters the state machine (no regress, and forward advance is
    // impossible while the newest verdict is FAIL), so it cannot deadlock.
    const resolvable = registryResolvableMilestones(sessionID, sessionPhaseMap, extractMilestoneCitationsFromReviewKD(readReviewKdContent(verdictInfo.filename)));
    if (resolvable.length === 0) {
      debug(`MALFORMED_FAIL: FAIL review KD ${verdictInfo.filename} carries no registry-resolvable milestone citations — blocked, no regression, no reopen`);
      return false;
    }
    let regressed = false;
    if (f1Options && f1Options.verdictRegressedKDs && typeof f1Options.backwardTransition === "function") {
      regressed = regressVerifyOnFail(sessionID, verdictInfo.filename, sessionFiles, sessionPhaseMap, resolvable, f1Options.verdictRegressedKDs, f1Options.backwardTransition);
    }
    debug(`Disk check VERIFY: newest KD ${verdictInfo.filename} verdict=FAIL → ${regressed ? "regressed to SWARM" : "blocked (fix-cycle guard or no regression handler)"}`);
    return false;
  }
  if (verdictInfo && verdictInfo.verdict === "FUNDAMENTAL") {
    const escalation = `FUNDAMENTAL_ESCALATION: review KD ${verdictInfo.filename} carries verdict FUNDAMENTAL — VERIFY advancement blocked; escalate to user (Happy to Delete) or override with /phase`;
    debug(escalation);
    process.stderr.write(`[protocol-gate] ${escalation}\n`);
    debug(`Disk check VERIFY: blocked by FUNDAMENTAL verdict on ${verdictInfo.filename}`);
    return false;
  }
  if (!verdictInfo || !verdictInfo.verdict) {
    // MISSING: an absent/invalid verdict field blocks advancement — the
    // Inspector must emit a real verdict. Never treated as PASS.
    debug(`VERDICT_MISSING: newest review KD ${verdictInfo ? verdictInfo.filename : "(none)"} lacks a valid verdict field — advancement blocked`);
    return false;
  }
  // Fresh-PASS-after-fix (R010): a PASS verdict advances only when it is at
  // least as new as the newest impl-* KD. A fix cycle that landed after the
  // review (newer impl KD) makes the PASS stale — a fresh review is required
  // before EXTRACT starts. No impl KD ⇒ no fix cycle ⇒ trivially fresh.
  const verdictMtime = getFileMtimeMs(join(getKnowledgeDir(), verdictInfo.filename));
  const newestImpl = newestImplMtimeMs(sessionFiles);
  if (newestImpl > verdictMtime) {
    debug(`STALE_PASS: verdict KD ${verdictInfo.filename} mtime=${verdictMtime} < newest impl KD mtime=${newestImpl} — fresh review required after last fix`);
    return false;
  }
  // The merged review+audit surface advances on a single review KD (R010).
  // The regression side stays OR (checkPhaseStateConsistency) so a single-KD
  // VERIFY holds instead of directly regressing to SWARM — otherwise the
  // unbounded VERIFY⇄SWARM loop returns.
  const result = hasReview;
  debug(`Disk check VERIFY: review=${hasReview} → ${result}`);
  return result;
}

// Reads the active override marker for a session — null when absent or
// malformed. The marker is authoritative only while the current phase equals
// its target.
function getOverrideUntil(sessionPhaseMap, sessionID) {
  const overrideUntil = sessionPhaseMap.get(`${sessionID}:overrideUntil`);
  if (!overrideUntil || typeof overrideUntil.phase !== "number" || typeof overrideUntil.since !== "number") return null;
  return overrideUntil;
}

// Bounded stat — returns the file's mtimeMs or -1 on failure. Only candidate
// files that already match the phase prefix are stat'd, so the override
// freshness check stays within the bounded-work budget (single readdir +
// bounded stat, no per-file glob).
function getFileMtimeMs(fullPath) {
  try {
    return statSync(fullPath).mtimeMs;
  } catch (_) {
    return -1;
  }
}

function checkDiskAdvancement(sessionID, phase, sessionPhaseMap, swarmDispatchCount, f1Options) {
  if (phase === undefined) return false;

  // Session ID is required to filter out stale KDs from prior sessions.
  // KD filenames embed the session ID (e.g. intent-foo-ses_abc123.md).
  // Without this, a plan KD from a different session instantly advances PREFLIGHT.
  const storedSID = sessionPhaseMap.get(`${sessionID}:sid`);
  if (!storedSID) {
    debug(`Disk check: no session ID set for ${sessionID} — skipping`);
    return false;
  }

  // Knowledge directory is project-relative by default (cwd), overridable via
  // PROTOCOL_GATE_KNOWLEDGE_DIR seam. PLUGIN_DIR stays for log paths
  // which ARE relative to plugin location.
  const knowledgeDir = getKnowledgeDir();
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
  // Generation scoping: files from a prior lifecycle carry a
  // different `-genN-` suffix and must not advance the new lifecycle.
  // Generation defaults to 0 when the state was never loaded or the
  // file carried no generation field — session-ID-only matching is the fallback.
  // Reads scan the current session's KDs only — cross-session
  // adoption is removed, so a fresh session can never advance off another
  // lifecycle's KDs. lookupSIDs stays single-session (diagnostic only).
  const generation = getCurrentGeneration(sessionPhaseMap, sessionID);
  const lookupSIDs = getKDLookupSIDs(sessionPhaseMap, sessionID);
  const sessionFiles = [];
  for (const f of files) {
    if (matchesSessionKDForSession(f, sessionPhaseMap, sessionID, generation)) {
      sessionFiles.push(f);
    } else if (lookupSIDs.some(sid => f.endsWith(`-${sid}.md`) || f.includes(`-${sid}-gen`))) {
      // Same session but different generation — stale prior-lifecycle KD.
      // Log the skip so generation mismatches are diagnosable.
      const fileGenMatch = f.match(/-gen(\d+)\.md$/);
      const fileGen = fileGenMatch ? parseInt(fileGenMatch[1], 10) : 0;
      debug(`Skipped KD ${f}: generation mismatch (file=${fileGen}, current=${generation})`);
    }
  }

  // DECOMPOSE has no single-prefix pattern — its dual-KD gate is handled below.
  // PREFLIGHT advances when a `preflight-` KD is written by the Committer.
  // The session-ID filter prevents stale KDs from prior sessions from triggering advancement.
  const patterns = {
    [STATES.INTENT]: /^intent-/i,
    [STATES.PREFLIGHT]: /^preflight-/i,
    [STATES.EXPLORE]: /^exploration-/i,
    [STATES.INVESTIGATE]: /^analysis-/i,
    [STATES.ALIGN]: /^spec-/i,
    [STATES.SWARM]: /^impl-/i,
    [STATES.VERIFY]: /^review-/i,
    [STATES.EXTRACT]: /^composed-/i,
    [STATES.EVOLVE]: /^process-/i,
    [STATES.CLEANUP]: /^cleanup-/i
  };

  const pattern = patterns[phase];

  // While the override is active at this phase, only fresh evidence
  // (KD mtime >= since) advances — pre-existing/stale KDs never undo the
  // manual override (interface contract #5). KDs written before `since` are
  // skipped; the marker clears on advance-away, restoring normal
  // advancement semantics for later phases.
  const overrideUntil = getOverrideUntil(sessionPhaseMap, sessionID);
  const overrideActive = overrideUntil && phase === overrideUntil.phase;

  // DECOMPOSE advancement requires BOTH the plan KD and the milestone registry
  // (dual-KD gate). The Pathfinder produces both at DECOMPOSE; SWARM must not
  // start until the registry (live state SSOT) is on disk. A plan- KD alone is
  // the fail-closed case — no advancement. Under an override at DECOMPOSE,
  // both KDs must be fresh (mtime >= since, contract #5).
  if (phase === STATES.DECOMPOSE) {
    const hasPlan = sessionFiles.some(f => /^plan-/i.test(f) && (!overrideActive || getFileMtimeMs(join(knowledgeDir, f)) >= overrideUntil.since));
    const hasMilestones = sessionFiles.some(f => /^milestones-/i.test(f) && (!overrideActive || getFileMtimeMs(join(knowledgeDir, f)) >= overrideUntil.since));
    const result = hasPlan && hasMilestones;
    debug(`Disk check DECOMPOSE: plan=${hasPlan}, milestones=${hasMilestones} → ${result}${overrideActive ? ` (override fresh-evidence since ${overrideUntil.since})` : ""}`);
    return result;
  }

  if (!pattern) return false;

  // The verdict-aware VERIFY gate — see evaluateVerifyVerdict.
  // The newest review KD's frontmatter verdict decides advancement; only
  // the newest KD's frontmatter is read. Under an override at VERIFY,
  // the newest review KD's mtime is the evidence timestamp — a stale
  // verdict KD never re-advances VERIFY (contract #5).
  if (phase === STATES.VERIFY) {
    if (overrideActive) {
      const verdictInfo = findNewestVerdictKD(sessionFiles);
      if (!verdictInfo) {
        debug(`Disk check VERIFY: no review KD — cannot advance under override (since=${overrideUntil.since})`);
        return false;
      }
      const mtime = getFileMtimeMs(join(knowledgeDir, verdictInfo.filename));
      if (mtime < overrideUntil.since) {
        debug(`Disk check VERIFY: newest KD ${verdictInfo.filename} mtime=${mtime} < since=${overrideUntil.since} — not fresh (override)`);
        return false;
      }
      debug(`Disk check VERIFY: newest KD ${verdictInfo.filename} is fresh (mtime=${mtime} >= since=${overrideUntil.since}) — evaluating verdict`);
      return evaluateVerifyVerdict(sessionID, sessionFiles, sessionPhaseMap, f1Options);
    }
    return evaluateVerifyVerdict(sessionID, sessionFiles, sessionPhaseMap, f1Options);
  }

  // SWARM advancement requires ALL registry milestones to be
  // checked-off with their impl KDs on disk (checkAllMilestonesCheckedOff).
  // The milestone registry is the live state SSOT — the legacy dispatch-count
  // gate (MILESTONE_COUNT, swarmDispatchCount) has no gating effect. Fails
  // closed on missing/empty/unparsable registries (REGISTRY_MISSING/EMPTY).
  // Under an override at SWARM, the milestone registry file's mtime is the
  // evidence timestamp — a stale registry never re-advances SWARM (contract #5).
  if (phase === STATES.SWARM) {
    const gate = checkAllMilestonesCheckedOff(sessionID, sessionPhaseMap);
    let result = gate.ok;
    let overrideNote = "";
    if (result && overrideActive) {
      const registry = readMilestoneRegistry(sessionID, sessionPhaseMap);
      const registryMtime = registry ? getFileMtimeMs(registry.path) : -1;
      result = registryMtime >= overrideUntil.since;
      overrideNote = `, override fresh-evidence: registry mtime=${registryMtime} >= since=${overrideUntil.since} → ${result}`;
    }
    debug(`Disk check SWARM: all-checked-off gate → ${gate.ok} (${gate.checkedOff}/${gate.total})${overrideNote}`);
    return result;
  }

  let result;
  if (overrideActive) {
    // The INTENT override target advances on PRESENCE of the intent
    // KD — the KD IS the phase deliverable, so its write-time relative to
    // `since` is irrelevant to whether intent work is done. This is the only
    // freshness exemption; all other override targets (and the DECOMPOSE /
    // VERIFY / SWARM special cases above) keep fresh-evidence semantics.
    const freshnessRequired = phase !== STATES.INTENT;
    result = sessionFiles.some(f => pattern.test(f) && (!freshnessRequired || getFileMtimeMs(join(knowledgeDir, f)) >= overrideUntil.since));
    debug(`Disk check ${getPhaseName(phase)}: override ${freshnessRequired ? "fresh-evidence" : "presence"} (since=${overrideUntil.since}) → ${result}`);
  } else {
    result = sessionFiles.some(f => pattern.test(f));
    debug(`Disk check ${getPhaseName(phase)}: pattern=${pattern}, sessionID=${sessionID}, lookupSIDs=${JSON.stringify(lookupSIDs)} → ${result}`);
  }
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

  const knowledgeDir = getKnowledgeDir();
  let files = [];
  try { files = readdirSync(knowledgeDir); } catch (_) { return false; }

  // Generation-scoped: stale gen-N KDs from a prior lifecycle must not
  // suppress legitimate phase regression in the current lifecycle.
  // The scan covers the current session's KDs only — a fresh
  // session is never held up or regressed by another lifecycle's KDs.
  const generation = getCurrentGeneration(sessionPhaseMap, sessionID);
  const sessionFiles = files.filter(f => matchesSessionKDForSession(f, sessionPhaseMap, sessionID, generation));

  const patterns = {
    [STATES.INTENT]: /^intent-/i,
    [STATES.PREFLIGHT]: /^preflight-/i,
    [STATES.EXPLORE]: /^exploration-/i,
    [STATES.INVESTIGATE]: /^analysis-/i,
    [STATES.ALIGN]: /^spec-/i,
    [STATES.DECOMPOSE]: /^plan-/i,
    [STATES.SWARM]: /^impl-/i,
    [STATES.VERIFY]: /^review-/i,
    [STATES.EXTRACT]: /^composed-/i,
    [STATES.EVOLVE]: /^process-/i,
    [STATES.CLEANUP]: /^cleanup-/i
  };

  const currentPattern = patterns[currentPhase];
  if (!currentPattern) return false;

  // While the override is active at the target phase, the override is
  // authoritative — a missing KD for the overridden phase is logged but never
  // regresses the phase. The marker clears on advance-away, backward
  // transition, new /phase, or REPORT reset, after which normal regression
  // resumes.
  const overrideUntil = sessionPhaseMap.get(`${sessionID}:overrideUntil`);
  if (overrideUntil && currentPhase === overrideUntil.phase) {
    debug(`Consistency check: skipped — /phase override pins ${getPhaseName(currentPhase)} (since=${overrideUntil.since}) for session ${sessionID}`);
    return false;
  }

  // Skip regression when a subagent dispatch is in-flight for this phase.
  // The KD is pending creation, not deleted — false regression would loop.
  // inFlightDispatches stores an array of prefixes (e.g., ["review"] for VERIFY).
  const inFlightPrefixes = inFlightDispatches?.get(sessionID);
  if (inFlightPrefixes && Array.isArray(inFlightPrefixes) && inFlightPrefixes.some(p => currentPattern.test(`${p}-`))) {
    debug(`Consistency check: skipped — in-flight dispatch for ${getPhaseName(currentPhase)} KD (prefixes=${JSON.stringify(inFlightPrefixes)})`);
    return false;
  }

  // Grace period for fresh phase advancement.
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
    // VERIFY regression-side OR: a single review KD keeps VERIFY
    // "phase is fine". MUST stay OR — an AND here would regress a single-KD
    // VERIFY directly to SWARM via the set() below (bypassing the backward
    // cycle cap), reintroducing the unbounded VERIFY⇄SWARM loop.
    // Advancement is gated separately in evaluateVerifyVerdict.
    if (hasReview) return false; // current phase is fine
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
      // VERIFY backward-walk OR: a surviving single review KD
      // anchors VERIFY during the backward walk. MUST stay OR — aligning it to
      // AND would let a missing second KD regress VERIFY directly to SWARM via
      // the set() below (bypassing handleBackwardTransition and the cycle cap),
      // reintroducing the unbounded loop.
      if (hasReview) {
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

  // INTENT with a missing intent KD and no earlier-phase KD falls
  // through to the general no-regression rule below. The old special case
  // regressed INTENT → PROTOCOL_NOT_LOADED on the first non-creating disk-check
  // call after a restart, stalling the intent KD write. A missing intent
  // KD is recovered by rewriting it in INTENT (write allowed by the allowlist);
  // checkDiskAdvancement still returns false, so nothing advances.

  if (!foundEarlierKD) return false; // no regression — phase set directly, not via lifecycle

  debug(`Consistency regression: ${getPhaseName(currentPhase)} → ${getPhaseName(regressedPhase)}`);
  sessionPhaseMap.set(sessionID, regressedPhase);

  // Counters persist across regressions — safety mechanisms (force-advance,
  // re-dispatch cap) must remain effective. Only clear swarmDispatchCount when
  // regressing past SWARM, as that is phase-dependent cleanup, not counter reset.
  // Clear dispatch count if regressing past SWARM phase
  if (regressedPhase < STATES.SWARM) {
    swarmDispatchCount.delete(sessionID);
  }

  // Persist regressed phase
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
    // Per-session record of the LAST charged dispatch, set at
    // the :2475 increment site so the tool.execute.after hook can restore the
    // redispatch budget when a dispatch produces no expected RESULT KD
    // (empty-result detection). One entry per session — a re-dispatch
    // overwrites the previous record; the entry is deleted after reconciliation.
    const lastTaskDispatch = new Map();
    // Tracks active subagent dispatches per session.
    // When a task call dispatches the current phase's expected agent, the
    // expected KD prefix is stored here. checkPhaseStateConsistency skips
    // regression when an in-flight dispatch exists — the KD is pending, not deleted.
    const inFlightDispatches = new Map();
    // Event-driven phase advancement verification.
    // When a task dispatch or write triggers a phase advancement, pendingVerification
    // is set. While active, checkPhaseStateConsistency is skipped (preventing false
    // regression) and diskCheckFailures is not incremented (preventing premature stuck
    // detection). Cleared when KD appears on disk, session ends, or safety timeout fires.
    // Replaces the time-based REGRESSION_COOLDOWN_MS mechanism.
    const pendingVerification = new Map();
    // Tracks tool calls made while pendingVerification is active per session.
    // Used by the safety timeout: warning at 10, force-advance at 15.
    const pendingVerificationToolCount = new Map();
    // Fresh advancement tracking — records when a phase was just advanced via
    // disk check. Used by checkPhaseStateConsistency to grant a grace period before
    // allowing regression. Prevents false regression when SWARM→VERIFY advancement
    // occurs and VERIFY's KD hasn't been produced yet.
    // In-memory only — not persisted to .state files.
    const freshAdvancement = new Map(); // sessionID → {phase, diskCheckCount}
    // Track agent type for ALL sessions (including subagents) to enforce
    // checkpoint KD restrictions. Populated in chatParams for every session.
    const sessionAgentMap = new Map();
    // Fix-cycle-tied FAIL regression guard — per-session
    // { kdFilename, regressedAt } for the review KD that fired a FAIL
    // auto-regression. Re-evaluating the same KD regresses again only when a
    // new fix cycle landed after regressedAt (newest impl-* KD mtime >);
    // without one it blocks (no infinite FAIL→SWARM→VERIFY loop); a NEW FAIL KD
    // always regresses. In-memory only (like freshAdvancement) — the cap is
    // re-established from disk on restart via the cycle counter semantics.
    const verdictRegressedKDs = new Map(); // sessionID → { kdFilename, regressedAt }
    // One-shot phase-transition announcements — sessionID →
    // { from, to, reason }. Set at the disk-advancement site when the phase
    // increments; consumed+deleted in the first systemTransform that runs after
    // advancement. In-memory only — a restart loses it, which is correct (the
    // event is in the past; the durable log line remains the record).
    const advancementAnnouncements = new Map();
    // In-memory verbatim raw-intent capture — sessionID →
    // Array<{messageID, text}>. Populated by the chat.message hook (fires on
    // message receipt, before any LLM call) for overseer messages only;
    // consumed by the INTENT-phase systemTransform injection. Read-only
    // with respect to KDs: it never auto-writes the intent KD — the
    // Overseer remains the KD author. In-memory only — restart durability is
    // out of scope (state-persistence lifecycle), a restart leaves it empty
    // and the injection is omitted gracefully.
    const rawIntentCapture = new Map();
    // tool.definition doesn't receive sessionID — track the most recent session
    // so it knows which phase to enforce. Updated in chat.params and tool.execute.before.
    let lastSeenSession = null;

    // --- State persistence (file-backed SSOT) ---
    // The .state file is the single source of truth for phase. The
    // in-memory sessionPhaseMap is a cache reconciled against the file on every
    // overseer message; every transition persists before it is considered
    // complete; a restart restores from the file; a fresh session
    // with no own state file starts at PROTOCOL_NOT_LOADED — no cross-session
    // adoption — and the active-session pointer is deleted at lifecycle
    // end and never re-created for a finished session.
    function getStatePath(sessionID) {
      const safe = sanitizeSessionID(sessionID);
      if (!safe) return null;
      return join(getStateDir(), `.protocol-state-${safe}.json`);
    }

    function saveState(sessionID) {
      const statePath = getStatePath(sessionID);
      if (!statePath) {
        debug(`saveState: unsafe session ID rejected: ${JSON.stringify(sessionID)}`);
        process.stderr.write(`[protocol-gate] saveState: unsafe session ID rejected\n`);
        return false;
      }
      // The phase entry is deleted at lifecycle end (REPORT reset).
      // Persist that state as phase 0 — the next reconcile restores
      // PROTOCOL_NOT_LOADED and honors any manual edit of this file.
      const phase = sessionPhaseMap.get(sessionID) ?? STATES.PROTOCOL_NOT_LOADED;
      const sid = sessionPhaseMap.get(`${sessionID}:sid`);
      try {
        // generation persists across lifecycle resets via the :gen map entry.
        // Written even at phase 0 so the counter survives restarts between
        // lifecycles. Returns boolean so callers can enforce the atomicity
        // contract: revert in-memory :gen when save fails.
        const generation = sessionPhaseMap.get(`${sessionID}:gen`) || 0;
        // Omit sid from state JSON when it's null/undefined (deleted after REPORT).
        // Previously, sid: null was serialized, causing loadState to skip phase restoration
        // and producing artifacts in the state file.
        const state = { phase, generation, timestamp: Date.now() };
        if (sid) state.sid = sid;
        // Serialize the /phase override marker so it survives a
        // mid-session restart. Omitted when absent — legacy state
        // files without overrideUntil load unchanged.
        const overrideUntil = sessionPhaseMap.get(`${sessionID}:overrideUntil`);
        if (overrideUntil && typeof overrideUntil.phase === "number" && typeof overrideUntil.since === "number") {
          state.overrideUntil = { phase: overrideUntil.phase, since: overrideUntil.since };
        }
        const stateDir = getStateDir();
        mkdirSync(stateDir, { recursive: true });
        // Atomic durable write — tmp file + fsync + rename. A
        // failure (disk full, permissions) surfaces to the caller as false +
        // stderr so the in-memory phase never silently diverges from disk.
        atomicWriteFileSync(statePath, JSON.stringify(state));
        // The workspace-level pointer is only written while the
        // lifecycle is ACTIVE (phase entry present). At lifecycle end (REPORT
        // reset) the phase entry is deleted, so saveState must NOT re-create
        // `.active-session.json` pointing at the finished session — the
        // finished lifecycle is never a resume target (the pointer is inert
        // for fresh sessions; it is deleted at REPORT).
        if (sessionPhaseMap.has(sessionID)) {
          if (!writeActiveSession(sessionID)) {
            debug(`saveState: state persisted but active-session pointer update failed for ${sessionID}`);
          }
        } else {
          debug(`saveState: phase entry absent for ${sessionID} — active-session pointer not updated (finished lifecycle)`);
        }
        return true;
      } catch (e) {
        debug(`saveState error: ${e.message}`);
        process.stderr.write(`[protocol-gate] saveState error for session ${sessionID}: ${e.message}\n`);
        return false;
      }
    }

    // Reads + parses the session's state file. Returns the parsed state object,
    // "missing" when no file exists, or "corrupt" when the file exists but
    // cannot be parsed. On corruption the original file is preserved via a
    // backup rename — never silently clobbered with phase 0.
    function readStateFile(sessionID) {
      const statePath = getStatePath(sessionID);
      if (!statePath) return "missing"; // unsafe session ID — nothing to read
      try {
        return JSON.parse(readFileSync(statePath, "utf8"));
      } catch (e) {
        if (e.code === "ENOENT") return "missing";
        try {
          const backupPath = join(getStateDir(), `.protocol-state-${sanitizeSessionID(sessionID)}.corrupt-${Date.now()}.json`);
          renameSync(statePath, backupPath);
          debug(`loadState: corrupt state file backed up to ${backupPath} (${e.message})`);
          process.stderr.write(`[protocol-gate] Corrupt state file for session ${sessionID} — backed up to ${basename(backupPath)}; initializing PROTOCOL_NOT_LOADED\n`);
        } catch (be) {
          debug(`loadState: failed to back up corrupt state file for ${sessionID}: ${be.message}`);
        }
        return "corrupt";
      }
    }

    // Spec contract: returns the parsed {phase, generation, sid} object or null
    // when no valid file exists. reconcileSessionState drives the map mutation;
    // this keeps the documented loadState contract testable.
    function loadState(sessionID) {
      const state = readStateFile(sessionID);
      return state === "missing" || state === "corrupt" || state === null ? null : state;
    }

    // --- Active-session pointer ---
    // Workspace-level file recording the most recently active lifecycle.
    // It is INERT for fresh sessions — a session with no own state
    // file never adopts from it. It is deleted at lifecycle end and is
    // never re-created for a finished session; it exists only as an audit
    // marker for the currently active lifecycle.
    function getActiveSessionPath() {
      return join(getStateDir(), ".active-session.json");
    }

    function readActiveSession() {
      try {
        const data = JSON.parse(readFileSync(getActiveSessionPath(), "utf8"));
        if (data && typeof data.sessionID === "string" && data.sessionID.length > 0) {
          return data;
        }
      } catch (_) {}
      return null;
    }

    function writeActiveSession(sessionID) {
      const safe = sanitizeSessionID(sessionID);
      if (!safe) return false;
      try {
        mkdirSync(getStateDir(), { recursive: true });
        atomicWriteFileSync(getActiveSessionPath(), JSON.stringify({ sessionID: safe, lastUpdated: new Date().toISOString() }));
        return true;
      } catch (e) {
        debug(`writeActiveSession error: ${e.message}`);
        return false;
      }
    }

    // Deletes the workspace-level active-session pointer at
    // lifecycle end — a finished lifecycle must never be a resume target. The
    // REPORT reset handlers call this before saveState; saveState itself never
    // re-creates the pointer for a session whose phase entry is absent.
    function deleteActiveSession() {
      try {
        rmSync(getActiveSessionPath(), { force: true });
        debug(`deleteActiveSession: removed active-session pointer`);
        return true;
      } catch (e) {
        debug(`deleteActiveSession error: ${e.message}`);
        return false;
      }
    }

    // The file is the runtime SSOT — reconcile the in-memory cache
    // on every overseer message so manual file edits are honored mid-session.
    // Priority: valid own file > corrupt-file fresh init >
    // missing-file fresh PROTOCOL_NOT_LOADED init (the active-session
    // pointer is never adopted).
    function reconcileSessionState(sessionID) {
      const state = readStateFile(sessionID);
      // firstLoad is captured BEFORE the fresh-init branches below
      // set the phase entry. The restore timestamp must be recorded only when
      // this server instance loads the session from a valid state file for the
      // first time — that is a restart. A mid-session chat.params reconcile
      // re-syncs an already-in-memory session and is NOT a restart;
      // re-recording there would make every mid-session KD look pre-restart
      // and flag RESTART_CATCH_UP falsely.
      const firstLoad = !sessionPhaseMap.has(sessionID);

      if (state === "missing") {
        // Fresh-session-only lifecycle start — the workspace-level
        // active-session pointer is INERT. A session with no own state file
        // never adopts another session's phase, generation, or `:sid`; it
        // always initializes at PROTOCOL_NOT_LOADED with `:sid` = current so
        // the mandatory todowrite kickoff runs. A same-session restart
        // restores via this session's own state file; a restart that
        // mints a NEW session id mid-lifecycle is recovered via the user's
        // /phase override (SAFETY_ESCAPE).
        sessionPhaseMap.set(sessionID, STATES.PROTOCOL_NOT_LOADED);
        sessionPhaseMap.set(`${sessionID}:sid`, sessionID);
        saveState(sessionID);
        debug(`reconcile: initialized PROTOCOL_NOT_LOADED for ${sessionID} (no cross-session adoption)`);
        return;
      }

      if (state === "corrupt") {
        // The corrupt file was backed up by readStateFile — initialize
        // fresh rather than trusting a half-written state. The next valid
        // transition overwrites the original path with valid JSON.
        sessionPhaseMap.set(sessionID, STATES.PROTOCOL_NOT_LOADED);
        sessionPhaseMap.set(`${sessionID}:sid`, sessionID);
        saveState(sessionID);
        debug(`reconcile: initialized PROTOCOL_NOT_LOADED after corrupt state file for ${sessionID}`);
        return;
      }

      // Valid own file — restore phase, generation, and sid.
      if (state.generation !== undefined) {
        sessionPhaseMap.set(`${sessionID}:gen`, state.generation);
      }
      // Heal a stale `:sid` on restore — the stored sid may belong
      // to a prior lifecycle (legacy adoption chain). Only the current
      // session's KDs may be read/advanced off, so the map entry is refreshed
      // to the current sessionID and the state file is persisted WITHOUT the
      // stale sid, eliminating stale-sid chaining across pre-existing files.
      // Legacy files without `sid` keep the current-session default (no
      // migration step).
      const healedSid = state.sid && state.sid !== sessionID ? sessionID : state.sid;
      sessionPhaseMap.set(`${sessionID}:sid`, healedSid || sessionID);
      const phase = typeof state.phase === "number" ? state.phase : STATES.PROTOCOL_NOT_LOADED;
      sessionPhaseMap.set(sessionID, phase);
      // Record the in-memory restore timestamp on the first valid
      // restore per server instance — the advancement block uses it to flag
      // post-restart disk-evidence catch-up (RESTART_CATCH_UP, log-only).
      // Never persisted (saveState serializes only phase/generation/
      // sid/overrideUntil): a second restart re-runs reconcile and re-records.
      if (firstLoad) {
        sessionPhaseMap.set(`${sessionID}:restoredAt`, Date.now());
        debug(`reconcile: recorded restore timestamp for ${sessionID}`);
      }
      // Restore the persistent override marker so a mid-session
      // restart honors the override until fresh evidence. Omitted
      // when absent — legacy state files load unchanged.
      if (state.overrideUntil && typeof state.overrideUntil.phase === "number" && typeof state.overrideUntil.since === "number") {
        sessionPhaseMap.set(`${sessionID}:overrideUntil`, { phase: state.overrideUntil.phase, since: state.overrideUntil.since });
        debug(`reconcile: restored overrideUntil phase=${getPhaseName(state.overrideUntil.phase)} since=${state.overrideUntil.since} for ${sessionID}`);
      }
      if (state.sid && state.sid !== sessionID) {
        debug(`reconcile: healed stale sid ${state.sid} → ${sessionID} for ${sessionID}`);
        saveState(sessionID);
      }
      debug(`reconcile: restored phase=${getPhaseName(phase)} sid=${healedSid || sessionID} for ${sessionID}`);
    }

    const agentToPhaseMap = buildAgentToPhaseMap(PHASE_AGENT_MAP);

    debug("Plugin initializing…");
    debug(`Loaded config: ${Object.keys(STATES).length} states, maxCycles=${config.maxCyclesPerTransition || 3}`);
    debug(`Backward transitions: ${JSON.stringify(BACKWARD_TRANSITIONS)}`);
    debug(`Phase→agent map: ${JSON.stringify(PHASE_AGENT_MAP)}`);

    // Clean up orphaned state files with missing SID on plugin load.
    // These accumulate when sessions are interrupted mid-lifecycle.
    // Only delete files where sid is missing from the JSON, not where sid is null
    // (null sid is valid for INTENT-phase state before intent KD is written).
    // A phase-0 file that carries a `generation` field is a completed-lifecycle
    // marker (post-REPORT state) — it must survive restarts so the counter is
    // not lost between lifecycles.
    try {
      const stateDir = getStateDir();
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
      // A backward transition clears the override marker — the
      // user chose to move back, so the previous override no longer applies.
      if (sessionPhaseMap.has(`${sessionID}:overrideUntil`)) {
        sessionPhaseMap.delete(`${sessionID}:overrideUntil`);
        debug(`Override cleared: backward transition ${getPhaseName(prevPhase)} → ${getPhaseName(targetPhase)}`);
      }
      // A backward transition also supersedes any pending auto-advance
      // — the one-shot announcement is stale the moment the user moves back.
      advancementAnnouncements.delete(sessionID);
      debug(`Backward transition complete: ${getPhaseName(prevPhase)} → ${getPhaseName(targetPhase)}`);
      saveState(sessionID);
      pendingVerification.delete(sessionID);
      pendingVerificationToolCount.delete(sessionID);
      debug(`pendingVerification: CLEARED (backward transition) for session ${sessionID}`);

      // Reset counters when regressing to a target phase.
      // This prevents stale dispatch counts from causing formula divergence
      // and allows fresh tracking of re-dispatches for the new phase entry.
      // Reset swarmDispatchCount when regressing TO SWARM
      if (targetPhase === STATES.SWARM) {
        const knowledgeDir = getKnowledgeDir();
        let implFiles = [];
        try {
          const files = readdirSync(knowledgeDir);
          // Count impl KDs for the current session only — no
          // cross-session lookup set after adoption removal.
          implFiles = files.filter(f => matchesSessionKDForSession(f, sessionPhaseMap, sessionID, getCurrentGeneration(sessionPhaseMap, sessionID)) && /^impl-/i.test(f));
        } catch (_) {}
        const reconciliedCount = Math.max(1, implFiles.length);
        swarmDispatchCount.set(sessionID, reconciliedCount);
        debug(`COUNTER_RESET: swarmDispatchCount set to ${reconciliedCount} (${implFiles.length} impl files found) for session ${sessionID}`);
      }
      // Reset phaseRedispatchCount for the target phase
      phaseRedispatchCount.delete(`${sessionID}:${targetPhase}`);
      // Regression to SWARM also clears every per-milestone
      // redispatch budget — re-entering the swarm starts each milestone fresh.
      clearPerMilestoneRedispatchKeys(phaseRedispatchCount, sessionID);
      debug(`COUNTER_RESET: phaseRedispatchCount deleted for ${getPhaseName(targetPhase)} (session ${sessionID})`);
      return true;
    }

    // Restart-proof check-off — the impl KD filename is the ONLY
    // source of the parent lifecycle. Candidate parent sessions are collected
    // from the on-disk .state files (which survive restart) plus the in-memory
    // overseer cache; the filename's embedded `-{sessionID}-gen{N}` suffix
    // selects the parent via matchesSessionKD. A fresh instance with an empty
    // overseerSessions set still checks the milestone off.
    function collectParentSessionCandidates() {
      const candidates = new Set(overseerSessions);
      try {
        const stateDir = getStateDir();
        for (const f of readdirSync(stateDir)) {
          const m = f.match(/^\.protocol-state-(.+)\.json$/);
          if (m) candidates.add(m[1]);
        }
      } catch (_) {}
      return [...candidates];
    }

    // Persisted generation for a session — reads the .state file so check-off
    // matches the correct lifecycle after a restart when the in-memory map is
    // empty (the file is the SSOT). Returns null when no valid file
    // exists so callers can fall back to the in-memory value.
    function getPersistedGeneration(sessionID) {
      const statePath = getStatePath(sessionID);
      if (!statePath) return null;
      try {
        const data = JSON.parse(readFileSync(statePath, "utf8"));
        return typeof data.generation === "number" ? data.generation : 0;
      } catch (_) {
        return null;
      }
    }

    // When the artisan writes its milestone-scoped impl KD,
    // advance that milestone to checked-off in the parent lifecycle's registry.
    // The impl KD on disk IS the verifiable evidence of completion — the
    // SWARM→VERIFY gate reads it back via checkMilestoneCheckedOff. Only a row
    // in-progress in the registry can complete; the parent session and
    // generation come from the filename + on-disk state, never from in-memory
    // session state alone.
    // RESTART REQUIRED (MEM-059): plugins load once per opencode process —
    // changes to this check-off path and its loud diagnostics take effect
    // only after opencode restarts.
    function autoCheckOffMilestone(relPath) {
      const milestoneId = extractMilestoneIdFromImplKD(relPath);
      if (!milestoneId) return;
      for (const candidate of collectParentSessionCandidates()) {
        // Disk generation is the SSOT (restart-proof); the map is a fallback.
        const generation = getPersistedGeneration(candidate) ?? getCurrentGeneration(sessionPhaseMap, candidate);
        if (matchesSessionKD(relPath, candidate, generation)) {
          // Seed the in-memory generation so the generation-scoped registry
          // lookup (locateMilestoneRegistry) finds the same lifecycle after a
          // restart when the map is empty.
          if (!sessionPhaseMap.has(`${candidate}:gen`)) {
            sessionPhaseMap.set(`${candidate}:gen`, generation);
          }
          const result = updateMilestoneRegistry(candidate, sessionPhaseMap, milestoneId, ["checked-off"]);
          debug(`auto check-off: impl KD for milestone ${milestoneId} (parent ${candidate}) → ${JSON.stringify(result)}`);
          // Only a SUCCESSFUL check-off resets the per-milestone
          // redispatch budget. A failed registry update keeps the counter so
          // retries still count toward the cap; a re-opened milestone
          // starts fresh because its budget was cleared at the earlier
          // check-off — the desired re-open semantics.
          if (result.ok) {
            phaseRedispatchCount.delete(milestoneRedispatchKey(candidate, milestoneId));
            debug(`COUNTER_RESET: per-milestone redispatch key deleted for ${milestoneId} (session ${candidate})`);
          } else {
            // Loud, non-blocking diagnostic (R002/NFR001): silent failures
            // here left registries stuck in SWARM (Issue 64). Visible without
            // PROTOCOL_GATE_DEBUG; carries the {ok:false} reason
            // (no-registry / milestone-not-found / invalid-transition / write-failed).
            loud(`AUTO_CHECKOFF_FAILED: milestone ${milestoneId} (parent ${candidate}) — ${result.reason}`);
          }
          return;
        }
      }
      // No parent-session/generation candidate matched the impl KD filename —
      // nothing was checked off. Loud no-op diagnostic (R002b) so the miss is
      // observable instead of silent.
      loud(`AUTO_CHECKOFF_UNMATCHED: ${relPath}`);
    }

    // --- Hook: chat.params ---
    async function chatParams(input, output) {
      const { sessionID, agent } = input;
      lastSeenSession = sessionID;

      // Track agent for ALL sessions (overseer and subagents).
      // Used by checkpoint KD enforcement to verify the writing agent.
      if (agent) sessionAgentMap.set(sessionID, agent);

      if (agent === "overseer") {
        overseerSessions.add(sessionID);
        // The state file is the runtime SSOT — reconcile the
        // in-memory cache on every overseer message so manual file edits are
        // honored mid-session. The old `!sessionPhaseMap.has` one-shot load
        // guard is deliberately removed: the file always wins.
        reconcileSessionState(sessionID);
      } else {
        // Non-overseer sessions pass through unaffected — don't touch the maps.
        // Protocol-gate is Overseer-only; subagent tool calls must not be blocked.
        debug(`chat.params: non-overseer session ${sessionID} (agent=${agent}) — passing through`);
        return;
      }
    }

    // --- Hook: chat.message ---
    // Verbatim raw-intent capture: fires when a message is received, before any
    // LLM call. The Overseer's Raw Request is captured word-for-word so the
    // INTENT-phase systemTransform injection can relay it verbatim into
    // the intent KD authoring flow — behavioral relay rules are insufficient
    // because the model may summarize or omit. Read-only discipline:
    // no KD writes, no mutation of output.message; subagent messages and
    // non-text parts are skipped; the per-session capture is
    // capped at RAW_INTENT_MAX_MESSAGES by dropping the oldest entries.
    async function chatMessage(input, output) {
      const { sessionID, agent, messageID } = input || {};
      if (!sessionID) return;
      if (agent && String(agent).toLowerCase() !== "overseer") return;
      const parts = output?.parts;
      if (!Array.isArray(parts)) return;
      const texts = parts
        .filter(p => p && p.type === "text" && typeof p.text === "string")
        .map(p => p.text);
      if (texts.length === 0) return;
      const entry = { messageID, text: texts.join("\n") };
      const list = rawIntentCapture.get(sessionID) || [];
      list.push(entry);
      if (list.length > RAW_INTENT_MAX_MESSAGES) {
        list.splice(0, list.length - RAW_INTENT_MAX_MESSAGES);
      }
      rawIntentCapture.set(sessionID, list);
      debug(`chat.message: captured ${texts.length} text part(s) for session ${sessionID} (${list.length}/${RAW_INTENT_MAX_MESSAGES})`);
    }

    // --- Hook: command.execute.before ---
    // Implements the /phase slash command — the single user-facing override
    // path. Validates the argument against STATES (rejections: 99, INVALID,
    // empty), sets the phase in memory, persists via saveState, and replies
    // with a deterministic confirmation. Any valid phase 0-12 is accepted with
    // no forward-jump cap; the command template is confirmation-only —
    // the LLM never hand-writes state files.
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
      const prevPhase = sessionPhaseMap.get(sessionID);
      sessionPhaseMap.set(sessionID, n);
      // Every /phase invocation persists an override marker
      // { phase, since } — while the current phase equals the target, only
      // fresh evidence (KD mtime >= since) advances and consistency never
      // regresses. A new /phase replaces any prior marker (clear-on-new-
      // override); the marker clears on advance-away, backward
      // transition, or REPORT reset.
      sessionPhaseMap.set(`${sessionID}:overrideUntil`, { phase: n, since: Date.now() });
      // A manual /phase override supersedes any pending auto-advance.
      // The one-shot announcement must not leak into the next systemTransform —
      // e.g. a stale "auto-advanced EXPLORE → INVESTIGATE" after a redispatch to
      // EXPLORE would contradict the manual override and misroute the LLM.
      advancementAnnouncements.delete(sessionID);
      // Re-capture the session ID so checkDiskAdvancement can filter KDs by
      // session — required when /phase starts a fresh lifecycle.
      if (!sessionPhaseMap.has(`${sessionID}:sid`)) {
        sessionPhaseMap.set(`${sessionID}:sid`, sessionID);
      }
      overseerSessions.add(sessionID);
      saveState(sessionID);
      // The user's /phase override is the ONLY escape hatch
      // from a stuck SWARM — the automatic safety mechanisms never advance it.
      if (prevPhase === STATES.SWARM && n !== STATES.SWARM) {
        debug(`SAFETY_ESCAPE: /phase override ${getPhaseName(prevPhase)} → ${getPhaseName(n)} for session ${sessionID} — manual escape from SWARM`);
        // An escaped-and-continued lifecycle must restart
        // each milestone with a fresh redispatch budget, or stale caps from
        // before the escape could deny legitimate retries. Numeric phase-key
        // counters are preserved — only non-numeric per-milestone keys clear.
        clearPerMilestoneRedispatchKeys(phaseRedispatchCount, sessionID);
      }
      debug(`Phase override: ${getPhaseName(n)} (${n}) for session ${sessionID} — overrideUntil set (phase ${n}, since ${sessionPhaseMap.get(`${sessionID}:overrideUntil`).since})`);
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
        // Non-task tool blocks set output.status = "deny" without throwing
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

      // Structural git-stage guard. Rejects `git add`
      // invocations that would stage gitignored paths — force flags bypass the
      // ignore rules and explicit knowledge/ paths are the gitignored workflow
      // set. Runs before the overseer/non-overseer split so every session is
      // covered; the positive guidance points to the allowed staging forms.
      if (tool === "bash" && typeof args.command === "string") {
        const addSegments = args.command.split(/\s*(?:&&|\|\||;)\s*/).filter(seg => /\bgit add\b/.test(seg));
        if (addSegments.length > 0) {
          const forceFlag = addSegments.some(seg => /(^|\s)(-f|--force)(\s|$)/.test(seg));
          const knowledgePath = addSegments.some(seg => /\bknowledge\//.test(seg));
          if (forceFlag || knowledgePath) {
            debug(`STAGE GUARD: rejecting git add — forceFlag=${forceFlag} knowledgePath=${knowledgePath} (command=${args.command})`);
            throw new ProtocolGateError(
              ERROR_TEMPLATES.GITIGNORED_STAGE_REJECTED.code,
              ERROR_TEMPLATES.GITIGNORED_STAGE_REJECTED.message,
              ERROR_TEMPLATES.GITIGNORED_STAGE_REJECTED.guidance
            );
          }
        }
      }

      if (!isOverseerSession(sessionID)) {
        // Checkpoint KD enforcement for subagent writes/edits.
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
          // The artisan's milestone-scoped impl KD write is the
          // check-off signal — advance that milestone in the parent SWARM
          // lifecycle's registry. Only the artisan (the intended writer of impl
          // KDs) triggers it; other agents' writes never touch milestone state.
          const isImplKD = /^knowledge\/impl-/i.test(relPath) || /\/knowledge\/impl-/i.test(relPath);
          if (isImplKD && (sessionAgentMap.get(sessionID)?.toLowerCase() || "unknown") === "artisan") {
            autoCheckOffMilestone(relPath);
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
              // Re-initialize :sid when entering INTENT after REPORT→PROTOCOL_NOT_LOADED cycle.
              // Without this, checkDiskAdvancement lacks :sid to filter KDs by session, preventing progression.
              sessionPhaseMap.set(`${sessionID}:sid`, sessionID);
              debug("INTENT phase: write the intent KD with the raw user request; the Explorer handles codebase exploration after dispatch.");
              skipDiskCheckAfterTodo.set(sessionID, true);
              saveState(sessionID);
            } else {
              debug(`todowrite: missing lifecycle keywords in PROTOCOL_NOT_LOADED`);
              throw new ProtocolGateError(ERROR_TEMPLATES.BLOCKED_NO_LIFECYCLE.code, ERROR_TEMPLATES.BLOCKED_NO_LIFECYCLE.message, ERROR_TEMPLATES.BLOCKED_NO_LIFECYCLE.guidance);
            }
          }
        }
        // Phase advancement happens ONLY via checkDiskAdvancement() — not via todowrite content
      }

      // --- write handler ---
      else if (tool === "write") {
        const path = args?.filePath || "";
        const relPath = toProjectRelative(path);

        // Check if path matches the required pattern (handles both relative and absolute paths)
        const isIntentKD = relPath.startsWith("knowledge/intent-") || relPath.includes("/knowledge/intent-");
        const isReportKD = relPath.startsWith("knowledge/report-") || relPath.includes("/knowledge/report-");
        // Checkpoint KD enforcement — Overseer should not write checkpoint KDs.
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
          // Lifecycle end — the finished session must never be a
          // resume target. Delete the pointer; saveState won't re-create it
          // because the phase entry is deleted below.
          deleteActiveSession();
          // Increment generation on lifecycle end — the new generation
          // scopes all KDs written in the next lifecycle. The increment
          // is atomic with saveState — revert on save failure.
          const currentGen = getCurrentGeneration(sessionPhaseMap, sessionID);
          const nextGen = currentGen + 1;
          sessionPhaseMap.set(`${sessionID}:gen`, nextGen);
          // Delete the phase entry instead of setting PROTOCOL_NOT_LOADED.
          // chat.params only re-runs loadState() when the entry is absent, so a
          // 0 here would keep the in-memory map diverged from a manually edited
          // state file. Deleting forces loadState() on the next message.
          sessionPhaseMap.delete(sessionID);
          diskCheckFailures.set(sessionID, 0);
          sessionPhaseMap.delete(`${sessionID}:sid`);
          // Lifecycle end clears the override marker — a finished
          // lifecycle is never pinned; the next lifecycle starts fresh.
          if (sessionPhaseMap.has(`${sessionID}:overrideUntil`)) {
            sessionPhaseMap.delete(`${sessionID}:overrideUntil`);
            debug(`Override cleared: REPORT reset`);
          }
          swarmDispatchCount.delete(sessionID);
          cycleMap.delete(sessionID);
          verdictRegressedKDs.delete(sessionID);
          pendingVerification.delete(sessionID);
          pendingVerificationToolCount.delete(sessionID);
          if (!saveState(sessionID)) {
            sessionPhaseMap.set(`${sessionID}:gen`, currentGen);
            debug(`saveState failed — generation stays ${currentGen} for session ${sessionID}`);
          } else {
            debug(`Generation ${currentGen} → ${nextGen} for session ${sessionID}`);
          }
          // Remove this lifecycle's KDs so stale files can never
          // advance or suppress the next generation. Pass the ENDING
          // generation (currentGen, captured before the increment) so a reused
          // session ID never deletes the new lifecycle's KDs. Cleanup
          // failure must not block the phase reset — wrapped in try-catch.
          // Accepted race: any KD written between the REPORT trigger and
          // this cleanup belongs to the ending lifecycle; deletion is safe.
          try {
            cleanupLifecycleKDs(sessionID, currentGen);
          } catch (e) {
            debug(`cleanupLifecycleKDs error for session ${sessionID}: ${e.message}`);
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

        // Trigger pendingVerification when write creates a KD matching
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
        const relPath = toProjectRelative(path);
        // Skill files cover the auto-loaded KD-format template skills. There is
        // deliberately no generic "templates" allowance: delegation templates
        // are JSON files auto-injected by delegation-gate at dispatch, never
        // read by the Overseer.
        const isSkillFile = relPath.endsWith("/SKILL.md") || relPath.includes("/skills/");

        if (phase === STATES.SWARM) {
          // SWARM phase: dispatcher visibility — the Overseer reads the
          // milestone registry to track milestone state and drive
          // per-milestone artisan dispatches. All other reads stay blocked.
          const isMilestonesKD = /^knowledge\/milestones-/i.test(relPath) || /\/knowledge\/milestones-/i.test(relPath);
          if (!isMilestonesKD) {
            debug(`read: BLOCKED phase=${phaseName} path=${path} (SWARM reads restricted to milestone registry KDs)`);
            throw new ProtocolGateError(ERROR_TEMPLATES.BLOCKED_WRONG_PHASE.code, "❌ BLOCKED: Wrong phase. Read from knowledge/milestones-*.md only", "Read from knowledge/milestones-*.md only");
          }
        } else if (phase === STATES.INTENT || phase === STATES.REPORT) {
          if (phase === STATES.INTENT) {
            // INTENT phase: only skill files (auto-loaded template skills) and
            // the current session's intent KDs. Restricting to intent KDs
            // prevents the Overseer from reading prior-session reports or other
            // KDs and falling back to self-execution. Delegation templates are
            // auto-injected by delegation-gate at dispatch — not read here.
            const isIntentKD = /knowledge\/intent-/i.test(relPath);
            if (!isSkillFile && !isIntentKD) {
              debug(`read: BLOCKED phase=${phaseName} path=${path} (INTENT reads restricted to skill files and intent KDs)`);
              throw new ProtocolGateError(ERROR_TEMPLATES.BLOCKED_WRONG_PHASE.code, "❌ BLOCKED: Wrong phase. Read from skill files or knowledge/intent-*.md only — delegation templates are auto-injected by delegation-gate at dispatch, never read", "Read from skill files or knowledge/intent-*.md only");
            }
          } else {
            // REPORT phase: allow skill files (auto-loaded template skills) and
            // any knowledge KD (needed to compose report). Delegation templates
            // are auto-injected by delegation-gate at dispatch — not read here.
            const isKnowledge = relPath.startsWith("knowledge/") || relPath.includes("/knowledge/");
            if (!isSkillFile && !isKnowledge) {
              debug(`read: BLOCKED phase=${phaseName} path=${path} (reads restricted to skill files and knowledge KDs)`);
              throw new ProtocolGateError(ERROR_TEMPLATES.BLOCKED_WRONG_PHASE.code, "❌ BLOCKED: Wrong phase. Read from skill files or knowledge KDs only — delegation templates are auto-injected by delegation-gate at dispatch, never read", "Read from skill files or knowledge KDs only");
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
          // Lifecycle end — delete the active-session pointer; the
          // finished session must never be a resume target (see write handler).
          deleteActiveSession();
          // Generation increment — mirrors the write handler (see above
          // for the atomicity rationale). Delete the phase
          // entry so the next chat.params re-runs loadState().
          const currentGen = getCurrentGeneration(sessionPhaseMap, sessionID);
          const nextGen = currentGen + 1;
          sessionPhaseMap.set(`${sessionID}:gen`, nextGen);
          sessionPhaseMap.delete(sessionID);
          diskCheckFailures.set(sessionID, 0);
          sessionPhaseMap.delete(`${sessionID}:sid`);
          // Lifecycle end clears the override marker (see write
          // handler for the rationale).
          if (sessionPhaseMap.has(`${sessionID}:overrideUntil`)) {
            sessionPhaseMap.delete(`${sessionID}:overrideUntil`);
            debug(`Override cleared: REPORT reset via edit`);
          }
          swarmDispatchCount.delete(sessionID);
          cycleMap.delete(sessionID);
          verdictRegressedKDs.delete(sessionID);
          pendingVerification.delete(sessionID);
          pendingVerificationToolCount.delete(sessionID);
          if (!saveState(sessionID)) {
            sessionPhaseMap.set(`${sessionID}:gen`, currentGen);
            debug(`saveState failed — generation stays ${currentGen} for session ${sessionID}`);
          } else {
            debug(`Generation ${currentGen} → ${nextGen} for session ${sessionID}`);
          }
          // Cleanup the ending lifecycle's KDs: pass the
          // ENDING generation (currentGen) so newer generations survive a
          // reused session ID; try-catch (see write handler).
          try {
            cleanupLifecycleKDs(sessionID, currentGen);
          } catch (e) {
            debug(`cleanupLifecycleKDs error for session ${sessionID}: ${e.message}`);
          }
          phase = STATES.PROTOCOL_NOT_LOADED;
          phaseName = getPhaseName(phase);
        } else if (phase === STATES.REPORT && !isReportKD) {
          debug(`edit: BLOCKED phase=${phaseName} path=${path} (must edit knowledge/report-*.md)`);
          throw new ProtocolGateError(ERROR_TEMPLATES.BLOCKED_WRONG_PHASE.code, "❌ BLOCKED: Wrong phase. Edit knowledge/report-*.md", "Edit knowledge/report-*.md");
        }
      }

      // A SWARM re-dispatch must re-open its checked-off milestone
      // BEFORE the all-checked-off gate runs. The gate is checked on the same
      // task call (below); without the re-open first, an all-done registry would
      // advance SWARM→VERIFY and the re-dispatch would be blocked as a wrong
      // agent before the task handler ever runs. Only genuine artisan dispatches
      // to SWARM's agent advance the registry; every other task call passes
      // through untouched.
      // MILESTONE_ID cardinality is validated BEFORE any
      // registry mutation. A MULTI_MILESTONE rejection must leave the registry
      // byte-identical — without this check, first-line-wins extraction would
      // advance the first row before delegation-gate rejected the dispatch
      // (phantom in-progress row). Mirrors delegation-gate's collectMilestoneIds
      // semantics so both gates agree on cardinality.
      if (tool === "task" && phase === STATES.SWARM) {
        let dispatchAgent = extractAgentFromPrompt(args?.prompt || "");
        if (!dispatchAgent && args?.subagent_type) dispatchAgent = String(args.subagent_type).toLowerCase();
        const swarmAgent = PHASE_AGENT_MAP[getPhaseName(STATES.SWARM)]?.toLowerCase();
        if (dispatchAgent && swarmAgent && dispatchAgent === swarmAgent) {
          const milestoneIds = collectMilestoneIds(args?.prompt || "");
          if (milestoneIds.length > 1 || (milestoneIds.length === 1 && /,/.test(milestoneIds[0]))) {
            debug(`MULTI_MILESTONE: multiple milestones in single swarm dispatch: ${JSON.stringify(milestoneIds)}`);
            throw new ProtocolGateError(ERROR_TEMPLATES.MULTI_MILESTONE.code, ERROR_TEMPLATES.MULTI_MILESTONE.message, ERROR_TEMPLATES.MULTI_MILESTONE.guidance);
          }
          if (milestoneIds.length === 1) {
            const regResult = updateMilestoneRegistry(sessionID, sessionPhaseMap, milestoneIds[0], ["assigned", "in-progress"], { reopen: true });
            debug(`SWARM registry update (pre-gate) for ${milestoneIds[0]}: ${JSON.stringify(regResult)}`);
          }
        }
      }

      // --- disk-based advancement for lifecycle tools ---
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
          if (await checkDiskAdvancement(sessionID, currentPhase, sessionPhaseMap, swarmDispatchCount, { verdictRegressedKDs, backwardTransition: handleBackwardTransition })) {
            sessionPhaseMap.set(sessionID, currentPhase + 1);
            // The phase advanced away from the override target on
            // fresh evidence — clear the marker so normal advancement
            // semantics resume for this and later phases.
            const overrideUntil = getOverrideUntil(sessionPhaseMap, sessionID);
            if (overrideUntil && currentPhase === overrideUntil.phase) {
              sessionPhaseMap.delete(`${sessionID}:overrideUntil`);
              debug(`Override cleared: advanced ${getPhaseName(currentPhase)} → ${getPhaseName(currentPhase + 1)} on fresh evidence`);
            }
            diskCheckFailures.set(sessionID, 0);
            // Clear in-flight tracking — KD appeared on disk, dispatch is complete
            inFlightDispatches.delete(sessionID);
            pendingVerification.delete(sessionID);
            pendingVerificationToolCount.delete(sessionID);
            debug(`pendingVerification: CLEARED (disk advancement) for session ${sessionID}`);
            // Reset re-dispatch counter for the phase we just advanced from
            phaseRedispatchCount.delete(`${sessionID}:${currentPhase}`);
            const newPhase = currentPhase + 1;
            // Record fresh advancement to prevent false regression.
            // checkPhaseStateConsistency uses this to grant a grace period before
            // allowing regression from the new phase back to the old one.
            freshAdvancement.set(sessionID, { phase: newPhase, diskCheckCount: 0 });
            debug(`FRESH_ADVANCEMENT: ${currentPhaseName} → ${getPhaseName(newPhase)} recorded for session ${sessionID}`);
            // Explicit advancement event. Diagnostic re-read of
            // the already-returned gate result — the all-checked-off gate semantics
            // are unchanged; this only formats checkedOff/total as evidence
            // for the log and the one-shot announcement below.
            let advancementGateEvidence = "";
            if (currentPhase === STATES.SWARM) {
              const gateEvidence = checkAllMilestonesCheckedOff(sessionID, sessionPhaseMap);
              advancementGateEvidence = `all milestones checked-off: ${gateEvidence.checkedOff}/${gateEvidence.total}`;
            }
            debug(`Disk advancement: ${currentPhaseName} → ${getPhaseName(newPhase)}${advancementGateEvidence ? ` (${advancementGateEvidence})` : ""}`);
            // Post-restart disk-evidence catch-up diagnostic — log-only.
            // After a restart the gate may advance one phase per tool call across
            // phases whose KDs already exist on disk; that is disk-evidence
            // catch-up, not a skip — no mtime gate, no suppression.
            // When the advancing phase's evidence KD predates the session's
            // restore timestamp, name it RESTART_CATCH_UP so a "phase jumped"
            // read is explained as accumulated disk evidence. Skipped when no
            // restore timestamp was recorded or the evidence KD is
            // indeterminable (checkDiskAdvancement returns boolean only).
            const restoredAt = sessionPhaseMap.get(`${sessionID}:restoredAt`);
            if (typeof restoredAt === "number") {
              const evidenceFile = findNewestEvidenceKD(sessionPhaseMap, sessionID, currentPhase);
              if (evidenceFile) {
                const evidenceMtime = getFileMtimeMs(join(getKnowledgeDir(), evidenceFile));
                if (evidenceMtime >= 0 && evidenceMtime < restoredAt) {
                  debug(`RESTART_CATCH_UP: ${currentPhaseName} → ${getPhaseName(newPhase)} on pre-existing KD (restore ${restoredAt}, KD mtime ${evidenceMtime})`);
                }
              }
            }
            // Record the transition for the one-shot
            // LLM-visible announcement. The systemTransform consumes and deletes
            // the entry on its next run for this session.
            advancementAnnouncements.set(sessionID, {
              from: currentPhaseName,
              to: getPhaseName(newPhase),
              reason: advancementGateEvidence || null
            });
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
            // After lifecycle-end the phase entry was deleted; currentPhase
            // is undefined and there is nothing to check — skip the whole block
            // (getPhaseName(undefined).toLowerCase() would throw).
            if (currentPhase === undefined) {
              debug(`Disk advancement: no phase entry for ${sessionID} — skipping consistency block`);
            } else if (currentPhase !== STATES.REPORT) {
              const currentPhasePrefixes = getPrefixes(currentPhase);
              if (currentPhasePrefixes.length === 0) {
                currentPhasePrefixes.push(currentPhaseName.toLowerCase());
              }

              // Skip consistency check when write/task is creating expected KD.
              // For VERIFY phase, match against ANY prefix in the array (review).
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

              // Always increment diskCheckFailures — even during
              // pendingVerification — so safety mechanisms (force-advance at 15,
              // re-dispatch cap at 5) can fire regardless of pendingVerification state.
              // Previously, pendingVerification suppressed all stuck detection,
              // causing the infinite loop to run indefinitely.
              const currentFailures = (diskCheckFailures.get(sessionID) || 0) + 1;
              diskCheckFailures.set(sessionID, currentFailures);

              // Check force-advance safety mechanism BEFORE pendingVerification guard.
              // When pendingVerification is active but the subagent is stuck and not
              // producing the expected KD, this ensures the force-advance still fires.
              let safetyTriggered = false;
              if (currentFailures >= 15) {
                if (currentPhase === STATES.SWARM) {
                  // A stuck SWARM never
                  // auto-advances to VERIFY. Mark stuck milestones failed,
                  // reset counters, stay in SWARM. User /phase is the escape.
                  markStuckMilestonesFailed(sessionID, sessionPhaseMap, `FORCE ADVANCE at ${currentFailures} failures`);
                  diskCheckFailures.set(sessionID, 0);
                  phaseRedispatchCount.delete(`${sessionID}:${currentPhase}`);
                  // SWARM FORCE ADVANCE clears every per-milestone
                  // redispatch budget too — no stale caps after the escape hatch.
                  clearPerMilestoneRedispatchKeys(phaseRedispatchCount, sessionID);
                  pendingVerification.delete(sessionID);
                  pendingVerificationToolCount.delete(sessionID);
                  inFlightDispatches.delete(sessionID);
                  saveState(sessionID);
                } else {
                  debug(`SAFETY_OVERRIDE: FORCE ADVANCE — ${currentPhaseName} → VERIFY after ${currentFailures} stuck failures (pendingVerification active=${!!pendingVerification.get(sessionID)})`);
                  sessionPhaseMap.set(sessionID, STATES.VERIFY);
                  diskCheckFailures.set(sessionID, 0);
                  phaseRedispatchCount.delete(`${sessionID}:${currentPhase}`);
                  pendingVerification.delete(sessionID);
                  pendingVerificationToolCount.delete(sessionID);
                  inFlightDispatches.delete(sessionID);
                  saveState(sessionID);
                }
                safetyTriggered = true;
              } else {
                // Check re-dispatch cap BEFORE pendingVerification guard.
                // In SWARM the cap reads the offending
                // milestone's own key — a missing key returns 0, so a fresh
                // milestone (zero prior attempts) can never satisfy `>= 5` and
                // never throws SAFETY_STUCK on its first dispatch. Non-SWARM
                // phases keep the phase-keyed counter; a malformed
                // SWARM prompt with no extractable milestone ID falls back to
                // the phase key (prior behavior preserved, no crash).
                let redispatchKey = `${sessionID}:${currentPhase}`;
                let capMilestoneId = null;
                if (currentPhase === STATES.SWARM) {
                  capMilestoneId = extractMilestoneIdFromPrompt(args?.prompt || "");
                  if (capMilestoneId) {
                    redispatchKey = milestoneRedispatchKey(sessionID, capMilestoneId);
                  }
                }
                const redispatches = phaseRedispatchCount.get(redispatchKey) || 0;
                if (redispatches >= 5 && tool === "task") {
                  if (currentPhase === STATES.SWARM) {
                    // The redispatch cap during
                    // SWARM blocks the dispatch, marks the stuck milestone
                    // failed, and throws SAFETY_STUCK (no auto-advance).
                    // Only the offending milestone's row fails.
                    if (capMilestoneId) {
                      markStuckMilestonesFailed(sessionID, sessionPhaseMap, `REDISPATCH CAP at ${redispatches} re-dispatches`, capMilestoneId);
                    } else {
                      markStuckMilestonesFailed(sessionID, sessionPhaseMap, `REDISPATCH CAP at ${redispatches} re-dispatches`);
                    }
                    diskCheckFailures.set(sessionID, 0);
                    phaseRedispatchCount.delete(redispatchKey);
                    pendingVerification.delete(sessionID);
                    pendingVerificationToolCount.delete(sessionID);
                    inFlightDispatches.delete(sessionID);
                    saveState(sessionID);
                    throw new ProtocolGateError("SAFETY_STUCK", `❌ SAFETY_STUCK: SWARM re-dispatch cap (${redispatches}) reached — milestone marked failed. Escalate to user or override with /phase`, "Escalate to user or use /phase to override");
                  }
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
                    if (currentPhase === STATES.SWARM) {
                      // A stuck SWARM never
                      // auto-advances to VERIFY. Mark stuck milestones failed,
                      // clear pendingVerification, stay in SWARM.
                      markStuckMilestonesFailed(sessionID, sessionPhaseMap, `pendingVerification force-advance after ${toolCalls} tool calls`);
                      pendingVerification.delete(sessionID);
                      pendingVerificationToolCount.delete(sessionID);
                      diskCheckFailures.set(sessionID, 0);
                      inFlightDispatches.delete(sessionID);
                      saveState(sessionID);
                    } else {
                      debug(`pendingVerification SAFETY: force-advance after ${toolCalls} tool calls — expectedPrefixes=${JSON.stringify(pvState.expectedPrefixes)}`);
                      pendingVerification.delete(sessionID);
                      pendingVerificationToolCount.delete(sessionID);
                      sessionPhaseMap.set(sessionID, STATES.VERIFY);
                      diskCheckFailures.set(sessionID, 0);
                      inFlightDispatches.delete(sessionID);
                      saveState(sessionID);
                    }
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
                      const knowledgeDir = getKnowledgeDir();
                      let foundFiles = [];
                      // The stuck diagnostic scans the current
                      // session's KDs only (single-session lookup).
                      try { foundFiles = readdirSync(knowledgeDir).filter(f => matchesSessionKDForSession(f, sessionPhaseMap, sessionID, getCurrentGeneration(sessionPhaseMap, sessionID))); } catch (_) {}
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
              // MILESTONE_COUNT is no longer extracted or
              // stored — the all-checked-off registry gate replaces count-based
              // advancement, so count signals have no gating effect.
              // Per-milestone registry tracking runs in the pre-gate block
              // above (the re-open must precede the all-checked-off gate).
              // swarmDispatchCount remains a pure counter — it has no gating
              // effect (the all-checked-off registry gate replaces it).
              debug(`SWARM dispatch count for ${sessionID}: ${count}`);
            }
            // Track re-dispatches per phase to cap retries.
            // In SWARM the counter increments the dispatched milestone's own
            // key (case-normalized) so each milestone caps independently; a
            // malformed prompt with no milestone ID falls back to the phase key
            // (prior behavior preserved). Non-SWARM phases stay phase-keyed.
            let redispatchKey = `${sessionID}:${phase}`;
            if (phase === STATES.SWARM) {
              const milestoneId = extractMilestoneIdFromPrompt(args?.prompt || "");
              if (milestoneId) {
                redispatchKey = milestoneRedispatchKey(sessionID, milestoneId);
              }
            }
            phaseRedispatchCount.set(redispatchKey, (phaseRedispatchCount.get(redispatchKey) || 0) + 1);
            // Record the charged dispatch so the
            // tool.execute.after hook can restore the budget when the dispatch
            // produces no expected RESULT KD (empty-result detection). resultKd
            // is parsed from the raw prompt's `RESULT KD:` line; prefixes are
            // the phase's expected KD prefixes (multi-KD phases like VERIFY
            // scan all of them when no explicit RESULT KD is present).
            lastTaskDispatch.set(sessionID, {
              redispatchKey,
              resultKd: parseResultKdFromPrompt(args?.prompt || ""),
              prefixes: getPrefixes(phase),
              phase,
              agentName,
              callID
            });
            // Trigger pendingVerification when task dispatches the current phase's
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
              // Require explicit BACKWARD: true flag for backward transitions
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
              // is now blocked — which is correct because checkpoint commits are
              // the artisan's responsibility, not the overseer's.
              const expectedAgent = currentPhaseAgent || phaseName;
              debug(`task: BLOCKED wrong agent=${agentName} in phase=${phaseName} (expected: ${expectedAgent})`);
              throw new ProtocolGateError(ERROR_TEMPLATES.WRONG_AGENT(expectedAgent).code, ERROR_TEMPLATES.WRONG_AGENT(expectedAgent).message, ERROR_TEMPLATES.WRONG_AGENT(expectedAgent).guidance);
            }
          }
        }
      }
    }

    // --- Helper: expected-KD existence for a recorded dispatch ---
    // Explicit RESULT KD paths are checked directly; dispatches without one
    // fall back to a prefix scan of the phase's expected KD prefixes
    // (multi-KD phases like DECOMPOSE = plan+milestones, VERIFY = review are
    // covered by the scan).
    // The RESULT KD path is project-relative (e.g. `knowledge/impl-...`), so
    // the leading `knowledge/` segment is stripped before joining with
    // getKnowledgeDir(). A missing knowledge/ dir is not an error — returns false.
    function expectedKdExists(recorded, sessionID) {
      if (recorded.resultKd) {
        const rel = toProjectRelative(recorded.resultKd).replace(/^(?:\.\/)?knowledge\//, "");
        return existsSync(join(getKnowledgeDir(), rel));
      }
      const knowledgeDir = getKnowledgeDir();
      let files;
      try {
        files = readdirSync(knowledgeDir);
      } catch (_) {
        return false;
      }
      const generation = getCurrentGeneration(sessionPhaseMap, sessionID);
      return files.some(f =>
        recorded.prefixes.some(p => f.startsWith(`${p}-`)) &&
        matchesSessionKDForSession(f, sessionPhaseMap, sessionID, generation)
      );
    }

    // --- Hook: tool.execute.after ---
    // Empty-result redispatch reconciliation. The before-hook
    // charges the redispatch budget at the increment site; this hook
    // restores the charge when a task dispatch produced no expected RESULT KD,
    // so an empty-result dispatch does not silently consume a redispatch slot.
    // Non-fatal: it returns normally and tool execution
    // continues regardless of outcome.
    async function toolExecuteAfter(input, output) {
      const { tool, sessionID } = input;
      // Mirror the :1779 gate — only overseer task dispatches touch the
      // overseer's redispatch counter; subagent→subagent task calls never do.
      if (tool !== "task" || !isOverseerSession(sessionID)) return;
      const recorded = lastTaskDispatch.get(sessionID);
      if (!recorded) return;
      if (expectedKdExists(recorded, sessionID)) {
        // The dispatch produced its expected KD — keep the charge. SWARM
        // check-off already reset the per-milestone counter via
        // autoCheckOffMilestone; non-SWARM phases keep the increment for a
        // produced KD.
        lastTaskDispatch.delete(sessionID);
        return;
      }
      // No expected KD on disk — empty-result dispatch. Restore the counter
      // with floor 0 (delete when it would drop to 0, matching fresh-key
      // semantics) so the next dispatch of the same milestone is not capped.
      const v = phaseRedispatchCount.get(recorded.redispatchKey) || 0;
      if (v > 1) phaseRedispatchCount.set(recorded.redispatchKey, v - 1);
      else phaseRedispatchCount.delete(recorded.redispatchKey);
      lastTaskDispatch.delete(sessionID);
      debug(`COUNTER_RECONCILE: empty-result dispatch for session ${sessionID} — redispatchKey=${recorded.redispatchKey} restored to ${v > 1 ? v - 1 : 0}`);
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
        // use them in the KD filename. The -gen{N} suffix
        // scopes this lifecycle's KDs so stale prior-lifecycle KDs never match.
        if (phase === STATES.INTENT && sessionID) {
          const generation = getCurrentGeneration(sessionPhaseMap, sessionID);
          systemMsg += `\n\nYour session ID is: ${sessionID}`;
          systemMsg += `\nUse this session ID and generation in the intent KD filename: knowledge/intent-{name}-${sessionID}-gen${generation}.md`;
        }

        // During SWARM, surface the milestone list (IDs + live
        // states) so the Overseer knows the plan's milestones and dispatches
        // exactly one MILESTONE ID per artisan. The registry KD is the SSOT —
        // the list is read fresh from disk, never from in-memory caches.
        if (phase === STATES.SWARM && sessionID) {
          const registry = readMilestoneRegistry(sessionID, sessionPhaseMap);
          if (registry && registry.rows.length > 0) {
            const list = registry.rows.map(r => `${r.id}=${r.state}`).join(", ");
            systemMsg += `\n\nMilestone registry (live state SSOT): ${list}`;
            systemMsg += `\nInclude exactly one "MILESTONE ID: <id>" matching the registry row you are dispatching.`;
          }
        }

        output.system.push(systemMsg);

        // One-shot phase-transition announcement. The map
        // entry is consumed in this same transform — deleted right after
        // announcing — so multi-tool turns never repeat it. No entry
        // (e.g. non-disk advancements or a restart) → no announcement.
        const announcement = advancementAnnouncements.get(sessionID);
        if (announcement) {
          const reasonSuffix = announcement.reason ? ` (${announcement.reason})` : "";
          output.system.push(`[Protocol Gate] Phase auto-advanced: ${announcement.from} → ${announcement.to}${reasonSuffix}`);
          advancementAnnouncements.delete(sessionID);
          debug(`systemTransform: announced phase auto-advance ${announcement.from} → ${announcement.to} for session ${sessionID}`);
        }

        // INTENT-phase verbatim raw-intent injection. The captured
        // user text is relayed word-for-word into the Raw Request authoring
        // flow, removing model discretion over the verbatim copy. Read-only:
        // the directive instructs a copy, never an auto-write — the
        // Overseer remains the KD author. Fires only while phase stays INTENT
        // (may repeat on subsequent turns; stops automatically on advance).
        // Overseer-only: this block is inside the isOverseerSession
        // gate at the top of systemTransform.
        if (phase === STATES.INTENT && sessionID) {
          const captured = rawIntentCapture.get(sessionID);
          if (captured && captured.length > 0) {
            captured.forEach((entry, i) => {
              output.system.push(`[Protocol Gate] Raw user request (verbatim) — copy exactly, word for word, into the Raw Request section of the intent KD. Do not paraphrase or summarize. — Message ${i + 1}: ${entry.text}`);
            });
          }
        }
      }
      debug(`systemTransform: injected phase constraint for phase=${phaseName}`);
    }

    return {
      "chat.params": chatParams,
      "chat.message": chatMessage,
      "permission.ask": permissionAsk,
      "tool.execute.before": toolExecuteBefore,
      "tool.execute.after": toolExecuteAfter,
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
      lastTaskDispatch,
      diskCheckFailures,
      inFlightDispatches,
      pendingVerification,
      pendingVerificationToolCount,
      freshAdvancement,
      advancementAnnouncements,
      rawIntentCapture,
      RAW_INTENT_MAX_MESSAGES,
      KD_TYPE_PREFIXES,
      checkPhaseStateConsistency,
      checkDiskAdvancement,
      cleanupLifecycleKDs,
      extractMilestoneIdFromPrompt,
      collectMilestoneIds,
      milestoneRedispatchKey,
      clearPerMilestoneRedispatchKeys,
      updateMilestoneRegistry,
      extractMilestoneIdFromImplKD,
      findMilestoneImplKD,
      readMilestoneState,
      checkMilestoneCheckedOff,
      readMilestoneRegistry,
      checkAllMilestonesCheckedOff,
      reconcileStuckRowsFromDiskEvidence,
      supersedeMilestoneImplKDs,
      matchesSessionKDAnyGeneration,
      markStuckMilestonesFailed,
      readVerdictFrontmatter,
      findNewestVerdictKD,
      reopenCheckedOffMilestones,
      regressVerifyOnFail,
      extractMilestoneCitationsFromReviewKD,
      verdictRegressedKDs,
      collectParentSessionCandidates,
      getPersistedGeneration,
      getCurrentGeneration: (sessionID) => getCurrentGeneration(sessionPhaseMap, sessionID),
      parsePhaseArg,
      saveState,
      loadState,
      getStatePath,
      sanitizeSessionID,
      getActiveSessionPath,
      readActiveSession,
      writeActiveSession,
      deleteActiveSession,
      reconcileSessionState,
      getKDLookupSIDs,
      ProtocolGateError,
      ERRORS: ERROR_TEMPLATES,
      get lastSeenSession() { return lastSeenSession; }
    };
  }
};
