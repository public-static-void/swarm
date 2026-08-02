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
import { appendFileSync, closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeSync } from "fs";
import { basename, dirname, join } from "path";
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
  SWARM: "Dispatch the Artisan agent. Read the plan and milestone registry KDs to track milestone state before each dispatch. Include exactly one MILESTONE ID: matching the registry row you are dispatching. Name the dispatch's RESULT KD milestone-scoped — knowledge/impl-<milestone_id>-<name>-<session_id>-gen<N>.md — so the impl KD checks that milestone off on write.",
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
const TOOL_RESTRICTIONS = {
  INTENT: { read: "ONLY templates and intent KDs", bash: "ONLY mkdir for knowledge directory creation" },
  SWARM: { read: "ONLY plan and milestone registry KDs" },
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
  FABRICATED_SECTION: { code: "FABRICATED_SECTION", message: "❌ FABRICATED: Intent KD contains fabricated section. Follow the intent template exactly", guidance: "Follow the intent template exactly — Raw Request, Triage Notes, Next Steps, Process Friction only" },
  MULTI_MILESTONE: { code: "MULTI_MILESTONE", message: "❌ MULTI_MILESTONE: Multiple milestones in single dispatch", guidance: "Include exactly one MILESTONE ID: <milestone-id> field per dispatch" }
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

// Deletes ONLY the knowledge KDs of a session's ENDING lifecycle generation
// (R101): for generation 0 the legacy `-${sessionID}.md` variant plus the
// `-gen0.md` suffix; for generation N only the `-gen${N}.md` variant. Files of
// any other generation are never touched — a reused session ID spans lifecycles
// (opencode --continue), so a stray/duplicate REPORT write or edit fired after
// the next lifecycle began must not wipe the new lifecycle's KDs (BUG-008).
// Semantics mirror the generation-scoped read path matchesSessionKD (R104).
// Single readdirSync + batch rmSync loop (NFR007 — no per-file glob).
// EC-005: a missing knowledge/ dir is not an error — returns 0.
// R6: logs the count of removed files.
function cleanupLifecycleKDs(sessionID, generation = 0) {
  const knowledgeDir = join(process.cwd(), "knowledge");
  let files = [];
  try {
    files = readdirSync(knowledgeDir);
  } catch (e) {
    debug(`cleanupLifecycleKDs: knowledge/ dir not found for session ${sessionID} — nothing to clean (EC-005)`);
    return 0;
  }
  const gen = Number(generation) || 0;
  // Regex construction over the raw session ID keeps the historical failure
  // mode: a malformed ID throws, and the REPORT call sites' try/catch turns it
  // into a logged, non-blocking cleanup (EC-008).
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
  return stale.length;
}

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

// NFR004: session IDs reach file paths and can be attacker-influenced. Reject
// path separators, NUL, and the traversal entries so a crafted ID can never
// escape the plugin's .state directory. opencode session IDs (ses_...) pass.
function sanitizeSessionID(sessionID) {
  if (typeof sessionID !== "string" || sessionID.length === 0) return null;
  if (sessionID === "." || sessionID === "..") return null;
  if (/[\\/\0]/.test(sessionID)) return null;
  return sessionID;
}

// NFR001: atomic durable write — tmp file + fsync + rename. The rename is
// atomic on the same filesystem, so a crash mid-write can never leave a torn
// file at the target path. Throws on failure; callers surface the error.
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
// gates agree on cardinality (R017). A comma inside a single value means
// multiple milestones were crammed into one field; the caller rejects that as
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
// is the source of truth. R017/P019: cardinality (exactly one) is validated at
// the dispatch call site BEFORE any registry mutation — this helper only
// surfaces the first value for callers that already know cardinality holds.
function extractMilestoneIdFromPrompt(prompt) {
  const ids = collectMilestoneIds(prompt);
  return ids.length > 0 ? ids[0] : null;
}

// Advances a milestone row in the session's milestone registry KD through the
// given state chain (e.g. ["assigned", "in-progress"]) on a SWARM dispatch.
// Only the machine-readable `## Milestone States` YAML block is rewritten — the
// human-readable Milestone Details table stays untouched. A row already at the
// final state is left alone (idempotent). Reaching checked-off is restricted to
// in-progress milestones — the artisan checks off only after its impl KD lands,
// so pending/assigned/failed rows are rejected with invalid-transition. Row
// matching is case-insensitive (impl KDs may carry any casing for the milestone
// token, e.g. impl-m3 vs row M3) and the replacement preserves the registry
// row's own casing.
// R014/NFR001: the write is atomic (tmp + fsync + rename) so a crash mid-write
// can never leave a torn registry YAML on disk.
// R016 (P017): a checked-off row is immutable for every caller EXCEPT the SWARM
// re-dispatch path (opts.reopen). When the Overseer re-dispatches a checked-off
// milestone after inspector findings, the row re-opens to a non-terminal state
// so the SWARM→VERIFY gate fails closed again until the fix is re-verified.
// Returns { ok, path, changed } on success or { ok: false, reason } otherwise.
function updateMilestoneRegistry(sessionID, sessionPhaseMap, milestoneId, states, opts = {}) {
  const located = locateMilestoneRegistry(sessionID, sessionPhaseMap);
  if (!located) return { ok: false, reason: "no-registry" };

  const rowPattern = new RegExp(`^\\s*${escapeRegExp(milestoneId)}:\\s*([A-Za-z-]+)\\s*$`, "mi");
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
    // Only the SWARM re-dispatch path re-opens completed rows (R016); every
    // other writer leaves them immutable so evidence is never silently lost.
    if (!opts.reopen || finalState === "checked-off") {
      return { ok: true, path: located.path, changed: false };
    }
  }

  const rowId = rowMatch[0].slice(0, rowMatch[0].indexOf(":")).trim();
  const newBlock = located.block.replace(rowPattern, `  ${rowId}: ${finalState}`);
  const newContent = located.content.slice(0, located.fenceStart) + newBlock + located.content.slice(located.fenceEnd);
  try {
    // R014/NFR001: atomic durable registry write — no torn YAML after a crash.
    atomicWriteFileSync(located.path, newContent);
    debug(`Registry ${located.path}: ${milestoneId} ${current} → ${finalState} (session ${sessionID})`);
    return { ok: true, path: located.path, changed: true };
  } catch (e) {
    debug(`Registry write failed for ${located.path}: ${e.message}`);
    return { ok: false, reason: "write-failed" };
  }
}

