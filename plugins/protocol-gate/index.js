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
// Debug enablement (sentinel-first): set PROTOCOL_GATE_DEBUG=1 in the
// environment to enable, or create the `.debug` sentinel file next to the
// plugin at plugins/protocol-gate/.debug (absolute: join(PLUGIN_DIR,
// ".debug") derived from this file's own directory, so it works from any
// startup cwd — logs always land INSIDE the config dir). The env var only
// reaches the plugin host when the background service itself starts with
// it — a later client launch cannot inject it into a running service — so
// the sentinel file is the reliable switch across workspaces. Precedence:
// env >= sentinel (either one enables; see getEnablementState()).
// Writes to plugins/logs/protocol-gate.log; set PROTOCOL_GATE_LOG_DIR to
// override the directory — the seam the test suite uses to isolate writes.
// Set PROTOCOL_GATE_DEBUG_FILE to redirect the sentinel path in tests.
// Always-on load-signal: every load overwrites the tiny status file
// <resolved-log-dir>/protocol-gate.status (default
// plugins/logs/protocol-gate.status) with { gate, ts, seq, pid, enabled,
// via, sentinelPath, logFile, logWritable } — readable even when logging is
// so "loaded, logging off" is distinguishable from "not loaded". When
// enabled, a timestamped pid-attributed `gate loaded` line is appended to
// the log. Write/mkdir failures are counted via getDroppedLogCount() and
// surfaced in the enablement state — never silently dropped, never stderr.
import { execFileSync } from "child_process";
import { createHash } from "crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { Plugin } from "@opencode/plugin";
import { parseSegments } from "./segments.js";
import {
  adviseDenial,
  adviseDenialFromAttemptLog,
  clearAttributionCache,
  getAttributionAgentsDir,
  loadAgentShellAllowlist,
  parseAgentShellAllowlist,
} from "./attribution.js";
import {
  escapeRegExp,
  extractImplKDGeneration,
  getKDLookupSIDs,
  matchesSessionKDAnyGeneration,
  matchesSessionKD,
  matchesSessionKDForSession,
  matchesSessionKDPinnedGeneration,
  sanitizeSessionID,
} from "./kd-match.js";
import { atomicWriteFileSync } from "./fs-atomic.js";
import { PHASE_INSTRUCTIONS, STATES, TOOL_ALLOWLIST, TOOL_RESTRICTIONS, TRANSPORT_TOOLS, admitTool } from "./phases.js";

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

// The one definition of the per-session state file path. Module-level so the
// generation resolution can read persisted state without a server instance;
// the server's getStatePath delegates here rather than restating the shape.
function getStateFilePath(sessionID) {
  const safe = sanitizeSessionID(sessionID);
  if (!safe) return null;
  return join(getStateDir(), `.protocol-state-${safe}.json`);
}

function getKnowledgeDir(sessionID) {
  // Shared project-root seam with knowledge-gate. The precedence is:
  // 1. PROTOCOL_GATE_KNOWLEDGE_DIR — explicit override (tests, production seam)
  // 2. KNOWLEDGE_GATE_PROJECT_ROOT — shared env seam with knowledge-gate so
  //    a session's lifecycle KDs and its issues/memories resolve to the same root
  // 3. Per-session learned dir — captured from absolute `knowledge/` paths in
  //    tool args (a session's own traffic is the strongest evidence of where
  //    its KDs live, independent of server cwd)
  // 4. Server project root — captured from server() input.directory at load
  //    (the SDK contract: the project this plugin instance serves; the SDK
  //    explicitly prefers it over process.cwd() for resolving paths)
  // 5. join(process.cwd(), "knowledge") — cwd fallback (unchanged default)
  if (process.env.PROTOCOL_GATE_KNOWLEDGE_DIR) {
    return resolve(process.env.PROTOCOL_GATE_KNOWLEDGE_DIR);
  }
  if (process.env.KNOWLEDGE_GATE_PROJECT_ROOT) {
    return join(resolve(process.env.KNOWLEDGE_GATE_PROJECT_ROOT), "knowledge");
  }
  if (sessionID !== undefined && sessionID !== null) {
    const learned = sessionKnowledgeDirs.get(sessionID);
    if (learned) return learned;
  }
  if (serverProjectRoot !== null) {
    try {
      if (existsSync(serverProjectRoot)) return join(serverProjectRoot, "knowledge");
    } catch (_) {}
  }
  return join(process.cwd(), "knowledge");
}

// Project root this plugin instance serves, captured from server() input at
// load. Module-level (like the env seams) so module-scope helpers share it;
// explicit env overrides above always win, and per-session learned dirs win
// over this default. Null until a server() call provides a directory.
let serverProjectRoot = null;

// Per-session knowledge dirs learned from absolute tool-arg paths. A session
// whose traffic references /abs/path/knowledge/... has its KDs there,
// regardless of server cwd. Keyed by session so concurrent sessions in
// different workspaces never cross-contaminate (a wrong dir can only cause
// missed matches — filename+session+generation matching still guards every
// advancement — never false ones).
const sessionKnowledgeDirs = new Map();

function setServerProjectRoot(dir) {
  // Null clears (fresh server instance). Non-empty strings resolve.
  serverProjectRoot = typeof dir === "string" && dir.length > 0 ? resolve(dir) : null;
}

// Path-like tool-arg keys worth learning from. Deliberately NOT content or
// prompt text: only dedicated path fields, so KD references inside file
// contents can never redirect resolution.
const LEARNABLE_PATH_KEYS = ["filePath", "path", "file", "filename", "target", "dir", "cwd", "workdir"];

function learnKnowledgeDirFromArgs(sessionID, args) {
  if (!sessionID || !args || typeof args !== "object") return;
  if (sessionKnowledgeDirs.has(sessionID)) return;
  for (const k of LEARNABLE_PATH_KEYS) {
    const v = args[k];
    if (typeof v !== "string") continue;
    const normalized = v.replace(/\\/g, "/");
    const idx = normalized.indexOf("/knowledge/");
    if (idx > 0 && normalized.startsWith("/")) {
      sessionKnowledgeDirs.set(sessionID, normalized.slice(0, idx + "/knowledge".length));
      debug(`learned knowledge dir for session ${sessionID}: ${normalized.slice(0, idx + "/knowledge".length)}`);
      return;
    }
  }
}

// Phase tables (STATES, PHASE_INSTRUCTIONS, TOOL_ALLOWLIST, TOOL_RESTRICTIONS,
// TRANSPORT_TOOLS, admitTool) live in ./phases.js — gate-local, imported above
// and re-exported by reference in the test-access block below.

// Retention cap for the per-session verbatim raw-intent capture. The
// chat.message hook keeps the opening request plus the newest follow-ups, up
// to RAW_INTENT_MAX_MESSAGES overseer messages, so the INTENT-phase
// systemTransform injection stays bounded.
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

// Tools whose calls trigger the disk-evidence advancement check
// (checkDiskAdvancement). read/shell widen the gate's disk-check surface so the
// reconciliation backstop (reconcileStuckRowsFromDiskEvidence) runs on the
// Overseer's verification reads — the F5 gap that let a stuck row go unhealed.
// The gate still advances ONLY on the all-checked-off verdict.
// skill is the universal disk-check driver: allowlisted in every phase
// with no handler side effects, so its calls purely re-evaluate
// lifecycle state against KD evidence on disk.
const DISK_CHECK_TOOLS = ["write", "glob", "skill", "subagent", "read", "shell"];

class ProtocolGateError extends Error {
  constructor(code, message, guidance) {
    super(message);
    this.name = "ProtocolGateError";
    this.code = code;
    this.guidance = guidance;
  }
}

const ERROR_TEMPLATES = {
  BLOCKED_WRONG_PHASE: { code: "BLOCKED_WRONG_PHASE", message: "❌ BLOCKED: Wrong phase. Use [tools] in [phases]", guidance: "Wait for the phase to advance" },
  BLOCKED_UNINITIALIZED: { code: "BLOCKED_UNINITIALIZED", message: "⏳ WAIT: Awaiting chat.params initialization", guidance: "Wait for chat.params to initialize" },
  WRONG_AGENT: (agent) => ({ code: "WRONG_AGENT", message: `❌ WRONG AGENT: Incorrect agent dispatched. Expected: ${agent}`, guidance: `Dispatch to ${agent}` }),
  CYCLE_LIMIT_EXCEEDED: { code: "CYCLE_LIMIT_EXCEEDED", message: "❌ ERROR: Backward transition cycle limit exceeded. Escalate to user", guidance: "Escalate to user" },
  FABRICATED_SECTION: { code: "FABRICATED_SECTION", message: "❌ FABRICATED: Intent KD contains fabricated section. Follow the intent template exactly", guidance: "Follow the intent template exactly — Raw Request, Triage Notes, Next Steps, Process Friction only" },
  MULTI_MILESTONE: { code: "MULTI_MILESTONE", message: "❌ MULTI_MILESTONE: Multiple milestones in single dispatch", guidance: "Include exactly one MILESTONE ID: <milestone-id> field per dispatch" },
  GITIGNORED_STAGE_REJECTED: { code: "GITIGNORED_STAGE_REJECTED", message: "❌ GITIGNORED_STAGE_REJECTED: git add would stage gitignored knowledge/ paths — knowledge/ is workflow meta and stays out of the commit set", guidance: "Stage only intended tracked files — run `git add <tracked-path>` (AGENTS.md, agents/, skills/, plugins/, tests/, opencode.json) or `git add .` to stage all non-ignored changes" },
  SHELL_DENIED_ATTRIBUTED: { code: "SHELL_DENIED_ATTRIBUTED", message: "SHELL DENIED (attributed — see message)", guidance: "Follow the Try next line in the message" },
  INTENT_BOUNDARY_CLOSED: { code: "INTENT_BOUNDARY_CLOSED", message: "❌ INTENT BOUNDARY CLOSED: write/edit of intent-*.md outside INTENT", guidance: "Run /phase INTENT to reopen the INTENT edit window, then edit knowledge/intent-*.md" },
  GENERATION_HELD: (generation, holders) => ({
    code: "GENERATION_HELD",
    message: `❌ GENERATION_HELD: generation ${generation} is already held by an unfinished lifecycle of this session (${(holders || []).join(", ")})`,
    guidance: `Start this lifecycle at a free generation — the gate allocates one above every label on disk and records it as LIFECYCLE_GENERATION_ALLOCATED — then rewrite the INTENT with that number in its filename. At the same generation the filename carries no discriminator, so the two lifecycles' evidence would be one set.`
  })
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

// Persisted lifecycle state for a session, read from the .state file — the SSOT
// across restarts, when the in-memory map is empty. `present:false` means no
// readable file (callers fall back to the map); a file without a generation
// field is a legacy state and reads as generation 0.
function readPersistedLifecycleState(sessionID) {
  const statePath = getStateFilePath(sessionID);
  if (!statePath) return { present: false, generation: null, phase: null };
  try {
    const data = JSON.parse(readFileSync(statePath, "utf8"));
    return {
      present: true,
      generation: typeof data.generation === "number" ? data.generation : 0,
      phase: typeof data.phase === "number" ? data.phase : null
    };
  } catch (_) {
    return { present: false, generation: null, phase: null };
  }
}

// A lifecycle is identified by the generation its own artifacts carry, never by
// the persisted counter. Every lifecycle writes its INTENT KD first and the
// INTENT edit window closes behind it, so that artifact's embedded `-gen{N}` is
// the lifecycle's name. The counter is only the allocator (see
// allocateLifecycleGeneration) and moves at REPORT, so a lifecycle can start
// under a counter that already ran past its label — an earlier lifecycle's
// REPORT moved it, or the label was inherited from a previous INTENT. Resolving
// evidence against the counter in that state refuses the running lifecycle's own
// artifacts and wedges it, so lookups resolve against this anchor instead.
function findLifecycleAnchor(sessionID) {
  const knowledgeDir = getKnowledgeDir(sessionID);
  let files = [];
  try { files = readdirSync(knowledgeDir); } catch (_) { return null; }
  const candidates = [];
  for (const f of files) {
    if (!/^intent-/i.test(f)) continue;
    const generation = extractImplKDGeneration(f, sessionID);
    if (generation === null) continue;
    candidates.push({ file: f, generation, mtimeMs: getFileMtimeMs(join(knowledgeDir, f)) });
  }
  if (candidates.length === 0) return null;
  // Newest anchor wins: a lifecycle's INTENT is written once, at its start, so
  // the newer file is the later lifecycle. Generation and filename break an
  // mtime tie deterministically — a same-millisecond pair must never make the
  // resolved lifecycle depend on readdir order.
  candidates.sort((a, b) =>
    (b.mtimeMs - a.mtimeMs) || (b.generation - a.generation) || a.file.localeCompare(b.file)
  );
  return { generation: candidates[0].generation, file: candidates[0].file, candidates };
}

// The generation every lifecycle-scoped KD lookup resolves against. Falls back
// to the persisted counter only when no anchor governs — a session that has not
// written its INTENT yet, a generation-0 legacy lifecycle, or a session still in
// INTENT. That last case is not an oversight: while the session sits in INTENT,
// any INTENT on disk belongs to a prior lifecycle (this lifecycle's is the one
// being written), so nothing on disk can name the running lifecycle and the
// allocated number is its identity.
function getActiveLifecycleGeneration(sessionPhaseMap, sessionID) {
  const persistedState = readPersistedLifecycleState(sessionID);
  // The in-memory value wins when it is set: it is seeded from this same file
  // at load and is the live value afterwards. The file is the fallback a restart
  // reads, and its `generation: 0` for a legacy file must not override a
  // generation the session is actually running at.
  const inMap = sessionPhaseMap.get(`${sessionID}:gen`);
  const persisted = typeof inMap === "number"
    ? inMap
    : (persistedState.generation ?? 0);
  const phase = sessionPhaseMap.get(sessionID) ?? persistedState.phase;
  const pastIntent = typeof phase === "number" && phase > STATES.INTENT;
  const anchor = pastIntent ? findLifecycleAnchor(sessionID) : null;
  if (!anchor) return persisted;
  if (anchor.candidates.length > 1) {
    const others = anchor.candidates.slice(1).map(c => `${c.file}@gen${c.generation}`).join(",");
    gateRecordEvent("LIFECYCLE_ANCHOR_AMBIGUOUS", [
      ["session", sessionID],
      ["activeGen", anchor.generation],
      ["anchor", anchor.file],
      ["others", others]
    ], `several lifecycle INTENTs are on disk for this session — the newest anchors the running lifecycle; the others belong to prior or abandoned lifecycles and stay inert only where their generation differs`, `LIFECYCLE_ANCHOR_AMBIGUOUS|${sessionID}|a:${anchor.generation}|f:${anchor.file}|o:${others}`);
  }
  if (anchor.generation === persisted) return persisted;
  gateRecordEvent("LIFECYCLE_GENERATION_RECONCILED", [
    ["session", sessionID],
    ["persistedGen", persisted],
    ["activeGen", anchor.generation],
    ["anchor", anchor.file]
  ], `evidence resolves against the generation this lifecycle's own artifacts carry; the persisted counter is the allocator and sits at a different number`, `LIFECYCLE_GENERATION_RECONCILED|${sessionID}|p:${persisted}|a:${anchor.generation}|f:${anchor.file}`);
  return anchor.generation;
}

// The number the lifecycle starting now will carry. Handing out a number an
// existing artifact of this session already carries is what lets an unfinished
// lifecycle's evidence pass for a fresh one's, so the allocator takes one above
// both the counter and every generation already on disk — it never reuses a
// label and never moves backwards. Called at the REPORT reset, where the ending
// lifecycle's artifacts are still on disk and the next lifecycle begins.
function allocateLifecycleGeneration(sessionPhaseMap, sessionID) {
  const counter = getCurrentGeneration(sessionPhaseMap, sessionID);
  const knowledgeDir = getKnowledgeDir(sessionID);
  let files = [];
  try { files = readdirSync(knowledgeDir); } catch (_) { return counter + 1; }
  let highest = -1;
  for (const f of files) {
    if (f.toLowerCase().endsWith(".superseded.md")) continue;
    const generation = extractImplKDGeneration(f, sessionID);
    if (generation === null) continue;
    if (generation > highest) highest = generation;
  }
  const allocated = Math.max(counter, highest) + 1;
  gateRecordEvent("LIFECYCLE_GENERATION_ALLOCATED", [
    ["session", sessionID],
    ["counter", counter],
    ["highestOnDisk", highest],
    ["allocated", allocated]
  ], `the next lifecycle is named ${allocated}: one above the counter and above every generation this session's artifacts already carry, so no running lifecycle can be handed a label in use`, `LIFECYCLE_GENERATION_ALLOCATED|${sessionID}|c:${counter}|h:${highest}|n:${allocated}`);
  return allocated;
}

// KD session matchers (matchesSessionKD*, getKDLookupSIDs) live in
// ./kd-match.js — gate-local, imported above and re-exported by reference in
// the test-access block below.

// Superseded-impl evidence probe for the consistency check: a
// `*.superseded.md` impl file for the current session counts as evidence
// that SWARM is not missing its KD — after a reopen the only impl evidence
// may be superseded files, and falsely regressing SWARM→DECOMPOSE would
// jump the phase machine backward. The shared predicate
// matchesSessionKD/matchesSessionKDAnyGeneration is UNCHANGED —
// this probe is scoped to the consistency check only, never to the shared
// evidence predicate.
function hasSupersededImplEvidence(files, sessionID) {
  return files.some(f => {
    if (!/^impl-/i.test(f)) return false;
    if (!f.toLowerCase().endsWith(".superseded.md")) return false;
    return matchesSessionKDAnyGeneration(f.slice(0, -".superseded.md".length), sessionID);
  });
}

// Correction-section headers the pre-cleanup hook recognizes in lifecycle
// KDs. SPEC amendments and critical corrections land in sections like
// `## Correction` or `## Amendment`; the hook archives these before
// cleanupLifecycleKDs() deletes the KDs.
const CORRECTION_SECTION_RE = /^##\s+(?:Issue-\d+\s+)?(?:Correction|Amendment)\b/i;

// Extracts correction sections from a KD's content. Returns an array of
// { header, body } objects; empty when the file carries no correction
// section. A section runs from its `##` header to the next `##` header.
function extractCorrectionSections(content) {
  const lines = String(content || "").split(/\r?\n/);
  const sections = [];
  let current = null;
  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      current = CORRECTION_SECTION_RE.test(line) ? { header: line, body: [] } : null;
      if (current) sections.push(current);
    } else if (current) {
      current.body.push(line);
    }
  }
  return sections;
}

// Pre-cleanup hook: scans the ending generation's KDs for correction
// sections and archives them to knowledge/issues/ before
// cleanupLifecycleKDs() deletes the KDs. Runs synchronously ahead of the
// cleanup; archive failures are logged and non-blocking so the REPORT phase
// reset is never delayed. Returns the number of correction sections archived.
function preCleanupHook(sessionID, generation = 0) {
  const knowledgeDir = getKnowledgeDir(sessionID);
  let files = [];
  try {
    files = readdirSync(knowledgeDir);
  } catch (e) {
    debug(`preCleanupHook: knowledge/ dir not found for session ${sessionID} — nothing to archive`);
    return 0;
  }
  const gen = Number(generation) || 0;
  const genPattern = new RegExp(`-${sessionID}-gen${gen}\\.md$`, "i");
  const endingKDs = files.filter(f => (gen === 0 && f.endsWith(`-${sessionID}.md`)) || genPattern.test(f));
  const entries = [];
  for (const f of endingKDs) {
    let content = "";
    try {
      content = readFileSync(join(knowledgeDir, f), "utf8");
    } catch (e) {
      debug(`preCleanupHook: failed to read ${f}: ${e.message}`);
      continue;
    }
    const sections = extractCorrectionSections(content);
    if (sections.length > 0) entries.push({ file: f, sections });
  }
  if (entries.length === 0) return 0;
  const issuesDir = join(knowledgeDir, "issues");
  try {
    mkdirSync(issuesDir, { recursive: true });
  } catch (e) {
    debug(`preCleanupHook: failed to create issues dir: ${e.message}`);
    return 0;
  }
  const archivePath = join(issuesDir, `corrections-${sessionID}-gen${gen}.md`);
  const body = entries.map(({ file, sections }) => {
    const sectionText = sections.map(s => `${s.header}\n${s.body.join("\n")}`).join("\n\n");
    return `## Source: ${file}\n\n${sectionText}`;
  }).join("\n\n");
  const archiveContent = `---
title: "CORRECTIONS ARCHIVE: ${sessionID} generation ${gen}"
version: 1.0.0
status: draft
type: report
session_id: "${sessionID}"
author: protocol-gate
superseded_by: null
---

# Corrections archived before lifecycle-end cleanup

${body}
`;
  try {
    atomicWriteFileSync(archivePath, archiveContent);
    debug(`preCleanupHook: archived ${entries.reduce((n, e) => n + e.sections.length, 0)} correction sections from ${entries.length} KDs to ${archivePath}`);
  } catch (e) {
    debug(`preCleanupHook: failed to write archive ${archivePath}: ${e.message}`);
    return 0;
  }
  return entries.reduce((n, e) => n + e.sections.length, 0);
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
  const knowledgeDir = getKnowledgeDir(sessionID);
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
  // Lifecycle-end cleanup also clears the session's short-term memory store:
  // promotion already copies selected notes to long-term memory
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
  // Store-aware scratch cleanup: generic and project-scoped notes live
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

// Parses a single phase reference (number 1-12 or case-insensitive phase name)
// into a phase number. Returns null when the reference is not a valid phase.
function parseSinglePhaseArg(arg) {
  if (typeof arg !== "string") return null;
  const trimmed = arg.trim().toUpperCase();
  if (trimmed === "") return null;
  if (/^\d+$/.test(trimmed)) {
    const n = parseInt(trimmed, 10);
    if (Number.isInteger(n) && n >= 1 && n <= 12) return n;
    return null;
  }
  return Object.prototype.hasOwnProperty.call(STATES, trimmed) ? STATES[trimmed] : null;
}

// Parses a /phase command argument into a phase reference. Accepts:
//   - a single phase: number string 1-12 (e.g. "5" → ALIGN) or a phase name,
//     case-insensitive (e.g. "INTENT", "preflight") — returns a number
//   - an ordered multi-phase list: comma-separated (e.g. "3,4,5") or
//     brace-enclosed (e.g. "{3,4,5}") — returns a number[] in the given order
// Returns null when the argument is not a valid phase reference — the
// rejection cases (99, INVALID, empty, malformed list) all funnel through here.
function parsePhaseArg(arg) {
  if (typeof arg !== "string") return null;
  const trimmed = arg.trim();
  if (trimmed === "") return null;

  // Brace-enclosed list: {3,4,5} or {INTENT,PREFLIGHT}. Strip the braces and
  // fall through to the comma-split below.
  let listStr = trimmed;
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    listStr = trimmed.slice(1, -1);
  }

  if (listStr.includes(",")) {
    const parts = listStr.split(",").map(p => p.trim()).filter(p => p !== "");
    if (parts.length === 0) return null;
    const phases = [];
    for (const part of parts) {
      const n = parseSinglePhaseArg(part);
      if (n === null) return null;
      phases.push(n);
    }
    return phases;
  }

  return parseSinglePhaseArg(trimmed);
}

// Parses a V2 command invocation into the raw argument string for a command.
// Accepts the documented prompt-text shape and the bare-string form; strips a
// leading `/name` prefix when present, otherwise uses the full text. Module
// scope (not setup-local) so the suite can cover the parsing directly.
function argsFromPrompt(invocation, name) {
  const raw = invocation?.prompt?.text ?? invocation?.prompt ?? "";
  const text = typeof raw === "string" ? raw : "";
  const stripped = text.replace(new RegExp(`^\\s*\\/?${name}\\b`, "i"), "").trim();
  return stripped === text.trim() ? text.trim() : stripped;
}

// Retention cap for the per-session /phase override record. The state file
// keeps only the latest OVERRIDE_HISTORY_MAX walks so a long-lived session
// never grows its state file without bound. Named constant, exported as a
// test-access property.
const OVERRIDE_HISTORY_MAX = 20;

// Strips a trailing lifecycle-generation token from a /phase argument.
// Users reaching for `/phase align gen1` (observed in the trace session)
// mean "phase ALIGN" — the lifecycle generation stays implicit (it comes
// from the persisted `:gen` state, never from the command). Accepted suffix
// forms, case-insensitive: `gen<N>`, `gen <N>`, `generation<N>`,
// `generation <N>`. Returns { rest, generation } — generation is the parsed
// number or null when no suffix is present. The rest is returned untouched
// (still trimmed by the caller) so parsePhaseArg semantics stay strict.
function stripGenerationSuffix(arg) {
  if (typeof arg !== "string") return { rest: arg, generation: null };
  const m = String(arg).match(/^(.*?)(?:\s+gen(?:eration)?\s*(\d+))\s*$/i);
  if (!m) return { rest: arg, generation: null };
  return { rest: m[1], generation: parseInt(m[2], 10) };
}

// Appends a /phase override walk to the session's in-memory record. Each
// entry pins { at, from, to } plus the queue for multi-phase walks, the
// cleared flag for explicit clears, or the ignored generation suffix — the
// one-line record the confirmation text echoes so lifecycle KDs can cite the
// walk without reading debug logs. saveState persists the tail; the REPORT
// lifecycle-end reset drops it with the finished lifecycle.
function recordPhaseOverride(sessionPhaseMap, sessionID, entry) {
  const key = `${sessionID}:overrideHistory`;
  const history = sessionPhaseMap.get(key) || [];
  history.push(entry);
  while (history.length > OVERRIDE_HISTORY_MAX) history.shift();
  sessionPhaseMap.set(key, history);
  return history;
}

// Identical-verdict advisory: the count threshold lives here, defined once —
// agent contracts describe the repeated-verdict expectation behaviorally
// rather than naming this constant.
const IDENTICAL_FAIL_BRAKE_THRESHOLD = 2;

// File-backed store for consecutive-identical-verdict counts. The store file
// lives under the gitignored state dir (same family as the lifecycle state
// files), so counts survive an opencode restart. No in-memory cache: every
// read hits disk, so a fresh plugin load rehydrates the same counts and a
// restart neither clears an engaged brake nor fabricates one. Shape:
// { "<sessionID>:<MILESTONE>": { milestoneId, fingerprint, count, updatedAt } }.
function brakeStorePath() {
  return join(getStateDir(), ".identical-verdict-brake.json");
}

function readBrakeStore() {
  try {
    const parsed = JSON.parse(readFileSync(brakeStorePath(), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (_) {
    return {};
  }
}

function writeBrakeStore(store) {
  mkdirSync(getStateDir(), { recursive: true });
  atomicWriteFileSync(brakeStorePath(), JSON.stringify(store));
}

function brakeSlotKey(sessionID, milestoneId) {
  return `${sessionID}:${String(milestoneId).toUpperCase()}`;
}

// Records one gate verdict for a milestone and returns the consecutive run.
// An identical fingerprint extends the run; a differing fingerprint restarts
// it at 1, so flapping verdicts never accumulate toward the threshold.
function recordGateVerdict(sessionID, milestoneId, verdictFingerprint) {
  const store = readBrakeStore();
  const slot = brakeSlotKey(sessionID, milestoneId);
  const fingerprint = String(verdictFingerprint);
  const prev = store[slot];
  const count = prev && prev.fingerprint === fingerprint ? prev.count + 1 : 1;
  store[slot] = { milestoneId: String(milestoneId), fingerprint, count, updatedAt: Date.now() };
  try {
    writeBrakeStore(store);
  } catch (e) {
    debug(`brake store write failed for session ${sessionID}: ${e.message}`);
  }
  return { count, fingerprint };
}

// Diagnosed recovery: clears the session's brake slots (one milestone, or
// all when no milestone is named). A cleared slot restarts at zero — the
// next verdict begins a fresh run.
function resetGateVerdictBrake(sessionID, milestoneId) {
  const store = readBrakeStore();
  if (milestoneId === undefined) {
    const prefix = `${sessionID}:`;
    for (const key of Object.keys(store)) {
      if (key.startsWith(prefix)) delete store[key];
    }
  } else {
    delete store[brakeSlotKey(sessionID, milestoneId)];
  }
  try {
    writeBrakeStore(store);
  } catch (e) {
    debug(`brake store reset failed for session ${sessionID}: ${e.message}`);
  }
}

function getBrakeEntry(sessionID, milestoneId) {
  const entry = readBrakeStore()[brakeSlotKey(sessionID, milestoneId)];
  return entry && typeof entry.count === "number" ? entry : null;
}

function findEngagedBrakes(sessionID) {
  const store = readBrakeStore();
  const prefix = `${sessionID}:`;
  const engaged = [];
  for (const [key, entry] of Object.entries(store)) {
    if (!key.startsWith(prefix)) continue;
    if (entry && typeof entry.count === "number" && entry.count >= IDENTICAL_FAIL_BRAKE_THRESHOLD) {
      engaged.push(entry);
    }
  }
  return engaged;
}

// Parses the machine-readable diagnosis claim from /phase arguments:
// `diagnosis:<reference>` and `escalation:<reference>` tokens (bare or
// quoted). Returns { diagnosis, escalation } with null for absent tokens.
// The claim is the gate-visible half of the overseer rule — the human half
// (a recorded diagnosis note plus escalation-protocol invocation) is what
// the references point at.
function parseBrakeDiagnosisClaim(argText) {
  const text = String(argText ?? "");
  const take = (name) => {
    const m = text.match(new RegExp(`(?:^|\\s)${name}\\s*:\\s*("[^"]+"|'[^']+'|\\S+)`, "i"));
    if (!m) return null;
    return m[1].replace(/^["']|["']$/g, "");
  };
  return { diagnosis: take("diagnosis"), escalation: take("escalation") };
}

// Removes the diagnosis-claim tokens so the remaining text parses as the
// plain phase argument the override path already accepts. Claim-free input
// passes through unchanged.
function stripBrakeDiagnosisClaim(argText) {
  return String(argText ?? "")
    .replace(/(?:^|\s)(?:diagnosis|escalation)\s*:\s*("[^"]+"|'[^']+'|\S+)/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Gate check for the /phase override path, advisory-only: the user's /phase
// override always proceeds. A session with no engaged slot passes through
// untouched (a lone verdict still permits override). An engaged slot is
// recorded as an advisory diagnosis (count, milestone, fingerprint, plus any
// carried diagnosis/escalation references) in the protocol-gate log — the
// override advances regardless. Diagnosis-claim tokens travel as optional
// carriage and never gate the override; a diagnosed override clears the
// session's slots as the recorded recovery.
function evaluatePhaseOverrideBrake(sessionID, argText) {
  const engaged = findEngagedBrakes(sessionID);
  if (engaged.length === 0) return { allowed: true, engaged: false, consecutiveCount: 0 };
  const { diagnosis, escalation } = parseBrakeDiagnosisClaim(argText);
  const first = engaged[0];
  loud(`BRAKE_ENGAGED session=${sessionID} milestone=${first.milestoneId} verdict=${first.fingerprint} consecutiveCount=${first.count} diagnosis=${diagnosis ?? "none"} escalation=${escalation ?? "none"} allowed=true`);
  if (diagnosis && escalation) {
    resetGateVerdictBrake(sessionID);
  }
  return { allowed: true, engaged: true, consecutiveCount: first.count, milestoneId: first.milestoneId, fingerprint: first.fingerprint, diagnosis, escalation };
}
// Phase hops that are producible without a subagent dispatch: INTENT is
// written by the Overseer itself, and REPORT is the terminal hop — nothing
// follows it. Every other live phase must be reachable through a subagent
// dispatch or the walk would commit a hop no agent can ever satisfy.
const WALK_PRODUCER_PATHS = Object.freeze({
  [STATES.INTENT]: "overseer-write",
  [STATES.REPORT]: "lifecycle-end"
});

// Full-walk pre-validation for a /phase override queue. Checks four classes in
// order and reports the first unsatisfiable hop:
//   0. hop-after-terminal — REPORT is the last hop a walk may name;
//   1. scope — every hop resolves to a phase carrying a tool-scope entry, so
//      the walk never lands where no tool contract is documented;
//   2. gate-type — every hop resolves to a phase with a known advancement
//      gate (KD prefix, dual-KD, or verdict gate), so the walk never lands
//      where no evidence check can run;
//   3. not-producible — every hop is reachable by an agent (a subagent dispatch
//      or one of the two documented producer paths), so the walk never names a
//      hop nothing can complete.
// Connectivity is deliberately NOT checked: a multi-phase argument is a
// forward plan, and the user's ordering wins — an ordered list is traversed as
// given, so the walk is never rejected for being "not backward". Returns null
// when the whole walk is committable, or { from, to, reason } with reason one
// of "hop-after-terminal" | "scope" | "gate-type" | "not-producible". The
// second parameter is retained so the test-access signature stays stable; the
// walk no longer consults the backward-transition graph. The scope/gate tables
// are injectable for unit tests; defaults are the live gate tables.
function validateMultiPhaseWalk(phases, currentPhase, _backwardTransitions, overrides) {
  const tables = overrides || {};
  const allowlist = tables.toolAllowlist || TOOL_ALLOWLIST;
  const prefixes = tables.gatePrefixes || KD_TYPE_PREFIXES;
  const hops = Array.isArray(phases) ? phases : [phases];
  // REPORT ends the lifecycle — no hop may follow it.
  const reportAt = hops.indexOf(STATES.REPORT);
  if (reportAt !== -1 && reportAt !== hops.length - 1) {
    return { from: hops[reportAt], to: hops[reportAt + 1], reason: "hop-after-terminal" };
  }
  for (let i = 0; i < hops.length; i++) {
    if (!allowlist[getPhaseName(hops[i])]) {
      return { from: i === 0 ? currentPhase : hops[i - 1], to: hops[i], reason: "scope" };
    }
  }
  for (let i = 0; i < hops.length; i++) {
    const gate = prefixes[hops[i]];
    // REPORT is terminal — its advancement demand (lifecycle end, no KD
    // evidence) is known, so overrides naming it stay committable.
    const known = hops[i] === STATES.REPORT || (Array.isArray(gate) ? gate.length > 0 : !!gate);
    if (!known) {
      return { from: i === 0 ? currentPhase : hops[i - 1], to: hops[i], reason: "gate-type" };
    }
  }
  for (let i = 0; i < hops.length; i++) {
    const tools = allowlist[getPhaseName(hops[i])] || [];
    if (tools.includes("subagent")) continue;
    if (WALK_PRODUCER_PATHS[hops[i]]) continue;
    return { from: i === 0 ? currentPhase : hops[i - 1], to: hops[i], reason: "not-producible" };
  }
  return null;
}

// Renders a rejected walk as a fail-closed error string. Scope, gate-type,
// structural and producibility rejections each name the hop and the reason
// class; any unrecognized reason class fails closed with a generic message (the
// walk is never silently committed).
function describeRejectedWalk(rejected) {
  const name = (p) => `${getPhaseName(p)} (${p})`;
  if (rejected.reason === "hop-after-terminal") {
    return `Error: phase ${name(rejected.to)} follows REPORT — REPORT is the terminal hop and ends the walk.`;
  }
  if (rejected.reason === "scope") return `Error: phase ${name(rejected.to)} carries no tool scope — the walk cannot be committed.`;
  if (rejected.reason === "gate-type") return `Error: phase ${name(rejected.to)} has no advancement gate — the walk cannot be committed.`;
  if (rejected.reason === "not-producible") {
    return `Error: phase ${name(rejected.to)} is not producible — no agent writes its evidence, so the hop can never complete.`;
  }
  return `Error: the override walk is not committable — phase ${name(rejected.to)} was rejected (${rejected.reason}).`;
}


// Stall probe: whether the head hop of a committed multi-phase queue has
// earned any fresh KD evidence (a session- and generation-matching file under
// the head phase's gate prefix with mtime >= since). Pure query — never
// mutates. Backs the wedged-queue error: a discarded queue whose head earned
// nothing was abandoned, never advanced through.
function queueHeadHasFreshEvidence(sessionPhaseMap, sessionID, marker) {
  if (!marker || !Array.isArray(marker.phases) || marker.phases.length === 0) return false;
  const anchor = typeof marker.hopSince === "number" ? marker.hopSince : marker.since;
  if (typeof anchor !== "number") return false;
  const prefixes = getPrefixes(marker.phases[0]);
  if (prefixes.length === 0) return false;
  let files = [];
  try {
    files = readdirSync(getKnowledgeDir(sessionID));
  } catch (_) {
    return false;
  }
  const generation = getActiveLifecycleGeneration(sessionPhaseMap, sessionID);
  const knowledgeDir = getKnowledgeDir(sessionID);
  const lowered = prefixes.map((p) => String(p).toLowerCase());
  return files.some((f) => {
    if (!matchesSessionKDForSession(f, sessionPhaseMap, sessionID, generation)) return false;
    const fl = f.toLowerCase();
    if (!lowered.some((p) => fl.startsWith(`${p}-`))) return false;
    return getFileMtimeMs(join(knowledgeDir, f)) >= anchor;
  });
}

// sanitizeSessionID lives in ./kd-match.js and atomicWriteFileSync in
// ./fs-atomic.js — gate-local, imported above.

let _logFile = null;

// Log/debug seam ownership: this gate keeps its own getLogFile /
// isDebugEnabled / debug / loud / warn seam instead of importing a shared
// plugins/lib helper. Each gate runs as an independent plugin host entry
// and stays independently deactivatable — a shared import would turn one
// helper regression into a three-gate outage and couple release cadence.
// The collapse counter below is per-gate for the same reason: process-local
// counts mean no gate's log volume can starve another gate's visibility.
function getLogFile() {
  const logDir = process.env.PROTOCOL_GATE_LOG_DIR || join(PLUGIN_DIR, "..", "logs");
  // Re-bind the cached path when the env seam moves the log directory — a
  // stale cache would keep appending to the previously resolved path.
  if (!_logFile || dirname(_logFile) !== logDir) {
    try { mkdirSync(logDir, { recursive: true }); } catch (_) { _droppedLogCount++; }
    _logFile = join(logDir, "protocol-gate.log");
  }
  return _logFile;
}

function debugFlagFile() {
  return process.env.PROTOCOL_GATE_DEBUG_FILE || join(PLUGIN_DIR, ".debug");
}

function isEnvDebugEnabled() {
  const raw = (process.env.PROTOCOL_GATE_DEBUG || "").trim().toLowerCase();
  return raw === "1" || raw === "true";
}

// Logging enablement: the per-gate DEBUG env var or the sentinel file
// above. A single `VAR=1 opencode` launch cannot enable logging when the
// TUI attaches to an already-running background service started without
// the var, so the on-disk sentinel — visible to every host process — is
// checked as well. DEBUG_FILE is the test seam (mirrors LOG_DIR).
// Only the values 1/true (case-insensitive) switch on via env; anything
// else (including 0/false) leaves the env signal off so the sentinel stays
// the unambiguous switch.
function isDebugEnabled() {
  if (isEnvDebugEnabled()) return true;
  try { return existsSync(debugFlagFile()); } catch (_) { return false; }
}

// Dropped-log counter: every log-seam write/mkdir failure lands here, so a
// failure is countable from the enablement state instead of vanishing.
// Never stderr — stderr bleeds into model prompt context.
let _droppedLogCount = 0;

function getDroppedLogCount() {
  return _droppedLogCount;
}

function resetDroppedLogCount() {
  _droppedLogCount = 0;
}

// Per-process load-signal sequence: every emit in this host process takes
// the next number, so two starts in the same millisecond still leave two
// distinguishable loaded lines for incident attribution.
let _loadSignalSeq = 0;

function debug(msg) {
  if (isDebugEnabled()) {
    try {
      appendFileSync(getLogFile(), `[${new Date().toISOString()}] [protocol-gate] ${msg}\n`);
    } catch (_) {
      _droppedLogCount++;
    }
  }
}

// Structured enablement snapshot: one object carrying every input the
// load-signal reports, so tests and operators read a single source instead
// of re-deriving precedence. Either signal switches on; env is reported
// first when both are present. The log-dir probe result rides along so an
// unwritable directory shows up as data, not as a missing file.
function probeLogDirWritable(logFile) {
  const dir = dirname(logFile);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    return { writable: false, reason: `log dir mkdir failed (${dir}): ${e.message}` };
  }
  const probe = join(dir, `.writability-probe-${process.pid}`);
  try {
    writeFileSync(probe, "");
    unlinkSync(probe);
  } catch (e) {
    return { writable: false, reason: `log dir not writable (${dir}): ${e.message}` };
  }
  return { writable: true };
}

function getEnablementState() {
  const sentinelPath = debugFlagFile();
  const logFile = getLogFile();
  let enabled = false;
  let via = "none";
  if (isEnvDebugEnabled()) {
    enabled = true;
    via = "env";
  } else {
    try {
      if (existsSync(sentinelPath)) {
        enabled = true;
        via = "sentinel";
      }
    } catch (_) {}
  }
  const probe = probeLogDirWritable(logFile);
  const state = { enabled, via, sentinelPath, logFile, logWritable: probe.writable };
  if (!probe.writable) state.reason = probe.reason;
  if (_droppedLogCount > 0) state.droppedLogs = _droppedLogCount;
  return state;
}

function getStatusFile(state) {
  return join(dirname(state.logFile), "protocol-gate.status");
}

// Always-on load-signal: overwrites the tiny status file on every load —
// even with logging off — so "loaded, logging off" reads differently from
// "not loaded". When logging is on, a timestamped pid-attributed loaded
// line is appended to the gate log, one per process start, so incident
// windows stay attributable. Write failures bump the dropped counter and
// surface on the next state read; nothing here touches stderr.
function emitLoadSignal(state) {
  const statusFile = getStatusFile(state);
  _loadSignalSeq++;
  const payload = {
    gate: "protocol-gate",
    ts: new Date().toISOString(),
    seq: _loadSignalSeq,
    pid: process.pid,
    enabled: state.enabled,
    via: state.via,
    sentinelPath: state.sentinelPath,
    logFile: state.logFile,
    logWritable: state.logWritable
  };
  if (state.reason) payload.reason = state.reason;
  if (state.droppedLogs) payload.droppedLogs = state.droppedLogs;
  try {
    writeFileSync(statusFile, JSON.stringify(payload) + "\n");
  } catch (_) {
    _droppedLogCount++;
  }
  if (state.enabled) {
    try {
      appendFileSync(state.logFile, `[${payload.ts}] [protocol-gate] gate loaded #${payload.seq} (pid ${process.pid}, via ${state.via}, status ${statusFile})\n`);
    } catch (_) {
      _droppedLogCount++;
    }
  }
}

// Startup load-signal: unconditional — a present status file proves the
// gate loaded in this host process, and the loaded line in the log (when
// enabled) pins the incident window. The sentinel file above is the
// reliable switch when client-launch env vars cannot reach an
// already-running background service.
emitLoadSignal(getEnablementState());

// Log-collapse budget (first-N-plus-count): repetitive per-call debug lines
// log the first LOG_COLLAPSE_N verbatim; the (N+1)th call logs one summary
// line carrying the running total and further calls stay silent. N is fixed
// for this gate (3). Verdict, block, and error lines never route through
// here — only the high-volume non-overseer "passing through" repeats.
const LOG_COLLAPSE_N = 3;
const _collapseCounts = {};
function debugCollapsed(key, line) {
  _collapseCounts[key] = (_collapseCounts[key] || 0) + 1;
  const n = _collapseCounts[key];
  if (n <= LOG_COLLAPSE_N) { debug(line); return; }
  if (n === LOG_COLLAPSE_N + 1) debug(`${key}: first ${LOG_COLLAPSE_N} shown; further repeats collapsed (total ${n})`);
}
function resetLogCollapse() {
  for (const k of Object.keys(_collapseCounts)) delete _collapseCounts[k];
}

// Loud channel — file-only logging gated behind PROTOCOL_GATE_DEBUG.
// Previously wrote to stderr which bled into user prompts; moved to file
// logging. Emissions are per-event and rare by nature.
function loud(msg) {
  if (isDebugEnabled()) {
    try {
      appendFileSync(getLogFile(), `[${new Date().toISOString()}] [protocol-gate] ${msg}\n`);
    } catch (_) {
      _droppedLogCount++;
    }
  }
}

// Warn channel — file-only diagnostics for gate-blocking failures.
// opencode surfaces ALL process.stderr.write() output into the user prompt,
// so stderr is a prompt-corruption vector. The only safe diagnostic
// channel is fs.appendFileSync() to the effective log file
// (plugins/logs/protocol-gate.log by default), gated
// behind PROTOCOL_GATE_DEBUG like loud(). Called for failures that block gate
// progression (AUTO_CHECKOFF_FAILED, AUTO_CHECKOFF_UNMATCHED) and stalled
// SWARM dispatches.
function warn(msg) {
  if (isDebugEnabled()) {
    try {
      appendFileSync(getLogFile(), `[${new Date().toISOString()}] [protocol-gate] WARN: ${msg}\n`);
    } catch (_) {
      _droppedLogCount++;
    }
  }
}

// Always-on gate record. Unlike debug()/loud()/warn(), this writes with the
// debug flag unset: a lifecycle wedged on a rejected artifact must be
// diagnosable from the log alone, and a normal run carries no flag — the
// 2026-10-21 CLEANUP non-advance left no trace for exactly that reason. Callers
// emit one line per verdict, never per tool call.
function gateRecord(msg) {
  try {
    appendFileSync(getLogFile(), `[${new Date().toISOString()}] [protocol-gate] ${msg}\n`);
  } catch (_) {
    _droppedLogCount++;
  }
}

// Structured gate record: `<TOKEN>: key=value … cause=<free text>` — one line
// per event, values space-free except the trailing free-text cause, so an
// operator greps a token and reads its fields without parsing prose.
// `dedupeKey` makes the emission once-per-event instead of once-per-evaluation:
// the gate re-runs promotion and stamp settlement on every tool call, and a
// repeated evaluation of unchanged state must add no line. Keys are released
// when the milestone row re-closes (releaseGateRecordKeys), so a later
// reopen → fix cycle is recorded again rather than silenced by the earlier one.
const _gateRecordKeys = new Set();

// Milestone tag shared by every dedupe key, case-normalized so a row id and the
// token parsed out of an impl-KD filename ("m-obs" vs "M-obs") release each
// other's keys.
function gateRecordMilestoneTag(milestoneId) {
  return `m:${String(milestoneId).toUpperCase()}|`;
}

function gateRecordEvent(token, fields, cause, dedupeKey) {
  if (dedupeKey) {
    if (_gateRecordKeys.has(dedupeKey)) return false;
    _gateRecordKeys.add(dedupeKey);
  }
  const rendered = fields.map(([k, v]) => `${k}=${v}`).join(" ");
  gateRecord(cause ? `${token}: ${rendered} cause=${cause}` : `${token}: ${rendered}`);
  return true;
}

function releaseGateRecordKeys(milestoneId) {
  const tag = gateRecordMilestoneTag(milestoneId);
  for (const key of [..._gateRecordKeys]) {
    if (key.includes(tag)) _gateRecordKeys.delete(key);
  }
}

// Prose-record variant of gateRecord: same human-readable line, emitted once per
// (token, milestone, artifact set). The stale/superseded probes and the
// remediation path re-run on every tool call, so an unchanged stuck row would
// otherwise repeat its diagnosis once per call; the key carries the milestone
// tag so a successful re-close releases it (releaseGateRecordKeys).
function gateRecordOnce(msg, dedupeKey) {
  if (_gateRecordKeys.has(dedupeKey)) return false;
  _gateRecordKeys.add(dedupeKey);
  gateRecord(msg);
  return true;
}

// Git-repo bootstrap guard — guarantees the workspace is a git repo before any
// lifecycle phase runs, so the lifecycle's first git-dependent operation
// (PREFLIGHT branch creation) always has a repo to work in. Runs at server()
// init with the plugin's full Node.js access (child_process), NOT through any
// agent's bash allowlist. Idempotent: when .git exists, no subprocess is
// spawned. Never touches .gitignore — gitignore management stays the
// Committer's PREFLIGHT job. Failure is non-fatal: logs and continues so the
// Committer's PREFLIGHT remains the authoritative git-error surface.
function ensureGitRepo(directory, _execFile = execFileSync) {
  if (existsSync(join(directory, ".git"))) {
    debug(`ensureGitRepo: ${directory} is already a git repo — no action`);
    return { initialized: false, reason: "already-repo" };
  }
  try {
    _execFile("git", ["init"], { cwd: directory, stdio: "ignore" });
    debug(`ensureGitRepo: initialized git repo in ${directory}`);
    return { initialized: true, reason: "initialized" };
  } catch (e) {
    debug(`ensureGitRepo: git init failed in ${directory}: ${e.message}`);
    return { initialized: false, reason: "failed" };
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
      const invalidated = supersedeMilestoneImplKDs(sessionID, sessionPhaseMap, milestoneId);
      // Always-on reopen record: milestone, the artifacts this reopen
      // invalidated, and the cause. The record carries the stamped set the
      // supersede call just produced — recomputing it here would report a
      // different (already-stamped) set.
      gateRecordEvent("REOPEN", [
        ["session", sessionID],
        ["milestone", milestoneId],
        ["artifact", invalidated.length > 0 ? invalidated.join(",") : "none"]
      ], opts.trigger || "unattributed");
    }
    // A row returning to checked-off starts a fresh record epoch: the
    // settlement/promotion keys from the previous pass belong to that pass, and
    // a later reopen → fix cycle must be recorded rather than deduped. Its
    // stamp snapshots are dropped for the same reason — a settled row has no
    // outstanding stamp to clear.
    if (finalState === "checked-off") {
      releaseGateRecordKeys(milestoneId);
      clearStampSnapshotsForMilestone(sessionPhaseMap, sessionID, milestoneId);
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
  const generation = getActiveLifecycleGeneration(sessionPhaseMap, sessionID);
  const knowledgeDir = getKnowledgeDir(sessionID);
  let files = [];
  try { files = readdirSync(knowledgeDir); } catch (_) { return null; }
  // Registry lookup is scoped to the current session only — no cross-session
  // adoption means a prior lifecycle's registry never gates a fresh session's
  // SWARM.
  const registries = files.filter(f => /^milestones-/i.test(f) && matchesSessionKDForSession(f, sessionPhaseMap, sessionID, generation));
  if (registries.length > 1) {
    // Duplicate-registry guard: a second milestones-*.md for the same
    // session/generation makes the registry ambiguous. Fail closed (null →
    // REGISTRY_MISSING) rather than silently tracking whichever file sorts
    // first — the old find() behavior cascaded into the supersede-impl-KD
    // stall.
    warn(`DUPLICATE_REGISTRY: ${registries.length} milestone registries match session ${sessionID} generation ${generation}: ${registries.join(", ")} — failing closed (REGISTRY_MISSING)`);
    return null;
  }
  const registry = registries[0];
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

// DIVERGENCE RECOVERY PROCEDURE (swarm/50 audited recovery — operator-invoked,
// never automatic). The pinned evidence predicate below refuses to promote a
// row from a same-session impl KD whose embedded `-gen{N}` differs from the
// persisted lifecycle generation (the gen0/gen1 skew a VERIFY FAIL backtrack
// can produce), and logs a GEN_MISMATCH_SKIP line naming session, milestone,
// file generation, and persisted generation. When that skew wedges a row, the
// operator recovers in three steps:
//   Step 1 — diagnose (role: Overseer/operator; artifact: the GEN_MISMATCH_SKIP
//     log line in plugins/logs/protocol-gate.log). Read fileGen vs
//     persistedGen to confirm generation skew rather than missing evidence.
//   Step 2 — scoped-remove (role: operator, in-process via
//     deleteStaleMilestoneKD after evaluateStaleKDDeletable passes —
//     no shell grant exists for this; agents/committer.md holds no
//     `rm knowledge/*` grant by design). Applies only to files
//     satisfying the four-clause stale predicate documented below;
//     artifact: the STALE_KD_DELETE audit line, or
//     STALE_KD_DELETE_REFUSED when live evidence is attempted).
//   Step 3 — redispatch (role: Overseer; artifact: a fresh impl KD at the
//     current persisted generation, which the pinned predicate promotes, and
//     the SWARM→VERIFY gate opening on it).
// RESTART REQUIRED: plugins load once per opencode process, so this
// gate-logic change — pinning plus the skip/remove diagnostics — takes effect
// only after opencode restarts. Live behavior lags disk until then; operators
// should restart after pulling gate-logic fixes.

// Finds the milestone-scoped impl KD on disk for a milestone. Evidence
// matching is generation-pinned: the FILENAME's own embedded `-gen{N}` must
// equal the persisted lifecycle generation (matchesSessionKDPinnedGeneration);
// legacy suffix-less files count as generation 0, so they satisfy the lookup
// only in a generation-0 lifecycle. A stale prior-generation file never
// satisfies the lookup — the reconcile path below logs a GEN_MISMATCH_SKIP
// diagnostic for it instead (see the DIVERGENCE RECOVERY PROCEDURE above for
// the operator-invoked recovery). The session-id match stays mandatory, so a
// foreign session's impl KD is never evidence. Staleness within the session is
// additionally handled by supersedeMilestoneImplKDs (re-open) and
// cleanupLifecycleKDs (REPORT). The milestone prefix match is
// case-insensitive. Returns the filename or null.
function findMilestoneImplKD(sessionID, sessionPhaseMap, milestoneId) {
  if (!milestoneId) return null;
  const knowledgeDir = getKnowledgeDir(sessionID);
  let files = [];
  try { files = readdirSync(knowledgeDir); } catch (_) { return null; }
  // Impl-KD evidence is scoped to the current session only — a prior
  // lifecycle's impl KDs (under another session id) never check off a fresh
  // session's milestone rows. Files whose frontmatter carries a superseded
  // status are stale evidence from an earlier pass (stamped in place on
  // reopen) and never count, so a reopened row cannot re-complete on the
  // work the review just invalidated. Shared predicate below, so the
  // cross-check and the write-hook check-off agree on stamped rows.
  const generation = getActiveLifecycleGeneration(sessionPhaseMap, sessionID);
  const found = files.find(f => isLiveMilestoneEvidence(knowledgeDir, f, sessionID, milestoneId, generation));
  return found || null;
}

// --- Liveness allowlist (IC-1) ---
// An artifact counts as completion evidence only when its declared frontmatter
// `status` normalizes into this set. Frozen and exported because it is the one
// admission vocabulary: a status word must never mean "evidence" on one gate
// path and "stale" on another. `superseded` is deliberately absent — it is the
// stamp a reopen puts on invalidated work.
const LIVE_STATUSES = Object.freeze(["draft", "review", "approved", "amended"]);
const STALE_STATUS = "superseded";

// Locates the leading frontmatter block and reports where its body sits, so a
// rewrite can replace frontmatter lines without reflowing a single body byte.
// A leading UTF-8 BOM is stripped for the match but retained in `bom`, and
// CRLF/LF inputs match identically — normalization happens exactly once here
// (FR-02), never again in a consumer.
function frontmatterSpan(content) {
  const bom = content.charCodeAt(0) === 0xfeff ? "\ufeff" : "";
  const text = bom ? content.slice(1) : content;
  const match = text.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---(?:[ \t]*\r?\n|$)/);
  if (!match) return null;
  const bodyStart = text.indexOf("\n") + 1;
  return { bom, text, body: match[1], bodyStart, bodyEnd: bodyStart + match[1].length };
}

// Normalizes one declared value: drop a trailing `#` comment, trim, strip a
// surrounding quote pair, lowercase. A value that is empty after this is
// indistinguishable from an omitted status.
function normalizeDeclaredStatus(raw) {
  let value = String(raw ?? "").replace(/[ \t]+#.*$/, "").trim();
  const quoted = value.match(/^"([\s\S]*)"$/) || value.match(/^'([\s\S]*)'$/);
  if (quoted) value = quoted[1].trim();
  return value.toLowerCase();
}

// The single liveness parse (FR-01..FR-04). Pure over the string, so the
// write-hook (which sees incoming bytes before the runtime materializes the
// file) and the disk-reading wrapper below reach the same verdict from the
// same input. Fail-closed: only an allowlisted declared status is live.
// `declared` is the normalized value; `raw` keeps what was written for records.
function evaluateLiveness(content) {
  if (typeof content !== "string" || content.trim().length === 0) {
    return { live: false, declared: null, raw: null, reason: "empty-content" };
  }
  const span = frontmatterSpan(content);
  if (!span) return { live: false, declared: null, raw: null, reason: "unparsable-frontmatter" };
  const raws = [...span.body.matchAll(/^[ \t]*status[ \t]*:[ \t]*(.*)$/gim)].map(m => m[1]);
  if (raws.length === 0) return { live: false, declared: null, raw: null, reason: "absent-status" };
  // Two declarations cannot both govern the artifact — refuse rather than pick.
  if (raws.length > 1) return { live: false, declared: null, raw: null, reason: "ambiguous-status" };
  const raw = raws[0].trim();
  const declared = normalizeDeclaredStatus(raw);
  if (declared.length === 0) return { live: false, declared: null, raw, reason: "absent-status" };
  if (LIVE_STATUSES.includes(declared)) return { live: true, declared, raw, reason: null };
  return {
    live: false,
    declared,
    raw,
    reason: declared === STALE_STATUS ? "stale-status" : "unknown-status"
  };
}

// File-level wrapper: adds the `missing-file` verdict an unreadable artifact
// needs and emits the always-on rejection record, because only here is the path
// known. A repeated evaluation of the same path emits nothing (NFR-02), keyed
// on path + declared + reason so a different declared value still reports.
function evaluateLivenessFile(knowledgeDir, filename) {
  let content;
  try {
    content = readFileSync(join(knowledgeDir, filename), "utf8");
  } catch (_) {
    recordLivenessRejection(join(knowledgeDir, filename), null, "missing-file");
    return { live: false, declared: null, raw: null, reason: "missing-file" };
  }
  const verdict = evaluateLiveness(content);
  if (!verdict.live) recordLivenessRejection(join(knowledgeDir, filename), verdict.declared, verdict.reason);
  return verdict;
}

// Always-on rejection record (AC-06). Values stay space-free: the declared
// status is recorded in its normalized form, `<absent>` when no status parsed.
function recordLivenessRejection(path, declared, reason) {
  gateRecordEvent("LIVENESS_REJECTED", [
    ["path", path],
    ["declared", declared || "<absent>"],
    ["reason", reason]
  ], null, `LIVENESS_REJECTED|${path}|d:${declared || "<absent>"}|r:${reason}`);
}

// Legacy predicate name, redefined on the one parse (FR-04): a caller asking
// "is this stale" gets exactly the negation of "is this live", never a second
// status vocabulary.
function isStaleImplKDContent(content) {
  return !evaluateLiveness(content).live;
}

// Labels an evidence artifact with an allowlisted status (FR-14 M2). The
// frontmatter block is created when absent and only the status line changes
// when present — every other byte, body included, survives. Never rejects,
// deletes or demotes: the caller chooses `amended` for an artifact whose pass a
// FAIL invalidated and `draft` otherwise. An artifact the allowlist already
// admits is left untouched, so labelling cannot downgrade a reviewed or approved
// artifact to draft. A non-allowlisted target is refused rather than written, so
// labelling can never introduce a new stale stamp.
function labelEvidenceStatus(content, status) {
  const target = String(status || "").trim().toLowerCase();
  if (typeof content !== "string" || !LIVE_STATUSES.includes(target)) return { content, changed: false };
  if (evaluateLiveness(content).live) return { content, changed: false };
  const span = frontmatterSpan(content);
  if (!span) {
    const rest = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
    return { content: `---\nstatus: ${target}\n---\n${rest}`, changed: true };
  }
  const hasStatus = /^[ \t]*status[ \t]*:/im.test(span.body);
  const body = hasStatus
    ? span.body.replace(/^[ \t]*status[ \t]*:.*$/im, `status: ${target}`)
    : `status: ${target}\n${span.body}`;
  if (body === span.body) return { content, changed: false };
  return {
    content: `${span.bom}${span.text.slice(0, span.bodyStart)}${body}${span.text.slice(span.bodyEnd)}`,
    changed: true
  };
}

// Relative paths of every `.md` under a knowledge root, so the audit population
// is the whole tree rather than the top level: issue, memory and project records
// sit in subdirectories beside lifecycle evidence, and an audit that stopped at
// the top level would leave those unexamined. Depth is bounded because the audit
// runs by hand, and an unbounded walk over a symlinked tree never terminates.
function collectMarkdownPaths(root, rel = "", depth = 0) {
  if (depth > 4) return [];
  let entries = [];
  try { entries = readdirSync(join(root, rel), { withFileTypes: true }); } catch (_) { return []; }
  const found = [];
  for (const entry of entries) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      found.push(...collectMarkdownPaths(root, child, depth + 1));
    } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
      found.push(child);
    }
  }
  return found;
}

// M1 audit (FR-14): reports every artifact under `knowledge/` the allowlist
// rejects, without gating anything. Retained as an exported seam so the audit is
// re-runnable on a later tree — admission is already the allowlist, so this never
// runs on the hot path. One line per artifact: the strict token already says the
// artifact is refused, so a second LIVENESS_REJECTED line would double-count the
// same event.
function auditStrictLivenessWouldReject(knowledgeDir) {
  const rejected = [];
  for (const rel of collectMarkdownPaths(knowledgeDir)) {
    let content;
    try {
      content = readFileSync(join(knowledgeDir, rel), "utf8");
    } catch (_) {
      continue;
    }
    const verdict = evaluateLiveness(content);
    if (verdict.live) continue;
    rejected.push({ path: rel, declared: verdict.declared, reason: verdict.reason });
    gateRecordEvent("LIVENESS_STRICT_WOULD_REJECT", [
      ["path", rel],
      ["declared", verdict.declared || "<absent>"],
      ["reason", verdict.reason]
    ], null, `LIVENESS_STRICT_WOULD_REJECT|${join(knowledgeDir, rel)}|d:${verdict.declared || "<absent>"}|r:${verdict.reason}`);
  }
  return rejected;
}

// Shared staleness predicate for milestone completion evidence: a
// same-session impl KD filename counts as live evidence only when its
// embedded generation equals the persisted lifecycle generation AND its
// frontmatter does NOT carry a superseded status. Consulted by the
// cross-check path (findMilestoneImplKD), the write-hook check-off path
// (autoCheckOffMilestone, via the incoming-content variant above), and the
// stuck-row reconciliation path (reconcileStuckRowsFromDiskEvidence) alike,
// so registry promotion and checkMilestoneCheckedOff agree on stamped rows.
function isLiveMilestoneEvidence(knowledgeDir, filename, sessionID, milestoneId, generation) {
  const prefix = `impl-${milestoneId}-`;
  if (!filename.toLowerCase().startsWith(prefix.toLowerCase())) return false;
  if (!matchesSessionKDPinnedGeneration(filename, sessionID, generation)) return false;
  return isLiveEvidenceFile(knowledgeDir, filename);
}

// Fail-closed readability gate for the pinned evidence path: a file whose
// bytes cannot be read is not evidence — it never promotes (it is named by
// the GEN_MISMATCH_SKIP diagnostic instead). The liveness allowlist decides;
// a KD written without frontmatter is no longer live, which is what makes the
// labelling migration mandatory for pre-existing evidence.
function isLiveEvidenceFile(knowledgeDir, filename) {
  return evaluateLivenessFile(knowledgeDir, filename).live;
}

// Reads the leading frontmatter block of a knowledge KD and reports whether the
// allowlist refuses it. Canonical impl-KD filenames are stable identifiers, so
// staleness lives in the frontmatter rather than in a filename suffix. Shares
// the one parse with isLiveEvidenceFile — the two can never disagree.
function isSupersededByFrontmatter(knowledgeDir, filename) {
  return !evaluateLivenessFile(knowledgeDir, filename).live;
}

// Snapshots the on-disk impl KD behind an incoming write, so the write-hook
// can tell a genuine post-stamp rewrite (new bytes over a stamped file —
// mtime newer than the stamp by construction) from a byte-identical re-write
// (no new work). Returns { dir, base, content, stale } or null when the path
// is not an impl KD or no file is on disk yet (fresh canonical write).
// Fail-open null keeps the promotion path unchanged for fresh files.
function readImplKDSnapshot(relPath, writerSessionID) {
  if (typeof relPath !== "string" || relPath.length === 0) return null;
  const base = relPath.replace(/\\/g, "/").split("/").pop();
  if (!/^impl-/i.test(base)) return null;
  const dir = getKnowledgeDir(writerSessionID ?? undefined);
  let content;
  try {
    content = readFileSync(join(dir, base), "utf8");
  } catch (_) {
    return null;
  }
  return { dir, base, content, stale: !evaluateLiveness(content).live };
}

// Stamps a canonical impl KD as superseded in place. The filename never
// changes — only the frontmatter gains `status: superseded` (an existing
// replacement pointer in `superseded_by` is kept; when the field is absent
// it is recorded as null because the replacement does not exist yet at
// reopen time). The write is atomic so a crash cannot leave a torn KD.
function stampImplKDSuperseded(knowledgeDir, filename, milestoneId) {
  const target = join(knowledgeDir, filename);
  const content = readFileSync(target, "utf8");
  const fence = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(\s*\r?\n|$)/);
  let next;
  if (fence) {
    let body = fence[1];
    if (/^\s*status\s*:.*$/im.test(body)) {
      body = body.replace(/^\s*status\s*:.*$/im, "status: superseded");
    } else {
      body = `status: superseded\n${body}`;
    }
    if (!/^\s*superseded_by\s*:.*$/im.test(body)) {
      body = `${body}\nsuperseded_by: null`;
    }
    next = `---\n${body}\n---${fence[2]}${content.slice(fence[0].length)}`;
  } else {
    next = `---\nstatus: superseded\nsuperseded_by: null\n---\n${content}`;
  }
  atomicWriteFileSync(target, next);
  debug(`supersede: stale impl KD ${filename} stamped superseded in place (milestone ${milestoneId} re-opened)`);
}

// Rewrites KD text into the sanctioned post-reopen state (FR-05): a
// frontmatter `superseded` stamp becomes `status: amended`, and
// `superseded_by` records the canonical basename of the invalidated pass.
// An author-written `amended` (or any other live status) is accepted as-is and
// only gains the lineage field. Pure over the string so the landed-bytes path
// and the audit-remediation path share one rewrite; every other frontmatter
// line and the whole body survive byte-identical, so the fix-up content the
// artisan landed is preserved.
// Returns { content, cleared, lineageSet, refused }: cleared is true only when
// the gate flipped its own stale stamp; refused is true when the text is not
// in a state the gate may amend (no frontmatter, or a non-live status that is
// not the stale stamp) — the caller declines with `unparsable-frontmatter`
// rather than inventing a status.
function amendStampContent(content, pointer) {
  if (typeof content !== "string" || content.trim().length === 0) {
    return { content, cleared: false, lineageSet: false, refused: true };
  }
  const span = frontmatterSpan(content);
  if (!span) return { content, cleared: false, lineageSet: false, refused: true };
  const verdict = evaluateLiveness(content);
  if (!verdict.live && verdict.reason !== "stale-status") {
    return { content, cleared: false, lineageSet: false, refused: true };
  }
  const withLineage = (body) => (/^[ \t]*superseded_by[ \t]*:/im.test(body)
    ? body.replace(/^[ \t]*superseded_by[ \t]*:.*$/im, `superseded_by: ${pointer}`)
    : `${body}\nsuperseded_by: ${pointer}`);
  const build = (body) => ({
    content: `${span.bom}${span.text.slice(0, span.bodyStart)}${body}${span.text.slice(span.bodyEnd)}`,
    cleared: verdict.reason === "stale-status",
    lineageSet: true,
    refused: false
  });
  if (verdict.reason === "stale-status") {
    return build(withLineage(span.body.replace(/^[ \t]*status[ \t]*:.*$/im, "status: amended")));
  }
  // Already live: only the lineage field is written, and only when it is
  // missing or null — an author's existing pointer is never overwritten.
  const hasPointer = /^[ \t]*superseded_by[ \t]*:/im.test(span.body)
    && !/^[ \t]*superseded_by[ \t]*:[ \t]*(null|~)?[ \t]*$/im.test(span.body);
  if (hasPointer) return { content, cleared: false, lineageSet: true, refused: false };
  return build(withLineage(span.body));
}

// --- Stamp snapshots (IC-2) ---
// The reopen stamps an artifact in place, so "has new work landed since the
// stamp" is a content question, not an mtime one. A sha256 digest of the
// stamped bytes is recorded into persisted session state at reopen and removed
// once the artifact settles or its row returns to checked-off. A restart that
// loses the digest declines with `no-stamp-snapshot` rather than promoting over
// a stamp the gate cannot recognise.
function digestContent(content) {
  return createHash("sha256").update(typeof content === "string" ? content : String(content ?? ""), "utf8").digest("hex");
}

function stampSnapshotKey(milestoneId, base) {
  return `${milestoneId}|${base}`;
}

function getStampSnapshots(sessionPhaseMap, sessionID, create = false) {
  const key = `${sessionID}:stampSnapshots`;
  let snapshots = sessionPhaseMap.get(key);
  if ((!snapshots || typeof snapshots !== "object") && create) {
    snapshots = {};
    sessionPhaseMap.set(key, snapshots);
  }
  return snapshots && typeof snapshots === "object" ? snapshots : null;
}

function dropStampSnapshot(sessionPhaseMap, sessionID, milestoneId, base) {
  const snapshots = getStampSnapshots(sessionPhaseMap, sessionID);
  if (!snapshots) return;
  delete snapshots[stampSnapshotKey(milestoneId, base)];
}

// A row returning to checked-off closes the stamp epoch for its milestone —
// whatever chance of settlement remained belongs to a pass that is over.
function clearStampSnapshotsForMilestone(sessionPhaseMap, sessionID, milestoneId) {
  const snapshots = getStampSnapshots(sessionPhaseMap, sessionID);
  if (!snapshots) return;
  const prefix = `${String(milestoneId).toUpperCase()}|`;
  for (const key of Object.keys(snapshots)) {
    if (key.toUpperCase().startsWith(prefix)) delete snapshots[key];
  }
}

// saveState is closure-scoped inside server(); the reopen path that records a
// digest is module-level. The persister rides on the map itself so a digest
// reaches disk at the moment it is recorded — and so a second server instance
// in the same process can never persist the wrong lifecycle's map.
function persistSessionState(sessionPhaseMap, sessionID) {
  const persist = sessionPhaseMap && typeof sessionPhaseMap.persist === "function" ? sessionPhaseMap.persist : null;
  if (!persist) return false;
  try {
    return persist(sessionID) !== false;
  } catch (_) {
    return false;
  }
}

// Re-opening a checked-off milestone invalidates its prior completion
// evidence: the Inspector's findings mean the delivered work no longer
// passes, so the old impl KD must not re-check-off the row at the next gate
// evaluation. Staleness is recorded ON DISK by stamping the milestone's
// same-session impl KDs (any embedded generation) as superseded in their
// frontmatter — filenames stay canonical, so the evidence linkage keyed on
// Stable names cannot orphan. Stamps survive restarts — plugins load once per
// process, so no in-memory epoch marker would. Best-effort: a failed stamp
// leaves the file in place and is logged.
// Each stamped file also gets its post-stamp digest recorded in session state
// (IC-2), which is what lets settlement later prove the rewrite carried new
// work instead of trusting a transport or a timestamp.
// Returns the canonical filenames this call stamped, so the caller can record
// exactly which artifacts it invalidated instead of re-deriving the set.
function supersedeMilestoneImplKDs(sessionID, sessionPhaseMap, milestoneId) {
  const knowledgeDir = getKnowledgeDir(sessionID);
  const stamped = [];
  let files = [];
  try { files = readdirSync(knowledgeDir); } catch (_) { return stamped; }
  const prefix = `impl-${milestoneId}-`;
  for (const f of files) {
    if (!f.toLowerCase().startsWith(prefix.toLowerCase())) continue;
    if (!matchesSessionKDAnyGeneration(f, sessionID)) continue;
    if (isSupersededByFrontmatter(knowledgeDir, f)) continue;
    try {
      stampImplKDSuperseded(knowledgeDir, f, milestoneId);
      stamped.push(f);
    } catch (e) {
      debug(`supersede: stamp failed for ${f}: ${e.message}`);
    }
  }
  if (stamped.length > 0) {
    const snapshots = getStampSnapshots(sessionPhaseMap, sessionID, true);
    for (const f of stamped) {
      try {
        snapshots[stampSnapshotKey(milestoneId, f)] = digestContent(readFileSync(join(knowledgeDir, f), "utf8"));
      } catch (e) {
        debug(`supersede: digest failed for ${f}: ${e.message}`);
      }
    }
    persistSessionState(sessionPhaseMap, sessionID);
  }
  return stamped;
}

// Scoped stale-KD removal predicate and operator (swarm/50 C-SCOPED-DELETE).
// Holder: protocol-gate (in-process). There is NO `rm knowledge/impl-*`
// shell grant in agents/committer.md by design — the committer shell
// allowlist is git-only (`git add*` allow, `git add -f*` deny), and
// `knowledge/` stays untracked via `.gitignore:5` (staging via the
// committer allowlist only). Removal, when the four clauses below all
// hold, is performed in-process by deleteStaleMilestoneKD (unlinkSync
// after evaluateStaleKDDeletable passes) with audit emission on both
// paths — no shell invocation path exists. Operators consult
// evaluateStaleKDDeletable; live-generation evidence is always refused.
//
// Stale predicate (all must hold):
//   (a) basename matches `impl-<milestoneId>-<sessionId>-gen<N>.md` (or the
//       legacy `impl-<milestoneId>-<sessionId>.md`, counted as generation 0);
//       renamed `.superseded.md` provenance is never removed by this path.
//   (b) the embedded session marker equals the active lifecycle session.
//   (c) the embedded generation differs from the persisted lifecycle
//       generation, OR the artifact is not live under the liveness allowlist.
//   (d) live-generation evidence never qualifies: a file whose generation
//       equals the persisted generation and whose frontmatter is live is
//       refused deletion (predicate-level impossibility). The verdict comes
//       from the same parse the evidence path uses, so a row can never be
//       deletable here and live there.
// Audit record shapes:
//   removal: STALE_KD_DELETE session=<id> milestone=<rowId> file=<name>
//     fileGen=<N> persistedGen=<M> reason=<gen-mismatch|superseded|not-live>
//     actor=<role> deleted=true
//   refusal: STALE_KD_DELETE_REFUSED session=<id> milestone=<rowId> file=<name>
//     fileGen=<N|unknown> persistedGen=<M> reason=<...> actor=<role>
//     deleted=false
function evaluateStaleKDDeletable(filename, sessionID, persistedGeneration, liveness) {
  const unknown = { deletable: false, reason: "invalid-path", milestoneId: "unknown", fileGen: null };
  if (typeof filename !== "string" || filename.length === 0) return unknown;
  if (filename.includes("/") || filename.includes("\\")) return unknown;
  if (!/^impl-/i.test(filename)) return { ...unknown, reason: "not-impl-kd" };
  if (filename.toLowerCase().endsWith(".superseded.md")) return { ...unknown, reason: "renamed-provenance" };
  const fileGen = extractImplKDGeneration(filename, sessionID);
  if (fileGen === null) return { ...unknown, reason: "foreign-session" };
  const milestoneId = extractMilestoneIdFromImplKD(filename) || "unknown";
  const verdict = liveness && typeof liveness === "object" && typeof liveness.live === "boolean"
    ? liveness
    : evaluateLiveness(typeof liveness === "string" ? liveness : "");
  if (fileGen === persistedGeneration && verdict.live) {
    return { deletable: false, reason: "live-evidence", milestoneId, fileGen };
  }
  if (fileGen !== persistedGeneration) {
    return { deletable: true, reason: "gen-mismatch", milestoneId, fileGen };
  }
  return { deletable: true, reason: verdict.reason === "stale-status" ? "superseded" : "not-live", milestoneId, fileGen };
}

// Operator half of the scoped stale-KD removal: evaluates the four-clause
// predicate against the file on disk, removes only qualifying files, and
// emits the audit record on both paths. Returns { ok, reason, milestoneId,
// fileGen, persistedGen }. Never throws for missing/unreadable files —
// refusal with a record is the fail-closed outcome.
function deleteStaleMilestoneKD(sessionID, sessionPhaseMap, filename, actor) {
  const who = actor || "Committer";
  const knowledgeDir = getKnowledgeDir(sessionID);
  // Deletion protects the running lifecycle's live evidence, so the comparison
  // generation is the lifecycle's identity, not the allocator counter: a moved
  // counter would otherwise label the active lifecycle's own artifacts stale.
  const activeGen = getActiveLifecycleGeneration(sessionPhaseMap, sessionID);
  const persistedGen = getCurrentGeneration(sessionPhaseMap, sessionID);
  let content = null;
  try {
    content = readFileSync(join(knowledgeDir, filename), "utf8");
  } catch (_) {
    content = null;
  }
  if (typeof content !== "string") {
    loud(`STALE_KD_DELETE_REFUSED: session=${sessionID} milestone=unknown file=${filename} fileGen=unknown activeGen=${activeGen} persistedGen=${persistedGen} reason=missing actor=${who} deleted=false`);
    return { ok: false, reason: "missing", milestoneId: "unknown", fileGen: null, activeGen, persistedGen: persistedGen };
  }
  const verdictForDeletion = evaluateLiveness(content);
  const verdict = evaluateStaleKDDeletable(filename, sessionID, activeGen, verdictForDeletion);
  if (!verdict.deletable) {
    loud(`STALE_KD_DELETE_REFUSED: session=${sessionID} milestone=${verdict.milestoneId} file=${filename} fileGen=${verdict.fileGen ?? "unknown"} activeGen=${activeGen} persistedGen=${persistedGen} reason=${verdict.reason} actor=${who} deleted=false`);
    return { ok: false, reason: verdict.reason, milestoneId: verdict.milestoneId, fileGen: verdict.fileGen, activeGen, persistedGen: persistedGen };
  }
  try {
    unlinkSync(join(knowledgeDir, filename));
  } catch (e) {
    loud(`STALE_KD_DELETE_REFUSED: session=${sessionID} milestone=${verdict.milestoneId} file=${filename} fileGen=${verdict.fileGen} activeGen=${activeGen} persistedGen=${persistedGen} reason=delete-failed actor=${who} deleted=false`);
    return { ok: false, reason: "delete-failed", milestoneId: verdict.milestoneId, fileGen: verdict.fileGen, activeGen, persistedGen: persistedGen };
  }
  loud(`STALE_KD_DELETE: session=${sessionID} milestone=${verdict.milestoneId} file=${filename} fileGen=${verdict.fileGen} activeGen=${activeGen} persistedGen=${persistedGen} reason=${verdict.reason} actor=${who} deleted=true`);
  return { ok: true, reason: verdict.reason, milestoneId: verdict.milestoneId, fileGen: verdict.fileGen, activeGen, persistedGen: persistedGen };
}

// --- Deterministic stamp settlement (FR-06..FR-08) ---
// An impl-KD transport is identified by the artifact's basename, never by the
// path prefix it happens to arrive under: an absolute path, a `./` prefix and a
// nested directory all name the same artifact, and the old `^knowledge/impl-`
// guard silently dropped the two that did not match its spelling.
function isImplKDArtifactPath(filePath) {
  if (typeof filePath !== "string" || filePath.length === 0) return false;
  return /^impl-/i.test(filePath.replace(/\\/g, "/").split("/").pop());
}

// Resolves the directory settlement reads an artifact from. It is the session's
// knowledge dir and nothing else: that is the directory the SWARM gate reads the
// evidence back from (findMilestoneImplKD), so a settlement performed anywhere
// else would promote a row over a file the gate never opens. A write path is a
// hint about which artifact the writer meant, never a licence to settle a copy —
// an absolute path, a `./` prefix and a nested directory all resolve here, and a
// path that names a same-basename file elsewhere resolves here too.
function resolveArtifactDir(sessionID) {
  return getKnowledgeDir(sessionID);
}

// One record per settlement attempt, and nothing on a repeat of the same
// attempt. The key carries the artifact's directory so two lifecycles holding
// artifacts of the same name in different knowledge dirs never silence each
// other.
function settleStampDeclined(milestoneId, base, dir, reason, transport) {
  gateRecordEvent("STAMP_DECLINED", [
    ["milestone", milestoneId],
    ["artifact", base],
    ["reason", reason],
    ["transport", transport]
  ], `milestone ${milestoneId} settlement declined for ${base} (${reason}) — the row keeps its registry state and the artifact is untouched`, `STAMP_DECLINED|${dir}|${gateRecordMilestoneTag(milestoneId)}a:${base}|r:${reason}`);
}

// The three entry points one settlement implementation serves (FR-06). The tag
// is the only attribution a settlement line carries: without it a record says
// what settled but not which transport reached the settlement.
const SETTLEMENT_TRANSPORTS = ["after-hook", "swarm-gate", "stuck-row"];

// Settles one stamped artifact. Preconditions are checked in the order FR-07
// states them, and every failing branch declines with exactly one token — a
// decline never deletes, demotes or hides the artifact, and leaves the row
// in-progress so the operator's next ordinary action is a redispatch.
// Returns { settled, reason, content?, promoted? }.
function settleStampClearForArtifact(sessionID, sessionPhaseMap, { dir, base, milestoneId, transport }) {
  if (!SETTLEMENT_TRANSPORTS.includes(transport)) {
    throw new TypeError(`settleStampClearForArtifact: transport must be one of ${SETTLEMENT_TRANSPORTS.join(", ")} (got ${String(transport)})`);
  }
  if (typeof base !== "string" || base.length === 0) return { settled: false, reason: "not-cited-artifact" };
  const artifactDir = resolveArtifactDir(sessionID);
  const rowId = milestoneId || extractMilestoneIdFromImplKD(base);
  // (0) Only the canonical artifact is settleable. A caller naming another
  // directory is asking the gate to amend and promote from a file that the
  // registry check-off cross-check never reads — the wedge this guards: the copy
  // settles, the digest is dropped, and the canonical artifact's own stamp can
  // no longer be cleared by anything but a hand edit.
  if (typeof dir === "string" && dir.length > 0 && resolve(dir) !== resolve(artifactDir)) {
    settleStampDeclined(rowId || "unknown", base, artifactDir, "not-cited-artifact", transport);
    return { settled: false, reason: "not-cited-artifact" };
  }
  // (1) Only a reopened row has a stamp to clear.
  const state = rowId ? readMilestoneState(sessionID, sessionPhaseMap, rowId) : null;
  if (state !== "in-progress") {
    settleStampDeclined(rowId || "unknown", base, artifactDir, "not-in-progress", transport);
    return { settled: false, reason: "not-in-progress" };
  }
  // (2) The artifact must be this milestone's impl KD for the current session.
  if (!/^impl-/i.test(base)
    || !base.toLowerCase().startsWith(`impl-${rowId}-`.toLowerCase())
    || !matchesSessionKDAnyGeneration(base, sessionID)) {
    settleStampDeclined(rowId, base, artifactDir, "not-cited-artifact", transport);
    return { settled: false, reason: "not-cited-artifact" };
  }
  // (3) No recorded digest means the gate cannot tell a fix-up from the stamp it
  // wrote; decline rather than promote over a stamp it does not recognise.
  const snapshots = getStampSnapshots(sessionPhaseMap, sessionID);
  const snapshotDigest = snapshots ? snapshots[stampSnapshotKey(rowId, base)] : undefined;
  if (typeof snapshotDigest !== "string" || snapshotDigest.length === 0) {
    settleStampDeclined(rowId, base, artifactDir, "no-stamp-snapshot", transport);
    return { settled: false, reason: "no-stamp-snapshot" };
  }
  let landed;
  try {
    landed = readFileSync(join(artifactDir, base), "utf8");
  } catch (_) {
    settleStampDeclined(rowId, base, artifactDir, "write-failed", transport);
    return { settled: false, reason: "write-failed" };
  }
  // (4) Genuineness: the landed bytes must be new work past the stamp.
  if (digestContent(landed) === snapshotDigest) {
    settleStampDeclined(rowId, base, artifactDir, "byte-identical", transport);
    return { settled: false, reason: "byte-identical" };
  }
  // (5) The landed bytes must be in a state the gate may amend — its own stale
  // stamp, or already live. Anything else declines rather than inventing a
  // status the author never wrote.
  const rewrite = amendStampContent(landed, base);
  if (rewrite.refused) {
    settleStampDeclined(rowId, base, artifactDir, "unparsable-frontmatter", transport);
    return { settled: false, reason: "unparsable-frontmatter" };
  }
  if (rewrite.content !== landed) {
    try {
      atomicWriteFileSync(join(artifactDir, base), rewrite.content);
    } catch (_) {
      settleStampDeclined(rowId, base, artifactDir, "write-failed", transport);
      return { settled: false, reason: "write-failed" };
    }
  }
  // (6) Re-read and verify the LANDED bytes before promoting: promotion never
  // precedes evidence (FR-08).
  let settledContent;
  try {
    settledContent = readFileSync(join(artifactDir, base), "utf8");
  } catch (_) {
    settleStampDeclined(rowId, base, artifactDir, "write-failed", transport);
    return { settled: false, reason: "write-failed" };
  }
  const settledVerdict = evaluateLiveness(settledContent);
  if (!settledVerdict.live) {
    settleStampDeclined(rowId, base, artifactDir, "unparsable-frontmatter", transport);
    return { settled: false, reason: "unparsable-frontmatter" };
  }
  // Exactly one always-on line per settlement: the gate's own stamp rewrite is
  // STAMP_CLEARED, while an artifact the author already made live records the
  // lineage it gained instead — two lines for one event would double-count it.
  if (rewrite.cleared) {
    gateRecordEvent("STAMP_CLEARED", [
      ["milestone", rowId],
      ["artifact", base],
      ["transport", transport]
    ], `milestone ${rowId} fix-up rewrite at ${base} — stamp cleared (status: ${settledVerdict.declared}, superseded_by: ${base}); the row re-completes on the landed evidence`, `STAMP_CLEARED|${artifactDir}|${gateRecordMilestoneTag(rowId)}a:${base}`);
  } else {
    gateRecordEvent("STAMP_LINEAGE_RECORDED", [
      ["milestone", rowId],
      ["artifact", base],
      ["transport", transport]
    ], `milestone ${rowId} fix-up rewrite at ${base} — landed frontmatter already live (status: ${settledVerdict.declared}), superseded_by lineage recorded (${base}); the row re-completes on the landed evidence`, `STAMP_LINEAGE_RECORDED|${artifactDir}|${gateRecordMilestoneTag(rowId)}a:${base}`);
  }
  dropStampSnapshot(sessionPhaseMap, sessionID, rowId, base);
  persistSessionState(sessionPhaseMap, sessionID);
  // Promotion is the ordinary registry transition and is recorded either way —
  // a row that stays open must be explainable from the log alone.
  const registry = readMilestoneRegistry(sessionID, sessionPhaseMap);
  const resolvedId = resolveMilestoneRowId(registry, base, rowId);
  const result = updateMilestoneRegistry(sessionID, sessionPhaseMap, resolvedId, ["checked-off"]);
  const promoted = !!(result.ok && result.changed);
  const reason = promoted ? "amended-evidence" : (result.ok ? "already-checked-off" : result.reason);
  gateRecordEvent("CHECKOFF", [
    ["milestone", resolvedId],
    ["artifact", base],
    ["promoted", promoted ? "true" : "false"],
    ["reason", reason]
  ], null, `CHECKOFF|${artifactDir}|${gateRecordMilestoneTag(resolvedId)}a:${base}|p:${promoted ? "true" : "false"}|r:${reason}`);
  return { settled: true, reason: null, content: settledContent, promoted };
}

// Drives settlement over every artifact stamped in this session, so a gate
// evaluation and the after-write fast path run the same loop. `transport` names
// the entry point that reached this loop — the record it writes carries the tag,
// so a settlement line says which of the three points produced it. No observed
// write path steers it: the canonical artifact is the only thing either loop
// settles, so a write that merely shares a stamped artifact's basename cannot
// settle (or silently unsnapshot) the row it names.
function settleStampClearsForSession(sessionID, sessionPhaseMap, transport) {
  const snapshots = getStampSnapshots(sessionPhaseMap, sessionID);
  if (!snapshots) return 0;
  const keys = Object.keys(snapshots);
  if (keys.length === 0) return 0;
  const artifactDir = resolveArtifactDir(sessionID);
  let settled = 0;
  for (const key of keys) {
    const sep = key.indexOf("|");
    if (sep <= 0) continue;
    const milestoneId = key.slice(0, sep);
    const base = key.slice(sep + 1);
    if (settleStampClearForArtifact(sessionID, sessionPhaseMap, { dir: artifactDir, base, milestoneId, transport }).settled) settled++;
  }
  return settled;
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

// Resolves the milestone row to check off for an impl KD against the parent
// session's registry rows (the SSOT of milestone IDs). The legacy extractor
// truncates hyphenated IDs (`impl-M-core-...` → `M`), so the row whose ID
// prefix-matches the impl KD's name portion is the authoritative ID. A row
// whose ID exactly matches the legacy-extracted token is preferred over a
// prefix match — `impl-M-core-...` prefix-matches both `M` and `M-core`, and
// the exact token match wins (no more permissive than the legacy first-token).
// Returns the resolved canonical row ID, or the legacy-extracted milestoneId
// when no row matches (the caller's updateMilestoneRegistry then reports
// milestone-not-found).
function resolveMilestoneRowId(registry, relPath, milestoneId) {
  if (!registry || !Array.isArray(registry.rows) || registry.rows.length === 0) {
    return milestoneId;
  }
  const exact = registry.rows.find(r => r.id.toLowerCase() === milestoneId.toLowerCase());
  if (exact) return exact.id;
  const base = relPath.replace(/\\/g, "/").split("/").pop();
  const namePortion = base.replace(/\.md$/, "").replace(/^impl-/i, "");
  const nameLower = namePortion.toLowerCase();
  const prefix = registry.rows.find(r => nameLower.startsWith(`${r.id.toLowerCase()}-`));
  return prefix ? prefix.id : milestoneId;
}

// Generation-mismatch skip diagnostic: same-session impl files for a milestone
// row whose embedded generation differs from the ACTIVE lifecycle generation —
// or whose bytes cannot be read (fail-closed) — are skipped with an always-on
// record, never promoted. Legacy suffix-less files count as generation 0, so
// they skip (with fileGen=0) once the lifecycle moves past generation 0. Files
// from foreign sessions are not this lifecycle's evidence and stay silent here.
// Record shape: GEN_MISMATCH_SKIP session=<id> milestone=<rowId> file=<name>
// fileGen=<N> activeGen=<M> persistedGen=<P> reason=<gen-mismatch|unreadable>
// promoted=false.
function emitGenerationMismatchSkips(knowledgeDir, files, sessionID, milestoneId, activeGeneration, persistedGeneration) {
  const prefix = `impl-${milestoneId}-`;
  for (const f of files) {
    if (!f.toLowerCase().startsWith(prefix.toLowerCase())) continue;
    if (f.toLowerCase().endsWith(".superseded.md")) continue;
    const fileGen = extractImplKDGeneration(f, sessionID);
    if (fileGen === null) {
      // The name carries no `-gen{N}` marker for this session, so the artifact
      // cannot be placed in any lifecycle. Recorded rather than skipped
      // silently: an artifact a reader can see on disk and the gate never
      // mentions is the shape that made "the gate is disabled" a plausible
      // misreading.
      gateRecordEvent("GEN_MISMATCH_SKIP", [
        ["session", sessionID], ["milestone", milestoneId], ["file", f],
        ["fileGen", "none"], ["activeGen", activeGeneration],
        ["persistedGen", persistedGeneration], ["reason", "no-generation-token"],
        ["promoted", "false"]
      ], `the filename carries no generation marker for this session, so the artifact belongs to no lifecycle this gate can name and the row is not promoted from it`, `GEN_MISMATCH_SKIP|${gateRecordMilestoneTag(milestoneId)}a:${f}|fg:none|ag:${activeGeneration}|r:no-generation-token`);
      continue;
    }
    if (fileGen === activeGeneration) {
      // Same generation but not live evidence: either unreadable bytes
      // (fail-closed — the pinned predicate already declined) or a status the
      // liveness allowlist refuses (named by the promotion record in
      // reconcileStuckRowsFromDiskEvidence).
      // Only the unreadable case skips here.
      let readable = true;
      try {
        readFileSync(join(knowledgeDir, f), "utf8");
      } catch (_) {
        readable = false;
      }
      if (!readable) {
        gateRecordEvent("GEN_MISMATCH_SKIP", [
          ["session", sessionID], ["milestone", milestoneId], ["file", f],
          ["fileGen", fileGen], ["activeGen", activeGeneration],
          ["persistedGen", persistedGeneration], ["reason", "unreadable"],
          ["promoted", "false"]
        ], `the artifact cannot be read, so it is not evidence — the row keeps its state`, `GEN_MISMATCH_SKIP|${gateRecordMilestoneTag(milestoneId)}a:${f}|fg:${fileGen}|ag:${activeGeneration}|r:unreadable`);
      }
      continue;
    }
    gateRecordEvent("GEN_MISMATCH_SKIP", [
      ["session", sessionID], ["milestone", milestoneId], ["file", f],
      ["fileGen", fileGen], ["activeGen", activeGeneration],
      ["persistedGen", persistedGeneration], ["reason", "gen-mismatch"],
      ["promoted", "false"]
    ], `file generation ${fileGen} is not the active lifecycle's ${activeGeneration}, so the row is not promoted from it`, `GEN_MISMATCH_SKIP|${gateRecordMilestoneTag(milestoneId)}a:${f}|fg:${fileGen}|ag:${activeGeneration}`);
  }
}

// Disk-evidence reconciliation: before the all-checked-off
// verdict is computed, every non-checked-off row (`in-progress`, `assigned`,
// `pending`, `failed`) whose milestone-scoped impl KD exists on disk under the
// SAME session id AND at the persisted lifecycle generation is promoted to
// checked-off. Evidence matching is generation-pinned (filename `-gen{N}`
// equals the persisted generation; legacy suffix-less files count as
// generation 0); rows without pinned evidence are never promoted and keep
// blocking the gate. Same-session files that miss the pin are named by a
// GEN_MISMATCH_SKIP diagnostic — see the DIVERGENCE RECOVERY PROCEDURE above
// for the operator-invoked recovery (diagnose → scoped-remove → redispatch).
//
// RESTART REQUIRED: plugins load once per opencode process, so this
// gate-logic change — reconciliation and the loud auto-checkoff diagnostics —
// takes effect only after opencode restarts. Live behavior lags disk until
// then; operators should restart after pulling gate-logic fixes.
//
// Promotion goes through the existing strict registry writer as two audited
// steps (<stuck> → in-progress → checked-off): updateMilestoneRegistry's
// transition rules stay untouched (SPEC A1 — the reconcile path is separate).
// Single top-level readdir shared across rows; idempotent — once all
// rows are checked-off there are no stuck rows and the scan is skipped
// entirely. A missing/unparsable registry never reaches here (the
// caller fails closed first); reconciliation never fabricates rows.
function reconcileStuckRowsFromDiskEvidence(sessionID, sessionPhaseMap, registry) {
  // Settlement is attempted here too (FR-06 point c): a stamped artifact whose
  // fix-up write landed outside the write hook re-closes its row at the next
  // reconciliation instead of staying stuck, and its record names the transport
  // that settled it.
  const settled = settleStampClearsForSession(sessionID, sessionPhaseMap, "stuck-row");
  if (settled > 0) {
    const refreshed = readMilestoneRegistry(sessionID, sessionPhaseMap);
    if (refreshed) registry = refreshed;
  }
  const stuck = registry.rows.filter(r => r.state !== "checked-off");
  if (stuck.length === 0) return settled;
  const knowledgeDir = getKnowledgeDir(sessionID);
  let files = [];
  try { files = readdirSync(knowledgeDir); } catch (_) { return settled; }
  const persistedGeneration = getCurrentGeneration(sessionPhaseMap, sessionID);
  const generation = getActiveLifecycleGeneration(sessionPhaseMap, sessionID);
  let promoted = 0;
  for (const row of stuck) {
    const prefix = `impl-${row.id}-`;
    // Shared pinned predicate: only live (non-frontmatter-superseded)
    // same-session, active-lifecycle-generation evidence promotes — the
    // write-hook check-off consults the same resolution over the incoming
    // path, so both agree on skewed rows.
    const evidence = files.find(f => isLiveMilestoneEvidence(knowledgeDir, f, sessionID, row.id, generation));
    if (!evidence) {
      // Generation-mismatch skip: same-session impl files for this row that
      // miss the generation pin (or cannot be read) are skipped audibly —
      // never promoted. The row keeps blocking the gate; the operator
      // recovers via the DIVERGENCE RECOVERY PROCEDURE (diagnose →
      // scoped-remove → redispatch).
      emitGenerationMismatchSkips(knowledgeDir, files, sessionID, row.id, generation, persistedGeneration);
      // Superseded-only evidence probe: a reopened row's stale impl
      // KDs survive on disk as `*.superseded.md` — invisible to the predicate
      // above by design, since widening it would double-suffix the files on
      // every subsequent reopen. When those renamed files are the row's ONLY
      // same-session impl evidence, say so loudly instead of leaving the
      // unpromoted row unexplained; the row keeps blocking the gate.
      const superseded = files.filter(f => {
        if (!f.toLowerCase().startsWith(prefix.toLowerCase())) return false;
        if (!f.toLowerCase().endsWith(".superseded.md")) return false;
        return matchesSessionKDAnyGeneration(f.slice(0, -".superseded.md".length), sessionID);
      });
      if (superseded.length > 0) {
        gateRecordOnce(`SUPERSEDED_EVIDENCE: milestone ${row.id} stays ${row.state} — same-session impl evidence exists solely as superseded file(s): ${superseded.join(", ")}. Remediation options: (a) restore a canonical-path impl KD for milestone ${row.id}, or (b) invoke the remediation path to advance the row to checked-off citing the superseded impl KD(s) as evidence.`, `SUPERSEDED_EVIDENCE|${gateRecordMilestoneTag(row.id)}a:${[...superseded].sort().join(",")}`);
      }
      // Frontmatter-stamped stale evidence: canonical files the liveness
      // allowlist refuses are invisible to the predicate above by design. Name
      // them so a row awaiting fresh fix evidence is explainable instead of
      // silently stuck; only a fresh canonical write re-completes such a row,
      // never the stale file itself. One CHECKOFF line carries the reason — the
      // promotion evaluation did run and did not promote, so it is a promotion
      // record, not a second always-on event.
      const stamped = files.filter(f => {
        if (!f.toLowerCase().startsWith(prefix.toLowerCase())) return false;
        if (!matchesSessionKDAnyGeneration(f, sessionID)) return false;
        return isSupersededByFrontmatter(knowledgeDir, f);
      });
      if (stamped.length > 0) {
        const refusal = evaluateLivenessFile(knowledgeDir, stamped[0]);
        gateRecordEvent("CHECKOFF", [
          ["milestone", row.id],
          ["artifact", stamped.join(",")],
          ["promoted", "false"],
          ["reason", refusal.reason]
        ], `milestone ${row.id} stays ${row.state} — prior completion evidence is not live (${refusal.reason}, canonical names kept): ${stamped.join(", ")}. Write fresh fix evidence at a canonical impl path for milestone ${row.id} to re-complete.`, `CHECKOFF|${gateRecordMilestoneTag(row.id)}a:${[...stamped].sort().join(",")}|p:false|r:${refusal.reason}`);
      }
      continue;
    }
    const opened = updateMilestoneRegistry(sessionID, sessionPhaseMap, row.id, ["in-progress"]);
    if (!opened.ok) {
      warn(`AUTO_CHECKOFF_FAILED: milestone ${row.id} (reconcile ${row.state} → in-progress) — ${opened.reason}`);
      continue;
    }
    const result = updateMilestoneRegistry(sessionID, sessionPhaseMap, row.id, ["checked-off"]);
    if (!result.ok) {
      warn(`AUTO_CHECKOFF_FAILED: milestone ${row.id} (reconcile in-progress → checked-off) — ${result.reason}`);
      continue;
    }
    gateRecord(`RECONCILE_CHECKOFF: milestone ${row.id} promoted ${row.state} → checked-off (impl KD ${evidence})`);
    promoted++;
  }
  return promoted + settled;
}

// Explicit, audited remediation path for orphaned legacy evidence: advances
// a superseded-only milestone row to checked-off by restoring its legacy
// `*.superseded.md` file(s) to their canonical filename(s) once, then
// promoting the row through the strict registry writer's transition rules.
// Distinct from the /phase VERIFY override — this never routes through
// SAFETY_ESCAPE and never touches the phase machine. It requires an explicit
// invocation (never fires automatically), so the registry state machine
// remains the guard. A row that is already checked-off, or one with live
// (non-superseded) impl evidence, is left untouched — the remediation is
// scoped to the superseded-only case. Frontmatter-stamped stale evidence is
// never restored: a stamp records work the review invalidated, and only a
// genuine fix-up rewrite re-completes such a row — a stamped-only row is
// named distinctly (frontmatter-stamped-evidence) with recovery guidance
// instead of the generic no-superseded-evidence.
// Returns { ok, reason?, milestoneId, evidence, actor } — evidence names the
// restored canonical file(s).
function reconcileSupersededMilestone(sessionID, sessionPhaseMap, milestoneId, actor) {
  const located = locateMilestoneRegistry(sessionID, sessionPhaseMap);
  if (!located) return { ok: false, reason: "no-registry", milestoneId };
  const rowPattern = new RegExp(`^\\s*${escapeRegExp(milestoneId)}:\\s*([A-Za-z-]+)[ \\t]*$`, "mi");
  const rowMatch = located.block.match(rowPattern);
  if (!rowMatch) return { ok: false, reason: "milestone-not-found", milestoneId };
  const current = rowMatch[1];
  if (current === "checked-off") {
    return { ok: false, reason: "already-checked-off", milestoneId };
  }
  // Scope the remediation to the superseded-only case: if the row has live
  // (non-superseded) same-session impl evidence, the automatic reconcile path
  // already handles it — an explicit remediation would be redundant and could
  // mask a live-evidence check-off. Frontmatter-stamped files are stale, not
  // live, so they do not block the remediation. Only a row whose sole
  // same-session impl evidence is `.superseded.md` file(s) qualifies.
  // Liveness uses the pinned predicate: wrong-generation evidence is ghost
  // evidence, never a block on explicit audited remediation.
  const knowledgeDir = getKnowledgeDir(sessionID);
  let files = [];
  try { files = readdirSync(knowledgeDir); } catch (_) { return { ok: false, reason: "no-knowledge-dir", milestoneId }; }
  const prefix = `impl-${milestoneId}-`;
  const generation = getActiveLifecycleGeneration(sessionPhaseMap, sessionID);
  const live = files.find(f => isLiveMilestoneEvidence(knowledgeDir, f, sessionID, milestoneId, generation));
  if (live) return { ok: false, reason: "live-evidence-present", milestoneId };
  const superseded = files.filter(f => {
    if (!f.toLowerCase().startsWith(prefix.toLowerCase())) return false;
    if (!f.toLowerCase().endsWith(".superseded.md")) return false;
    return matchesSessionKDAnyGeneration(f.slice(0, -".superseded.md".length), sessionID);
  });
  if (superseded.length === 0) {
    // Frontmatter-stamped stale evidence: canonical files whose frontmatter
    // carries a superseded status record work the review invalidated, so only
    // a genuine fix-up rewrite re-completes the row — the remediation never
    // restores them. Name them distinctly (instead of the generic
    // no-superseded-evidence) with the recovery guidance, so a row awaiting
    // fresh fix evidence is explainable and the row stays open.
    const stamped = files.filter(f => {
      if (!f.toLowerCase().startsWith(prefix.toLowerCase())) return false;
      if (!matchesSessionKDAnyGeneration(f, sessionID)) return false;
      return isSupersededByFrontmatter(knowledgeDir, f);
    });
    if (stamped.length > 0) {
      gateRecordOnce(`STAMPED_EVIDENCE: milestone ${milestoneId} stays ${current} — same-session impl evidence is frontmatter-superseded (stale, canonical names kept): ${stamped.join(", ")}. Only a genuine fix-up rewrite re-completes this row: write new fix evidence over the stamped file (the gate clears the stamp on landing) or at a fresh canonical impl path for milestone ${milestoneId}.`, `STAMPED_EVIDENCE|${gateRecordMilestoneTag(milestoneId)}a:${[...stamped].sort().join(",")}`);
      return { ok: false, reason: "frontmatter-stamped-evidence", milestoneId, evidence: stamped };
    }
    return { ok: false, reason: "no-superseded-evidence", milestoneId };
  }
  // Restore each legacy file to its canonical name once, so the normal
  // evidence linkage observes it again. A canonical target that already
  // exists is never overwritten — the legacy file stays in place instead.
  const restored = [];
  for (const legacy of superseded) {
    const canonical = legacy.slice(0, -".superseded.md".length);
    if (existsSync(join(knowledgeDir, canonical))) {
      debug(`reconcile-superseded: canonical target ${canonical} already exists — leaving legacy ${legacy} in place`);
      continue;
    }
    try {
      renameSync(join(knowledgeDir, legacy), join(knowledgeDir, canonical));
      restored.push(canonical);
    } catch (e) {
      debug(`reconcile-superseded: restore failed for ${legacy}: ${e.message}`);
    }
  }
  if (restored.length === 0) {
    return { ok: false, reason: "canonical-exists", milestoneId };
  }
  // Advance through the strict registry writer's transition rules. The row is
  // <stuck> (in-progress/assigned/pending/failed) → checked-off; the writer
  // only permits checked-off from in-progress, so mirror the reconcile path's
  // two audited steps (stuck → in-progress → checked-off).
  const opened = updateMilestoneRegistry(sessionID, sessionPhaseMap, milestoneId, ["in-progress"]);
  if (!opened.ok) return { ok: false, reason: opened.reason, milestoneId };
  const result = updateMilestoneRegistry(sessionID, sessionPhaseMap, milestoneId, ["checked-off"]);
  if (!result.ok) return { ok: false, reason: result.reason, milestoneId };
  const who = actor || "unknown";
  loud(`SUPERSEDED_RECONCILED: milestone ${milestoneId} advanced to checked-off via explicit remediation — canonical evidence restored: ${restored.join(", ")} — actor: ${who}`);
  return { ok: true, milestoneId, evidence: restored, actor: who };
}

// The all-checked-off gate — SWARM→VERIFY advances ONLY when every registry
// row is checked-off AND its milestone-scoped impl KD is on disk
// (checkMilestoneCheckedOff semantics: registry state + disk evidence).
// Fails closed on missing (REGISTRY_MISSING) and empty (REGISTRY_EMPTY)
// registries. Before the verdict is computed, evidence-backed stuck rows are
// reconciled to checked-off (reconcileStuckRowsFromDiskEvidence) and the
// registry is re-read after any promotion. Returns { ok, total, checkedOff, rows }.
function checkAllMilestonesCheckedOff(sessionID, sessionPhaseMap) {
  // Stamp settlement is attempted at every SWARM gate evaluation (FR-06 point
  // b), before the registry is read, so a row the settlement re-closes is
  // already checked-off when the verdict is computed.
  const settled = settleStampClearsForSession(sessionID, sessionPhaseMap, "swarm-gate");
  let registry = readMilestoneRegistry(sessionID, sessionPhaseMap);
  if (!registry) {
    debug(`REGISTRY_MISSING: no milestone registry for session ${sessionID} — SWARM cannot advance`);
    return { ok: false, total: 0, checkedOff: 0, rows: [] };
  }
  if (registry.rows.length === 0) {
    debug(`REGISTRY_EMPTY: milestone registry has no rows for session ${sessionID} — SWARM cannot advance`);
    return { ok: false, total: 0, checkedOff: 0, rows: [] };
  }
  // Reconcile evidence-backed stuck rows BEFORE computing ok — the
  // promotion writes land in the registry, so re-read it when rows changed.
  const reconciled = reconcileStuckRowsFromDiskEvidence(sessionID, sessionPhaseMap, registry);
  if (settled > 0 || reconciled > 0) {
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
    warn(`SWARM gate: ${checkedOff}/${rows.length} milestones checked-off — blocked by: ${stuck.map(r => r.id).join(", ")}`);
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
function markStuckMilestonesFailed(sessionID, sessionPhaseMap, trigger, milestoneId, toolCalls) {
  const registry = readMilestoneRegistry(sessionID, sessionPhaseMap);
  if (!registry) {
    debug(`SAFETY_STUCK: ${trigger} for session ${sessionID} — no registry to mark`);
    return;
  }
  const rows = milestoneId
    ? registry.rows.filter(r => r.id.toUpperCase() === String(milestoneId).toUpperCase())
    : registry.rows;
  const failedIds = [];
  for (const row of rows) {
    if (row.state !== "checked-off" && row.state !== "failed") {
      const result = updateMilestoneRegistry(sessionID, sessionPhaseMap, row.id, ["failed"]);
      failedIds.push(row.id);
      debug(`SAFETY_STUCK: marked ${row.id} failed (${trigger}) — ${JSON.stringify(result)}`);
    }
  }
  debug(`SAFETY_STUCK: ${trigger} for session ${sessionID} — staying in SWARM (no auto-advance)`);
  if (failedIds.length > 0) {
    warn(`SWARM_STALLED: milestones ${failedIds.join(", ")} lack impl KD evidence — force-marked failed after ${toolCalls} tool calls, gate stays in SWARM`);
  }
}

// Extracts the milestone ID from an impl KD filename per the milestone-scoped
// naming contract `impl-<milestone-id>-<name>-<session>[-gen{N}].md`. The first
// token after the `impl-` prefix is the milestone ID. Returns null for non-impl
// filenames (other KD types) and invalid input — a legacy unscoped impl KD
// yields its first name token, which never matches a registry row.
//
// When a known milestone ID is provided, the name portion after `impl-` must
// start with `<knownMilestoneId>-` (case-insensitive) — this is what lets
// hyphenated milestone IDs (e.g. `M-core`) survive extraction, since the legacy
// first-token split truncates them to `M`. On a prefix match the filename's own
// token is returned (filename casing preserved); on mismatch null is returned.
// Without a known ID the legacy first-token behavior is unchanged.
function extractMilestoneIdFromImplKD(filename, knownMilestoneId) {
  if (typeof filename !== "string") return null;
  const base = filename.replace(/\\/g, "/").split("/").pop();
  if (!/^impl-/i.test(base)) return null;
  const name = base.replace(/\.md$/, "");
  const namePortion = name.replace(/^impl-/i, "");
  if (typeof knownMilestoneId === "string" && knownMilestoneId.length > 0) {
    const prefix = `${knownMilestoneId}-`;
    if (namePortion.toLowerCase().startsWith(prefix.toLowerCase())) {
      return namePortion.slice(0, knownMilestoneId.length) || null;
    }
    return null;
  }
  const token = namePortion.split("-")[0];
  return token || null;
}

// escapeRegExp lives in ./kd-match.js — gate-local, imported above.

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

// Extract the target path from tool args across V1/V2/custom arg shapes.
// V1 and V2 file tools use `filePath`, but runtimes and harnesses vary
// (`path`, `file`, `filename`, `target`). Returns "" when none present —
// callers treat that as non-matching (fail-closed), never as a match.
function extractToolPath(a) {
  if (!a || typeof a !== "object") return "";
  for (const k of ["filePath", "path", "file", "filename", "target"]) {
    const v = a[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return "";
}

// Reads the incoming file text from tool args across write/edit arg shapes.
// Write tools carry the full text under `content`; edit-shaped calls vary
// (`content`, `newText`, `newString`, `text`, `data`). Returns the string or
// undefined when no text is present — callers fail open on undefined (live).
function extractToolContent(a) {
  if (!a || typeof a !== "object") return undefined;
  for (const k of ["content", "newContent", "newText", "newString", "text", "data"]) {
    const v = a[k];
    if (typeof v === "string") return v;
  }
  return undefined;
}

// Whether a payload is a whole KD document rather than a patch fragment. The
// liveness parse is a document parse — `frontmatterSpan` needs `---` at byte 0
// (BOM aside) and a closing fence — so a fragment can be neither live nor
// stale, and judging one returns a verdict about bytes the writer never
// touched. Callers evaluate document-shaped payloads and defer a fragment to
// the disk evaluation of the landed file.
function isDocumentPayload(text) {
  return typeof text === "string" && frontmatterSpan(text) !== null;
}

// Canonical tool identity: runtimes namespace built-ins (e.g.
// `default.write`). Strip the namespace so the allowlist and every
// handler below see the tool the agent means. Fail-safe direction: a
// namespaced variant inherits its base tool's restrictions, never escapes
// them.
//
// V2 renames (opencode.ai/v2/docs/migrate-v1): task->subagent,
// bash->shell, patch->edit. Legacy names are normalized to the V2
// canonical so one comparison covers both runtimes; write/edit stay
// distinct (V2 action `edit` covers both tools, but the tool IDs remain
// separate for KD create-vs-modify detection).
function canonicalToolName(t) {
  let name = t;
  if (typeof name === "string" && name.includes(".")) {
    const base = name.slice(name.lastIndexOf(".") + 1);
    if (base.length > 0) name = base;
  }
  if (name === "task") return "subagent";
  if (name === "bash") return "shell";
  if (name === "patch") return "edit";
  return name;
}

// The document-level verdict vocabulary is binary: a review either passes or
// fails. Severity and blocking intent live in the KD body, never in a third
// document-level token.
const ACCEPTED_REVIEW_VERDICTS = ["PASS", "FAIL"];
// Tokens retired from the vocabulary. They are not aliases: a review carrying
// one is invalid (it blocks) and is detected only so the diagnostic can name
// what replaced it.
const RETIRED_REVIEW_VERDICTS = ["FUNDAMENTAL"];

// Reads the `verdict` field from a KD file's YAML frontmatter — the machine
// source for the verdict-aware VERIFY gate. Only the first frontmatter block
// (between the leading `---` and the next `---` line) is inspected; a body
// Verdict section is human-readable and never read. Returns "PASS" or "FAIL",
// or null when the field is absent or carries any other literal (invalid
// blocks advancement — the MISSING rule in evaluateVerifyVerdict, never
// treated as PASS).
function readVerdictFrontmatter(filePath) {
  const literal = readVerdictLiteral(filePath);
  return ACCEPTED_REVIEW_VERDICTS.includes(literal) ? literal : null;
}

// Reads the raw `verdict` literal upper-cased, or null when absent/unreadable.
// Separate from readVerdictFrontmatter so the accepted set stays binary while
// the retired-token diagnostic can still name what the author wrote.
function readVerdictLiteral(filePath) {
  try {
    const content = readFileSync(filePath, "utf8");
    const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!frontmatter) return null;
    const verdictMatch = frontmatter[1].match(/^verdict\s*:\s*([A-Za-z]+)\s*$/m);
    return verdictMatch ? verdictMatch[1].toUpperCase() : null;
  } catch (_) {
    return null;
  }
}

// The retired literal this KD carries, or null. Used only for the diagnostic
// that tells the author which token left the vocabulary and what to write
// instead.
function readRetiredVerdictToken(filePath) {
  const literal = readVerdictLiteral(filePath);
  return RETIRED_REVIEW_VERDICTS.includes(literal) ? literal : null;
}

// Detects the escalation marker in a review KD body: a level-2 heading reading
// `Escalation` outside a fenced code block, followed by at least one non-empty
// line before the next level-2 heading or end of file. An empty section and a
// fenced example both mean "no marker" — the marker must carry the author's
// actual escalation text to count.
function hasEscalationMarker(content) {
  if (typeof content !== "string" || content.length === 0) return false;
  const lines = content.split(/\r?\n/);
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !/^## Escalation\s*$/.test(line)) continue;
    for (let j = i + 1; j < lines.length; j++) {
      if (/^## \S/.test(lines[j])) break;
      if (lines[j].trim().length > 0) return true;
    }
  }
  return false;
}

// Finds the newest review KD among the session's KDs. "Newest" is
// deterministic: greatest file mtime, tie-break by greatest filename. Returns
// { filename, verdict, retiredToken } (both fields read from the newest KD's
// frontmatter) or null when no review KD exists — the caller then falls back to
// the presence-based result (false). Legacy audit- KDs are inert: the merged
// review+audit surface reads verdicts from review- only.
function findNewestVerdictKD(sessionFiles, sessionID = undefined) {
  const reviewFiles = sessionFiles.filter(f => /^review-/i.test(f));
  if (reviewFiles.length === 0) return null;
  const knowledgeDir = getKnowledgeDir(sessionID);
  reviewFiles.sort((a, b) => {
    let mtimeDiff = 0;
    try { mtimeDiff = statSync(join(knowledgeDir, b)).mtimeMs - statSync(join(knowledgeDir, a)).mtimeMs; } catch (_) {}
    if (mtimeDiff !== 0) return mtimeDiff;
    return b > a ? 1 : b < a ? -1 : 0;
  });
  const filename = reviewFiles[0];
  return {
    filename,
    verdict: readVerdictFrontmatter(join(knowledgeDir, filename)),
    retiredToken: readRetiredVerdictToken(join(knowledgeDir, filename))
  };
}

// Re-derives the evidence KD for a phase's disk-advancement pattern.
// checkDiskAdvancement returns boolean only, so the RESTART_CATCH_UP
// diagnostic re-derives the newest session-scoped, generation-scoped KD that
// would have driven the advance. Returns the filename or null when none is
// determinable (diagnostic skipped). Single readdir + bounded stat
// (getFileMtimeMs); consumed only by the log-only diagnostic, never by the
// advancement gate itself.
function findNewestEvidenceKD(sessionPhaseMap, sessionID, phase) {
  if (phase === undefined || phase === STATES.REPORT) return null;
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
  const knowledgeDir = getKnowledgeDir(sessionID);
  let files = [];
  try { files = readdirSync(knowledgeDir); } catch (_) { return null; }
  const generation = getActiveLifecycleGeneration(sessionPhaseMap, sessionID);
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

// Parses the review frontmatter `reopen_target` field — the ONLY source of
// reopen targets (FR-11, IC-3). Scalar (`reopen_target: M4`) and flow-sequence
// (`reopen_target: [M4, M-core]`) forms parse identically: brackets stripped,
// comma split, quotes stripped, trimmed, uppercased. A token must match
// `^[A-Za-z0-9_-]+$`; case-insensitive resolution to a registry row is the
// caller's job, because "unresolvable" needs the registry.
// Returns { present, tokens, reason, value }: reason is null when the field is
// usable, `invalid-reopen-target` when a token breaks the grammar, and
// `ambiguous-target` when the frontmatter carries the key twice. An absent,
// empty, `""` or `null` field yields zero tokens and no reason — the caller
// decides between the escalate and refuse branches.
function parseReopenTarget(content) {
  const span = typeof content === "string" ? frontmatterSpan(content) : null;
  if (!span) return { present: false, tokens: [], reason: null, value: null };
  const lines = [...span.body.matchAll(/^[ \t]*reopen_target[ \t]*:[ \t]*(.*)$/gim)].map(m => m[1].trim());
  if (lines.length === 0) return { present: false, tokens: [], reason: null, value: null };
  // Two keys cannot both govern the reopen set — refuse rather than pick one.
  if (lines.length > 1) return { present: true, tokens: [], reason: "ambiguous-target", value: lines.join(",") };
  const raw = lines[0];
  if (raw.length === 0 || /^(null|~)$/i.test(raw)) return { present: true, tokens: [], reason: null, value: raw };
  const inner = raw.replace(/^\[/, "").replace(/\]$/, "");
  const tokens = [];
  for (const piece of inner.split(",")) {
    const cleaned = piece.trim().replace(/^["']/, "").replace(/["']$/, "").trim();
    if (cleaned.length === 0) continue;
    if (!/^[A-Za-z0-9_-]+$/.test(cleaned)) {
      return { present: true, tokens: [], reason: "invalid-reopen-target", value: raw };
    }
    tokens.push(cleaned.toUpperCase());
  }
  return { present: true, tokens: [...new Set(tokens)], reason: null, value: raw };
}

// On a FAIL auto-regression the milestone rows named by the review KD's
// `reopen_target` field re-open to in-progress, so the all-checked-off gate
// cannot re-advance SWARM→VERIFY before fresh impl KDs land. Scoped reopen:
// milestoneIds are the registry-resolvable tokens parsed from that field — the
// intersection with registry row ids reopens exactly; unrelated checked-off
// rows are untouched. Idempotent for rows already in-progress; a missing/empty
// registry is a no-op and the SWARM gate fails closed on REGISTRY_EMPTY/MISSING.
// updateMilestoneRegistry's reopen semantics preserve the registry row's own
// casing.
function reopenCheckedOffMilestones(sessionID, sessionPhaseMap, citedMilestoneIds, trigger) {
  const registry = readMilestoneRegistry(sessionID, sessionPhaseMap);
  if (!registry) {
    debug(`reopen: no milestone registry for session ${sessionID} — nothing to reopen`);
    return;
  }
  const cited = new Set((citedMilestoneIds || []).map(id => String(id).toUpperCase()));
  for (const row of registry.rows) {
    if (row.state === "checked-off" && cited.has(String(row.id).toUpperCase())) {
      const result = updateMilestoneRegistry(sessionID, sessionPhaseMap, row.id, ["in-progress"], { reopen: true, trigger });
      debug(`reopen: milestone ${row.id} checked-off → in-progress (${JSON.stringify(result)})`);
    }
  }
}

// The FAIL-finding subsection scan and the `Milestone citation:` prose parse
// that used to derive this set are retired (FR-11): `reopen_target` in the
// review frontmatter is the only target source, parsed by parseReopenTarget.


// Newest session-scoped impl KD mtime — the freshness baseline for the
// fresh-PASS-after-fix and fix-cycle-tied regression rules. -Infinity when no
// impl KD exists (no fix cycle has ever landed, so freshness is trivially met).
function newestImplMtimeMs(sessionFiles, sessionID = undefined) {
  const implFiles = sessionFiles.filter(f => /^impl-/i.test(f));
  if (implFiles.length === 0) return -Infinity;
  const knowledgeDir = getKnowledgeDir(sessionID);
  let newest = -Infinity;
  for (const f of implFiles) {
    const m = getFileMtimeMs(join(knowledgeDir, f));
    if (m > newest) newest = m;
  }
  return newest;
}

// Reads a review KD's full content for citation parsing. Returns "" on read
// failure — the malformed-FAIL rule then fails closed (zero citations).
function readReviewKdContent(filename, sessionID = undefined) {
  try {
    return readFileSync(join(getKnowledgeDir(sessionID), filename), "utf8");
  } catch (_) {
    return "";
  }
}

// FAIL-verdict auto-regression. Regresses VERIFY→SWARM via the existing
// backward-transition path — no `BACKWARD: true` flag and no explicit dispatch
// — then re-opens the cited checked-off milestone rows. A verdict, once acted
// on, is consumed: the consumption guard records { kdFilename, regressedAt }
// per session, and an unchanged verdict never regresses twice. A fix cycle
// landing after the regression is the recovery, not a new trigger —
// re-regressing on it would reopen the just-fixed rows and invalidate the
// fresh evidence in a VERIFY⇄SWARM ping-pong. Only a re-emitted verdict (a
// NEW filename, or the same review KD rewritten after regressedAt) carries
// new information and regresses again. The cycle cap in backwardTransition
// bounds repeated genuine re-reviews. Returns true when a regression fired,
// false when the verdict was already consumed.
function regressVerifyOnFail(sessionID, kdFilename, sessionFiles, sessionPhaseMap, citedMilestoneIds, verdictRegressedKDs, backwardTransition) {
  const guard = verdictRegressedKDs.get(sessionID);
  // Monotonic regressedAt: two regressions may land in the same millisecond
  // (fast local writes), but the consumption guard needs the second
  // regression's timestamp to be strictly greater — bump by 1ms when
  // Date.now() ties.
  const now = Math.max(Date.now(), (guard && typeof guard.regressedAt === "number" ? guard.regressedAt + 1 : 0));
  if (guard && guard.kdFilename === kdFilename) {
    // Consumed verdict: the review KD itself must be newer than the last
    // regression to act again. Impl-KD mtimes are deliberately NOT consulted —
    // a post-regression fix is the recovery the lifecycle is waiting for, and
    // treating it as a re-trigger reopens the fixed rows and re-stamps the
    // fresh evidence superseded on every VERIFY evaluation. The mtime is
    // truncated to whole milliseconds: stat mtimeMs carries sub-ms precision
    // while regressedAt is an integer Date.now(), so a review written in the
    // same millisecond as the regression (which necessarily predates it —
    // the file was read to evaluate it) must never count as re-emitted.
    const reviewMtime = Math.floor(getFileMtimeMs(join(getKnowledgeDir(sessionID), kdFilename)));
    if (!(reviewMtime > guard.regressedAt)) {
      debug(`FAIL current, verdict consumed — same KD ${kdFilename} not re-emitted after regression (regressedAt=${guard.regressedAt}, review mtime=${reviewMtime})`);
      return false;
    }
  }
  verdictRegressedKDs.set(sessionID, { kdFilename, regressedAt: now });
  debug(`VERDICT_FAIL: KD ${kdFilename} verdict=FAIL — auto-regressing VERIFY→SWARM (no BACKWARD flag)`);
  backwardTransition(sessionID, STATES.VERIFY, STATES.SWARM);
  reopenCheckedOffMilestones(sessionID, sessionPhaseMap, citedMilestoneIds, `FAIL reopen_target in review KD ${kdFilename}`);
  // Identical-verdict brake feed: each genuine FAIL regression extends the
  // consecutive run for its cited milestones under the verdict fingerprint
  // (verdict plus cited set — a re-emitted review with the same shape
  // increments; a differently-shaped one restarts). Consumed duplicates
  // return false above and never reach this line, so fresh verdicts count.
  // The /phase override path consults the run via
  // evaluatePhaseOverrideBrake.
  const cited = [...new Set((citedMilestoneIds || []).map(id => String(id).toUpperCase()))];
  const fingerprint = `FAIL:${cited.slice().sort().join(",")}`;
  for (const milestoneId of cited) {
    recordGateVerdict(sessionID, milestoneId, fingerprint);
  }
  return true;
}

// Module-level verdict-aware VERIFY gate body. checkDiskAdvancement delegates
// the VERIFY verdict here; f1Options carries the server-local regression
// dependencies ({ verdictRegressedKDs, backwardTransition }) so direct unit-test
// calls without a handler stay blocked-but-safe (no regression side effect).
function evaluateVerifyVerdict(sessionID, sessionFiles, sessionPhaseMap, f1Options) {
  const hasReview = sessionFiles.some(f => /^review-/i.test(f));
  const verdictInfo = findNewestVerdictKD(sessionFiles, sessionID);
  if (verdictInfo && verdictInfo.retiredToken) {
    // Fail closed on a token that left the vocabulary, and tell the author
    // what to write instead: a FAIL plus a non-empty `## Escalation` section
    // carries the same block-and-escalate intent.
    debug(`FUNDAMENTAL_RETIRED: review KD ${verdictInfo.filename} carries retired verdict ${verdictInfo.retiredToken} — VERIFY advancement blocked; issue FAIL with a non-empty ## Escalation section instead`);
    return false;
  }
  if (verdictInfo && verdictInfo.verdict === "FAIL") {
    const reviewContent = readReviewKdContent(verdictInfo.filename, sessionID);
    const target = parseReopenTarget(reviewContent);
    const escalated = hasEscalationMarker(reviewContent);
    const registry = readMilestoneRegistry(sessionID, sessionPhaseMap);
    const resolvable = target.tokens.filter(id => registry && registry.rows.some(r => String(r.id).toUpperCase() === id));
    // Refusal reasons in IC-3 order: an unusable field first, then a field that
    // named rows the registry does not have, then a field that is simply absent.
    let refusal = target.reason;
    if (!refusal && target.tokens.length > 0 && resolvable.length !== target.tokens.length) {
      refusal = "unresolvable-reopen-target";
    }
    if (!refusal && target.tokens.length === 0) refusal = "no-reopen-target";
    if (refusal) {
      // A FAIL carrying a non-empty `## Escalation` and no target is the
      // documented escalate-without-regression shape: the fix loop cannot act
      // on it, so it blocks without touching state. Every other refusal is the
      // operator's mistake in a writable field, so the record names the field
      // and the value to write back.
      const cause = refusal === "no-reopen-target" && escalated
        ? `FAIL review KD ${verdictInfo.filename} carries no reopen_target and a non-empty ## Escalation section — blocked, no regression, no reopen; escalate to the user`
        : `FAIL review KD ${verdictInfo.filename} has an unusable reopen_target (${refusal}${target.value ? ` value=${target.value}` : ""}) — blocked, no regression, no reopen; write reopen_target: [<checked-off milestone id>] in the review frontmatter`;
      gateRecordEvent("REOPEN_TARGET_INVALID", [
        ["session", sessionID],
        ["review", verdictInfo.filename],
        ["reason", refusal]
      ], cause, `REOPEN_TARGET_INVALID|${verdictInfo.filename}|r:${refusal}`);
      debug(`REOPEN_TARGET_INVALID: ${cause}`);
      return false;
    }
    // A target naming rows that are not checked-off reopens nothing. Say so per
    // row rather than leaving a reader to infer it from an unchanged registry.
    for (const id of resolvable) {
      const row = registry.rows.find(r => String(r.id).toUpperCase() === id);
      if (!row || row.state === "checked-off") continue;
      gateRecordEvent("REOPEN_NOOP", [
        ["session", sessionID],
        ["milestone", row.id],
        ["reason", "not-checked-off"]
      ], `reopen_target in ${verdictInfo.filename} names milestone ${row.id}, which is already ${row.state} — nothing to reopen`, `REOPEN_NOOP|${gateRecordMilestoneTag(row.id)}r:not-checked-off`);
    }
    if (escalated) {
      // Both intents in one verdict: a fix loop would have to guess which one
      // the reviewer meant, so fail closed and let a re-review pick one.
      debug(`VERDICT_AMBIGUOUS: FAIL review KD ${verdictInfo.filename} names ${resolvable.length} resolvable milestone(s) and carries a non-empty ## Escalation section — blocked, no regression, no reopen; re-issue the review as a fixable FAIL without the marker or as an escalation FAIL with no target`);
      return false;
    }
    let regressed = false;
    if (f1Options && f1Options.verdictRegressedKDs && typeof f1Options.backwardTransition === "function") {
      regressed = regressVerifyOnFail(sessionID, verdictInfo.filename, sessionFiles, sessionPhaseMap, resolvable, f1Options.verdictRegressedKDs, f1Options.backwardTransition);
    }
    debug(`Disk check VERIFY: newest KD ${verdictInfo.filename} verdict=FAIL → ${regressed ? "regressed to SWARM" : "blocked (fix-cycle guard or no regression handler)"}`);
    return false;
  }
  if (!verdictInfo || !verdictInfo.verdict) {
    // MISSING: an absent/invalid verdict field blocks advancement — the
    // Inspector must emit a real verdict. Never treated as PASS.
    debug(`VERDICT_MISSING: newest review KD ${verdictInfo ? verdictInfo.filename : "(none)"} lacks a valid verdict field — advancement blocked`);
    return false;
  }
  // PASS never reopens (FR-13): the field is read only on FAIL, so a PASS that
  // carries it changes no state — record that it was seen and ignored.
  {
    const passTarget = parseReopenTarget(readReviewKdContent(verdictInfo.filename, sessionID));
    if (passTarget.present) {
      gateRecordEvent("REOPEN_TARGET_IGNORED", [
        ["session", sessionID],
        ["review", verdictInfo.filename],
        ["target", passTarget.tokens.length > 0 ? passTarget.tokens.join(",") : "<empty>"]
      ], `PASS review KD ${verdictInfo.filename} carries reopen_target — the field is read only on FAIL, so nothing reopened`, `REOPEN_TARGET_IGNORED|${verdictInfo.filename}|t:${passTarget.tokens.length > 0 ? passTarget.tokens.join(",") : "<empty>"}`);
    }
  }
  // Fresh-PASS-after-fix: a PASS verdict advances only when it is at
  // least as new as the newest impl-* KD. A fix cycle that landed after the
  // review (newer impl KD) makes the PASS stale — a fresh review is required
  // before EXTRACT starts. No impl KD ⇒ no fix cycle ⇒ trivially fresh.
  const verdictMtime = getFileMtimeMs(join(getKnowledgeDir(sessionID), verdictInfo.filename));
  const newestImpl = newestImplMtimeMs(sessionFiles, sessionID);
  if (newestImpl > verdictMtime) {
    debug(`STALE_PASS: verdict KD ${verdictInfo.filename} mtime=${verdictMtime} < newest impl KD mtime=${newestImpl} — fresh review required after last fix`);
    return false;
  }
  // The merged review+audit surface advances on a single review KD.
  // The regression side stays OR (checkPhaseStateConsistency) so a single-KD
  // VERIFY holds instead of directly regressing to SWARM — otherwise the
  // unbounded VERIFY⇄SWARM loop returns.
  const result = hasReview;
  debug(`Disk check VERIFY: review=${hasReview} → ${result}`);
  return result;
}

// Reads the machine-readable preflight signal from a PREFLIGHT KD's leading
// frontmatter block. Returns "PASS" or "ESCALATION", or null when the field
// is absent or carries any other value — a missing signal blocks advancement
// and is not counted as success.
function readPreflightVerdictFrontmatter(filePath) {
  try {
    const content = readFileSync(filePath, "utf8");
    const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!frontmatter) return null;
    const verdictMatch = frontmatter[1].match(/^preflight_verdict\s*:\s*([A-Za-z]+)\s*$/m);
    if (!verdictMatch) return null;
    const verdict = verdictMatch[1];
    return verdict === "PASS" || verdict === "ESCALATION" ? verdict : null;
  } catch (_) {
    return null;
  }
}

// Finds the newest preflight KD among the session's KDs. "Newest" mirrors the
// review-KD rule: greatest file mtime, tie-break by greatest filename.
// Returns { filename, verdict } or null when no preflight KD exists.
function findNewestPreflightKD(sessionFiles, sessionID = undefined) {
  const preflightFiles = sessionFiles.filter(f => /^preflight-/i.test(f));
  if (preflightFiles.length === 0) return null;
  const knowledgeDir = getKnowledgeDir(sessionID);
  preflightFiles.sort((a, b) => {
    let mtimeDiff = 0;
    try { mtimeDiff = statSync(join(knowledgeDir, b)).mtimeMs - statSync(join(knowledgeDir, a)).mtimeMs; } catch (_) {}
    if (mtimeDiff !== 0) return mtimeDiff;
    return b > a ? 1 : b < a ? -1 : 0;
  });
  const filename = preflightFiles[0];
  return { filename, verdict: readPreflightVerdictFrontmatter(join(knowledgeDir, filename)) };
}

// Verdict-aware PREFLIGHT gate body. checkDiskAdvancement delegates PREFLIGHT
// advancement here in the override and non-override paths alike. Advancement
// needs the newest session-generation preflight KD to carry PASS; an
// escalation verdict, a missing field, or an unreadable value blocks the
// phase (fail closed). While an override governs PREFLIGHT the newest KD must
// also carry fresh evidence (mtime >= the hop anchor) — stale KDs leave the
// manual override in place. The anchor is passed in by the caller when the
// caller already resolved it (a re-entered hop anchors at `hopSince`); the
// fallback recomputes the marker's own `since`. Emits one debug line per
// evaluation naming the newest KD, its parsed verdict, and the advance/block
// decision.
function evaluatePreflightVerdict(sessionID, sessionFiles, sessionPhaseMap, anchorOverride) {
  const info = findNewestPreflightKD(sessionFiles, sessionID);
  const newest = info ? info.filename : "(none)";
  const verdictLabel = info ? (info.verdict ?? "MISSING") : "MISSING";
  const overrideUntil = getOverrideUntil(sessionPhaseMap, sessionID);
  const overrideActive = overrideUntil && getOverrideTargetPhase(overrideUntil) === STATES.PREFLIGHT;
  const anchor = typeof anchorOverride === "number"
    ? anchorOverride
    : (overrideActive ? overrideUntil.since : null);
  if (anchor !== null && info) {
    const mtime = getFileMtimeMs(join(getKnowledgeDir(sessionID), info.filename));
    if (mtime < anchor) {
      debug(`Disk check PREFLIGHT: newest=${newest} verdict=${verdictLabel} → false (stale under override since=${anchor})`);
      return false;
    }
  }
  const result = !!info && info.verdict === "PASS";
  debug(`Disk check PREFLIGHT: newest=${newest} verdict=${verdictLabel} → ${result}`);
  return result;
}

// Reads the active override marker for a session — null when absent or
// malformed. The marker is authoritative only while the current phase equals
// its target. Accepts both the single-phase shape `{ phase, since }` and the
// multi-phase queue shape `{ phases: number[], since }` (backward compatible).
function getOverrideUntil(sessionPhaseMap, sessionID) {
  const overrideUntil = sessionPhaseMap.get(`${sessionID}:overrideUntil`);
  if (!overrideUntil || typeof overrideUntil.since !== "number") return null;
  if (typeof overrideUntil.phase === "number") return overrideUntil;
  if (Array.isArray(overrideUntil.phases) && overrideUntil.phases.length > 0) return overrideUntil;
  return null;
}

// Resolves the current override target phase from a marker — the head of the
// queue for a multi-phase marker, or the single phase for a legacy marker.
// Returns null when the marker is absent or has no target.
function getOverrideTargetPhase(overrideUntil) {
  if (!overrideUntil) return null;
  if (typeof overrideUntil.phase === "number") return overrideUntil.phase;
  if (Array.isArray(overrideUntil.phases) && overrideUntil.phases.length > 0) return overrideUntil.phases[0];
  return null;
}

// True when the active override is the terminal hop of a multi-phase queue —
// a one-element `phases` array. The marker SHAPE is the distinction from a
// genuine single-phase pin: a plan re-armed to its last hop still carries
// `phases`, while a user pin carries `phase`. Conflating them either parks the
// lifecycle behind an anchor SWARM never satisfies or auto-clears a pin the
// user owns (contract #5).
function isTerminalOverrideHop(overrideUntil) {
  return !!overrideUntil && Array.isArray(overrideUntil.phases) && overrideUntil.phases.length === 1;
}

// --- Override walk model (IC-4) ---
//
// A committed multi-phase /phase argument is a walk: `phases` is the remaining
// plan and `phases[0]` is the head. `walkExists` is the SHAPE test and excludes
// the legacy single-phase pin, whose documented semantics are unchanged — a pin
// is a one-hop plan the user owns.
//
// Behind/at/ahead are NUMERIC comparisons, never queue membership. A plan that
// skips SWARM (e.g. [1,7,10] walked from VERIFY) and a FAIL regression into
// SWARM must both read as "behind the head" and resume; testing membership
// instead would manufacture a divergence the walk can never leave.
function walkExists(sessionPhaseMap, sessionID) {
  const marker = getOverrideUntil(sessionPhaseMap, sessionID);
  return !!marker && Array.isArray(marker.phases) && marker.phases.length > 0;
}

// The remaining plan for any marker shape — a walk's queue, or a legacy pin
// read as a one-hop plan. Null when no marker governs anything.
function walkPlanOf(marker) {
  if (!marker) return null;
  if (Array.isArray(marker.phases) && marker.phases.length > 0) return [...marker.phases];
  if (typeof marker.phase === "number") return [marker.phase];
  return null;
}

// The anchor a hop's evidence must reach: `hopSince` when the hop was re-entered
// after a suspension, else the walk's own commit instant. While a walk is
// suspended, the phase it regressed into is anchored the same way — a resume
// must never be driven by pre-walk evidence. Returns null where the marker does
// not govern the phase: no marker, a legacy pin whose phase has moved on, or a
// phase ahead of the head (divergence, refused before any gate is read).
function gateFreshnessAnchor(sessionPhaseMap, sessionID, phase) {
  const marker = getOverrideUntil(sessionPhaseMap, sessionID);
  if (!marker || typeof phase !== "number") return null;
  const plan = walkPlanOf(marker);
  if (!plan) return null;
  const head = plan[0];
  if (!Array.isArray(marker.phases)) return phase === head ? marker.since : null;
  if (phase > head) return null;
  return typeof marker.hopSince === "number" ? marker.hopSince : marker.since;
}

// How a walk leaves the last hop.
const WALK_CLEAR_REASON = Object.freeze({
  ORIGIN: "origin-return",
  EXHAUSTED: "exhausted"
});

// IC-5 — the ONE next-hop decision every forward-advance site uses. Callers
// supply only their own serial fallback; the queue decides everything else, so
// no site can compute a forward target inline.
//   no-walk          no marker, or a pin whose phase has moved on: the fallback
//   hop              at the head with hops left: the next named hop
//   terminal-report  that next hop is the last one and is REPORT
//   resume           behind the head (a regression suspended the walk): the head
//   origin-return    at the last hop, gate passed: the pre-walk origin, else the
//                    fallback; the marker clears with a reason
//   diverged         ahead of the head: target null — the caller must not
//                    advance and must not fall through to presence
//   blocked          defensive: a governed hop that yields no target
function nextForwardPhase(sessionPhaseMap, sessionID, currentPhase, fallbackTarget) {
  const marker = getOverrideUntil(sessionPhaseMap, sessionID);
  const plan = walkPlanOf(marker);
  const isWalk = !!marker && Array.isArray(marker.phases);
  const head = plan ? plan[0] : null;
  const base = { target: fallbackTarget, outcome: "no-walk", head, queue: plan || [] };
  if (!plan || typeof currentPhase !== "number") return base;
  // A legacy pin governs only its own phase; anywhere else it is inert, exactly
  // as before the walk existed.
  if (!isWalk && currentPhase !== head) return base;
  if (currentPhase === head) {
    if (plan.length > 1) {
      const next = plan[1];
      const terminal = next === STATES.REPORT && plan.length === 2;
      return { target: next, outcome: terminal ? "terminal-report" : "hop", head, queue: plan };
    }
    const safePoint = sessionPhaseMap.get(`${sessionID}:overrideSafePoint`);
    const origin = safePoint && typeof safePoint.phase === "number" ? safePoint.phase : null;
    const returnsToOrigin = origin !== null && origin > currentPhase;
    return {
      target: returnsToOrigin ? origin : fallbackTarget,
      outcome: "origin-return",
      head,
      queue: plan,
      clearReason: returnsToOrigin ? WALK_CLEAR_REASON.ORIGIN : WALK_CLEAR_REASON.EXHAUSTED
    };
  }
  if (!isWalk) return base;
  if (currentPhase < head) return { target: head, outcome: "resume", head, queue: plan };
  return { target: null, outcome: "diverged", head, queue: plan };
}

// The no-walk fallback each forward-advance site supplies (FR-15): the serial
// next phase, or VERIFY where a force-advance has always pushed forward. Named
// here so no site spells a forward target of its own.
function noWalkFallback(currentPhase, forceToVerify = false) {
  return forceToVerify ? STATES.VERIFY : currentPhase + 1;
}

// Names the override/queue state for a refusal: the phase the override pins,
// the remaining hop queue, and whether this is the terminal hop of a plan or a
// single-phase pin. Returns null when no override pins the given phase, so
// non-override refusals keep their unchanged message. A walk that is not at its
// head names the off-head state instead: divergence (with the two documented
// recoveries) or suspension (with the re-entry evidence rule).
function describeOverrideState(sessionPhaseMap, sessionID, phase) {
  const overrideUntil = getOverrideUntil(sessionPhaseMap, sessionID);
  if (!overrideUntil) return null;
  const plan = walkPlanOf(overrideUntil);
  const head = plan ? plan[0] : null;
  if (Array.isArray(overrideUntil.phases) && head !== null && phase !== head) {
    const queue = `[${overrideUntil.phases.join(",")}]`;
    if (phase > head) {
      return `override divergence: phase=${phase} head=${head} queue=${queue} — /phase clear or re-issue the walk to recover.`;
    }
    return `Override active: walk suspended — phase ${getPhaseName(phase)} (${phase}), head ${getPhaseName(head)} (${head}), queue ${queue} — re-entry requires evidence written at or after re-entry.`;
  }
  if (head !== phase) return null;
  const target = `${getPhaseName(phase)} (${phase})`;
  if (Array.isArray(overrideUntil.phases)) {
    const hops = overrideUntil.phases.length;
    const status = hops > 1
      ? `${hops} hops remaining`
      : "terminal hop — 1 remaining (queue exhausted after this hop)";
    return `Override active: target ${target}, queue [${overrideUntil.phases.join(",")}] — ${status}.`;
  }
  return `Override active: single-phase pin at target ${target} — clears on fresh evidence or an explicit /phase clear.`;
}

// WRONG_AGENT refusal augmented with the override state when an override pins
// the current phase. A parked lifecycle therefore names its own cause (active
// override, target phase, remaining hops or terminal status) instead of
// returning an undifferentiated wrong-agent error.
function wrongAgentRefusal(sessionPhaseMap, sessionID, phase, expectedAgent) {
  const template = ERROR_TEMPLATES.WRONG_AGENT(expectedAgent);
  const overrideState = describeOverrideState(sessionPhaseMap, sessionID, phase);
  if (!overrideState) return template;
  return {
    code: template.code,
    message: `${template.message}. ${overrideState}`,
    guidance: `${template.guidance} — ${overrideState}`
  };
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

// Phase-entry anchor — epoch ms when the CURRENT phase was entered, or null
// when no anchor was recorded (legacy state files, direct map seeding). Kept
// distinct from the per-save `timestamp`: the anchor marks the phase start
// (the floor for evidence freshness), while `timestamp` moves on every save.
function getPhaseEnteredAt(sessionPhaseMap, sessionID) {
  const value = sessionPhaseMap.get(`${sessionID}:phaseEnteredAt`);
  return typeof value === "number" ? value : null;
}

// Establishes a phase entry: sets the phase and stamps the phase-entry anchor.
// Every transition into a phase (forward advance, regression, backward
// transition, override, fresh init) routes through here so the anchor always
// names the current phase's start.
function enterPhase(sessionPhaseMap, sessionID, phase) {
  sessionPhaseMap.set(sessionID, phase);
  sessionPhaseMap.set(`${sessionID}:phaseEnteredAt`, Date.now());
}

// The CLEANUP rejection vocabulary — every reason the identity verdict can
// return. Exported so the Overseer's description of the CLEANUP gate names the
// same tokens this predicate emits: one source keeps the two from drifting when
// a reason is added or retired.
export const CLEANUP_REJECTION_REASONS = Object.freeze({
  MISSING: "missing",
  UNPARSABLE: "unparsable",
  WRONG_TYPE: "wrong-type",
  WRONG_SESSION: "wrong-session",
  WRONG_GENERATION: "wrong-generation"
});

// CLEANUP artifact validity — the single predicate behind the CLEANUP → REPORT
// verdict, the rejection record, and the phase refusal. Identity alone decides:
// a cleanup artifact carrying this session and the persisted lifecycle
// generation, parseable frontmatter, `type: cleanup`, and the owning
// `session_id`. No timestamp is read, so a wall-clock rollover cannot invert
// the verdict, and each rejection names its own reason so a lifecycle wedged in
// CLEANUP is diagnosable from the log alone.
//
// Reasons: `missing` (no cleanup artifact for this session at all),
// `wrong-generation` (only another generation's artifact exists),
// `unparsable` (no leading frontmatter block), `wrong-type`, `wrong-session`,
// all taken from CLEANUP_REJECTION_REASONS above.
// Returns { ok, reason, filename, path, generation, fileGeneration }; `path` is
// the artifact's own path, or the expected pattern when nothing matched.
function evaluateCleanupArtifact(sessionID, sessionPhaseMap) {
  const storedSID = sessionPhaseMap.get(`${sessionID}:sid`) || sessionID;
  const generation = getActiveLifecycleGeneration(sessionPhaseMap, sessionID);
  const expectedPath = generation > 0
    ? `knowledge/cleanup-*-${storedSID}-gen${generation}.md`
    : `knowledge/cleanup-*-${storedSID}.md`;
  const verdict = (ok, reason, filename, path, fileGeneration) => ({
    ok,
    reason,
    filename: filename ?? null,
    path: path ?? expectedPath,
    generation,
    fileGeneration: fileGeneration ?? generation
  });

  const knowledgeDir = getKnowledgeDir(sessionID);
  let files = [];
  try {
    files = readdirSync(knowledgeDir);
  } catch (_) {
    return verdict(false, CLEANUP_REJECTION_REASONS.MISSING);
  }

  // Same-session candidates across generations: a wrong-generation artifact is
  // reported as such rather than as missing — the difference between "the
  // Committer never wrote it" and "a prior lifecycle's artifact is all that
  // exists".
  const candidates = files.filter(f => /^cleanup-/i.test(f) && matchesSessionKDAnyGeneration(f, storedSID));
  if (candidates.length === 0) return verdict(false, CLEANUP_REJECTION_REASONS.MISSING);

  const live = candidates.filter(f => matchesSessionKD(f, storedSID, generation));
  if (live.length === 0) {
    const newest = candidates
      .map(f => ({ f, gen: extractImplKDGeneration(f, storedSID) }))
      .sort((a, b) => (b.gen ?? -1) - (a.gen ?? -1))[0];
    return verdict(false, CLEANUP_REJECTION_REASONS.WRONG_GENERATION, newest.f, `knowledge/${newest.f}`, newest.gen);
  }

  // A valid artifact wins over an invalid sibling: the first live candidate
  // that satisfies every identity field advances, and the first failure is
  // reported only when none does.
  let firstFailure = null;
  for (const filename of live) {
    const path = `knowledge/${filename}`;
    let content = null;
    try {
      content = readFileSync(join(knowledgeDir, filename), "utf8");
    } catch (_) {
      content = null;
    }
    const frontmatter = typeof content === "string" ? content.match(/^---\r?\n([\s\S]*?)\r?\n---/) : null;
    if (!frontmatter) {
      firstFailure = firstFailure || verdict(false, CLEANUP_REJECTION_REASONS.UNPARSABLE, filename, path);
      continue;
    }
    const field = (name) => {
      const m = frontmatter[1].match(new RegExp(`^${name}\\s*:\\s*(.+?)\\s*$`, "m"));
      return m ? m[1].replace(/^["']|["']$/g, "").trim() : null;
    };
    const type = field("type");
    if (!type || type.toLowerCase() !== "cleanup") {
      firstFailure = firstFailure || verdict(false, CLEANUP_REJECTION_REASONS.WRONG_TYPE, filename, path);
      continue;
    }
    const artifactSession = field("session_id");
    if (!artifactSession || artifactSession !== storedSID) {
      firstFailure = firstFailure || verdict(false, CLEANUP_REJECTION_REASONS.WRONG_SESSION, filename, path);
      continue;
    }
    return verdict(true, null, filename, path);
  }
  return firstFailure;
}

function checkDiskAdvancement(sessionID, phase, sessionPhaseMap, swarmDispatchCount, f1Options) {
  if (phase === undefined) return false;

  // A walk whose head sits behind the current phase cannot advance: evidence is
  // irrelevant, because the phase the lifecycle stands in is not a hop of its
  // plan. The callers record WALK_DIVERGED and refuse; this is the backstop for
  // every other evaluation path.
  {
    const walkMarker = getOverrideUntil(sessionPhaseMap, sessionID);
    if (walkMarker && Array.isArray(walkMarker.phases) && walkMarker.phases.length > 0
      && typeof phase === "number" && phase > walkMarker.phases[0]) {
      debug(`Disk check: walk divergence — phase=${phase} head=${walkMarker.phases[0]} queue=${JSON.stringify(walkMarker.phases)} — refusing to advance`);
      return false;
    }
  }

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
  const knowledgeDir = getKnowledgeDir(sessionID);
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
  const generation = getActiveLifecycleGeneration(sessionPhaseMap, sessionID);
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

  // While an override governs this phase, only fresh evidence
  // (KD mtime >= the hop anchor) advances — pre-existing/stale KDs never undo
  // the manual override (interface contract #5). The anchor is `hopSince` for a
  // hop re-entered after a suspension and `since` otherwise, so a resume is
  // never driven by evidence that predates the regression. KDs written before
  // the anchor are skipped; the marker clears on advance-away, restoring normal
  // advancement semantics for later phases.
  const overrideAnchor = gateFreshnessAnchor(sessionPhaseMap, sessionID, phase);
  const overrideActive = overrideAnchor !== null;

  // DECOMPOSE advancement requires BOTH the plan KD and a parseable milestone
  // registry (dual-KD gate). The Pathfinder produces both at DECOMPOSE; SWARM
  // must not start until the registry (live state SSOT) is on disk and its
  // `## Milestone States` YAML block parses — an unparsable or duplicated
  // registry fails closed here instead of advancing into a guaranteed
  // REGISTRY_MISSING at SWARM. A plan- KD alone is the fail-closed case — no
  // advancement. Freshness is required on BOTH paths: the pair must be at or
  // after the phase-entry anchor (the phase's own start) on the non-override
  // path, and at or after the override `since` while an override is active
  // (contract #5). A phase whose entry predates the anchor — legacy state or
  // direct map seeding — keeps presence-only semantics.
  if (phase === STATES.DECOMPOSE) {
    const phaseEnteredAt = getPhaseEnteredAt(sessionPhaseMap, sessionID);
    const freshnessAnchor = overrideActive ? overrideAnchor : phaseEnteredAt;
    const isFresh = (f) => freshnessAnchor === null || getFileMtimeMs(join(knowledgeDir, f)) >= freshnessAnchor;
    const hasPlan = sessionFiles.some(f => /^plan-/i.test(f) && isFresh(f));
    const hasMilestones = sessionFiles.some(f => /^milestones-/i.test(f) && isFresh(f));
    // The milestones KD must parse via locateMilestoneRegistry semantics
    // (valid `## Milestone States` YAML block, exactly one registry per
    // session/generation). Reuses the same parser the SWARM gate uses so the
    // two gates can never disagree on what a valid registry is.
    const registryParses = hasMilestones && locateMilestoneRegistry(sessionID, sessionPhaseMap) !== null;
    const result = hasPlan && registryParses;
    const anchorNote = overrideActive ? `override fresh-evidence since ${overrideAnchor}` : `phase-entry anchor ${freshnessAnchor}`;
    debug(`Disk check DECOMPOSE: plan=${hasPlan}, milestones=${hasMilestones}, registry-parses=${registryParses} → ${result} (${anchorNote})`);
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
      const verdictInfo = findNewestVerdictKD(sessionFiles, sessionID);
      if (!verdictInfo) {
        debug(`Disk check VERIFY: no review KD — cannot advance under override (since=${overrideAnchor})`);
        return false;
      }
      const mtime = getFileMtimeMs(join(knowledgeDir, verdictInfo.filename));
      if (mtime < overrideAnchor) {
        debug(`Disk check VERIFY: newest KD ${verdictInfo.filename} mtime=${mtime} < since=${overrideAnchor} — not fresh (override)`);
        return false;
      }
      debug(`Disk check VERIFY: newest KD ${verdictInfo.filename} is fresh (mtime=${mtime} >= since=${overrideAnchor}) — evaluating verdict`);
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
    const terminalHop = isTerminalOverrideHop(getOverrideUntil(sessionPhaseMap, sessionID));
    if (result && overrideActive && !terminalHop) {
      const registry = readMilestoneRegistry(sessionID, sessionPhaseMap);
      const registryMtime = registry ? getFileMtimeMs(registry.path) : -1;
      result = registryMtime >= overrideAnchor;
      overrideNote = `, override fresh-evidence: registry mtime=${registryMtime} >= since=${overrideAnchor} → ${result}`;
      if (!result) {
        // The gate's evidence passed and a pin is what refuses the transition.
        // Always-on because this is the wedge shape: a pin taken while every row
        // was already checked-off can never be satisfied — a checked-off row is
        // never rewritten, so the registry that would carry the fresh mtime is
        // never written. Without the record the lifecycle parks with no trace
        // and reads as "the gate is disabled".
        gateRecordEvent("SWARM_GATE_PARKED", [
          ["session", sessionID],
          ["registry", registry ? registry.path.split("/").pop() : "<none>"],
          ["registryMtime", registryMtime],
          ["since", overrideAnchor],
          ["reason", "stale-registry"]
        ], `every milestone row is checked-off with its impl KD on disk, so the gate passed; the pin's fresh-evidence anchor is unmet and a checked-off row is never rewritten — walk the phase past SWARM or land a row transition, because evidence alone cannot satisfy this pin`, `SWARM_GATE_PARKED|${sessionID}|r:${registryMtime}|s:${overrideAnchor}`);
      }
    } else if (overrideActive && terminalHop) {
      // A terminal override hop completes on its ordinary advancement gate.
      // SWARM does not author the registry (a checked-off row is never
      // rewritten), so the registry-mtime anchor can never be satisfied at a
      // terminal SWARM hop — applying it would park the documented
      // origin-return permanently. A genuine single-phase pin keeps the anchor
      // (contract #5), handled by the branch above.
      overrideNote = ", terminal override hop — registry-mtime freshness anchor not applied";
    }
    debug(`Disk check SWARM: all-checked-off gate → ${gate.ok} (${gate.checkedOff}/${gate.total})${overrideNote}`);
    return result;
  }

  // The verdict-aware PREFLIGHT gate — see evaluatePreflightVerdict.
  // The newest preflight KD's frontmatter verdict decides advancement; an
  // escalation, missing, or unreadable signal blocks the phase. Override
  // freshness is evaluated inside the helper, so the override and
  // non-override paths route through it alike.
  if (phase === STATES.PREFLIGHT) {
    return evaluatePreflightVerdict(sessionID, sessionFiles, sessionPhaseMap, overrideAnchor);
  }

  // The identity-based CLEANUP gate — see evaluateCleanupArtifact. Validity is
  // stated once there and decides advancement from identity alone (type,
  // session, generation, parseable frontmatter). No mtime is read on this path,
  // so the override freshness anchor does not apply: a clock rollover cannot
  // invert a verdict that never consults the clock. Fail-closed — every
  // rejection blocks the advance and records its reason on the always-on
  // channel so a stranded lifecycle is diagnosable from the log alone.
  if (phase === STATES.CLEANUP) {
    const verdict = evaluateCleanupArtifact(sessionID, sessionPhaseMap);
    if (!verdict.ok) {
      gateRecord(`CLEANUP_ADVANCE_BLOCKED: session=${sessionID} path=${verdict.path} generation=${verdict.generation} reason=${verdict.reason} — CLEANUP → REPORT needs a cleanup artifact whose frontmatter declares type: cleanup and session_id: ${sessionID}, at the current generation, under knowledge/.`);
      return false;
    }
    debug(`Disk check CLEANUP: artifact=${verdict.filename} identity verdict ok (generation=${verdict.generation})`);
    return true;
  }

  let result;
  if (overrideActive) {
    // Every override-governed phase requires fresh evidence (KD mtime >= the
    // hop anchor) — including INTENT. A pre-existing intent KD (e.g. the old KD
    // the Overseer reads right after a /phase INTENT override) must never count
    // as evidence and undo the override before the corrected KD is written. The
    // in-place intent-correction path is the NON-override branch below, whose
    // presence exemption (a session-matching intent KD advances regardless of
    // mtime) stays in force.
    result = sessionFiles.some(f => pattern.test(f) && getFileMtimeMs(join(knowledgeDir, f)) >= overrideAnchor);
    debug(`Disk check ${getPhaseName(phase)}: override fresh-evidence (since=${overrideAnchor}) → ${result}`);
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
  if (currentPhase === undefined) return false;

  const storedSID = sessionPhaseMap.get(`${sessionID}:sid`);
  if (!storedSID) return false;

  const knowledgeDir = getKnowledgeDir(sessionID);
  let files = [];
  try { files = readdirSync(knowledgeDir); } catch (_) { return false; }

  // Generation-scoped: stale gen-N KDs from a prior lifecycle must not
  // suppress legitimate phase regression in the current lifecycle.
  // The scan covers the current session's KDs only — a fresh
  // session is never held up or regressed by another lifecycle's KDs.
  const generation = getActiveLifecycleGeneration(sessionPhaseMap, sessionID);
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
  if (overrideUntil && currentPhase === getOverrideTargetPhase(overrideUntil)) {
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
    // SWARM whose only impl evidence is superseded files is not
    // missing its KD — do not falsely regress to DECOMPOSE.
    if (currentPhase === STATES.SWARM && hasSupersededImplEvidence(files, sessionID)) return false;
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
      // A superseded-only SWARM anchors the backward walk the same
      // way a live impl KD does — the phase is not missing its evidence.
      if (phase === STATES.SWARM && hasSupersededImplEvidence(files, sessionID)) {
        regressedPhase = phase;
        foundEarlierKD = true;
        break;
      }
      if (sessionFiles.some(f => pattern.test(f))) {
        regressedPhase = phase;
        foundEarlierKD = true;
        break;
      }
    }
  }

  // INTENT with a missing intent KD and no earlier-phase KD falls
  // through to the general no-regression rule below. A missing intent
  // KD is recovered by rewriting it in INTENT (write allowed by the allowlist);
  // checkDiskAdvancement still returns false, so nothing advances.

  if (!foundEarlierKD) return false; // no regression — phase set directly, not via lifecycle

  debug(`Consistency regression: ${getPhaseName(currentPhase)} → ${getPhaseName(regressedPhase)}`);
  enterPhase(sessionPhaseMap, sessionID, regressedPhase);

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

async function protocolGateServer(input, options) {
    // Re-emit the load-signal per server instance: the module-level emit ran
    // with import-time env, while test seams (and host restarts) bind later.
    // Overwrites the same status file with freshly resolved paths.
    emitLoadSignal(getEnablementState());
    // Git-repo bootstrap guard — runs before any lifecycle state is touched so
    // the lifecycle's first git-dependent operation (PREFLIGHT branch
    // creation) always has a repo to work in. Uses the plugin's full Node.js
    // access, not any agent's bash allowlist.
    ensureGitRepo(input?.directory ?? process.cwd());
    // Capture the served project root for knowledge-dir resolution (preferred
    // over process.cwd() per SDK guidance; explicit env seams still win).
    // Reset per server instance along with learned session dirs so restarts
    // and test isolation start clean (production loads once per process).
    setServerProjectRoot(input?.directory ?? null);
    sessionKnowledgeDirs.clear();
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
    // Skip the disk check on the call that enters a phase whose evidence
    // may already be on disk (currently: entering PREFLIGHT). Without this,
    // the disk check immediately finds a pre-existing KD and jumps an extra
    // phase in the same call.
    const skipDiskCheckAfterAdvance = new Map();
    // Tracks consecutive disk check failures per session to detect stuck phases.
    // After 10 failed checks, logs a diagnostic suggesting the delegation is blocked.
    const diskCheckFailures = new Map();
    // Tracks re-dispatch attempts per session-phase pair to cap retries at 5.
    const phaseRedispatchCount = new Map();
    // Per-session blocked-dispatch watchdog counter: a SWARM dispatch
    // blocked as WRONG_AGENT increments this counter; at the threshold
    // (config.maxBlockedDispatches || 3) the gate logs a loud file-only
    // SAFETY_STUCK-style diagnostic and resets the counter so the Overseer
    // can retry the dispatch without a manual /phase override. The individual
    // WRONG_AGENT hard error on each blocked dispatch is preserved.
    const blockedDispatchCount = new Map();
    // Per-session record of the LAST charged dispatch, set at
    // the before-hook charge site so the tool.execute.after hook can restore the
    // redispatch budget when a dispatch produces no expected RESULT KD
    // (empty-result detection). One entry per session — a re-dispatch
    // overwrites the previous record; the entry is deleted after reconciliation.
    const lastTaskDispatch = new Map();
    // Pending impl-KD writes by subagent sessions — sessionID → relPath.
    // Recorded in tool.execute.before (where the tool args are visible) and
    // consumed in tool.execute.after (where the file has landed on disk). The
    // after-hook cannot see the tool args, so the before-hook records the path
    // for the post-write SWARM→VERIFY auto-advance evaluation.
    const pendingImplKDWrites = new Map();
    // Deferred check-offs by subagent sessions — sessionID →
    // { relPath, base, milestoneId }. Recorded in tool.execute.before when the
    // payload is a patch fragment, which the gate cannot judge as a document,
    // and consumed in tool.execute.after where the landed bytes are read. The
    // deferral is only a postponement: without this marker the landed file is
    // never evaluated, and a fragment-only fix delivery leaves a reopened row
    // open with nothing but the deferral line to show for it.
    const deferredCheckOffs = new Map();
    // Pending frontmatter stamp clears by subagent sessions — sessionID →
    // { relPath, base, dir, snapshot }. Recorded in tool.execute.before when an
    // impl-KD write lands over a stamped file with new bytes (a genuine
    // post-stamp rewrite), consumed in tool.execute.after where the landed
    // bytes are on disk: the after-hook re-verifies genuineness against the
    // recorded digest and settles the stamp (status: amended + superseded_by)
    // before promoting, so a row never completes on stale evidence. One entry
    // per session, deleted after consumption.
    const pendingStampClear = new Map();
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
    // auto-regression. A consumed verdict never regresses twice: re-evaluating
    // the same KD regresses again only when the review KD itself was
    // re-emitted after regressedAt (same filename, newer mtime); a NEW FAIL KD
    // filename always regresses. In-memory only (like freshAdvancement) — the cap is
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
    // with no own state file starts at INTENT — no cross-session
    // adoption — and the active-session pointer is deleted at lifecycle
    // end and never re-created for a finished session.
    function getStatePath(sessionID) {
      return getStateFilePath(sessionID);
    }

    function saveState(sessionID) {
      const statePath = getStatePath(sessionID);
      if (!statePath) {
        debug(`saveState: unsafe session ID rejected: ${JSON.stringify(sessionID)}`);
        return false;
      }
      // The phase entry is deleted at lifecycle end (REPORT reset).
      // Persist that state as INTENT — the next lifecycle begins there, and
      // the next reconcile restores INTENT and honors any manual edit of
      // this file.
      const phase = sessionPhaseMap.get(sessionID) ?? STATES.INTENT;
      const sid = sessionPhaseMap.get(`${sessionID}:sid`);
      try {
        // generation persists across lifecycle resets via the :gen map entry.
        // Written even at INTENT (fresh lifecycles start there) so the counter
        // survives restarts between lifecycles. Returns boolean so callers can
        // enforce the atomicity contract: revert in-memory :gen when save fails.
        const generation = sessionPhaseMap.get(`${sessionID}:gen`) || 0;
        // Omit sid from state JSON when it's null/undefined (deleted after REPORT).
        // Previously, sid: null was serialized, causing loadState to skip phase restoration
        // and producing artifacts in the state file.
        const state = { phase, generation, timestamp: Date.now() };
        if (sid) state.sid = sid;
        // Phase-entry anchor — persisted alongside the last-save timestamp so
        // evidence freshness survives a mid-session restart. Omitted when
        // absent — legacy state files without the field load unchanged.
        const phaseEnteredAt = sessionPhaseMap.get(`${sessionID}:phaseEnteredAt`);
        if (typeof phaseEnteredAt === "number") state.phaseEnteredAt = phaseEnteredAt;
        // Serialize the /phase override marker so it survives a
        // mid-session restart. Both marker shapes are persisted: the legacy
        // single-phase `{ phase, since }` and the multi-phase queue
        // `{ phases, since }`. Omitted when absent — legacy state
        // files without overrideUntil load unchanged.
        const overrideUntil = sessionPhaseMap.get(`${sessionID}:overrideUntil`);
        if (overrideUntil && typeof overrideUntil.since === "number") {
          if (typeof overrideUntil.phase === "number") {
            state.overrideUntil = { phase: overrideUntil.phase, since: overrideUntil.since };
          } else if (Array.isArray(overrideUntil.phases) && overrideUntil.phases.length > 0) {
            // A live walk carries its re-entry anchor and its suspension with
            // it across a restart, so a resumed hop keeps demanding evidence
            // written after re-entry. A fresh walk persists exactly
            // { phases, since } — the optional fields appear only when set.
            state.overrideUntil = { phases: overrideUntil.phases, since: overrideUntil.since };
            if (typeof overrideUntil.hopSince === "number") state.overrideUntil.hopSince = overrideUntil.hopSince;
            if (overrideUntil.state === "suspended") state.overrideUntil.state = "suspended";
            if (typeof overrideUntil.suspendedAt === "number") state.overrideUntil.suspendedAt = overrideUntil.suspendedAt;
          }
        }
        // Serialize the pre-walk snapshot so a wedged queue stays
        // diagnosable and roll-back-able across a mid-session restart.
        // Omitted when absent — legacy state files load unchanged.
        const overrideSafePoint = sessionPhaseMap.get(`${sessionID}:overrideSafePoint`);
        if (overrideSafePoint && typeof overrideSafePoint.phase === "number") {
          state.overrideSafePoint = { phase: overrideSafePoint.phase, marker: overrideSafePoint.marker ?? null };
        }
        // Serialize the /phase override record (bounded walk history) so the
        // walk survives a mid-session restart and stays citable from lifecycle
        // KDs. Omitted when empty — legacy state files load unchanged.
        const overrideHistory = sessionPhaseMap.get(`${sessionID}:overrideHistory`);
        if (Array.isArray(overrideHistory) && overrideHistory.length > 0) {
          state.overrideHistory = overrideHistory.slice(-OVERRIDE_HISTORY_MAX);
        }
        // Serialize the post-stamp digests (IC-2) so a restart between a reopen
        // and its fix-up does not lose the only record of what the stamped bytes
        // were. Without this the settlement declines `no-stamp-snapshot` and the
        // row stays open until an operator reopens it again. Omitted when empty —
        // legacy state files load unchanged.
        const stampSnapshots = sessionPhaseMap.get(`${sessionID}:stampSnapshots`);
        if (stampSnapshots && typeof stampSnapshots === "object" && Object.keys(stampSnapshots).length > 0) {
          state.stampSnapshots = { ...stampSnapshots };
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
        return false;
      }
    }

    // Module-level reopen and settlement paths persist through this hook, so the
    // digest they record reaches disk in the same call that computes it. Bound
    // per server instance: the map and its persister belong to one lifecycle
    // state, never to whichever instance happened to load last.
    sessionPhaseMap.persist = (sessionID) => saveState(sessionID);

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
    // missing-file fresh INTENT init (the active-session
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
        // always initializes at INTENT with `:sid` = current, and the first
        // act is writing the intent KD. A same-session restart
        // restores via this session's own state file; a restart that
        // mints a NEW session id mid-lifecycle is recovered via the user's
        // /phase override (SAFETY_ESCAPE).
        enterPhase(sessionPhaseMap, sessionID, STATES.INTENT);
        sessionPhaseMap.set(`${sessionID}:sid`, sessionID);
        saveState(sessionID);
        debug(`reconcile: initialized INTENT for ${sessionID} (no cross-session adoption)`);
        return;
      }

      if (state === "corrupt") {
        // The corrupt file was backed up by readStateFile — initialize
        // fresh rather than trusting a half-written state. The next valid
        // transition overwrites the original path with valid JSON.
        enterPhase(sessionPhaseMap, sessionID, STATES.INTENT);
        sessionPhaseMap.set(`${sessionID}:sid`, sessionID);
        saveState(sessionID);
        debug(`reconcile: initialized INTENT after corrupt state file for ${sessionID}`);
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
      // Legacy phase 0 (PROTOCOL_NOT_LOADED, removed) maps to INTENT — the
      // lifecycle now begins there directly.
      const rawPhase = typeof state.phase === "number" ? state.phase : STATES.INTENT;
      const phase = rawPhase === 0 ? STATES.INTENT : rawPhase;
      sessionPhaseMap.set(sessionID, phase);
      // Restore the phase-entry anchor so evidence freshness survives a
      // restart — the restored phase's own start is what the DECOMPOSE gate
      // compares against. Omitted when absent — legacy state files keep
      // presence-only semantics.
      if (typeof state.phaseEnteredAt === "number") {
        sessionPhaseMap.set(`${sessionID}:phaseEnteredAt`, state.phaseEnteredAt);
      }
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
      // restart honors the override until fresh evidence. Both marker shapes
      // are restored: the legacy single-phase `{ phase, since }` and the
      // multi-phase queue `{ phases, since }`. Omitted
      // when absent — legacy state files load unchanged.
      if (state.overrideUntil && typeof state.overrideUntil.since === "number") {
        if (typeof state.overrideUntil.phase === "number") {
          sessionPhaseMap.set(`${sessionID}:overrideUntil`, { phase: state.overrideUntil.phase, since: state.overrideUntil.since });
          debug(`reconcile: restored overrideUntil phase=${getPhaseName(state.overrideUntil.phase)} since=${state.overrideUntil.since} for ${sessionID}`);
        } else if (Array.isArray(state.overrideUntil.phases) && state.overrideUntil.phases.length > 0) {
          const restoredMarker = { phases: state.overrideUntil.phases, since: state.overrideUntil.since };
          // Suspension and the re-entry anchor survive a restart with the plan
          // they belong to; both are optional, so a fresh walk restores exactly
          // { phases, since }.
          if (typeof state.overrideUntil.hopSince === "number") restoredMarker.hopSince = state.overrideUntil.hopSince;
          if (state.overrideUntil.state === "suspended") restoredMarker.state = "suspended";
          if (typeof state.overrideUntil.suspendedAt === "number") restoredMarker.suspendedAt = state.overrideUntil.suspendedAt;
          sessionPhaseMap.set(`${sessionID}:overrideUntil`, restoredMarker);
          debug(`reconcile: restored overrideUntil queue=${JSON.stringify(state.overrideUntil.phases)} since=${state.overrideUntil.since}${restoredMarker.state === "suspended" ? " (suspended)" : ""} for ${sessionID}`);
        }
      }
      // Restore the pre-walk snapshot alongside the marker it documents.
      // Omitted when absent — legacy state files load unchanged.
      if (state.overrideSafePoint && typeof state.overrideSafePoint.phase === "number") {
        sessionPhaseMap.set(`${sessionID}:overrideSafePoint`, { phase: state.overrideSafePoint.phase, marker: state.overrideSafePoint.marker ?? null });
        debug(`reconcile: restored overrideSafePoint phase=${getPhaseName(state.overrideSafePoint.phase)} for ${sessionID}`);
      }
      // Restore the /phase override record so the walk stays citable after a
      // restart. Entries are trusted as written by recordPhaseOverride
      // (bounded at write time); malformed shapes are dropped. Omitted when
      // absent — legacy state files load unchanged.
      if (Array.isArray(state.overrideHistory) && state.overrideHistory.length > 0) {
        const restored = state.overrideHistory.filter(e => e && typeof e.at === "string" && typeof e.from === "number" && typeof e.to === "number").slice(-OVERRIDE_HISTORY_MAX);
        if (restored.length > 0) {
          sessionPhaseMap.set(`${sessionID}:overrideHistory`, restored);
          debug(`reconcile: restored overrideHistory (${restored.length} entries) for ${sessionID}`);
        }
      }
      if (state.sid && state.sid !== sessionID) {
        debug(`reconcile: healed stale sid ${state.sid} → ${sessionID} for ${sessionID}`);
        saveState(sessionID);
      }
      // Restore the post-stamp digests (IC-2) so a settlement attempt after a
      // restart still recognises the bytes it stamped. Malformed entries are
      // dropped rather than trusted: a digest that is not a string can never
      // match content, and a settlement that declines `no-stamp-snapshot` is
      // the honest outcome there anyway.
      if (state.stampSnapshots && typeof state.stampSnapshots === "object" && !Array.isArray(state.stampSnapshots)) {
        const restoredSnapshots = {};
        for (const [key, digest] of Object.entries(state.stampSnapshots)) {
          if (typeof key === "string" && key.includes("|") && typeof digest === "string" && digest.length > 0) {
            restoredSnapshots[key] = digest;
          }
        }
        if (Object.keys(restoredSnapshots).length > 0) {
          sessionPhaseMap.set(`${sessionID}:stampSnapshots`, restoredSnapshots);
          debug(`reconcile: restored ${Object.keys(restoredSnapshots).length} stamp snapshot(s) for ${sessionID}`);
        }
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
    // A reset file that carries a `generation` field is a completed-lifecycle
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
      enterPhase(sessionPhaseMap, sessionID, targetPhase);
      // A backward transition clears a legacy single-phase pin — the user chose
      // to move back, so the pin no longer applies — and the clear is recorded
      // always-on with its cause. A committed queue is the user's *plan*, so a
      // regression SUSPENDS it instead: the plan, the walk anchor and the safe
      // point survive, because the detour is not a changed mind. The head is
      // re-entered with a re-entry anchor on the way back (FR-22), so evidence
      // written before the regression can never satisfy the re-entered hop.
      if (sessionPhaseMap.has(`${sessionID}:overrideUntil`)) {
        const dropped = sessionPhaseMap.get(`${sessionID}:overrideUntil`);
        if (Array.isArray(dropped.phases) && dropped.phases.length > 0) {
          const alreadySuspended = dropped.state === "suspended";
          if (!alreadySuspended) {
            sessionPhaseMap.set(`${sessionID}:overrideUntil`, {
              ...dropped,
              state: "suspended",
              suspendedAt: Date.now()
            });
          }
          // One line per regression, even when the walk is already suspended:
          // the backward transition is the event, and an operator reading the
          // log must see every detour the plan took.
          gateRecordEvent("WALK_SUSPENDED", [
            ["session", sessionID],
            ["from", String(prevPhase)],
            ["to", String(targetPhase)],
            ["queue", `[${dropped.phases.join(",")}]`]
          ]);
          debug(`Override suspended: backward transition ${getPhaseName(prevPhase)} → ${getPhaseName(targetPhase)} — queue ${JSON.stringify(dropped.phases)} survives`);
        } else {
          sessionPhaseMap.delete(`${sessionID}:overrideUntil`);
          sessionPhaseMap.delete(`${sessionID}:overrideSafePoint`);
          sessionPhaseMap.delete(`${sessionID}:overrideEvals`);
          gateRecordEvent("WALK_CLEARED", [
            ["session", sessionID],
            ["reason", "backward-pin"],
            ["from", String(prevPhase)],
            ["to", String(targetPhase)],
            ["queue", `[${(Array.isArray(dropped?.phases) ? dropped.phases : [dropped?.phase]).filter(v => typeof v === "number").join(",")}]`]
          ], `backward transition ${getPhaseName(prevPhase)} → ${getPhaseName(targetPhase)}`);
          debug(`Override cleared: backward transition ${getPhaseName(prevPhase)} → ${getPhaseName(targetPhase)}`);
        }
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
        const knowledgeDir = getKnowledgeDir(sessionID);
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

    // Watchdog: observes a blocked SWARM dispatch. The per-session
    // blocked-dispatch counter increments on each WRONG_AGENT block; at the
    // threshold (config.maxBlockedDispatches || 3) the gate logs a loud
    // file-only SAFETY_STUCK-style diagnostic and resets the counter so the
    // Overseer can retry the dispatch without a manual /phase override. The
    // individual WRONG_AGENT hard error is preserved — this only observes.
    function watchBlockedSwarmDispatch(sessionID, phase) {
      if (phase !== STATES.SWARM) return;
      const threshold = config.maxBlockedDispatches || 3;
      const count = (blockedDispatchCount.get(sessionID) || 0) + 1;
      blockedDispatchCount.set(sessionID, count);
      if (count >= threshold) {
        loud(`SAFETY_STUCK: ${count} blocked SWARM dispatches (threshold ${threshold}) for session ${sessionID} — blocked-dispatch counter reset; retry the dispatch with the correct agent`);
        blockedDispatchCount.delete(sessionID);
      }
    }

    // Restart-proof check-off — the impl KD filename is the ONLY
    // source of the parent lifecycle. Candidate parent sessions are collected
    // from the on-disk .state files (which survive restart) plus the in-memory
    // overseer cache; the filename's embedded `-{sessionID}` suffix selects
    // the parent with the session-id match mandatory, and the embedded
    // `-gen{N}` must equal the persisted lifecycle generation
    // (generation-pinned — aligned with the disk-evidence predicate
    // findMilestoneImplKD, so skewed evidence declines with a
    // GEN_MISMATCH_SKIP instead of checking off). A fresh instance with an
    // empty overseerSessions set still checks the milestone off.
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

    // The lifecycle's number is allocated when the lifecycle starts. Its INTENT
    // is the artifact that names it, so the generation that INTENT carries IS
    // this lifecycle's number; adopting it into the persisted counter on the
    // INTENT write is what stops the counter and the artifacts from ever
    // disagreeing while the lifecycle runs. The state this removes is a counter
    // that says one number while every artifact of the running lifecycle carries
    // another — the state that refused this lifecycle's own evidence and left
    // the milestone gate with nothing to promote.
    //
    // Uniqueness is enforced here, not reported. A number another INTENT of this
    // session already carries belongs to a lifecycle that is still unfinished,
    // and at the same generation the filename carries no discriminator — the two
    // lifecycles' artifacts would satisfy one evidence predicate and merge.
    // Recording that would leave the merge in place, so the start is refused and
    // the caller blocks the write. The allocator keeps a held number out of
    // gate-allocated starts; this keeps it out of the starts a dispatcher names.
    function adoptLifecycleGenerationOnIntent(sessionID, relPath) {
      const base = String(relPath).replace(/\\/g, "/").split("/").pop();
      const generation = extractImplKDGeneration(base, sessionID);
      // No `-gen{N}` for this session: the name is not this lifecycle's INTENT
      // and carries no number to adopt. Not a skip — there is nothing to adopt.
      if (generation === null) return { ok: true, generation: null };
      const persisted = getPersistedGeneration(sessionID) ?? getCurrentGeneration(sessionPhaseMap, sessionID);
      const knowledgeDir = getKnowledgeDir(sessionID);
      let holders = [];
      try {
        holders = readdirSync(knowledgeDir).filter(f =>
          /^intent-/i.test(f) && f !== base && extractImplKDGeneration(f, sessionID) === generation
        );
      } catch (_) {}
      if (holders.length > 0) {
        gateRecordEvent("LIFECYCLE_GENERATION_COLLISION", [
          ["session", sessionID],
          ["generation", generation],
          ["anchor", base],
          ["others", holders.join(",")],
          ["started", "false"]
        ], `generation ${generation} is already held by an unfinished lifecycle of this session (${holders.join(",")}); at the same generation the filename carries no discriminator, so the two lifecycles' artifacts would be one evidence set — this lifecycle cannot start at ${generation} and the write is refused. Start at a free number: the allocator names the next one`, `LIFECYCLE_GENERATION_COLLISION|${sessionID}|g:${generation}|f:${base}|o:${holders.join(",")}`);
        return { ok: false, reason: "generation-held", generation, holders };
      }
      if (persisted === generation) return { ok: true, generation };
      sessionPhaseMap.set(`${sessionID}:gen`, generation);
      if (!saveState(sessionID)) {
        sessionPhaseMap.set(`${sessionID}:gen`, persisted);
        gateRecord(`LIFECYCLE_GENERATION_ADOPT_FAILED: session=${sessionID} artifact=${base} persistedGen=${persisted} activeGen=${generation} reason=state-write-failed`);
        return { ok: false, reason: "state-write-failed", generation: null };
      }
      gateRecordEvent("LIFECYCLE_GENERATION_ADOPTED", [
        ["session", sessionID],
        ["persistedGen", persisted],
        ["activeGen", generation],
        ["anchor", base]
      ], `the lifecycle started under ${generation}: the number its INTENT carries is now the persisted counter, so the allocator and the evidence agree from the first write`, `LIFECYCLE_GENERATION_ADOPTED|${sessionID}|p:${persisted}|a:${generation}|f:${base}`);
      return { ok: true, generation };
    }

    // When the artisan writes its milestone-scoped impl KD,
    // advance that milestone to checked-off in the parent lifecycle's registry.
    // The impl KD on disk IS the verifiable evidence of completion — the
    // SWARM→VERIFY gate reads it back via checkMilestoneCheckedOff. Only a row
    // in-progress in the registry can complete; the parent session and
    // generation come from the filename + on-disk state, never from in-memory
    // session state alone.
    // RESTART REQUIRED: plugins load once per opencode process —
    // changes to this check-off path and its loud diagnostics take effect
    // only after opencode restarts.
    // `transport` names the entry point that reached this evaluation: the write
    // hook judges the incoming document, the after-hook judges the bytes a
    // deferred fragment landed. The record carries the tag, so a promotion says
    // which of the two produced it.
    function autoCheckOffMilestone(relPath, incomingContent, writerSessionID, transport = "write-hook", opts = {}) {
      const milestoneId = extractMilestoneIdFromImplKD(relPath);
      if (!milestoneId) return;
      // Liveness decides with the one parse (FR-01, FR-04). The before-hook
      // fires before the runtime materializes the file, so the incoming text is
      // the only content available — the disk-reading cross-check consults the
      // same parse, so registry promotion and checkMilestoneCheckedOff agree.
      //
      // A stamped artifact is never promoted from the write hook, whatever the
      // transport carried: the only evidence the gate accepts is the LANDED
      // file, and the stamp has to settle on it first (FR-08). Settlement is a
      // disk-state evaluation reachable from the after-hook, the SWARM gate and
      // stuck-row reconciliation (FR-06), so nothing is lost by waiting.
      const diskSnapshot = readImplKDSnapshot(relPath, writerSessionID);
      const artifactBase = relPath.replace(/\\/g, "/").split("/").pop();
      const incomingVerdict = isDocumentPayload(incomingContent) ? evaluateLiveness(incomingContent) : null;
      if (!opts.landed && diskSnapshot !== null && diskSnapshot.stale) {
        if (typeof incomingContent === "string" && diskSnapshot.content !== incomingContent) {
          // A marker that a stamp clear is owed, not a claim about the target:
          // settlement re-derives the canonical artifact from disk, so this
          // record cannot redirect it at the path the writer happened to use.
          pendingStampClear.set(writerSessionID, { relPath, base: diskSnapshot.base });
          gateRecordEvent("STAMP_CLEAR_PENDING", [
            ["milestone", milestoneId],
            ["artifact", artifactBase]
          ], `milestone ${milestoneId} fix-up rewrite detected at ${relPath} — incoming bytes differ from the stamped digest, so the stamp settles on the landed bytes and the row promotes then`, `STAMP_CLEAR_PENDING|${milestoneId.toUpperCase()}|a:${artifactBase}`);
        }
        return;
      }
      if (typeof incomingContent === "string" && incomingVerdict === null) {
        // A patch fragment is not a document, so it carries no verdict about
        // the artifact. Deferring is recorded rather than silent: without the
        // line, "the hook saw a fragment and waited for the landed file" is
        // indistinguishable from "the hook never ran".
        gateRecordEvent("CHECKOFF_DEFERRED", [
          ["milestone", milestoneId],
          ["artifact", artifactBase],
          ["payload", "fragment"],
          ["promoted", "false"],
          ["reason", "not-a-document"]
        ], `milestone ${milestoneId}: the incoming payload carries no frontmatter block, so it is a patch fragment — the landed file is evaluated instead at ${relPath}`, `CHECKOFF_DEFERRED|${gateRecordMilestoneTag(milestoneId)}a:${artifactBase}`);
        // The deferral names its own consumer: the after-hook reads the landed
        // file and evaluates it there. Nothing about that evaluation depends on
        // the phase the process happens to stand in — a row's promotion is a
        // registry transition on evidence, not a phase move.
        deferredCheckOffs.set(writerSessionID, { relPath, base: artifactBase, milestoneId });
        return;
      }
      if (incomingVerdict && !incomingVerdict.live) {
        // Not live and no stamped file behind it: the promotion evaluation ran
        // and did not promote, so it is recorded as a promotion outcome
        // carrying the liveness reason rather than as a second event.
        gateRecordEvent("CHECKOFF", [
          ["milestone", milestoneId],
          ["artifact", artifactBase],
          ["promoted", "false"],
          ["reason", incomingVerdict.reason],
          ["transport", transport]
        ], `milestone ${milestoneId} keeps its registry state — incoming impl KD is not live (${incomingVerdict.reason}) at ${relPath}. Write fresh fix evidence with an allowlisted status to re-complete.`, `CHECKOFF|${gateRecordMilestoneTag(milestoneId)}a:${artifactBase}|p:false|r:${incomingVerdict.reason}|t:${transport}`);
        return;
      }
      for (const candidate of collectParentSessionCandidates()) {
        // The lifecycle's own artifacts name its generation; the persisted
        // counter is only the allocator and is carried in the record so a
        // moved counter is visible beside the value evidence resolved against.
        // The map is seeded so the generation-scoped registry lookup
        // (locateMilestoneRegistry) resolves the same lifecycle after a restart
        // when the map is empty. A write whose embedded generation differs from
        // the active lifecycle's declines with an always-on GEN_MISMATCH_SKIP
        // record instead of checking off.
        const persisted = getPersistedGeneration(candidate) ?? getCurrentGeneration(sessionPhaseMap, candidate);
        const generation = getActiveLifecycleGeneration(sessionPhaseMap, candidate);
        const base = relPath.replace(/\\/g, "/").split("/").pop();
        const fileGen = extractImplKDGeneration(base, candidate);
        if (fileGen === null) {
          // The filename carries no generation token for this session, so the
          // artifact cannot be placed in any lifecycle. Recorded per candidate
          // because the reason is the candidate's: a name that matches one
          // session and not another is the ordinary case here.
          gateRecord(`AUTO_CHECKOFF_UNMATCHED: ${relPath} session=${candidate} milestone=${milestoneId} reason=no-generation-token activeGen=${generation} persistedGen=${persisted} promoted=false`);
          continue;
        }
        if (fileGen !== generation) {
          gateRecordEvent("GEN_MISMATCH_SKIP", [
            ["session", candidate],
            ["milestone", milestoneId],
            ["file", base],
            ["fileGen", fileGen],
            ["activeGen", generation],
            ["persistedGen", persisted],
            ["reason", "gen-mismatch"],
            ["promoted", "false"]
          ], `the write is not this lifecycle's evidence: file generation ${fileGen} differs from the active lifecycle's ${generation}, so nothing is promoted at ${relPath}`, `GEN_MISMATCH_SKIP|${gateRecordMilestoneTag(milestoneId)}a:${base}|fg:${fileGen}|ag:${generation}`);
          return;
        }
        // Seed the in-memory generation so the generation-scoped registry
        // lookup (locateMilestoneRegistry) finds the same lifecycle after a
        // restart when the map is empty.
        if (!sessionPhaseMap.has(`${candidate}:gen`)) {
          sessionPhaseMap.set(`${candidate}:gen`, generation);
        }
        // Resolve the milestone against the parent-session registry rows —
        // the SSOT of milestone IDs. Hyphenated IDs (e.g. `M-core`) are
        // truncated to their first token (`M`) by the legacy extractor, so
        // the row whose ID prefix-matches the impl KD's name portion is the
        // authoritative ID to check off. An exact row-ID match is preferred
        // over a prefix match — `impl-M-core-...` prefix-matches both `M`
        // and `M-core`, and the exact row wins.
        const registry = readMilestoneRegistry(candidate, sessionPhaseMap);
        const resolvedId = resolveMilestoneRowId(registry, relPath, milestoneId);
        const result = updateMilestoneRegistry(candidate, sessionPhaseMap, resolvedId, ["checked-off"]);
        debug(`auto check-off: impl KD for milestone ${resolvedId} (parent ${candidate}) → ${JSON.stringify(result)}`);
        // Always-on promotion record: one line per evaluation, naming the
        // artifact and the outcome. Without it a row that stays open after a
        // write is indistinguishable from a write the gate never saw.
        const promoted = result.ok && result.changed;
        gateRecordEvent("CHECKOFF", [
          ["milestone", resolvedId],
          ["artifact", artifactBase],
          ["promoted", promoted ? "true" : "false"],
          ["reason", promoted ? "live-evidence" : (result.ok ? "already-checked-off" : result.reason)],
          ["transport", transport]
        ], null, `CHECKOFF|${gateRecordMilestoneTag(resolvedId)}a:${artifactBase}|p:${promoted ? "true" : "false"}|r:${promoted ? "live-evidence" : (result.ok ? "already-checked-off" : result.reason)}|t:${transport}`);
        // Only a SUCCESSFUL check-off resets the per-milestone
        // redispatch budget. A failed registry update keeps the counter so
        // retries still count toward the cap; a re-opened milestone
        // starts fresh because its budget was cleared at the earlier
        // check-off — the desired re-open semantics.
        if (result.ok) {
          phaseRedispatchCount.delete(milestoneRedispatchKey(candidate, resolvedId));
          debug(`COUNTER_RESET: per-milestone redispatch key deleted for ${resolvedId} (session ${candidate})`);
        } else {
          // Loud, non-blocking diagnostic: silent failures here left
          // registries stuck in SWARM. Always-on; carries the {ok:false} reason
          // (no-registry / milestone-not-found / invalid-transition / write-failed).
          gateRecord(`AUTO_CHECKOFF_FAILED: milestone ${resolvedId} (parent ${candidate}) — ${result.reason} artifact=${artifactBase} reason=${result.reason} promoted=false`);
        }
        return;
      }
      // No parent-session/generation candidate matched the impl KD filename —
      // nothing was checked off. Always-on so the miss is observable instead of
      // silent: a row that stays open after a write must not be
      // indistinguishable from a write the gate never saw.
      gateRecord(`AUTO_CHECKOFF_UNMATCHED: ${relPath} reason=no-matching-session promoted=false`);
    }

    // Terminal evaluation for a deferred check-off: the fragment has landed, so
    // the file on disk is read and judged by the same function the document path
    // uses. Deliberately phase-independent — a row's promotion is a registry
    // transition on evidence, not a phase move, so it must not be skipped
    // because this process is not the one standing in SWARM. One record either
    // way: the landed bytes decide, and a decline names why.
    function settleDeferredCheckOff(writerSessionID, relPath) {
      const pending = deferredCheckOffs.get(writerSessionID);
      if (!pending) return false;
      const base = String(relPath).replace(/\\/g, "/").split("/").pop();
      // A deferral is keyed to the artifact it postponed; a write to another
      // path must not consume it.
      if (pending.base !== base) return false;
      deferredCheckOffs.delete(writerSessionID);
      let landed = null;
      try { landed = readFileSync(join(resolveArtifactDir(writerSessionID), base), "utf8"); } catch (_) { landed = null; }
      if (landed === null) {
        gateRecordEvent("CHECKOFF", [
          ["milestone", pending.milestoneId],
          ["artifact", base],
          ["promoted", "false"],
          ["reason", "unreadable"],
          ["transport", "after-hook"]
        ], `milestone ${pending.milestoneId} keeps its registry state — the deferred write landed at ${relPath} but the file could not be read, so the evaluation had nothing to judge`, `CHECKOFF|${gateRecordMilestoneTag(pending.milestoneId)}a:${base}|p:false|r:unreadable|t:after-hook`);
        return false;
      }
      // A landing that is not a document has no evaluation left to defer to.
      // Recording it here closes the deferral instead of re-deferring on every
      // later write of the same artifact.
      if (!isDocumentPayload(landed)) {
        gateRecordEvent("CHECKOFF", [
          ["milestone", pending.milestoneId],
          ["artifact", base],
          ["promoted", "false"],
          ["reason", "not-a-document"],
          ["transport", "after-hook"]
        ], `milestone ${pending.milestoneId} keeps its registry state — the landed file at ${relPath} carries no frontmatter block either, so there is no document to evaluate`, `CHECKOFF|${gateRecordMilestoneTag(pending.milestoneId)}a:${base}|p:false|r:not-a-document|t:after-hook`);
        return false;
      }
      // The landed bytes are judged as a document, not through the write-hook's
      // stamp snapshot: the snapshot answers "is the file behind this write
      // already stamped?", a question about a write still in flight. Once the
      // write has landed the answer is in the bytes, and routing a not-live
      // landing through the snapshot would return silently — the deferral would
      // end in exactly the silence it exists to remove.
      autoCheckOffMilestone(relPath, landed, writerSessionID, "after-hook", { landed: true });
      return true;
    }

    // Settles every deferred genuine-rewrite stamp clear by evaluating disk
    // state: settlement is idempotent and stays transport-independent (FR-06),
    // and the tag on each record names which of the three transports produced
    // it, so this is the after-write fast path sharing one implementation with
    // the SWARM gate and stuck-row reconciliation. Each attempt, decline and
    // promotion carries its own always-on line, so a reopened row that never
    // closes is diagnosable with no debug flag set. The observed write path is
    // not handed in: settlement reads the canonical artifact, so a write aimed
    // at a same-basename copy settles nothing here.
    function settlePendingStampClears() {
      for (const candidate of collectParentSessionCandidates()) {
        settleStampClearsForSession(candidate, sessionPhaseMap, "after-hook");
      }
    }

    // Post-write SWARM→VERIFY auto-advance: after a subagent's impl KD write
    // completes (file on disk), evaluate the parent session's SWARM gate and
    // advance when every milestone row is checked-off with its impl KD on disk.
    // The before-hook check-off runs before the file lands, so the gate
    // evaluation belongs in the after-hook where the impl KD is verifiable
    // evidence. The advance targets the parent (Overseer) session's
    // phase-map entry only — the subagent's own session is unaffected.
    // Returns true when the parent session advanced.
    function advanceParentSessionFromSwarm(candidate) {
      const currentPhase = sessionPhaseMap.get(candidate);
      if (currentPhase !== STATES.SWARM) return false;
      // The queue decides the next hop here too: a walk naming SWARM followed by
      // EVOLVE hand the parent to EVOLVE, and a walk still behind SWARM resumes.
      const decision = nextForwardPhase(sessionPhaseMap, candidate, currentPhase, noWalkFallback(currentPhase));
      if (decision.outcome === "diverged") {
        applyForwardAdvance(candidate, currentPhase, decision);
        return false;
      }
      // checkDiskAdvancement applies the full SWARM gate including the
      // override fresh-evidence requirement (registry mtime >= since).
      if (!checkDiskAdvancement(candidate, STATES.SWARM, sessionPhaseMap, swarmDispatchCount)) {
        // Stall accounting: an advance evaluation ran against the committed
        // queue head and found no fresh evidence. See the commit path — the
        // wedged-queue error fires only after such an evaluation.
        const stalledMarker = getOverrideUntil(sessionPhaseMap, candidate);
        if (stalledMarker && Array.isArray(stalledMarker.phases) && currentPhase === getOverrideTargetPhase(stalledMarker)) {
          sessionPhaseMap.set(`${candidate}:overrideEvals`, (sessionPhaseMap.get(`${candidate}:overrideEvals`) || 0) + 1);
        }
        return false;
      }
      // The one transition commit owns the phase entry, the marker settle and
      // the record — the queue is authoritative here as at every other site.
      const applied = applyForwardAdvance(candidate, currentPhase, decision);
      if (applied.entered === null) return false;
      const newPhase = applied.entered;
      diskCheckFailures.set(candidate, 0);
      inFlightDispatches.delete(candidate);
      pendingVerification.delete(candidate);
      pendingVerificationToolCount.delete(candidate);
      phaseRedispatchCount.delete(`${candidate}:${currentPhase}`);
      const cycles = cycleMap.get(candidate);
      if (cycles && cycles[currentPhase] !== undefined) {
        delete cycles[currentPhase];
      }
      freshAdvancement.set(candidate, { phase: newPhase, diskCheckCount: 0 });
      const gateEvidence = checkAllMilestonesCheckedOff(candidate, sessionPhaseMap);
      const reason = `all milestones checked-off: ${gateEvidence.checkedOff}/${gateEvidence.total}`;
      advancementAnnouncements.set(candidate, {
        from: getPhaseName(currentPhase),
        to: getPhaseName(newPhase),
        reason
      });
      debug(`POST_WRITE_ADVANCE: ${getPhaseName(currentPhase)} → ${getPhaseName(newPhase)} for parent session ${candidate} (${reason})`);
      return true;
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
        debugCollapsed("passing-through", `chat.params: non-overseer session ${sessionID} (agent=${agent}) — passing through`);
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
    // capped at RAW_INTENT_MAX_MESSAGES, and overflow drops follow-ups from
    // index 1 upward so the message that opened the lifecycle survives.
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
        list.splice(1, list.length - RAW_INTENT_MAX_MESSAGES);
      }
      rawIntentCapture.set(sessionID, list);
      debug(`chat.message: captured ${texts.length} text part(s) for session ${sessionID} (${list.length}/${RAW_INTENT_MAX_MESSAGES})`);
    }

    // --- Hook: command.execute.before ---
    // Implements the /phase slash command — the single user-facing override
    // path. Validates the argument against STATES (rejections: 99, INVALID,
    // empty), sets the phase in memory, persists via saveState, and replies
    // with a deterministic confirmation. Any valid phase 1-12 is accepted with
    // no forward-jump cap; the command template is confirmation-only —
    // the LLM never hand-writes state files.
    //
    // The /phase override contract, echoed in every usage and rejection reply.
    // A multi-phase argument is a forward plan of target phases: the lifecycle
    // lands on the first, auto-advances to the next NAMED phase on fresh
    // evidence, and returns to the phase the override started from once the
    // list is exhausted. Phases the plan skips do not run their gates and
    // produce no KDs (so a missing downstream KD is not a fault). A trailing
    // gen<N> suffix is accepted and ignored.
    const PHASE_USAGE = "Usage: /phase <1-12|PHASE_NAME|{3,4,5}|clear>. A multi-phase list is a forward plan of target phases — the lifecycle lands on the first and auto-advances to each next named phase on fresh evidence, then returns to the phase the override started from; skipped phases do not run their gates. A trailing gen<N> suffix is accepted and ignored (the lifecycle generation stays implicit).";
    async function commandExecuteBefore(input, output) {
      const commandName = String(input.command || "").replace(/^\/+/, "");
      // Explicit, audited remediation path: /reconcile-superseded restores a
      // superseded-only milestone row to checked-off by restoring its legacy
      // canonical filename(s) once. Distinct from
      // /phase — it never routes through SAFETY_ESCAPE and never touches the
      // phase machine. Requires explicit invocation; never fires automatically.
      if (commandName === "reconcile-superseded") {
        const { sessionID, arguments: arg } = input;
        const trimmed = String(arg ?? "").trim();
        if (!trimmed) {
          output.parts = [{ type: "text", text: "Error: /reconcile-superseded requires a milestone ID. Usage: /reconcile-superseded <MILESTONE_ID>" }];
          return;
        }
        const actor = sessionAgentMap.get(sessionID) || "overseer";
        const result = reconcileSupersededMilestone(sessionID, sessionPhaseMap, trimmed, actor);
        if (result.ok) {
          output.parts = [{ type: "text", text: `SUPERSEDED_RECONCILED: milestone ${result.milestoneId} advanced to checked-off via explicit remediation (evidence: ${result.evidence.join(", ")}, actor: ${result.actor}).` }];
        } else {
          output.parts = [{ type: "text", text: `Error: could not reconcile milestone "${trimmed}" — ${result.reason}.` }];
        }
        return;
      }
      if (commandName !== "phase") return;
      const { sessionID, arguments: arg } = input;
      const trimmed = String(arg ?? "").trim();
      if (!trimmed) {
        output.parts = [{ type: "text", text: `Error: /phase requires an argument. ${PHASE_USAGE}` }];
        return;
      }
      // A trailing lifecycle-generation token (`/phase align gen1`) is
      // accepted and ignored — the lifecycle generation stays implicit in
      // persisted state. Diagnosis-claim tokens (`diagnosis:<ref>
      // escalation:<ref>`) travel alongside the phase argument for the
      // identical-verdict brake and are stripped before parsing, so the
      // stripped rest drives parsing below.
      const { rest: phaseArg, generation: generationSuffix } = stripGenerationSuffix(stripBrakeDiagnosisClaim(trimmed));
      const genNote = generationSuffix !== null ? ` Generation suffix gen${generationSuffix} ignored — lifecycle generation stays implicit.` : "";
      // Explicit clear: drop the override marker without moving the phase and
      // resume normal advancement semantics. Not an escape — the phase never
      // changes — so SAFETY_ESCAPE never fires here.
      if (phaseArg.trim().toLowerCase() === "clear") {
        const currentPhase = sessionPhaseMap.get(sessionID);
        const at = new Date().toISOString();
        if (sessionPhaseMap.has(`${sessionID}:overrideUntil`)) {
          const marker = sessionPhaseMap.get(`${sessionID}:overrideUntil`);
          const was = getOverrideTargetPhase(marker);
          const safePoint = sessionPhaseMap.get(`${sessionID}:overrideSafePoint`);
          // Wedged queue: the committed queue's head hop never earned its
          // fresh-evidence advance — surface the explicit error and roll back
          // to the pre-walk snapshot taken at commit time instead of dropping
          // the pin silently. Healthy markers clear exactly as before.
          const stalled = Array.isArray(marker?.phases)
            && (sessionPhaseMap.get(`${sessionID}:overrideEvals`) || 0) > 0
            && !queueHeadHasFreshEvidence(sessionPhaseMap, sessionID, marker);
          if (stalled && safePoint && typeof safePoint.phase === "number") {
            const wedgeError = { hop: marker.phases[0], since: marker.since, safePoint: { phase: safePoint.phase, marker: safePoint.marker ?? null } };
            output.wedgeError = wedgeError;
            if (wedgeError.safePoint.marker && typeof wedgeError.safePoint.marker.since === "number") {
              sessionPhaseMap.set(`${sessionID}:overrideUntil`, wedgeError.safePoint.marker);
            } else {
              sessionPhaseMap.delete(`${sessionID}:overrideUntil`);
            }
            enterPhase(sessionPhaseMap, sessionID, safePoint.phase);
            sessionPhaseMap.delete(`${sessionID}:overrideSafePoint`);
            sessionPhaseMap.delete(`${sessionID}:overrideEvals`);
            gateRecordEvent("WALK_CLEARED", [
              ["session", sessionID],
              ["reason", "explicit"],
              ["from", String(currentPhase)],
              ["to", String(safePoint.phase)],
              ["queue", `[${marker.phases.join(",")}]`]
            ], "wedged-queue-rollback");
            recordPhaseOverride(sessionPhaseMap, sessionID, { at, from: currentPhase, wedgedHop: marker.phases[0], rolledBackTo: wedgeError.safePoint });
            saveState(sessionID);
            debug(`Wedged queue: head ${getPhaseName(marker.phases[0])} earned no fresh evidence — rolled back to ${getPhaseName(safePoint.phase)} for session ${sessionID}`);
            output.parts = [{ type: "text", text: `Phase override cleared for session ${sessionID} (was ${getPhaseName(was)} (${was}) at ${getPhaseName(currentPhase)} (${currentPhase})).${genNote} Override record persisted in lifecycle state (overrideHistory).` },
              { type: "text", text: `Wedged override queue: hop ${getPhaseName(wedgeError.hop)} (${wedgeError.hop}) earned no fresh evidence — rolled back to ${getPhaseName(safePoint.phase)} (${safePoint.phase}).` }];
            return;
          }
          sessionPhaseMap.delete(`${sessionID}:overrideUntil`);
          sessionPhaseMap.delete(`${sessionID}:overrideSafePoint`);
          sessionPhaseMap.delete(`${sessionID}:overrideEvals`);
          gateRecordEvent("WALK_CLEARED", [
            ["session", sessionID],
            ["reason", "explicit"],
            ["from", String(currentPhase)],
            ["to", String(currentPhase)],
            ["queue", `[${(Array.isArray(marker?.phases) ? marker.phases : [marker?.phase]).filter(v => typeof v === "number").join(",")}]`]
          ]);
          recordPhaseOverride(sessionPhaseMap, sessionID, { at, from: currentPhase, to: currentPhase, cleared: true, ...(generationSuffix !== null ? { gen: generationSuffix } : {}) });
          saveState(sessionID);
          debug(`Override cleared: explicit /phase clear at ${getPhaseName(currentPhase)} for session ${sessionID}`);
          output.parts = [{ type: "text", text: `Phase override cleared for session ${sessionID} (was ${getPhaseName(was)} (${was}) at ${getPhaseName(currentPhase)} (${currentPhase})).${genNote} Override record persisted in lifecycle state (overrideHistory).` }];
        } else {
          output.parts = [{ type: "text", text: `No phase override is active for session ${sessionID} — nothing to clear.${genNote}` }];
        }
        return;
      }
      if (!phaseArg.trim()) {
        output.parts = [{ type: "text", text: `Error: /phase requires an argument. ${PHASE_USAGE}` }];
        return;
      }
      const parsed = parsePhaseArg(phaseArg);
      if (parsed === null) {
        output.parts = [{ type: "text", text: `Error: invalid phase "${trimmed}". Valid: a number 1-12, a phase name, an ordered list like {3,4,5}, or "clear". ${PHASE_USAGE}` }];
        return;
      }
      const isMulti = Array.isArray(parsed);
      const phases = isMulti ? parsed : [parsed];
      // Queue-length cap: the multi-phase override queue never exceeds the
      // total number of phases in lifecycle.json (12).
      if (phases.length > 12) {
        output.parts = [{ type: "text", text: `Error: too many phases in override (${phases.length}). Maximum is 12.` }];
        return;
      }
      // Override walks are atomic: the full requested walk is pre-validated
      // (per-hop tool-scope admissibility, per-hop advancement-gate type)
      // before any state is touched. Connectivity is not checked — a
      // multi-phase argument is a forward plan and the user's ordering wins,
      // so an ordered list is traversed exactly as given. Single-phase
      // overrides flow through the same atomic path as one-hop walks — scope
      // and gate checks pass for every phase 1-12, so their behavior is
      // unchanged. On any rejection the session-phase map and the state file
      // stay untouched and the error names the first unsatisfiable hop plus
      // the reason class (scope vs gate-type).
      {
        const currentPhase = sessionPhaseMap.get(sessionID);
        const rejected = validateMultiPhaseWalk(phases, currentPhase, BACKWARD_TRANSITIONS);
        if (rejected) {
          output.phaseError = { from: rejected.from, to: rejected.to, reason: rejected.reason };
          // Always-on rejection record: the walk was not committed, and the log
          // names the hop and the class that refused it, so a user whose queue
          // was silently shortened can read why from the log alone.
          gateRecordEvent("WALK_REJECTED", [
            ["session", sessionID],
            ["hop", String(rejected.to)],
            ["reason", rejected.reason]
          ], `commit-time validation refused hop ${getPhaseName(rejected.to)} (${rejected.to})`);
          output.parts = [{ type: "text", text: describeRejectedWalk(rejected) }];
          return;
        }
      }
      const n = phases[0];
      const prevPhase = sessionPhaseMap.get(sessionID);
      // Identical-verdict advisory: an engaged slot is noted in the
      // protocol-gate log for diagnosis, and the override always proceeds
      // to marker, history, and phase change below.
      {
        evaluatePhaseOverrideBrake(sessionID, trimmed);
      }
      // Pre-walk snapshot for the documented safe point: a discarded queue
      // whose head never earned fresh evidence rolls back to this phase plus
      // marker instead of pinning the lifecycle silently. Overwritten by
      // every new commit; dropped when the marker clears by any other path.
      {
        const priorMarker = sessionPhaseMap.get(`${sessionID}:overrideUntil`);
        let markerSnapshot = null;
        if (priorMarker && typeof priorMarker.since === "number") {
          if (typeof priorMarker.phase === "number") {
            markerSnapshot = { phase: priorMarker.phase, since: priorMarker.since };
          } else if (Array.isArray(priorMarker.phases) && priorMarker.phases.length > 0) {
            markerSnapshot = { phases: [...priorMarker.phases], since: priorMarker.since };
          }
        }
        sessionPhaseMap.set(`${sessionID}:overrideSafePoint`, { phase: prevPhase, marker: markerSnapshot });
        // Stall accounting starts at zero with every new commitment: the
        // wedged-queue error fires only after an advance evaluation actually
        // ran against the committed head and found no fresh evidence. A queue
        // discarded before any evaluation ran was simply changed-mind (silent
        // clear, as before); a queue discarded after starved evaluations was
        // stalled mid-walk (explicit error + rollback).
        sessionPhaseMap.set(`${sessionID}:overrideEvals`, 0);
      }
      enterPhase(sessionPhaseMap, sessionID, n);
      // Every /phase invocation persists an override marker — the legacy
      // single-phase shape { phase, since } or the multi-phase queue
      // { phases, since }. While the current phase equals the target, only
      // fresh evidence (KD mtime >= since) advances and consistency never
      // regresses. On fresh evidence the walk moves to the next named hop and
      // re-arms (pop the head); once the plan is exhausted it returns to the
      // origin phase carried in `overrideSafePoint`. A new /phase replaces any
      // prior marker (clear-on-new-override); the marker also clears on a
      // backward transition or REPORT reset.
      // A commit that replaces a live marker clears it first, so the record
      // order reads as the two events it is.
      if (sessionPhaseMap.has(`${sessionID}:overrideUntil`)) {
        const replaced = sessionPhaseMap.get(`${sessionID}:overrideUntil`);
        gateRecordEvent("WALK_CLEARED", [
          ["session", sessionID],
          ["reason", "replaced"],
          ["from", String(prevPhase)],
          ["to", String(n)],
          ["queue", `[${(Array.isArray(replaced?.phases) ? replaced.phases : [replaced?.phase]).filter(v => typeof v === "number").join(",")}]`]
        ]);
      }
      const since = Date.now();
      if (isMulti) {
        sessionPhaseMap.set(`${sessionID}:overrideUntil`, { phases, since });
      } else {
        sessionPhaseMap.set(`${sessionID}:overrideUntil`, { phase: n, since });
      }
      // Always-on walk commit: the marker every later hop is judged against,
      // readable with no debug flag set.
      gateRecordEvent("WALK_COMMIT", [
        ["session", sessionID],
        ["from", String(prevPhase)],
        ["to", String(n)],
        ["queue", `[${phases.join(",")}]`],
        ["kind", isMulti ? "walk" : "pin"]
      ]);
      // The one-line override record: the walk lands in lifecycle state
      // (overrideHistory, persisted by the saveState below) and is echoed in
      // the confirmation so lifecycle KDs can cite it without reading logs.
      const at = new Date().toISOString();
      const walkSafePoint = sessionPhaseMap.get(`${sessionID}:overrideSafePoint`);
      recordPhaseOverride(sessionPhaseMap, sessionID, {
        at,
        from: prevPhase,
        to: n,
        ...(isMulti ? { queue: [...phases] } : {}),
        ...(walkSafePoint ? { safePoint: { phase: walkSafePoint.phase, marker: walkSafePoint.marker } } : {}),
        ...(generationSuffix !== null ? { gen: generationSuffix } : {})
      });
      // A commit whose target is REPORT has already reached the terminal hop:
      // the report is written there, so the walk ends on arrival and the marker
      // never outlives it. This is the one completion the commit itself owns —
      // every other terminal arrival goes through applyForwardAdvance.
      if (n === STATES.REPORT) {
        sessionPhaseMap.delete(`${sessionID}:overrideUntil`);
        sessionPhaseMap.delete(`${sessionID}:overrideSafePoint`);
        sessionPhaseMap.delete(`${sessionID}:overrideEvals`);
        gateRecordEvent("WALK_COMPLETE", [
          ["session", sessionID],
          ["terminal", "REPORT"],
          ["kind", isMulti ? "hop" : "pin"]
        ]);
        debug(`WALK_COMPLETE: session ${sessionID} reached terminal REPORT by /phase commit`);
      }
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
      const marker = sessionPhaseMap.get(`${sessionID}:overrideUntil`);
      debug(`Phase override: ${getPhaseName(n)} (${n}) for session ${sessionID} — ${marker
        ? `overrideUntil set (${isMulti ? `queue ${JSON.stringify(phases)}` : `phase ${n}`}, since ${since})`
        : `terminal REPORT reached, marker cleared on arrival (since ${since})`}`);
      const walk = isMulti ? `, queue ${JSON.stringify(phases)}` : "";
      output.parts = [{ type: "text", text: isMulti
        ? `Phase set to ${getPhaseName(n)} (${n}) for session ${sessionID} — override queue ${JSON.stringify(phases)}.${genNote} Override record: ${getPhaseName(prevPhase)} (${prevPhase}) → ${getPhaseName(n)} (${n})${walk} at ${at} — persisted in lifecycle state (overrideHistory).`
        : `Phase set to ${getPhaseName(n)} (${n}) for session ${sessionID}.${genNote} Override record: ${getPhaseName(prevPhase)} (${prevPhase}) → ${getPhaseName(n)} (${n}) at ${at} — persisted in lifecycle state (overrideHistory).` }];
    }

    // --- Hook: permission.ask ---
    async function permissionAsk(input, output) {
      // Permission type: input.type is the tool name
      const { sessionID } = input;
      const tool = canonicalToolName(input.type);
      const phase = sessionPhaseMap.get(sessionID);

      if (phase === undefined) return;

      const phaseName = getPhaseName(phase);
      if (!phaseName) return;

      const allowedTools = TOOL_ALLOWLIST[phaseName] || [];
      if (!admitTool(phaseName, tool)) {
        debug(`permission.ask: DENY tool=${tool} in phase=${phaseName} (allowed: ${allowedTools.join(", ")})`);
        output.status = "deny";
        // Tool blocks set output.status = "deny" without throwing
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

    // The ONE transition commit (IC-5). Every forward-advance site decides its
    // next phase with nextForwardPhase and lands it here: the phase entry, the
    // marker settle (pop / suspend-clear / resume re-anchor / clear / complete),
    // the safe-point drop and the single always-on transition record exist in
    // this one place, and no site mutates the marker inline. The site keeps its
    // own counters, announcements and bookkeeping.
    // A `diverged` decision never advances and never falls through to presence
    // evidence: it records the divergence and returns entered: null, so every
    // caller reads "refuse" the same way it reads a closed gate.
    function applyForwardAdvance(sessionID, fromPhase, decision) {
      const marker = getOverrideUntil(sessionPhaseMap, sessionID);
      if (decision.outcome === "diverged") {
        gateRecordEvent("WALK_DIVERGED", [
          ["session", sessionID],
          ["phase", String(fromPhase)],
          ["head", String(decision.head)],
          ["queue", `[${decision.queue.join(",")}]`]
        ], `phase ${getPhaseName(fromPhase)} (${fromPhase}) is ahead of the walk head`, `WALK_DIVERGED|${sessionID}|${fromPhase}|${decision.head}|${decision.queue.join(",")}`);
        debug(`WALK_DIVERGED: session ${sessionID} phase=${fromPhase} head=${decision.head} queue=${JSON.stringify(decision.queue)} — refusing to advance`);
        return { entered: null, walk: "unchanged" };
      }
      const target = decision.target;
      if (typeof target !== "number") {
        // Defensive: a governed hop yielding no target. Recorded rather than
        // silently treated as a closed gate, so a walk that parks is diagnosable.
        gateRecordEvent("WALK_BLOCKED", [
          ["session", sessionID],
          ["phase", String(fromPhase)],
          ["outcome", decision.outcome],
          ["queue", `[${decision.queue.join(",")}]`]
        ], `walk outcome ${decision.outcome} produced no forward target`);
        debug(`WALK_BLOCKED: session ${sessionID} phase=${fromPhase} outcome=${decision.outcome} — no forward target`);
        return { entered: null, walk: "unchanged" };
      }

      enterPhase(sessionPhaseMap, sessionID, target);
      let walk = "unchanged";
      const queueOf = (m) => `[${(Array.isArray(m?.phases) ? m.phases : [m?.phase]).filter(v => typeof v === "number").join(",")}]`;

      if (decision.outcome === "hop") {
        // Consuming the head pops it: the next hop becomes the head and the
        // re-entry anchor, if this hop carried one, is cleared with the hop it
        // anchored — later hops are anchored to the walk's own `since` again.
        const remaining = decision.queue.slice(1);
        const rearmed = { phases: remaining, since: marker.since };
        sessionPhaseMap.set(`${sessionID}:overrideUntil`, rearmed);
        sessionPhaseMap.set(`${sessionID}:overrideEvals`, 0);
        gateRecordEvent("WALK_HOP", [
          ["session", sessionID],
          ["from", String(fromPhase)],
          ["to", String(target)],
          ["queue", `[${remaining.join(",")}]`]
        ]);
        debug(`WALK_HOP: ${getPhaseName(fromPhase)} → ${getPhaseName(target)} — queue now ${JSON.stringify(remaining)}`);
        walk = "popped";
      } else if (decision.outcome === "resume") {
        // Re-entering the suspended head stamps the re-entry instant: the hop
        // now demands evidence written at or after this moment, so nothing from
        // before the regression can satisfy it.
        const hopSince = Date.now();
        sessionPhaseMap.set(`${sessionID}:overrideUntil`, { phases: decision.queue, since: marker.since, hopSince });
        sessionPhaseMap.set(`${sessionID}:overrideEvals`, 0);
        gateRecordEvent("WALK_RESUMED", [
          ["session", sessionID],
          ["phase", String(target)],
          ["hopSince", String(hopSince)]
        ]);
        debug(`WALK_RESUMED: session ${sessionID} re-entered ${getPhaseName(target)} (${target}) with hopSince=${hopSince}`);
        walk = "resumed";
      } else if (decision.outcome === "terminal-report") {
        // REPORT is the terminal hop — the walk ends where the report is
        // written, so the marker never outlives the arrival.
        sessionPhaseMap.delete(`${sessionID}:overrideUntil`);
        sessionPhaseMap.delete(`${sessionID}:overrideSafePoint`);
        sessionPhaseMap.delete(`${sessionID}:overrideEvals`);
        gateRecordEvent("WALK_COMPLETE", [
          ["session", sessionID],
          ["terminal", "REPORT"],
          ["kind", "hop"]
        ]);
        debug(`WALK_COMPLETE: session ${sessionID} reached terminal REPORT by hop`);
        walk = "completed";
      } else if (decision.outcome === "origin-return") {
        const kind = Array.isArray(marker?.phases) ? "hop" : "pin";
        sessionPhaseMap.delete(`${sessionID}:overrideUntil`);
        sessionPhaseMap.delete(`${sessionID}:overrideSafePoint`);
        sessionPhaseMap.delete(`${sessionID}:overrideEvals`);
        if (target === STATES.REPORT) {
          gateRecordEvent("WALK_COMPLETE", [
            ["session", sessionID],
            ["terminal", "REPORT"],
            ["kind", kind]
          ]);
          debug(`WALK_COMPLETE: session ${sessionID} reached terminal REPORT by ${kind}`);
          walk = "completed";
        } else {
          gateRecordEvent("WALK_CLEARED", [
            ["session", sessionID],
            ["reason", decision.clearReason || WALK_CLEAR_REASON.EXHAUSTED],
            ["from", String(fromPhase)],
            ["to", String(target)],
            ["queue", queueOf(marker)]
          ]);
          debug(`WALK_CLEARED: reason=${decision.clearReason} — ${getPhaseName(fromPhase)} → ${getPhaseName(target)}`);
          walk = "cleared";
        }
      }

      saveState(sessionID);
      return { entered: target, walk };
    }

    // Shared disk-evidence advancement. Evaluates checkDiskAdvancement for
    // the session's current phase and performs the full transition
    // bookkeeping on positive evidence (override re-arm/clear, failure
    // reset, in-flight cleanup, cycle reset, grace period, announcement,
    // persistence, PREFLIGHT-entry skip). Returns true on advancement.
    // Called from the before-hook disk block on every lifecycle-tool call
    // AND from the after-hook for overseer KD-creating writes: the
    // before-hook runs before the file lands, so a write followed by
    // no further tool calls would otherwise never advance.
    async function advanceFromDiskEvidence(sessionID) {
      const currentPhase = sessionPhaseMap.get(sessionID);
      const currentPhaseName = getPhaseName(currentPhase);
      // The next hop is decided before any gate is read: a walk whose head sits
      // behind the current phase refuses regardless of what the evidence says.
      const decision = nextForwardPhase(sessionPhaseMap, sessionID, currentPhase, noWalkFallback(currentPhase));
      if (decision.outcome === "diverged") {
        applyForwardAdvance(sessionID, currentPhase, decision);
        return false;
      }
      if (!(await checkDiskAdvancement(sessionID, currentPhase, sessionPhaseMap, swarmDispatchCount, { verdictRegressedKDs, backwardTransition: handleBackwardTransition }))) {
        // Stall accounting — see advanceParentSessionFromSwarm above.
        const stalledMarker = getOverrideUntil(sessionPhaseMap, sessionID);
        if (stalledMarker && Array.isArray(stalledMarker.phases) && currentPhase === getOverrideTargetPhase(stalledMarker)) {
          sessionPhaseMap.set(`${sessionID}:overrideEvals`, (sessionPhaseMap.get(`${sessionID}:overrideEvals`) || 0) + 1);
        }
        return false;
      }

        // The one transition commit owns enterPhase, the marker settle, the
        // record and the save — see applyForwardAdvance. The sites keep only
        // their own counters and announcements.
        const applied = applyForwardAdvance(sessionID, currentPhase, decision);
        if (applied.entered === null) return false;
        const advanceTarget = applied.entered;
        diskCheckFailures.set(sessionID, 0);
        // Clear in-flight tracking — KD appeared on disk, dispatch is complete
        inFlightDispatches.delete(sessionID);
        pendingVerification.delete(sessionID);
        pendingVerificationToolCount.delete(sessionID);
        debug(`pendingVerification: CLEARED (disk advancement) for session ${sessionID}`);
        // Reset re-dispatch counter for the phase we just advanced from
        phaseRedispatchCount.delete(`${sessionID}:${currentPhase}`);
        // Diagnosed-recovery reset for the identical-verdict brake: a forward
        // advance out of VERIFY means fresh evidence satisfied the gate, so
        // the session's consecutive-verdict runs clear instead of persisting
        // across the recovery.
        if (currentPhase === STATES.VERIFY) resetGateVerdictBrake(sessionID);
        // Reset the per-target-phase cycle counter on a successful forward
        // advance out of the phase: a genuine fix cycle completed,
        // so the next regression to this phase starts fresh instead of
        // exhausting the maxCyclesPerTransition cap for the rest of the
        // lifecycle. The CYCLE_LIMIT_EXCEEDED hard stop is preserved —
        // consecutive regressions without an advance still throw.
        const cycles = cycleMap.get(sessionID);
        if (cycles && cycles[currentPhase] !== undefined) {
          delete cycles[currentPhase];
          debug(`COUNTER_RESET: cycle counter reset for ${currentPhaseName} (advance to ${getPhaseName(advanceTarget)})`);
        }
        const newPhase = advanceTarget;
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
        // RESTART_CATCH_UP: This is EXPECTED behavior. After a session restart,
        // each tool call checks if the current phase's KD exists on disk. When
        // KDs from the current lifecycle generation already exist (e.g. from a
        // prior abort or rapid multi-phase progression), the gate advances
        // through multiple phases in succession. This catch-up is intentional
        // and does not indicate a bug. The generation scoping (matchesSessionKD)
        // ensures only KDs matching the current session and generation trigger
        // advancement.
        //
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
            const evidenceMtime = getFileMtimeMs(join(getKnowledgeDir(sessionID), evidenceFile));
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
        // When entering PREFLIGHT, skip the next disk check to give the Overseer
        // time to dispatch the committer before advancement to EXPLORE.
        if (newPhase === STATES.PREFLIGHT) {
          skipDiskCheckAfterAdvance.set(sessionID, true);
          debug(`Disk advancement: skipping next disk check for PREFLIGHT`);
        }
      return true;
    }

    // --- Hook: tool.execute.before ---
    async function toolExecuteBefore(input, output) {
      let { tool, sessionID, callID } = input;
      tool = canonicalToolName(tool);
      lastSeenSession = sessionID;
      // opencode API: tool args live on output.args, not input.args
      const args = output.args || {};
      // Learn this session's knowledge dir from absolute tool-arg paths so
      // disk checks read where the session's KDs actually live.
      learnKnowledgeDirFromArgs(sessionID, args);

      // Structural git-stage guard. Rejects `git add`
      // invocations that would stage gitignored paths — force flags bypass the
      // ignore rules and explicit knowledge/ paths are the gitignored workflow
      // set. Runs before the overseer/non-overseer split so every session is
      // covered; the positive guidance points to the allowed staging forms.
      // Covered by the quote-aware splitter below so piped chains also
      // attribute per segment; quoted separators never split.
      if (tool === "shell" && typeof args.command === "string") {
        const addSegments = parseSegments(args.command).filter(seg => /\bgit add\b/.test(seg));
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

      // Shell denial attribution. Names the exact denied segment and the
      // allowlisted variants sharing its prefix so the calling agent retries
      // a concrete alternative instead of concluding a whole tool family is
      // denied. Subagent sessions only; unknown agents and unreadable
      // allowlists pass through untouched — uncertainty never blocks.
      if (tool === "shell" && typeof args.command === "string" && !isOverseerSession(sessionID)) {
        const callingAgent = sessionAgentMap.get(sessionID);
        if (callingAgent) {
          const loaded = loadAgentShellAllowlist(callingAgent);
          if (loaded.patterns) {
            const advice = adviseDenial({
              agent: callingAgent,
              rawCommand: args.command,
              patterns: loaded.patterns,
            });
            if (!advice.allowed) {
              debug(`SHELL ATTRIBUTION: agent=${callingAgent} denied=${advice.result.deniedSegments.join(" | ")} (command=${args.command})`);
              throw new ProtocolGateError(
                ERROR_TEMPLATES.SHELL_DENIED_ATTRIBUTED.code,
                advice.message,
                advice.result.suggestedRetry
                  ? `Run \`${advice.result.suggestedRetry}\` next, then log each segment result`
                  : "Route the task to a role granting it, then log each segment result"
              );
            }
          } else {
            debug(`SHELL ATTRIBUTION: allowlist unreadable for agent=${callingAgent} (${loaded.reason}) — passing through`);
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
          const path = extractToolPath(args);
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
          // The impl KD write is the check-off signal — advance that milestone
          // in the parent SWARM lifecycle's registry. The registry state
          // machine (updateMilestoneRegistry) is the authoritative guard: only
          // an in-progress row can check off, so firing for ANY non-overseer
          // writer cannot cause a wrong-advance. The writing agent is recorded
          // only when chat.params carried the agent field, so a session whose
          // agent is unknown must still trigger the check-off — the check-off
          // keys on the KD path, not on the writer's identity.
          const isImplKD = isImplKDArtifactPath(relPath);
          if (isImplKD) {
            const writingAgent = sessionAgentMap.get(sessionID)?.toLowerCase() || "unknown";
            if (writingAgent !== "artisan") {
              // File-only observability for a non-artisan/unknown impl-KD
              // writer — the check-off still proceeds; this just records who
              // wrote it so a future silent-skip class is visible.
              gateRecordEvent("AUTO_CHECKOFF_NON_ARTISAN", [
                ["agent", writingAgent],
                ["path", relPath]
              ], null, `AUTO_CHECKOFF_NON_ARTISAN|${relPath}|a:${writingAgent}`);
            }
            autoCheckOffMilestone(relPath, extractToolContent(args), sessionID);
            // Record the write for the after-hook's post-write SWARM→VERIFY
            // auto-advance — the before-hook has the args (relPath), the
            // after-hook needs it but cannot see them.
            pendingImplKDWrites.set(sessionID, relPath);
          }
        }
        // Session never identified as overseer via chat.params — pass through.
        // Subagent sessions are never in overseerSessions.
        debugCollapsed("passing-through", `tool.execute.before: non-overseer session ${sessionID} tool=${tool} — passing through`);
        return;
      }

      let phase = sessionPhaseMap.get(sessionID);
      if (phase === undefined) {
        // Fail-closed: an overseer session with no phase entry is an error
        // state, so the call blocks rather than passing through.
        debug(`tool.execute.before: BLOCKED overseer session ${sessionID} has no phase entry (tool=${tool})`);
        throw new ProtocolGateError(ERROR_TEMPLATES.BLOCKED_UNINITIALIZED.code, ERROR_TEMPLATES.BLOCKED_UNINITIALIZED.message, ERROR_TEMPLATES.BLOCKED_UNINITIALIZED.guidance);
      }

      let phaseName = getPhaseName(phase);

      // INTENT edit boundary (swarm/57). The session leaves INTENT
      // deterministically on the first successful write of its intent KD —
      // presence-based, never turn-timed. A later write/edit of any intent-*.md
      // is therefore a phase-boundary crossing, not a generic unlisted-tool
      // call: refuse it with a boundary-specific message (raised before the
      // generic admission refusal) that names the current phase and the
      // deterministic /phase INTENT recovery, so an in-session amendment can
      // never land silently in a downstream phase.
      if ((tool === "write" || tool === "edit") && phase !== STATES.INTENT) {
        const boundaryRel = toProjectRelative(extractToolPath(args));
        const isIntentTarget = boundaryRel.startsWith("knowledge/intent-") || boundaryRel.includes("/knowledge/intent-");
        if (isIntentTarget) {
          debug(`tool.execute.before: INTENT BOUNDARY refusal — ${tool} of ${boundaryRel} in phase=${phaseName}`);
          throw new ProtocolGateError(
            ERROR_TEMPLATES.INTENT_BOUNDARY_CLOSED.code,
            `❌ INTENT BOUNDARY CLOSED: ${tool} of intent-*.md is refused in ${phaseName}. The INTENT edit window closed on the first successful write of this session's intent KD. To amend the intent KD, run /phase INTENT (user-initiated) first — the corrected KD must carry an mtime at or after the override. Content stranded by a split amendment is carried into the next INTENT amendment, or recorded under the REPORT KD's Correction section.`,
            "Run /phase INTENT to reopen the INTENT edit window, then edit knowledge/intent-*.md"
          );
        }
      }

      // Enforce the phase admission predicate — safety net for tools not gated
      // by permission.ask. Transport tools pass through; the phase decision
      // then lands on the inner tool the carrier reaches, which arrives here as
      // its own tool id. A refused id is named so the caller sees which tool
      // the phase forbade and the set it may use instead.
      if (!admitTool(phaseName, tool)) {
        const allowedTools = TOOL_ALLOWLIST[phaseName] || [];
        debug(`tool.execute.before: BLOCKED tool=${tool} in phase=${phaseName} (allowed: ${allowedTools.join(", ")})`);
        let refusal = `❌ BLOCKED: Wrong phase. Tool "${tool}" is not available in ${phaseName}. Available tools in ${phaseName}: ${allowedTools.join(", ")}`;
        let refusalGuidance = `Allowed tools: ${allowedTools.join(", ")}`;
        // CLEANUP names what the phase is waiting for. Without this the refusal
        // reads as a tool-list complaint while the only deliverable still owed
        // is the one the phase refuses to allow.
        if (phase === STATES.CLEANUP) {
          const verdict = evaluateCleanupArtifact(sessionID, sessionPhaseMap);
          const status = verdict.ok
            ? `CLEANUP artifact ${verdict.path} is valid — the advance to REPORT is due on the next disk check`
            : `CLEANUP artifact ${verdict.path} — reason=${verdict.reason}`;
          refusal += `. ${status}.`;
          refusalGuidance += ` — ${status}`;
        }
        throw new ProtocolGateError(
          ERROR_TEMPLATES.BLOCKED_WRONG_PHASE.code,
          refusal,
          refusalGuidance
        );
      }

      // --- write handler ---
      if (tool === "write") {
        const path = extractToolPath(args);
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

        // REPORT → INTENT: report KD written means lifecycle is complete.
        // A new lifecycle begins at INTENT under the incremented generation.
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
          // Allocated, not incremented — see the write handler for why the
          // disk is consulted as well as the counter.
          const nextGen = allocateLifecycleGeneration(sessionPhaseMap, sessionID);
          sessionPhaseMap.set(`${sessionID}:gen`, nextGen);
          // Delete the phase entry instead of setting INTENT directly.
          // chat.params only re-runs loadState() when the entry is absent, so a
          // value here would keep the in-memory map diverged from a manually edited
          // state file. Deleting forces loadState() on the next message, which
          // restores INTENT (saveState persists INTENT for absent entries).
          sessionPhaseMap.delete(sessionID);
          diskCheckFailures.set(sessionID, 0);
          sessionPhaseMap.delete(`${sessionID}:sid`);
          // Lifecycle end clears the override marker — a finished
          // lifecycle is never pinned; the next lifecycle starts fresh.
          if (sessionPhaseMap.has(`${sessionID}:overrideUntil`)) {
            sessionPhaseMap.delete(`${sessionID}:overrideUntil`);
            debug(`Override cleared: REPORT reset`);
          }
          sessionPhaseMap.delete(`${sessionID}:overrideSafePoint`);
          sessionPhaseMap.delete(`${sessionID}:overrideEvals`);
          // Lifecycle end drops the override record with the finished
          // lifecycle — the next lifecycle starts fresh.
          sessionPhaseMap.delete(`${sessionID}:overrideHistory`);
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
          // Archive correction sections before deletion so SPEC amendments
          // and critical corrections survive lifecycle-end cleanup.
          try {
            preCleanupHook(sessionID, currentGen);
          } catch (e) {
            debug(`preCleanupHook error for session ${sessionID}: ${e.message}`);
          }
          try {
            cleanupLifecycleKDs(sessionID, currentGen);
          } catch (e) {
            debug(`cleanupLifecycleKDs error for session ${sessionID}: ${e.message}`);
          }
          phase = STATES.INTENT;
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

        // Lifecycle start: the INTENT that opens a lifecycle names it, so the
        // generation it carries is allocated here — before any later artifact
        // can be judged against a counter that belongs to another lifecycle.
        // Runs after the content validation so a rejected write adopts nothing.
        if (phase === STATES.INTENT && isIntentKD) {
          const adopted = adoptLifecycleGenerationOnIntent(sessionID, relPath);
          // A held number blocks the write: a lifecycle that started at a number
          // another unfinished lifecycle carries would merge the two evidence
          // sets, and nothing downstream could separate them again.
          if (!adopted.ok && adopted.reason === "generation-held") {
            const template = ERROR_TEMPLATES.GENERATION_HELD(adopted.generation, adopted.holders);
            throw new ProtocolGateError(template.code, template.message, template.guidance);
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
        const path = extractToolPath(args);
        const relPath = toProjectRelative(path);
        // Skills are auto-injected via the skill tool — never read via the
        // read tool. There is deliberately no generic "templates" allowance:
        // delegation templates are JSON files auto-injected by delegation-gate
        // at dispatch, never read by the Overseer.

        if (phase === STATES.SWARM || phase === STATES.DECOMPOSE || phase === STATES.VERIFY) {
          // SWARM phase: dispatcher visibility — the Overseer reads the
          // milestone registry to track milestone state and drive
          // per-milestone artisan dispatches. All other reads stay blocked.
          // DECOMPOSE phase: the Overseer reads the milestone registry the
          // Pathfinder just produced, before the disk-advance check catches
          // up to SWARM. Scoped to milestone KDs only — plan KDs and all
          // other files stay blocked.
          // VERIFY phase: a FAIL verdict regresses VERIFY→SWARM and reopens
          // cited milestone rows — the Overseer reads the registry to see
          // which rows were reopened before re-dispatching the same artisans.
          // Same milestone-KD-only scope as SWARM/DECOMPOSE.
          const isMilestonesKD = /^knowledge\/milestones-/i.test(relPath) || /\/knowledge\/milestones-/i.test(relPath);
          if (!isMilestonesKD) {
            debug(`read: BLOCKED phase=${phaseName} path=${path} (${phaseName} reads restricted to milestone registry KDs)`);
            throw new ProtocolGateError(ERROR_TEMPLATES.BLOCKED_WRONG_PHASE.code, "❌ BLOCKED: Wrong phase. Read from knowledge/milestones-*.md only", "Read from knowledge/milestones-*.md only");
          }
        } else if (phase === STATES.INTENT || phase === STATES.REPORT) {
          if (phase === STATES.INTENT) {
            // INTENT phase: only the current session's intent KDs. Restricting
            // to intent KDs prevents the Overseer from reading prior-session
            // reports or other KDs and falling back to self-execution. Skills
            // are auto-injected via the skill tool — never read here.
            // Delegation templates are auto-injected by delegation-gate at
            // dispatch — not read here.
            const isIntentKD = /knowledge\/intent-/i.test(relPath);
            if (!isIntentKD) {
              debug(`read: BLOCKED phase=${phaseName} path=${path} (INTENT reads restricted to intent KDs)`);
              throw new ProtocolGateError(ERROR_TEMPLATES.BLOCKED_WRONG_PHASE.code, "❌ BLOCKED: Wrong phase. Read from knowledge/intent-*.md only — delegation templates are auto-injected by delegation-gate at dispatch, never read; KD-format templates are auto-loaded skills (load via the skill tool)", "Read from knowledge/intent-*.md only");
            }
          } else {
            // REPORT phase: any knowledge KD (needed to compose the report).
            // Skills are auto-injected via the skill tool — never read here.
            // Delegation templates are auto-injected by delegation-gate at
            // dispatch — not read here.
            const isKnowledge = relPath.startsWith("knowledge/") || relPath.includes("/knowledge/");
            if (!isKnowledge) {
              debug(`read: BLOCKED phase=${phaseName} path=${path} (reads restricted to knowledge KDs)`);
              throw new ProtocolGateError(ERROR_TEMPLATES.BLOCKED_WRONG_PHASE.code, "❌ BLOCKED: Wrong phase. Read from knowledge KDs only — delegation templates are auto-injected by delegation-gate at dispatch, never read; KD-format templates are auto-loaded skills (load via the skill tool)", "Read from knowledge KDs only");
            }
          }
        }
      }

      // --- edit handler ---
      // Handles REPORT → INTENT transition when report KD is edited.
      // The write handler already covers this for `write` tool; `edit` is also
      // allowed in REPORT phase and needs the same lifecycle reset.
      else if (tool === "edit") {
        const path = extractToolPath(args);
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
          // Allocated, not incremented — see the write handler for why the
          // disk is consulted as well as the counter.
          const nextGen = allocateLifecycleGeneration(sessionPhaseMap, sessionID);
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
          sessionPhaseMap.delete(`${sessionID}:overrideSafePoint`);
          sessionPhaseMap.delete(`${sessionID}:overrideEvals`);
          // Lifecycle end drops the override record (see write handler).
          sessionPhaseMap.delete(`${sessionID}:overrideHistory`);
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
          // reused session ID; try-catch (see write handler). Archive
          // correction sections first so they are not lost.
          try {
            preCleanupHook(sessionID, currentGen);
          } catch (e) {
            debug(`preCleanupHook error for session ${sessionID}: ${e.message}`);
          }
          try {
            cleanupLifecycleKDs(sessionID, currentGen);
          } catch (e) {
            debug(`cleanupLifecycleKDs error for session ${sessionID}: ${e.message}`);
          }
          phase = STATES.INTENT;
          phaseName = getPhaseName(phase);
        } else if (phase === STATES.REPORT && !isReportKD) {
          debug(`edit: BLOCKED phase=${phaseName} path=${path} (must edit knowledge/report-*.md)`);
          throw new ProtocolGateError(ERROR_TEMPLATES.BLOCKED_WRONG_PHASE.code, "❌ BLOCKED: Wrong phase. Edit knowledge/report-*.md", "Edit knowledge/report-*.md");
        }
      }

      // A SWARM re-dispatch does NOT re-open checked-off milestone rows:
      // checked-off rows stay checked-off (the impl-KD write is idempotent —
      // updateMilestoneRegistry returns { ok: true, changed: false } for an
      // already-checked-off row). The all-checked-off gate may then advance
      // SWARM→VERIFY on the same task call — the desired checkpoint-recovery
      // behavior when the milestone IS done. User-requested redos of passed
      // milestones route through the sanctioned /phase SWARM backward override
      // (the plugin-owned phase command); the citation-driven reopen path (Inspector-FAIL
      // verdicts → reopenCheckedOffMilestones via regressVerifyOnFail) is the
      // only path that reopens checked-off rows.
      // MILESTONE_ID cardinality is validated BEFORE any
      // registry mutation. A MULTI_MILESTONE rejection must leave the registry
      // byte-identical — without this check, first-line-wins extraction would
      // advance the first row before delegation-gate rejected the dispatch
      // (phantom in-progress row). Mirrors delegation-gate's collectMilestoneIds
      // semantics so both gates agree on cardinality.
      if (tool === "subagent" && phase === STATES.SWARM) {
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
            const regResult = updateMilestoneRegistry(sessionID, sessionPhaseMap, milestoneIds[0], ["assigned", "in-progress"]);
            debug(`SWARM registry update (pre-gate) for ${milestoneIds[0]}: ${JSON.stringify(regResult)}`);
          }
        }
      }

      // --- disk-based advancement for lifecycle tools ---
      // Runs BEFORE the task handler so the phase is current when agent routing
      // validates the dispatched agent. Without this, task calls in PREFLIGHT
      // check against the stale pre-advancement phase and throw WRONG_AGENT.
      if (DISK_CHECK_TOOLS.includes(tool)) {
        // Skip the disk check on the call that enters PREFLIGHT: the registry
        // may already satisfy the gate and must not advance twice in one call.
        if (skipDiskCheckAfterAdvance.get(sessionID)) {
          skipDiskCheckAfterAdvance.set(sessionID, false);
          debug(`Disk advancement: skipped — phase just advanced in this call`);
        } else {
          const currentPhase = sessionPhaseMap.get(sessionID);
          const currentPhaseName = getPhaseName(currentPhase);
if (!(await advanceFromDiskEvidence(sessionID))) {
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
                (extractToolPath(args)).includes(`${p}-`) || (args?.content || "").includes(`${p}-`)
              );
              if (!isCreatingExpectedKD && tool === "subagent") {
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
                  markStuckMilestonesFailed(sessionID, sessionPhaseMap, `FORCE ADVANCE at ${currentFailures} failures`, undefined, currentFailures);
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
                  // The force-advance is a forward-advance site like any other:
                  // at a walk head it takes the next named hop, behind the head
                  // it re-enters the head, and ahead of it it refuses. VERIFY is
                  // only the no-walk fallback.
                  const forced = nextForwardPhase(sessionPhaseMap, sessionID, currentPhase, noWalkFallback(currentPhase, true));
                  debug(`SAFETY_OVERRIDE: FORCE ADVANCE — ${currentPhaseName} → ${getPhaseName(forced.target)} after ${currentFailures} stuck failures (outcome=${forced.outcome}, pendingVerification active=${!!pendingVerification.get(sessionID)})`);
                  applyForwardAdvance(sessionID, currentPhase, forced);
                  diskCheckFailures.set(sessionID, 0);
                  phaseRedispatchCount.delete(`${sessionID}:${currentPhase}`);
                  pendingVerification.delete(sessionID);
                  pendingVerificationToolCount.delete(sessionID);
                  inFlightDispatches.delete(sessionID);
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
                if (redispatches >= (config.maxRetriesPerPhase || 5) && tool === "subagent") {
                  if (currentPhase === STATES.SWARM) {
                    // The redispatch cap during
                    // SWARM blocks the dispatch, marks the stuck milestone
                    // failed, and throws SAFETY_STUCK (no auto-advance).
                    // Only the offending milestone's row fails.
                    if (capMilestoneId) {
                      markStuckMilestonesFailed(sessionID, sessionPhaseMap, `REDISPATCH CAP at ${redispatches} re-dispatches`, capMilestoneId, redispatches);
                    } else {
                      markStuckMilestonesFailed(sessionID, sessionPhaseMap, `REDISPATCH CAP at ${redispatches} re-dispatches`, undefined, redispatches);
                    }
                    diskCheckFailures.set(sessionID, 0);
                    phaseRedispatchCount.delete(redispatchKey);
                    pendingVerification.delete(sessionID);
                    pendingVerificationToolCount.delete(sessionID);
                    inFlightDispatches.delete(sessionID);
                    saveState(sessionID);
                    throw new ProtocolGateError("SAFETY_STUCK", `❌ SAFETY_STUCK: SWARM re-dispatch cap (${redispatches}) reached — milestone marked failed. Escalate to user or override with /phase`, "Escalate to user or use /phase to override");
                  }
                  const capped = nextForwardPhase(sessionPhaseMap, sessionID, currentPhase, noWalkFallback(currentPhase, true));
                  debug(`SAFETY_OVERRIDE: REDISPATCH CAP — ${currentPhaseName} phase — ${redispatches} re-dispatches used. Advancing to ${getPhaseName(capped.target)} (outcome=${capped.outcome}, pendingVerification active=${!!pendingVerification.get(sessionID)})`);
                  applyForwardAdvance(sessionID, currentPhase, capped);
                  diskCheckFailures.set(sessionID, 0);
                  phaseRedispatchCount.delete(`${sessionID}:${currentPhase}`);
                  pendingVerification.delete(sessionID);
                  pendingVerificationToolCount.delete(sessionID);
                  inFlightDispatches.delete(sessionID);
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
                      markStuckMilestonesFailed(sessionID, sessionPhaseMap, `pendingVerification force-advance after ${toolCalls} tool calls`, undefined, toolCalls);
                      pendingVerification.delete(sessionID);
                      pendingVerificationToolCount.delete(sessionID);
                      diskCheckFailures.set(sessionID, 0);
                      inFlightDispatches.delete(sessionID);
                      saveState(sessionID);
                    } else {
                      const timedOut = nextForwardPhase(sessionPhaseMap, sessionID, currentPhase, noWalkFallback(currentPhase, true));
                      debug(`pendingVerification SAFETY: force-advance after ${toolCalls} tool calls — advancing to ${getPhaseName(timedOut.target)} (outcome=${timedOut.outcome}) — expectedPrefixes=${JSON.stringify(pvState.expectedPrefixes)}`);
                      pendingVerification.delete(sessionID);
                      pendingVerificationToolCount.delete(sessionID);
                      applyForwardAdvance(sessionID, currentPhase, timedOut);
                      diskCheckFailures.set(sessionID, 0);
                      inFlightDispatches.delete(sessionID);
                    }
                  } else if (toolCalls >= 10) {
                    debug(`pendingVerification WARNING: ${toolCalls} tool calls without expected KD — clearing pendingVerification (expectedPrefixes=${JSON.stringify(pvState.expectedPrefixes)})`);
                    warn(`SWARM stalled: ${toolCalls} tool calls without expected KD (prefixes=${pvState.expectedPrefixes?.join(", ")}) — clearing pendingVerification`);
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
                      const knowledgeDir = getKnowledgeDir(sessionID);
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
      if (tool === "subagent") {
        // Task is only allowed during delegation phases (PREFLIGHT through CLEANUP)
        if (phase < STATES.PREFLIGHT || phase > STATES.CLEANUP) {
          // The refusal names the phase the gate is actually in. A hardcoded
          // phase name told the operator the lifecycle was in INTENT no matter
          // where it stood, so a lifecycle parked at REPORT read as a stalled
          // INTENT run and the recovery for the real phase was invisible.
          const terminal = phase === STATES.REPORT
            ? ` ${phaseName} is the terminal phase — write the report KD; no dispatch is needed.`
            : " Task is only available in PREFLIGHT through CLEANUP phases";
          // A refusal while an override governs the phase names that state too:
          // the walk's head, remaining hops, suspension or divergence sentence —
          // one formatter, so the refusal and the wrong-agent refusal can never
          // describe the same walk differently.
          const walkState = describeOverrideState(sessionPhaseMap, sessionID, phase);
          gateRecordEvent("DISPATCH_REFUSED", [
            ["session", sessionID],
            ["phase", phaseName],
            ["number", String(phase)],
            ["reason", "phase-restriction"]
          ], `task dispatch refused — ${phaseName} (${phase}) is outside PREFLIGHT through CLEANUP`);
          debug(`task: BLOCKED phase=${phaseName} (task not allowed outside delegation phases)`);
          throw new ProtocolGateError(
            ERROR_TEMPLATES.BLOCKED_WRONG_PHASE.code,
            `❌ BLOCKED: Task dispatch not allowed in ${phaseName} (${phase}) phase.${terminal}${walkState ? ` ${walkState}` : ""}`,
            phase === STATES.REPORT ? "Write the report KD — REPORT takes no dispatch" : "Wait for delegation phase"
          );
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
                watchBlockedSwarmDispatch(sessionID, phase);
                const refusal = wrongAgentRefusal(sessionPhaseMap, sessionID, phase, expectedAgent);
                throw new ProtocolGateError(refusal.code, refusal.message, refusal.guidance);
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
              watchBlockedSwarmDispatch(sessionID, phase);
              const refusal = wrongAgentRefusal(sessionPhaseMap, sessionID, phase, expectedAgent);
              throw new ProtocolGateError(refusal.code, refusal.message, refusal.guidance);
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
    // getKnowledgeDir(sessionID). A missing knowledge/ dir is not an error — returns false.
    function expectedKdExists(recorded, sessionID) {
      if (recorded.resultKd) {
        const rel = toProjectRelative(recorded.resultKd).replace(/^(?:\.\/)?knowledge\//, "");
        return existsSync(join(getKnowledgeDir(sessionID), rel));
      }
      const knowledgeDir = getKnowledgeDir(sessionID);
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
      const { sessionID } = input;
      const tool = canonicalToolName(input.tool);

      // Post-write SWARM→VERIFY auto-advance: when a subagent's impl KD write
      // completes (file on disk), evaluate the parent session's SWARM gate.
      // The before-hook check-off (autoCheckOffMilestone) runs before the file
      // lands, so the gate evaluation belongs in the after-hook where the impl
      // KD is verifiable disk evidence (the write must complete before the gate
      // evaluates, so the before-hook records the relPath for the after-hook).
      if ((tool === "write" || tool === "edit") && !isOverseerSession(sessionID)) {
        const relPath = pendingImplKDWrites.get(sessionID);
        pendingImplKDWrites.delete(sessionID);
        // Settle a deferred stamp clear BEFORE the advance evaluation below: the
        // stamp clears and the row promotes first, so disk-advancement observes
        // live evidence and SWARM→VERIFY advances through the evidence path.
        const pending = pendingStampClear.get(sessionID);
        pendingStampClear.delete(sessionID);
        const isImplWrite = isImplKDArtifactPath(relPath);
        if (pending || isImplWrite) settlePendingStampClears();
        if (isImplWrite) {
          // The deferral settles here, on the landed bytes, before any phase
          // gate is consulted: promotion is evidence, not a phase move.
          settleDeferredCheckOff(sessionID, relPath);
          for (const candidate of collectParentSessionCandidates()) {
            advanceParentSessionFromSwarm(candidate);
          }
        }
        return;
      }

      // Post-write advancement for overseer KD-creating writes. The
      // before-hook runs before the file lands on disk, so a write followed
      // by no further tool calls would never advance (write → stop stalls
      // the lifecycle). Re-evaluate now that the file exists. REPORT has no
      // disk advancement and lifecycle-end deletes the phase entry, so both
      // are skipped here. Falls through to the task gate below (no-op for
      // non-task tools).
      if (isOverseerSession(sessionID) && (tool === "write" || tool === "edit")) {
        const postPhase = sessionPhaseMap.get(sessionID);
        if (postPhase !== undefined && postPhase !== STATES.REPORT) {
          await advanceFromDiskEvidence(sessionID);
        }
      }

      // CLEANUP delivers its artifact through a subagent dispatch, so this hook
      // is the post-delivery evaluation point: the Committer's write lands
      // inside the dispatch, before the after-hook runs. Without it the phase
      // advances only on the Overseer's NEXT disk-check tool call — and the
      // only call the Overseer reaches for in CLEANUP is the report write,
      // which the phase refuses before any disk check runs. Scoped to CLEANUP:
      // every other phase keeps its existing advancement site.
      if (isOverseerSession(sessionID) && tool === "subagent") {
        const postPhase = sessionPhaseMap.get(sessionID);
        if (postPhase === STATES.CLEANUP) await advanceFromDiskEvidence(sessionID);
      }

      // Mirror the before-hook charge — only overseer task dispatches touch the
      // overseer's redispatch counter; subagent→subagent task calls never do.
      if (tool !== "subagent" || !isOverseerSession(sessionID)) return;
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
    // Prefer input.sessionID when available (authoritative); fall back to
    // lastSeenSession for hooks that don't receive it.
    async function toolDefinition(input, output) {
      const toolID = canonicalToolName(input.toolID);
      const sessionID = input?.sessionID || lastSeenSession;
      if (!sessionID) return;
      if (!isOverseerSession(sessionID)) return;
      const phase = sessionPhaseMap.get(sessionID);
      if (phase === undefined) return;
      const phaseName = getPhaseName(phase);
      if (!phaseName) return;
      const allowedTools = TOOL_ALLOWLIST[phaseName] || [];
      // Transport tools carry or delegate work — they are never phase-blocked,
      // so they receive no blocked-tool prefix.
      if (TRANSPORT_TOOLS.includes(toolID)) return;
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
      const sessionID = input?.sessionID || lastSeenSession;
      if (!sessionID) { debug("systemTransform: skip — no sessionID"); return; }
      if (!isOverseerSession(sessionID)) return;
      const phase = sessionPhaseMap.get(sessionID);
      if (phase === undefined) { debug(`systemTransform: skip — phase undefined for session=${sessionID}`); return; }
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
          debug(`systemTransform: INTENT injected session=${sessionID} gen=${generation}`);
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

        // INTENT-phase raw-intent injection. The captured user text is relayed
        // into the Raw Request authoring flow so downstream agents receive the
        // words they must execute; the axis is the kind of message, not its
        // position. A task specification addressed to the swarm is copied
        // verbatim, because a paraphrase mangles what downstream agents must
        // execute. A discussion with the Overseer about process is summarized,
        // and its gist — what is to be done — becomes the request, with the
        // message listed in Triage Notes beside its disposition; a message
        // about the Overseer's conduct or the process state is a disposition
        // only, never request material. Discriminating test: would a
        // downstream agent need these exact words to do its job? Position is a
        // tie-breaker, not the rule — a later message carrying the task
        // specification becomes the Raw Request verbatim. Read-only: the
        // directive instructs a copy, never an auto-write — the Overseer
        // remains the KD author. Fires only while phase stays INTENT (may
        // repeat on subsequent turns; stops automatically on advance).
        // Overseer-only: this block is inside the isOverseerSession gate at the
        // top of systemTransform.
        if (phase === STATES.INTENT && sessionID) {
          const captured = rawIntentCapture.get(sessionID);
          if (captured && captured.length > 0) {
            captured.forEach((entry, i) => {
              if (i === 0) {
                output.system.push(`[Protocol Gate] Earliest user message — Message ${i + 1}: ${entry.text} — Classify this message before writing the Raw Request. If it is a task specification addressed to the swarm, copy it verbatim into the Raw Request section of the intent KD, because a paraphrase mangles what downstream agents must execute. If it is a discussion with the Overseer about process, summarize its gist — what is to be done — as the Raw Request and list the message in Triage Notes beside its disposition. A message about the Overseer's conduct or the process state is a disposition only, never request material. Discriminating test: would a downstream agent need these exact words to do its job? Position is a tie-breaker, not the rule — a later message carrying the task specification becomes the Raw Request verbatim and this discussion is triaged.`);
              } else {
                output.system.push(`[Protocol Gate] Follow-up message — Message ${i + 1}: ${entry.text} — If this follow-up carries the task specification, that message becomes the Raw Request verbatim; if it is a discussion with the Overseer about process, summarize its gist — what is to be done — as the request and route the message to Triage Notes with its disposition; a message about the Overseer's conduct or the process state is a disposition only, never request material. Discriminating test: would a downstream agent need these exact words to do its job? Position is a tie-breaker, not the rule.`);
              }
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
      PHASE_INSTRUCTIONS,
      TOOL_ALLOWLIST,
      TOOL_RESTRICTIONS,
      TRANSPORT_TOOLS,
      admitTool,
      DISK_CHECK_TOOLS,
      ensureGitRepo,
      sessionPhaseMap,
      overseerSessions,
      isOverseerSession,
      cycleMap,
      swarmDispatchCount,
      phaseRedispatchCount,
      blockedDispatchCount,
      lastTaskDispatch,
      pendingImplKDWrites,
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
      // Log-collapse counter reset: test seam so collapse tests start from
      // a zero count regardless of prior hook calls in the same process.
      resetLogCollapse,
      cleanupLifecycleKDs,
      preCleanupHook,
      extractCorrectionSections,
      extractMilestoneIdFromPrompt,
      collectMilestoneIds,
      milestoneRedispatchKey,
      clearPerMilestoneRedispatchKeys,
      updateMilestoneRegistry,
      extractMilestoneIdFromImplKD,
      findMilestoneImplKD,
      isLiveMilestoneEvidence,
      emitGenerationMismatchSkips,
      evaluateStaleKDDeletable,
      deleteStaleMilestoneKD,
      readMilestoneState,
      checkMilestoneCheckedOff,
      readMilestoneRegistry,
      checkAllMilestonesCheckedOff,
      reconcileStuckRowsFromDiskEvidence,
      reconcileSupersededMilestone,
      supersedeMilestoneImplKDs,
      matchesSessionKDAnyGeneration,
      matchesSessionKD,
      matchesSessionKDForSession,
      matchesSessionKDPinnedGeneration,
      extractImplKDGeneration,
      escapeRegExp,
      atomicWriteFileSync,
      extractToolPath,
      canonicalToolName,
      getKnowledgeDir,
      learnKnowledgeDirFromArgs,
      setServerProjectRoot,
      markStuckMilestonesFailed,
      readVerdictFrontmatter,
      readRetiredVerdictToken,
      hasEscalationMarker,
      findNewestVerdictKD,
      readPreflightVerdictFrontmatter,
      evaluateCleanupArtifact,
      CLEANUP_REJECTION_REASONS,
      findNewestPreflightKD,
      evaluatePreflightVerdict,
      reopenCheckedOffMilestones,
      regressVerifyOnFail,
      // IC-1 liveness surface: one allowlist, one parse, plus the file-level
      // wrapper and the labelling/audit seams the migration phases use.
      LIVE_STATUSES,
      evaluateLiveness,
      evaluateLivenessFile,
      isStaleImplKDContent,
      isLiveEvidenceFile,
      isSupersededByFrontmatter,
      readImplKDSnapshot,
      labelEvidenceStatus,
      auditStrictLivenessWouldReject,
      // IC-2/IC-3 surfaces: stamp digests, the settlement entry point and the
      // structured reopen target parser.
      stampImplKDSuperseded,
      amendStampContent,
      digestContent,
      getStampSnapshots,
      settleStampClearForArtifact,
      settleStampClearsForSession,
      parseReopenTarget,
      verdictRegressedKDs,
      collectParentSessionCandidates,
      getPersistedGeneration,
      // Lifecycle identity surface: the generation a lifecycle's own artifacts
      // carry, the allocator that hands the next lifecycle a free number, and
      // the adoption at lifecycle start.
      getActiveLifecycleGeneration: (sessionID) => getActiveLifecycleGeneration(sessionPhaseMap, sessionID),
      findLifecycleAnchor: (sessionID) => findLifecycleAnchor(sessionID),
      allocateLifecycleGeneration: (sessionID) => allocateLifecycleGeneration(sessionPhaseMap, sessionID),
      adoptLifecycleGenerationOnIntent,
      isDocumentPayload,
      getCurrentGeneration: (sessionID) => getCurrentGeneration(sessionPhaseMap, sessionID),
      parsePhaseArg,
      parseSinglePhaseArg,
      stripGenerationSuffix,
      recordPhaseOverride,
      IDENTICAL_FAIL_BRAKE_THRESHOLD,
      recordGateVerdict,
      resetGateVerdictBrake,
      getBrakeEntry,
      findEngagedBrakes,
      parseBrakeDiagnosisClaim,
      stripBrakeDiagnosisClaim,
      evaluatePhaseOverrideBrake,
      brakeSlotKey,
      OVERRIDE_HISTORY_MAX,
      getOverrideTargetPhase,
      validateMultiPhaseWalk,
      describeRejectedWalk,
      queueHeadHasFreshEvidence,
      // IC-4/IC-5 public seams: the walk shape test and the one next-hop
      // decision, bound to this server's session map so the standing suite
      // reads them off the public surface with the documented arity.
      walkExists: (sessionID) => walkExists(sessionPhaseMap, sessionID),
      nextForwardPhase: (sessionID, currentPhase, fallbackTarget) =>
        nextForwardPhase(sessionPhaseMap, sessionID, currentPhase, fallbackTarget),
      argsFromPrompt,
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
      get lastSeenSession() { return lastSeenSession; },
      // Enablement introspection: structured state, load-signal trigger,
      // status-file path, writability probe, and the dropped-write counter
      // so the standing suite reads behavior off the public surface.
      getEnablementState,
      emitLoadSignal,
      getStatusFile,
      probeLogDirWritable,
      getDroppedLogCount,
      resetDroppedLogCount,
      // Quote-aware shell splitter for denial attribution: exposed
      // here so the standing suite reads it off the public surface.
      parseSegments,
      // Denial attribution hook plus the post-denial bisect advisor,
      // with the agent-definition allowlist loader behind both.
      adviseDenial,
      adviseDenialFromAttemptLog,
      loadAgentShellAllowlist,
      parseAgentShellAllowlist,
      clearAttributionCache,
      getAttributionAgentsDir
    };
  }

  // --- V2 entrypoint (OpenCode V2 requires id + setup/effect) ---
  // Reuses the V1 server() closure above so the phase machine stays single-source.
  async function protocolGateSetup(ctx) {
    const v1 = await protocolGateServer(
      { directory: ctx?.location?.directory },
      ctx?.options
    );
    const pushSystem = (event, text) => {
      if (!event?.system || typeof text !== "string" || !text) return;
      try {
        const first = event.system[0];
        if (first && typeof first === "object" && "type" in first) {
          event.system.push({ type: "text", text });
        } else {
          event.system.push(text);
        }
      } catch {
        try { event.system.push(text); } catch {}
      }
    };
    // chat.params tracking + tool allowlist descriptions + system constraints
    const handleContext = async (event) => {
      const sessionID = event?.sessionID;
      const agent = event?.agent;
      try { await v1["chat.params"]?.({ sessionID, agent }, {}); } catch {}
      try {
        const tools = event?.tools;
        if (tools && sessionID) {
          for (const toolID of Object.keys(tools)) {
            if (TRANSPORT_TOOLS.includes(canonicalToolName(toolID))) continue;
            const current = tools[toolID] || {};
            const output = { description: current.description, parameters: current.input };
            await v1["tool.definition"]?.({ toolID, sessionID }, output);
            if (output.description && output.description !== current.description) {
              tools[toolID] = { ...current, description: output.description };
            }
          }
        }
      } catch {}
      try {
        const out = { system: [] };
        await v1["experimental.chat.system.transform"]?.({ sessionID, agent }, out);
        for (const line of out.system || []) pushSystem(event, line);
      } catch {}
    };
    await ctx.session.hook("context", handleContext);
    try { await ctx.session.hook("compaction", handleContext); } catch {}
    try { await ctx.session.hook("generate", handleContext); } catch {}
    // Verbatim raw-intent capture (V1 chat.message is read-only).
    await ctx.session.hook("prompt", async (event) => {
      try {
        const sessionID = event?.sessionID;
        const text = event?.prompt?.text;
        if (!sessionID || typeof text !== "string" || !text) return;
        await v1["chat.message"]?.(
          { sessionID, agent: "overseer" },
          { parts: [{ type: "text", text }] }
        );
      } catch {}
    });
    // Phase allowlist enforcement (V1 permission.ask sets status deny).
    await ctx.permission.hook("evaluate", async (event) => {
      try {
        const output = { status: event?.effect };
        await v1["permission.ask"]?.(
          { sessionID: event?.sessionID, type: event?.action },
          output
        );
        if (output.status === "deny" || output.status === "allow" || output.status === "ask") {
          event.effect = output.status;
        }
      } catch (e) {
        try { event.effect = "deny"; event.message = e?.message; } catch {}
      }
    });
    // WHEN-gate: dispatch validation, milestone check-off, git-stage guard.
    // V1 throws to block — letting it propagate fails the V2 operation too.
    await ctx.tool.hook("execute.before", async (event) => {
      const args = event?.input ?? event?.args;
      const v1Out = { args: args && typeof args === "object" ? { ...args } : args };
      await v1["tool.execute.before"]?.(
        { tool: event?.tool, sessionID: event?.sessionID, callID: event?.callID },
        v1Out
      );
      if (event && "input" in event) event.input = v1Out.args;
      if (event && "args" in event) event.args = v1Out.args;
    });
    await ctx.tool.hook("execute.after", async (event) => {
      try {
        await v1["tool.execute.after"]?.(
          {
            tool: event?.tool,
            sessionID: event?.sessionID,
            callID: event?.callID,
            args: event?.input ?? event?.args,
          },
          {}
        );
      } catch {}
    });
    // /phase and /reconcile-superseded: no direct V2 command-before hook, so
    // own the commands and surface the V1 confirmation text synthetically.
    const wireCommand = async (name, description) => {
      await ctx.command.transform((editor) => {
        editor.add({
          name,
          description,
          execute: async ({ sessionID, prompt }) => {
            const raw = typeof prompt?.text === "string" ? prompt.text : "";
            const args = raw.replace(new RegExp(`^/?${name}\\b\\s*`), "");
            const out = {};
            await v1["command.execute.before"]?.({ command: name, sessionID, arguments: args }, out);
            const reply = out?.parts?.[0]?.text;
            if (reply && sessionID) {
              try { await ctx.session.synthetic({ sessionID, text: reply }); }
              catch { try { await ctx.session.prompt({ sessionID, text: reply }); } catch {} }
            }
          },
        });
      });
    };
    try { await wireCommand("phase", "Set protocol-gate lifecycle phase (1-12, name, {a,b,c} multi-phase walk, or clear; trailing gen<N> ignored)"); } catch {}
    try { await wireCommand("reconcile-superseded", "Reconcile a superseded-only milestone to checked-off"); } catch {}
  }

  export default {
    id: "protocol-gate",
    setup: protocolGateSetup,
    server: protocolGateServer,
  };