// M4 (R009/R010): Locates and parses the session's milestone registry KD.
// Shared by updateMilestoneRegistry and readMilestoneState so both helpers agree
// on the machine-readable `## Milestone States` YAML block as the SSOT.
// Returns { path, content, block, fenceStart, fenceEnd } or null when the
// registry file or YAML block is missing.
function locateMilestoneRegistry(sessionID, sessionPhaseMap) {
  const generation = getCurrentGeneration(sessionPhaseMap, sessionID);
  const knowledgeDir = join(process.cwd(), "knowledge");
  let files = [];
  try { files = readdirSync(knowledgeDir); } catch (_) { return null; }
  const registry = files.find(f => /^milestones-/i.test(f) && matchesSessionKD(f, sessionID, generation));
  if (!registry) return null;

  const path = join(knowledgeDir, registry);
  let content;
  try { content = readFileSync(path, "utf8"); } catch (_) { return null; }

  const blockStart = content.search(/^##\s*Milestone States\s*$/m);
  if (blockStart === -1) return null;
  const fenceStart = content.indexOf("```yaml", blockStart);
  const fenceEnd = content.indexOf("```", fenceStart + 7);
  if (fenceStart === -1 || fenceEnd === -1) return null;
  return { path, content, block: content.slice(fenceStart, fenceEnd), fenceStart, fenceEnd };
}

// M4 (R009/R010): Reads the current state of a milestone row from the registry
// YAML block. Returns the state string or null when the registry/row is missing.
function readMilestoneState(sessionID, sessionPhaseMap, milestoneId) {
  const located = locateMilestoneRegistry(sessionID, sessionPhaseMap);
  if (!located) return null;
  const rowPattern = new RegExp(`^\\s*${escapeRegExp(milestoneId)}:\\s*([A-Za-z-]+)\\s*$`, "mi");
  const rowMatch = located.block.match(rowPattern);
  return rowMatch ? rowMatch[1] : null;
}

// M4 (R009/R010): Finds the milestone-scoped impl KD on disk for a milestone.
// Mirrors matchesSessionKD generation scoping: gen 0 matches the legacy
// `-<session>.md` suffix; gen N matches only `-<session>-genN.md`. The milestone
// prefix match is case-insensitive. Returns the filename or null.
function findMilestoneImplKD(sessionID, sessionPhaseMap, milestoneId) {
  if (!milestoneId) return null;
  const generation = getCurrentGeneration(sessionPhaseMap, sessionID);
  const knowledgeDir = join(process.cwd(), "knowledge");
  let files = [];
  try { files = readdirSync(knowledgeDir); } catch (_) { return null; }
  const prefix = `impl-${milestoneId}-`;
  const found = files.find(f => f.toLowerCase().startsWith(prefix.toLowerCase()) && matchesSessionKD(f, sessionID, generation));
  return found || null;
}

// M4 (R009/R010): Cross-checks a milestone's registry state against its impl KD
// on disk — the verifiable check-off semantics the M5 all-checked-off gate will
// consume. A row is genuinely checked-off only when BOTH the registry row says
// checked-off AND the milestone-scoped impl KD exists on disk.
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

// M5 (R011-R014): Parses the session's milestone registry rows from the
// machine-readable `## Milestone States` YAML block (the same SSOT the M4
// helpers use). Returns { rows: [{ id, state }], path, content, block,
// fenceStart, fenceEnd } or null when the registry file or YAML block is
// missing/unparsable.
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

// M5 (R011-R014): The all-checked-off gate — SWARM→VERIFY advances ONLY when
// every registry row is checked-off AND its milestone-scoped impl KD is on
// disk (checkMilestoneCheckedOff semantics: registry state + disk evidence).
// Fails closed on missing (REGISTRY_MISSING) and empty (REGISTRY_EMPTY)
// registries. Returns { ok, total, checkedOff, rows }.
function checkAllMilestonesCheckedOff(sessionID, sessionPhaseMap) {
  const registry = readMilestoneRegistry(sessionID, sessionPhaseMap);
  if (!registry) {
    debug(`REGISTRY_MISSING: no milestone registry for session ${sessionID} — SWARM cannot advance`);
    return { ok: false, total: 0, checkedOff: 0, rows: [] };
  }
  if (registry.rows.length === 0) {
    debug(`REGISTRY_EMPTY: milestone registry has no rows for session ${sessionID} — SWARM cannot advance`);
    return { ok: false, total: 0, checkedOff: 0, rows: [] };
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

// M5 (R011-R014): Repurposes the legacy SWARM safety force-advances. A stuck
// SWARM session never auto-advances to VERIFY — it marks every non-checked-off
// milestone failed in the registry, logs SAFETY_STUCK, and stays in SWARM.
// The only escape hatch is the user's /phase override (SAFETY_ESCAPE).
function markStuckMilestonesFailed(sessionID, sessionPhaseMap, trigger) {
  const registry = readMilestoneRegistry(sessionID, sessionPhaseMap);
  if (!registry) {
    debug(`SAFETY_STUCK: ${trigger} for session ${sessionID} — no registry to mark`);
    return;
  }
  for (const row of registry.rows) {
    if (row.state !== "checked-off" && row.state !== "failed") {
      const result = updateMilestoneRegistry(sessionID, sessionPhaseMap, row.id, ["failed"]);
      debug(`SAFETY_STUCK: marked ${row.id} failed (${trigger}) — ${JSON.stringify(result)}`);
    }
  }
  debug(`SAFETY_STUCK: ${trigger} for session ${sessionID} — staying in SWARM (no auto-advance)`);
}

// M4 (R009/R010): Extracts the milestone ID from an impl KD filename per the
// milestone-scoped naming contract `impl-<milestone-id>-<name>-<session>[-gen{N}].md`.
// The first token after the `impl-` prefix is the milestone ID. Returns null for
// non-impl filenames (other KD types) and invalid input — a legacy unscoped
// impl KD yields its first name token, which never matches a registry row.
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
    [STATES.VERIFY]: /^review-|^audit-/i,
    [STATES.EXTRACT]: /^composed-/i,
    [STATES.EVOLVE]: /^process-/i,
    [STATES.CLEANUP]: /^cleanup-/i
  };

  const pattern = patterns[phase];

  // DECOMPOSE advancement requires BOTH the plan KD and the milestone registry
  // (R003 dual-KD gate). The Pathfinder produces both at DECOMPOSE; SWARM must
  // not start until the registry (live state SSOT) is on disk. A plan- KD alone
  // is the EC03 case — fail-closed, no advancement.
  if (phase === STATES.DECOMPOSE) {
    const hasPlan = sessionFiles.some(f => /^plan-/i.test(f));
    const hasMilestones = sessionFiles.some(f => /^milestones-/i.test(f));
    const result = hasPlan && hasMilestones;
    debug(`Disk check DECOMPOSE: plan=${hasPlan}, milestones=${hasMilestones} → ${result}`);
    return result;
  }

  if (!pattern) return false;

  if (phase === STATES.VERIFY) {
    const hasReview = sessionFiles.some(f => /^review-/i.test(f));
    const hasAudit = sessionFiles.some(f => /^audit-/i.test(f));
    const result = hasReview || hasAudit;
    debug(`Disk check VERIFY: review=${hasReview}, audit=${hasAudit} → ${result}`);
    return result;
  }

  // M5 (R011-R014): SWARM advancement requires ALL registry milestones to be
  // checked-off with their impl KDs on disk (checkAllMilestonesCheckedOff).
  // The milestone registry is the live state SSOT — the legacy dispatch-count
  // gate (MILESTONE_COUNT, swarmDispatchCount) has no gating effect. Fails
  // closed on missing/empty/unparsable registries (REGISTRY_MISSING/EMPTY).
  if (phase === STATES.SWARM) {
    const gate = checkAllMilestonesCheckedOff(sessionID, sessionPhaseMap);
    debug(`Disk check SWARM: all-checked-off gate → ${gate.ok} (${gate.checkedOff}/${gate.total})`);
    return gate.ok;
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

    // --- State persistence (M1: file-backed SSOT) ---
    // The .state file is the single source of truth for phase (R001). The
    // in-memory sessionPhaseMap is a cache reconciled against the file on every
    // overseer message; every transition persists before it is considered
    // complete (R002); a restart restores from the file (R003); a fresh session
    // ID continues the pointed-to lifecycle via the active-session pointer (R004).
    function getStatePath(sessionID) {
      const safe = sanitizeSessionID(sessionID);
      if (!safe) return null;
      return join(PLUGIN_DIR, ".state", `.protocol-state-${safe}.json`);
    }

    function saveState(sessionID) {
      const statePath = getStatePath(sessionID);
      if (!statePath) {
        debug(`saveState: unsafe session ID rejected: ${JSON.stringify(sessionID)} (NFR004)`);
        process.stderr.write(`[protocol-gate] saveState: unsafe session ID rejected (NFR004)\n`);
        return false;
      }
      // P009: the phase entry is deleted at lifecycle end (REPORT reset).
      // Persist that state as phase 0 — the next reconcile restores
      // PROTOCOL_NOT_LOADED and honors any manual edit of this file.
      const phase = sessionPhaseMap.get(sessionID) ?? STATES.PROTOCOL_NOT_LOADED;
      const sid = sessionPhaseMap.get(`${sessionID}:sid`);
      try {
        // generation persists across lifecycle resets via the :gen map entry.
        // Written even at phase 0 so the counter survives restarts between
        // lifecycles (R003). Returns boolean so callers can enforce the NFR001
        // atomicity contract: revert in-memory :gen when save fails.
        const generation = sessionPhaseMap.get(`${sessionID}:gen`) || 0;
        // Fix M4: Omit sid from state JSON when it's null/undefined (deleted after REPORT).
        // Previously, sid: null was serialized, causing loadState to skip phase restoration
        // and producing artifacts in the state file.
        const state = { phase, generation, timestamp: Date.now() };
        if (sid) state.sid = sid;
        const stateDir = join(PLUGIN_DIR, ".state");
        mkdirSync(stateDir, { recursive: true });
        // NFR001/R005: atomic durable write — tmp file + fsync + rename. A
        // failure (disk full, permissions) surfaces to the caller as false +
        // stderr so the in-memory phase never silently diverges from disk.
        atomicWriteFileSync(statePath, JSON.stringify(state));
        // R004: keep the workspace-level active-session pointer current so a
        // restart that mints a fresh session ID can continue this lifecycle.
        if (!writeActiveSession(sessionID)) {
          debug(`saveState: state persisted but active-session pointer update failed for ${sessionID}`);
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
    // backup rename (R006) — never silently clobbered with phase 0.
    function readStateFile(sessionID) {
      const statePath = getStatePath(sessionID);
      if (!statePath) return "missing"; // unsafe session ID — nothing to read (NFR004)
      try {
        return JSON.parse(readFileSync(statePath, "utf8"));
      } catch (e) {
        if (e.code === "ENOENT") return "missing";
        try {
          const backupPath = join(PLUGIN_DIR, ".state", `.protocol-state-${sanitizeSessionID(sessionID)}.corrupt-${Date.now()}.json`);
          renameSync(statePath, backupPath);
          debug(`loadState: corrupt state file backed up to ${backupPath} (${e.message})`);
          process.stderr.write(`[protocol-gate] Corrupt state file for session ${sessionID} — backed up to ${basename(backupPath)}; initializing PROTOCOL_NOT_LOADED (R006)\n`);
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

    // --- Active-session pointer (R004) ---
    // Workspace-level file recording the most recently active lifecycle. A
    // fresh session ID with no own state file restores the pointed-to phase and
    // adopts that lifecycle, covering opencode restarting with a new session ID.
    function getActiveSessionPath() {
      return join(PLUGIN_DIR, ".state", ".active-session.json");
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
        mkdirSync(join(PLUGIN_DIR, ".state"), { recursive: true });
        atomicWriteFileSync(getActiveSessionPath(), JSON.stringify({ sessionID: safe, lastUpdated: new Date().toISOString() }));
        return true;
      } catch (e) {
        debug(`writeActiveSession error: ${e.message}`);
        return false;
      }
    }

    // P002/R001: the file is the runtime SSOT — reconcile the in-memory cache
    // on every overseer message so manual file edits are honored mid-session.
    // Priority: valid own file (R003) > active-session pointer adoption (R004)
    // > fresh PROTOCOL_NOT_LOADED init. Corrupt files back up + fresh init (R006).
    function reconcileSessionState(sessionID) {
      const state = readStateFile(sessionID);

      if (state === "missing") {
        // R004: no own state file — continue the pointed-to lifecycle when a
        // workspace-level active-session pointer exists for a different session.
        const pointer = readActiveSession();
        if (pointer && pointer.sessionID && pointer.sessionID !== sessionID) {
          const pointed = readStateFile(pointer.sessionID);
          if (pointed !== "missing" && pointed !== "corrupt" && pointed !== null) {
            const gen = pointed.generation !== undefined ? pointed.generation : 0;
            sessionPhaseMap.set(`${sessionID}:gen`, gen);
            sessionPhaseMap.set(`${sessionID}:sid`, pointed.sid || pointer.sessionID);
            const phase = typeof pointed.phase === "number" ? pointed.phase : STATES.PROTOCOL_NOT_LOADED;
            sessionPhaseMap.set(sessionID, phase);
            debug(`reconcile: adopted phase=${getPhaseName(phase)} from active-session ${pointer.sessionID} for ${sessionID} (R004)`);
            // The current session now owns the lifecycle — persist its own
            // state file and move the pointer so the adoption is durable.
            saveState(sessionID);
            return;
          }
        }
        // Fresh session — initialize PROTOCOL_NOT_LOADED and persist (R004).
        sessionPhaseMap.set(sessionID, STATES.PROTOCOL_NOT_LOADED);
        sessionPhaseMap.set(`${sessionID}:sid`, sessionID);
        saveState(sessionID);
        debug(`reconcile: initialized PROTOCOL_NOT_LOADED for ${sessionID}`);
        return;
      }

      if (state === "corrupt") {
        // R006: the corrupt file was backed up by readStateFile — initialize
        // fresh rather than trusting a half-written state. The next valid
        // transition overwrites the original path with valid JSON.
        sessionPhaseMap.set(sessionID, STATES.PROTOCOL_NOT_LOADED);
        sessionPhaseMap.set(`${sessionID}:sid`, sessionID);
        saveState(sessionID);
        debug(`reconcile: initialized PROTOCOL_NOT_LOADED after corrupt state file for ${sessionID} (R006)`);
        return;
      }

      // Valid own file — restore phase, generation, and sid (R001/R003).
      if (state.generation !== undefined) {
        sessionPhaseMap.set(`${sessionID}:gen`, state.generation);
      }
      if (state.sid) {
        sessionPhaseMap.set(`${sessionID}:sid`, state.sid);
      } else if (!sessionPhaseMap.has(`${sessionID}:sid`)) {
        sessionPhaseMap.set(`${sessionID}:sid`, sessionID);
      }
      const phase = typeof state.phase === "number" ? state.phase : STATES.PROTOCOL_NOT_LOADED;
      sessionPhaseMap.set(sessionID, phase);
      debug(`reconcile: restored phase=${getPhaseName(phase)} sid=${state.sid} for ${sessionID} (R001)`);
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

    // R013/P014: restart-proof check-off — the impl KD filename is the ONLY
    // source of the parent lifecycle. Candidate parent sessions are collected
    // from the on-disk .state files (which survive restart) plus the in-memory
    // overseer cache; the filename's embedded `-{sessionID}-gen{N}` suffix
    // selects the parent via matchesSessionKD. A fresh instance with an empty
    // overseerSessions set still checks the milestone off (AC013).
    function collectParentSessionCandidates() {
      const candidates = new Set(overseerSessions);
      try {
        const stateDir = join(PLUGIN_DIR, ".state");
        for (const f of readdirSync(stateDir)) {
          const m = f.match(/^\.protocol-state-(.+)\.json$/);
          if (m) candidates.add(m[1]);
        }
      } catch (_) {}
      return [...candidates];
    }

    // Persisted generation for a session — reads the .state file so check-off
    // matches the correct lifecycle after a restart when the in-memory map is
    // empty (the file is the SSOT, R014). Returns null when no valid file
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

    // M3 (R012/R013): When the artisan writes its milestone-scoped impl KD,
    // advance that milestone to checked-off in the parent lifecycle's registry.
    // The impl KD on disk IS the verifiable evidence of completion — the
    // SWARM→VERIFY gate reads it back via checkMilestoneCheckedOff. Only a row
    // in-progress in the registry can complete (R012); the parent session and
    // generation come from the filename + on-disk state, never from in-memory
    // session state alone.
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
          debug(`M3 auto check-off: impl KD for milestone ${milestoneId} (parent ${candidate}) → ${JSON.stringify(result)}`);
          break;
        }
      }
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
        // P002/R001: the state file is the runtime SSOT — reconcile the
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

    // --- Hook: command.execute.before (R008) ---
    // Implements the /phase slash command — the single user-facing override
    // path. Validates the argument against STATES (rejections: 99, INVALID,
    // empty), sets the phase in memory, persists via saveState, and replies
    // with a deterministic confirmation. Any valid phase 0-12 is accepted with
    // no forward-jump cap (R009); the command template is confirmation-only —
    // the LLM never hand-writes state files (R007/NFR005).
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
      // Re-capture the session ID so checkDiskAdvancement can filter KDs by
      // session — required when /phase starts a fresh lifecycle.
      if (!sessionPhaseMap.has(`${sessionID}:sid`)) {
        sessionPhaseMap.set(`${sessionID}:sid`, sessionID);
      }
      overseerSessions.add(sessionID);
      saveState(sessionID);
      // M5 (R011-R014): the user's /phase override is the ONLY escape hatch
      // from a stuck SWARM — the automatic safety mechanisms never advance it.
      if (prevPhase === STATES.SWARM && n !== STATES.SWARM) {
        debug(`SAFETY_ESCAPE: /phase override ${getPhaseName(prevPhase)} → ${getPhaseName(n)} for session ${sessionID} — manual escape from SWARM`);
      }
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
          // M4 (R009/R010): the artisan's milestone-scoped impl KD write is the
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
          // advance or suppress the next generation. R102: pass the ENDING
          // generation (currentGen, captured before the increment) so a reused
          // session ID never deletes the new lifecycle's KDs. EC-008: cleanup
          // failure must not block the phase reset — wrapped in try-catch.
          // EC-004 accepted race: any KD written between the REPORT trigger and
          // this cleanup belongs to the ending lifecycle; deletion is safe.
          try {
            cleanupLifecycleKDs(sessionID, currentGen);
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
        const relPath = toProjectRelative(path);
        const isTemplate = relPath.includes("templates");
        const isSkillFile = relPath.endsWith("/SKILL.md") || relPath.includes("/skills/");

        if (phase === STATES.SWARM) {
          // SWARM phase: dispatcher visibility — the Overseer reads the plan and
          // the milestone registry to track milestone state and drive
          // per-milestone artisan dispatches. All other reads stay blocked.
          const isPlanKD = /^knowledge\/plan-/i.test(relPath) || /\/knowledge\/plan-/i.test(relPath);
          const isMilestonesKD = /^knowledge\/milestones-/i.test(relPath) || /\/knowledge\/milestones-/i.test(relPath);
          if (!isPlanKD && !isMilestonesKD) {
            debug(`read: BLOCKED phase=${phaseName} path=${path} (SWARM reads restricted to plan and milestone registry KDs)`);
            throw new ProtocolGateError(ERROR_TEMPLATES.BLOCKED_WRONG_PHASE.code, "❌ BLOCKED: Wrong phase. Read from knowledge/plan-*.md or knowledge/milestones-*.md", "Read from knowledge/plan-*.md or knowledge/milestones-*.md only");
          }
        } else if (phase === STATES.INTENT || phase === STATES.REPORT) {
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
          // R003/P008: cleanup the ending lifecycle's KDs. R102: pass the
          // ENDING generation (currentGen) so newer generations survive a
          // reused session ID; EC-008 try-catch (see write handler).
          try {
            cleanupLifecycleKDs(sessionID, currentGen);
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

      // R016/P017: a SWARM re-dispatch must re-open its checked-off milestone
      // BEFORE the all-checked-off gate runs. The gate is checked on the same
      // task call (below); without the re-open first, an all-done registry would
      // advance SWARM→VERIFY and the re-dispatch would be blocked as a wrong
      // agent before the task handler ever runs. Only genuine artisan dispatches
      // to SWARM's agent advance the registry; every other task call passes
      // through untouched.
      // R017/P019 (issue-7): MILESTONE_ID cardinality is validated BEFORE any
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
                if (currentPhase === STATES.SWARM) {
                  // M5 (R011-R014): repurposed — a stuck SWARM never
                  // auto-advances to VERIFY. Mark stuck milestones failed,
                  // reset counters, stay in SWARM. User /phase is the escape.
                  markStuckMilestonesFailed(sessionID, sessionPhaseMap, `FORCE ADVANCE at ${currentFailures} failures`);
                  diskCheckFailures.set(sessionID, 0);
                  phaseRedispatchCount.delete(`${sessionID}:${currentPhase}`);
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
                // R003: Check re-dispatch cap BEFORE pendingVerification guard
                const redispatchKey = `${sessionID}:${currentPhase}`;
                const redispatches = phaseRedispatchCount.get(redispatchKey) || 0;
                if (redispatches >= 5 && tool === "task") {
                  if (currentPhase === STATES.SWARM) {
                    // M5 (R011-R014): repurposed — the redispatch cap during
                    // SWARM blocks the dispatch, marks the stuck milestone
                    // failed, and throws SAFETY_STUCK (no auto-advance).
                    markStuckMilestonesFailed(sessionID, sessionPhaseMap, `REDISPATCH CAP at ${redispatches} re-dispatches`);
                    diskCheckFailures.set(sessionID, 0);
                    phaseRedispatchCount.delete(`${sessionID}:${currentPhase}`);
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
                      // M5 (R011-R014): repurposed — a stuck SWARM never
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
              // M5 (R011-R014): MILESTONE_COUNT is no longer extracted or
              // stored — the all-checked-off registry gate replaces count-based
              // advancement, so count signals have no gating effect (AC024).
              // M3: per-milestone registry tracking runs in the pre-gate block
              // above (R016 re-open must precede the all-checked-off gate).
              // swarmDispatchCount remains a pure counter — it has no gating
              // effect (M5: the all-checked-off registry gate replaces it).
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

        // R010 (AC010): during SWARM, surface the milestone list (IDs + live
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
      extractMilestoneIdFromPrompt,
      collectMilestoneIds,
      updateMilestoneRegistry,
      extractMilestoneIdFromImplKD,
      findMilestoneImplKD,
      readMilestoneState,
      checkMilestoneCheckedOff,
      readMilestoneRegistry,
      checkAllMilestonesCheckedOff,
      markStuckMilestonesFailed,
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
      reconcileSessionState,
      ProtocolGateError,
      ERRORS: ERROR_TEMPLATES,
      get lastSeenSession() { return lastSeenSession; }
    };
  }
};
