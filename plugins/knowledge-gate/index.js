// Knowledge-Gate Plugin — persistent memory search + issue tracking
//
// Hooks: chat.params, tool.definition,
//        experimental.chat.system.transform
// Scope: Scribe (memory writes), Habit Builder (issue detection),
//        all agents (memory_search queries), Overseer (open issue surfacing)
//
// Provides three capabilities:
// 1. memory_search tool — agents query knowledge/memory/ for prior insights
// 2. Issue scanning — detects high-severity open issues during EVOLVE phase,
//    triggers backward transitions via protocol-gate
// 3. INTENT phase issue surfacing — scans knowledge/issues/ for open items
//    and injects them into the Overseer's system prompt for Triage Notes
//
// Debug logging: set KNOWLEDGE_GATE_DEBUG=1 in environment to enable.
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
// tool() registers custom tools with the runtime via the plugin `tool` hook
// map — the documented mechanism (Hooks.tool) that puts memory_search and
// memory_write into the agent's callable tool list.
import { tool } from "@opencode-ai/plugin";

const __filename = fileURLToPath(import.meta.url);
const PLUGIN_DIR = dirname(__filename);
const PROJECT_ROOT = join(PLUGIN_DIR, "..", "..");

// Test seam: KNOWLEDGE_GATE_MEMORY_DIR / KNOWLEDGE_GATE_ISSUES_DIR override
// the data directories so the test suite can point the plugin at isolated
// temp dirs instead of mocking the fs module process-wide (which leaks into
// sibling suites under bun). Production defaults are unchanged.
const MEMORY_DIR = process.env.KNOWLEDGE_GATE_MEMORY_DIR
  ? resolve(process.env.KNOWLEDGE_GATE_MEMORY_DIR)
  : join(PROJECT_ROOT, "knowledge", "memory");
const ISSUES_DIR = process.env.KNOWLEDGE_GATE_ISSUES_DIR
  ? resolve(process.env.KNOWLEDGE_GATE_ISSUES_DIR)
  : join(PROJECT_ROOT, "knowledge", "issues");
// Short-term layer seam: session-scoped scratch notes live outside the
// long-term memory store and are excluded from memory_search by structure.
const SHORT_TERM_DIR = process.env.KNOWLEDGE_GATE_SHORT_TERM_DIR
  ? resolve(process.env.KNOWLEDGE_GATE_SHORT_TERM_DIR)
  : join(PROJECT_ROOT, "knowledge", "short-term");

// --- Debug logging ---

let _logFile = null;

function getLogFile() {
  if (!_logFile) {
    const logDir = join(PLUGIN_DIR, "..", "logs");
    try { mkdirSync(logDir, { recursive: true }); } catch (_) {}
    _logFile = join(logDir, "knowledge-gate.log");
  }
  return _logFile;
}

function debug(msg) {
  if (process.env.KNOWLEDGE_GATE_DEBUG) {
    try {
      appendFileSync(getLogFile(), `[${new Date().toISOString()}] [knowledge-gate] ${msg}\n`);
    } catch (_) {
      process.stderr.write(`[knowledge-gate] ${msg}\n`);
    }
  }
}

// --- Memory validation ---

/**
 * Controlled vocabulary for memory entry tags.
 * Tags are singular nouns, lowercase, hyphenated compounds allowed.
 * Organized by category for deriveSearchHints().
 */
const TAG_TAXONOMY = {
  plugin: ["protocol-gate", "delegation-gate", "knowledge-gate"],
  agent: ["overseer", "scribe", "analyzer", "artisan", "inspector", "committer", "explorer", "pathfinder", "spec-weaver", "habit-builder"],
  mode: ["explore", "investigate", "align", "decompose", "swarm", "review", "audit", "extract", "evolve"],
  domain: ["permissions", "auth", "state-machine", "phase-transition", "bug", "testing", "commit", "template", "scope", "lifecycle", "regression", "cache", "injection", "hook", "schema", "validation"],
  severity: ["critical", "major", "minor"],
  type: ["fact", "decision", "pattern", "warning", "context"]
};

// Flat set of all valid tags for quick lookup
const ALL_VALID_TAGS = new Set(Object.values(TAG_TAXONOMY).flat());

// MODE → primary tags for deriveSearchHints()
const MODE_TAG_MAP = {
  explore: ["exploration", "architecture", "investigation"],
  investigate: ["analysis", "root-cause", "bug"],
  align: ["specification", "design", "decision"],
  decompose: ["planning", "tasks", "dependencies"],
  swarm: ["implementation", "code", "pattern"],
  review: ["review", "quality"],
  audit: ["audit", "quality"],
  extract: ["knowledge", "insight", "documentation"],
  evolve: ["process", "friction", "improvement"]
};

// Agent type → additional tags for deriveSearchHints()
// Maps each agent to domain-specific tags for memory retrieval
const AGENT_TAG_MAP = {
  explorer: ["investigation", "architecture"],
  analyzer: ["analysis", "root-cause"],
  "spec-weaver": ["specification", "design"],
  pathfinder: ["planning", "decomposition"],
  artisan: ["implementation", "code"],
  inspector: ["review", "audit"],
  scribe: ["knowledge", "documentation"],
  overseer: ["orchestration", "process"],
  "habit-builder": ["process", "friction"]
};

// Stop words for SCOPE keyword extraction (common English words that carry no topical signal)
const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "as", "is", "was", "are", "were", "be",
  "been", "being", "have", "has", "had", "do", "does", "did", "will",
  "would", "could", "should", "may", "might", "shall", "can", "need",
  "this", "that", "these", "those", "it", "its", "not", "no", "nor",
  "so", "if", "then", "than", "too", "very", "just", "about", "also",
  "into", "over", "after", "before", "between", "through", "during",
  "each", "every", "all", "both", "few", "more", "most", "other",
  "some", "such", "only", "own", "same", "here", "there", "when",
  "where", "why", "how", "which", "who", "whom", "what", "per"
]);

// Noise words for SCOPE extraction — generic task verbs that carry no topical signal
const NOISE_WORDS = new Set([
  "investigate", "implement", "build", "create", "add",
  "remove", "update", "fix", "change", "review", "check",
  "verify", "ensure", "make", "write", "read"
]);

const VALID_TYPES = ["fact", "decision", "pattern", "warning", "context"];

/**
 * Gets the next sequential memory ID by scanning existing entries.
 * Mirrors getNextIssueId() pattern.
 */
function getNextMemoryId() {
  if (!existsSync(MEMORY_DIR)) return "MEM-001";

  let files;
  try {
    files = readdirSync(MEMORY_DIR).filter(f => f.startsWith("entry-") && f.endsWith(".json"));
  } catch (_) {
    return "MEM-001";
  }

  let maxNum = 0;
  for (const file of files) {
    const numMatch = file.match(/entry-(\d+)\.json/);
    if (numMatch) {
      const num = parseInt(numMatch[1], 10);
      if (num > maxNum) maxNum = num;
    }
  }

  return `MEM-${String(maxNum + 1).padStart(3, "0")}`;
}

/**
 * Validates a memory entry against the canonical schema.
 * Returns { valid: boolean, error?: string }.
 * Canonical schema:
 *   id (MEM-\d{3}), source_kd (string), tags (array 2-8),
 *   topic (string ≤100), insight (string ≤500), type (enum),
 *   created (ISO 8601 with time), session (string), version ("1.0.0"),
 *   superseded_by (string MEM-\d{3}, optional) — tombstone set via
 *   memory_update; superseded entries are excluded from search results
 */
function validateMemoryEntry(entry) {
  if (!entry || typeof entry !== "object") {
    return { valid: false, error: "Entry must be a non-null object" };
  }
  if (!/^MEM-\d{3}$/.test(entry.id)) {
    return { valid: false, error: `id must match MEM-\\d{3}, got "${entry.id}"` };
  }
  if (typeof entry.source_kd !== "string" || !entry.source_kd) {
    return { valid: false, error: "source_kd must be a non-empty string" };
  }
  if (!Array.isArray(entry.tags) || entry.tags.length < 2 || entry.tags.length > 8) {
    return { valid: false, error: "tags must be an array with 2-8 items" };
  }
  if (typeof entry.topic !== "string" || entry.topic.length > 100) {
    return { valid: false, error: `topic must be a string ≤100 chars, got length ${entry.topic?.length || 0}` };
  }
  if (typeof entry.insight !== "string" || entry.insight.length > 500) {
    return { valid: false, error: `insight must be a string ≤500 chars, got length ${entry.insight?.length || 0}` };
  }
  if (!VALID_TYPES.includes(entry.type)) {
    return { valid: false, error: `type must be one of: ${VALID_TYPES.join(", ")}, got "${entry.type}"` };
  }
  if (typeof entry.created !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(entry.created)) {
    return { valid: false, error: `created must be ISO 8601 with time, got "${entry.created}"` };
  }
  if (typeof entry.session !== "string" || !entry.session) {
    return { valid: false, error: "session must be a non-empty string" };
  }
  if (entry.version !== "1.0.0") {
    return { valid: false, error: 'version must be "1.0.0"' };
  }
  return { valid: true };
}

// --- Output formatting ---

/**
 * Formats a memory entry for either tool response (JSON) or prompt injection (markdown).
 * @param {Object} entry - Memory entry object
 * @param {string} format - "json" or "markdown"
 * @returns {Object|string} Formatted output
 */
function formatMemoryEntry(entry, format) {
  if (format === "markdown") {
    return `- [${entry.id}] (${entry.type || "unknown"}) ${entry.topic}: ${entry.insight} (source: ${entry.source_kd})`;
  }
  return entry; // json format returns raw object
}

// --- Issue scanning ---

/**
 * Scans knowledge/issues/ for open, high-severity issues.
 * Returns array of parsed issue objects.
 */
function ensureIssuesDir() {
  try {
    mkdirSync(ISSUES_DIR, { recursive: true });
  } catch (_) {
    // Non-fatal — if mkdir fails, issue operations will return empty
  }
}

function scanHighSeverityIssues() {
  ensureIssuesDir();
  if (!existsSync(ISSUES_DIR)) return [];

  let files;
  try {
    files = readdirSync(ISSUES_DIR).filter(f => f.startsWith("issue-") && f.endsWith(".md"));
  } catch (e) {
    debug(`scanHighSeverityIssues: failed to read issues dir: ${e.message}`);
    return [];
  }

  const highSeverity = [];
  for (const file of files) {
    try {
      const raw = readFileSync(join(ISSUES_DIR, file), "utf8");
      const issue = parseIssueFile(raw, file);
      if (issue && issue.severity === "high" && issue.status === "open") {
        highSeverity.push(issue);
      }
    } catch (e) {
      debug(`scanHighSeverityIssues: skipping ${file}: ${e.message}`);
    }
  }
  return highSeverity;
}

/**
 * Parses an issue markdown file's YAML frontmatter.
 * Minimal parser — does not require a YAML library.
 *
 * Value capture is tolerant:
 * - quoted values (start `"`) try JSON.parse (handles `\"` escapes) and fall
 *   back to stripping the surrounding quote pair (preserves embedded quotes)
 * - array values (`tags: [a, b]`) fold into the value dispatch → arrays
 * - a value starting with `"` that never closes on the line accumulates
 *   continuation lines until the closing quote (joined with `\n`)
 * - content without frontmatter returns null (unchanged)
 */
function parseIssueFile(content, filename) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const frontmatter = match[1];
  const result = { filename };
  const lines = frontmatter.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (!kv) continue;

    const key = kv[1];
    const rawValue = kv[2];

    // Array values: tags: [auth, permission]
    if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
      result[key] = rawValue.slice(1, -1).split(",").map(s => s.trim());
      continue;
    }

    // Quoted values: accumulate continuation lines until the closing quote,
    // then parse — JSON.parse first, quote-pair strip as fallback.
    if (rawValue.startsWith("\"")) {
      let buffer = rawValue;
      while (!hasClosingQuote(buffer) && i + 1 < lines.length) {
        i++;
        buffer += "\n" + lines[i];
      }
      result[key] = parseQuotedValue(buffer);
      continue;
    }

    result[key] = rawValue;
  }

  return result;
}

// True when a quoted value (starting with `"`) contains a closing unescaped
// quote. Used to bound multiline accumulation to the value.
function hasClosingQuote(value) {
  let escaped = false;
  for (let i = 1; i < value.length; i++) {
    const ch = value[i];
    if (escaped) {
      escaped = false;
    } else if (ch === "\\") {
      escaped = true;
    } else if (ch === "\"") {
      return true;
    }
  }
  return false;
}

// Parses a quoted value: JSON.parse first (handles `\"` escapes), then falls
// back to stripping the surrounding quote pair (preserves embedded quotes).
// Non-string JSON results fall back to the strip so value types never change
// (a quoted "42" stays the string "42", matching the legacy parser).
function parseQuotedValue(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "string") return parsed;
  } catch (_) {
    // Not valid JSON (e.g. literal newline) — strip below
  }
  if (raw.length >= 2 && raw[0] === "\"" && raw[raw.length - 1] === "\"") {
    return raw.slice(1, -1);
  }
  return raw;
}

/**
 * Scans knowledge/issues/ for ALL open issues (any severity).
 * Used during INTENT phase to surface prior-session issues to the Overseer.
 *
 * @param {object} [options]
 * @param {number} [options.cap] - positive integer → return at most `cap`
 *   issues taken AFTER the stable severity/id sort; undefined/0/invalid → no cap.
 */
function scanOpenIssues(options = {}) {
  ensureIssuesDir();
  if (!existsSync(ISSUES_DIR)) return [];

  let files;
  try {
    files = readdirSync(ISSUES_DIR).filter(f => f.startsWith("issue-") && f.endsWith(".md"));
  } catch (e) {
    debug(`scanOpenIssues: failed to read issues dir: ${e.message}`);
    return [];
  }

  const openIssues = [];
  for (const file of files) {
    try {
      const raw = readFileSync(join(ISSUES_DIR, file), "utf8");
      const issue = parseIssueFile(raw, file);
      if (issue && issue.status === "open") {
        openIssues.push(issue);
      }
    } catch (e) {
      debug(`scanOpenIssues: skipping ${file}: ${e.message}`);
    }
  }
  // readdirSync order is filesystem-dependent, so surfacing is non-deterministic
  // without an explicit sort. Rank by severity (high → medium → low) and break
  // ties by ascending numeric id so INTENT/EVOLVE injection is stable.
  openIssues.sort((a, b) => {
    const bySeverity = issueSeverityRank(a.severity) - issueSeverityRank(b.severity);
    if (bySeverity !== 0) return bySeverity;
    return issueNumericId(a) - issueNumericId(b);
  });
  return applyCap(openIssues, options.cap);
}

// Severity rank for issue surfacing: high(0) → medium(1) → low(2).
// Unknown severities sort after low so they never displace ranked issues.
function issueSeverityRank(severity) {
  return { high: 0, medium: 1, low: 2 }[severity] ?? 3;
}

// Numeric id for stable tie-breaks within a severity. Real registry ids are
// numeric ("14"); test fixtures and legacy files use "ISSUE-001" form.
function issueNumericId(issue) {
  const num = parseInt(String(issue.id).replace(/\D/g, ""), 10);
  return Number.isNaN(num) ? Number.MAX_SAFE_INTEGER : num;
}

// Bounded injection: positive integer → first N issues in the given
// (already severity-sorted) order; undefined/0/invalid → no cap. Shared by
// scanOpenIssues({ cap }) and the overseer branch's env-derived cap.
function applyCap(issues, cap) {
  return typeof cap === "number" && Number.isInteger(cap) && cap > 0
    ? issues.slice(0, cap)
    : issues;
}

// Cap for the overseer INTENT injection, read at transform call time
// (not module load — required for per-test env control). Env contract:
// unset/empty/invalid/negative → 10 (default); "0" → unbounded (0 = no cap);
// positive integer → that value.
function envOpenIssueCap() {
  const raw = (process.env.KNOWLEDGE_GATE_MAX_OPEN_ISSUES || "").trim();
  if (raw === "") return 10;
  if (raw === "0") return 0;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 10;
}

// Opt-in audience routing for the overseer INTENT injection, read at
// transform call time. KNOWLEDGE_GATE_ISSUE_AUDIENCE is a comma-separated
// list of case-insensitive substrings matched against `assigned_to`. Issues
// with no/empty `assigned_to` are ALWAYS included (unowned → need triage).
// Unset/empty/whitespace-only → no filter (today's behavior). Preserves the
// Sort order of the input list; the cap applies afterwards.
function filterByAudience(issues, audienceEnv) {
  const raw = (audienceEnv || "").trim();
  if (raw === "") return issues;
  const needles = raw.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  if (needles.length === 0) return issues;
  return issues.filter(issue => {
    const assigned = String(issue.assigned_to || "").trim().toLowerCase();
    if (assigned === "") return true;
    return needles.some(n => assigned.includes(n));
  });
}

/**
 * Gets the next sequential issue ID by scanning existing issues.
 */
function getNextIssueId() {
  ensureIssuesDir();
  if (!existsSync(ISSUES_DIR)) return "ISSUE-001";

  let files;
  try {
    files = readdirSync(ISSUES_DIR).filter(f => f.startsWith("issue-") && f.endsWith(".md"));
  } catch (_) {
    return "ISSUE-001";
  }

  let maxNum = 0;
  for (const file of files) {
    const numMatch = file.match(/issue-(\d+)\.md/);
    if (numMatch) {
      const num = parseInt(numMatch[1], 10);
      if (num > maxNum) maxNum = num;
    }
  }

  return `ISSUE-${String(maxNum + 1).padStart(3, "0")}`;
}

// --- Short-term memory (session-scoped scratch notes) ---
//
// knowledge/short-term/{sessionID}/{agent}/note-{NNN}.json — per-agent
// per-session notes every agent can write into its own namespace and the
// owner plus Scribe can read (the promotion path). Notes are session-scoped
// scratch state: bounded by the per-agent cap with oldest-first eviction,
// structurally excluded from long-term memory_search, and cleared at
// lifecycle end by protocol-gate. All short-term logic lives here — no
// cross-plugin imports.

const NOTE_VERSION = "1.0.0";
const NOTE_CAP = 100;

// Rejects path traversal in session/agent tokens before they become directory
// names under the short-term store (mirrors sanitizeSessionID in
// protocol-gate — session IDs reach file paths and can be attacker-influenced).
function sanitizeToken(token) {
  if (typeof token !== "string" || token.length === 0) return null;
  if (token === "." || token === "..") return null;
  if (/[\\/\0]/.test(token)) return null;
  return token;
}

// Resolves the agent namespace directory for a session+agent pair, or null
// when either token fails sanitization (the traversal guard).
function noteDirFor(session, agent) {
  const safeSession = sanitizeToken(session);
  const safeAgent = sanitizeToken(agent);
  if (!safeSession || !safeAgent) return null;
  return join(SHORT_TERM_DIR, safeSession, safeAgent);
}

// Resolves the note file for a session+agent+sequence number, or null when
// the tokens fail sanitization.
function noteFilePath(session, agent, num) {
  const dir = noteDirFor(session, agent);
  if (!dir) return null;
  return join(dir, `note-${String(num).padStart(3, "0")}.json`);
}

// Builds the canonical note id: ST-{session}-{agent}-{NNN}. The id embeds the
// same tokens the path uses, so a read/delete by id round-trips to the file.
function noteIdFor(session, agent, num) {
  return `ST-${session}-${agent}-${String(num).padStart(3, "0")}`;
}

// Parses a canonical note id back into { session, agent, num }. The greedy
// session group absorbs extra hyphens so hyphenated agent names round-trip:
// `ST-ses_1-spec-weaver-007` → session ses_1, agent spec-weaver, num 007.
function parseNoteId(id) {
  if (typeof id !== "string" || !id.startsWith("ST-")) return null;
  const m = id.slice(3).match(/^(.+)-(.+)-(\d{3})$/);
  if (!m) return null;
  return { session: m[1], agent: m[2], num: m[3] };
}

// Validates a note against the short-term schema. The long-term validator
// (validateMemoryEntry) stays untouched — the two layers have disjoint
// schemas and id namespaces by design.
function validateNote(note) {
  if (!note || typeof note !== "object") {
    return { valid: false, error: "Note must be a non-null object" };
  }
  if (typeof note.id !== "string" || !parseNoteId(note.id)) {
    return { valid: false, error: `id must match ST-{session}-{agent}-{NNN}, got "${note.id}"` };
  }
  if (typeof note.agent !== "string" || !note.agent) {
    return { valid: false, error: "agent must be a non-empty string" };
  }
  if (typeof note.session !== "string" || !note.session) {
    return { valid: false, error: "session must be a non-empty string" };
  }
  if (typeof note.created !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(note.created)) {
    return { valid: false, error: `created must be ISO 8601 with time, got "${note.created}"` };
  }
  if (typeof note.topic !== "string" || note.topic.length > 100) {
    return { valid: false, error: `topic must be a string ≤100 chars, got length ${note.topic?.length || 0}` };
  }
  if (typeof note.content !== "string" || note.content.length > 2000) {
    return { valid: false, error: `content must be a string ≤2000 chars, got length ${note.content?.length || 0}` };
  }
  if (note.tags !== undefined) {
    if (!Array.isArray(note.tags) || note.tags.length > 5) {
      return { valid: false, error: "tags must be an array with 0-5 items" };
    }
    if (note.tags.some(t => typeof t !== "string")) {
      return { valid: false, error: "tags must contain only strings" };
    }
  }
  if (note.version !== NOTE_VERSION) {
    return { valid: false, error: `version must be "${NOTE_VERSION}"` };
  }
  return { valid: true };
}

// Lists the note sequence numbers in an agent namespace, ascending. The count
// reflects physical note-*.json files (malformed content still occupies a
// bounded slot); readers skip malformed files.
function listNoteNumbers(session, agent) {
  const dir = noteDirFor(session, agent);
  if (!dir || !existsSync(dir)) return [];
  let files;
  try {
    files = readdirSync(dir).filter(f => /^note-\d{3}\.json$/.test(f));
  } catch (e) {
    debug(`listNoteNumbers: failed to read ${dir}: ${e.message}`);
    return [];
  }
  return files
    .map(f => parseInt(f.match(/note-(\d{3})\.json/)[1], 10))
    .sort((a, b) => a - b);
}

// Next sequence number for an agent namespace: max on disk + 1 (starts at 1).
function getNextNoteNumber(session, agent) {
  const nums = listNoteNumbers(session, agent);
  return nums.reduce((m, n) => Math.max(m, n), 0) + 1;
}

// Reads every note in a namespace, ascending by sequence number. Malformed
// note JSON is skipped with a debug log (mirrors loadEntriesFromDisk).
function readNotesFromDisk(session, agent) {
  const notes = [];
  for (const num of listNoteNumbers(session, agent)) {
    const filePath = noteFilePath(session, agent, num);
    try {
      notes.push(JSON.parse(readFileSync(filePath, "utf8")));
    } catch (e) {
      debug(`readNotesFromDisk: skipping malformed ${filePath}: ${e.message}`);
    }
  }
  return notes;
}

// Enforces the per-agent per-session cap: when the namespace holds NOTE_CAP
// notes, the oldest (lowest sequence number) is evicted before the next write.
// The scratch store stays bounded; eviction is logged. Race tolerance: two
// same-agent writes in one tick can momentarily reach cap+1, and the next
// write restores the steady state.
function evictOldestIfAtCap(session, agent) {
  const nums = listNoteNumbers(session, agent);
  if (nums.length < NOTE_CAP) return;
  const oldest = nums[0];
  const filePath = noteFilePath(session, agent, oldest);
  try {
    unlinkSync(filePath);
    debug(`evictOldestIfAtCap: evicted ${filePath} (cap ${NOTE_CAP})`);
  } catch (e) {
    debug(`evictOldestIfAtCap: eviction failed for ${filePath}: ${e.message}`);
  }
}

// --- Main plugin export ---

export default {
  id: "knowledge-gate",
  server: async function knowledgeGateServer(input, options) {
    const sessionAgentMap = new Map(); // sessionID → agent name

    // --- In-memory cache (per server instance) ---
    // The cache lives in the server closure, not module scope, so every
    // server() call yields a fresh cache — tests get clean state without
    // re-importing the module (bun's equivalent of vi.resetModules).
    const memoryCache = {
      entries: null,
      lastLoaded: null,
      ttlMs: parseInt(process.env.MEMORY_CACHE_TTL_MS || "30000", 10),
      isLoading: false,
      fileCount: 0
    };

    function isCacheValid() {
      if (memoryCache.entries === null || memoryCache.lastLoaded === null) return false;
      if ((Date.now() - memoryCache.lastLoaded) >= memoryCache.ttlMs) return false;
      // Detect external file changes by comparing file count
      // Uses readdirSync but avoids re-parsing all entries when count is unchanged
      try {
        const currentCount = readdirSync(MEMORY_DIR).filter(f => f.endsWith(".json")).length;
        if (currentCount !== memoryCache.fileCount) {
          memoryCache.entries = null;
          memoryCache.lastLoaded = null;
          return false;
        }
      } catch (_) {
        return false;
      }
      return true;
    }

    function loadEntriesFromDisk() {
      if (!existsSync(MEMORY_DIR)) {
        debug("loadEntriesFromDisk: memory dir does not exist");
        return [];
      }

      let files;
      try {
        files = readdirSync(MEMORY_DIR).filter(f => f.endsWith(".json"));
      } catch (e) {
        debug(`loadEntriesFromDisk: failed to read memory dir: ${e.message}`);
        return [];
      }

      // Detect file count change — invalidates cache
      if (memoryCache.entries !== null && files.length !== memoryCache.fileCount) {
        debug(`loadEntriesFromDisk: file count changed (${memoryCache.fileCount} → ${files.length}), cache invalidated`);
        memoryCache.entries = null;
        memoryCache.lastLoaded = null;
      }

      const entries = [];
      for (const file of files) {
        try {
          const raw = readFileSync(join(MEMORY_DIR, file), "utf8");
          const entry = JSON.parse(raw);
          entries.push(entry);
        } catch (e) {
          debug(`loadEntriesFromDisk: skipping malformed ${file}: ${e.message}`);
        }
      }

      memoryCache.entries = entries;
      memoryCache.lastLoaded = Date.now();
      memoryCache.fileCount = files.length;
      return entries;
    }

    // --- Memory search ---

    /**
     * Scans knowledge/memory/ for JSON entries matching query parameters.
     * Uses in-memory cache with configurable TTL to reduce disk I/O.
     * Returns entries sorted by tag-match count (descending), then recency.
     */
    function searchMemory(query) {
      const { tags = [], topic = "", limit = 5 } = query;

      // Load from cache or disk
      let entries;
      if (isCacheValid()) {
        entries = memoryCache.entries;
        debug(`searchMemory: cache hit (${entries.length} entries)`);
      } else {
        entries = loadEntriesFromDisk();
        debug(`searchMemory: cache miss, loaded ${entries.length} entries from disk`);
      }

      // Exclude superseded entries (tombstoned via memory_update superseded_by)
      // before scoring — a tombstoned entry no longer participates in search,
      // dedup matching (checkDuplicateMemory), or hint derivation.
      entries = entries.filter(e => !e.superseded_by);

      if (entries.length === 0) return [];

      // Score each entry by tag overlap count
      const scored = entries.map(entry => {
        const entryTags = entry.tags || [];
        const tagOverlap = tags.filter(t => entryTags.includes(t)).length;
        // Topic match: substring check, case-insensitive
        const topicMatch = topic && entry.topic
          ? entry.topic.toLowerCase().includes(topic.toLowerCase()) ? 1 : 0
          : 0;
        return { entry, score: tagOverlap + topicMatch * 2 };
      });

      // Sort by score descending, then by created timestamp descending (newest first)
      scored.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        const aTime = new Date(a.entry.created || 0).getTime();
        const bTime = new Date(b.entry.created || 0).getTime();
        return bTime - aTime;
      });

      return scored
        .filter(s => s.score > 0 || (tags.length === 0 && !topic))
        .slice(0, limit)
        .map(s => ({
          id: s.entry.id,
          source_kd: s.entry.source_kd,
          tags: s.entry.tags || [],
          topic: s.entry.topic || "",
          insight: s.entry.insight || ""
        }));
    }

    // --- Hint derivation + dedup (depend on the per-server searchMemory) ---

    function deriveSearchHints(context) {
      const { mode = "", agentType = "", phase = "", scope = "" } = context || {};

      // Mechanical modes skip entirely — no hint overhead for trivial dispatches
      if (["preflight", "checkpoint", "cleanup"].includes(mode)) {
        return { hints: [], shouldHint: false };
      }

      // Collect tags from MODE mapping
      const tags = [...(MODE_TAG_MAP[mode] || [])];

      // Add agent-type tags
      const agentTags = AGENT_TAG_MAP[agentType] || [];
      tags.push(...agentTags);

      // Extract noun keywords from SCOPE (top 3)
      if (scope) {
        const keywords = scope
          .toLowerCase()
          .replace(/[^a-zA-Z0-9\s-]/g, " ")
          .split(/\s+/)
          .filter(w => w.length >= 3 && !STOP_WORDS.has(w) && !NOISE_WORDS.has(w));
        // Remove duplicates while preserving order, take top 3
        const unique = [...new Set(keywords)];
        tags.push(...unique.slice(0, 3));
      }

      // Deduplicate all tags
      const uniqueTags = [...new Set(tags)];

      if (uniqueTags.length === 0) {
        return { hints: [], shouldHint: false };
      }

      // Search memory with derived tags — call searchMemory directly (internal function)
      const results = searchMemory({ tags: uniqueTags, limit: 5 });
      if (results.length === 0) {
        return { hints: [], shouldHint: false };
      }

      // Generate hint lines from results
      const primaryTags = uniqueTags.slice(0, 2);
      const hints = generateHintLines(results, primaryTags);

      return { hints, shouldHint: hints.length > 0 };
    }

    function generateHintLines(results, primaryTags) {
      const lines = [];

      for (const tag of primaryTags) {
        if (lines.length >= 3) break;
        const count = results.filter(r => (r.tags || []).includes(tag)).length;
        if (count > 0) {
          const line = `[Memory: ${count} entries match "${tag}". Use memory_search("${tag}") to retrieve.]`;
          // Enforce byte limit — skip if line exceeds 300 bytes (hint must be compact)
          if (Buffer.byteLength(line, "utf8") <= 300) {
            lines.push(line);
          }
        }
      }

      // Fallback: if no tag-grouping worked, use generic line
      if (lines.length === 0 && results.length > 0) {
        const line = `[Memory: ${results.length} entries match current context. Use memory_search(tags=[...]) to retrieve.]`;
        if (Buffer.byteLength(line, "utf8") <= 300) {
          lines.push(line);
        }
      }

      return lines.slice(0, 3);
    }

    function checkDuplicateMemory(entry, threshold = 3) {
      if (!entry || !entry.topic) return null;

      const results = searchMemory({ tags: entry.tags || [], topic: entry.topic, limit: 5 });
      for (const r of results) {
        // Calculate overlap score: tag match + topic match
        const tagOverlap = (entry.tags || []).filter(t => (r.tags || []).includes(t)).length;
        const topicMatch = r.topic && entry.topic
          ? r.topic.toLowerCase().includes(entry.topic.toLowerCase()) ||
            entry.topic.toLowerCase().includes(r.topic.toLowerCase()) ? 2 : 0
          : 0;
        const score = tagOverlap + topicMatch;
        // Duplicate only when topic overlaps AND score clears the threshold —
        // shared tags alone (unrelated topics) must not skip a write.
        if (topicMatch && score >= threshold) {
          return r;
        }
      }

      return null;
    }

    debug("Knowledge Gate loaded");

    // --- Registered tools: memory_search + memory_write ---
    // Custom tools are registered through the plugin `tool` hook map so they
    // appear in the agent's callable tool list. Scribe-only gating uses
    // ToolContext.agent (the runtime passes it per call), falling back to
    // the session map when the context omits it.
    const memoryTools = {
      memory_search: tool({
        description: "Search knowledge/memory/ for prior session insights. Args: tags (string array), topic (string), limit (integer, default 5). Returns JSON array of matching entries.",
        args: {
          tags: tool.schema.array(tool.schema.string()).optional().describe("Tags to match against entry tags"),
          topic: tool.schema.string().optional().describe("Topic substring to match"),
          limit: tool.schema.number().int().optional().describe("Maximum number of results (default 5)")
        },
        async execute(args) {
          const query = {
            tags: args.tags || [],
            topic: args.topic || "",
            limit: args.limit || 5
          };
          const results = searchMemory(query);
          return JSON.stringify(results, null, 2);
        }
      }),
      memory_write: tool({
        description: "Write a validated memory entry to knowledge/memory/. Only Scribe may write. Args: entry (object with fields: id (optional), source_kd, tags, topic, insight, type, created, session, version). Validates schema, checks tags against controlled vocabulary, deduplicates, auto-assigns ID, and writes to disk.",
        args: {
          entry: tool.schema.object({
            id: tool.schema.string().optional().describe("Auto-assigned if omitted"),
            source_kd: tool.schema.string().describe("Source KD path"),
            tags: tool.schema.array(tool.schema.string()).describe("2-8 tags from controlled vocabulary"),
            topic: tool.schema.string().describe("Topic ≤100 chars"),
            insight: tool.schema.string().describe("Insight ≤500 chars"),
            type: tool.schema.enum(["fact", "decision", "pattern", "warning", "context"]).describe("Entry type"),
            created: tool.schema.string().describe("ISO 8601 timestamp"),
            session: tool.schema.string().describe("Session ID"),
            version: tool.schema.string().describe("Schema version (1.0.0)")
          })
        },
        async execute(args, context) {
          const entry = args.entry;
          const agent = (context.agent || sessionAgentMap.get(context.sessionID) || "").toLowerCase();

          // Permission check: only Scribe can write memory entries
          if (agent !== "scribe") {
            debug(`memory_write: rejected — called by non-Scribe agent "${agent}"`);
            return JSON.stringify({ error: "Only Scribe agent has permission to write memory entries. Called by: " + (agent || "unknown") });
          }

          // Ensure memory directory exists
          try { mkdirSync(MEMORY_DIR, { recursive: true }); } catch (_) {}

          // Auto-assign ID before validation — so validateMemoryEntry sees a valid ID
          if (!entry.id || entry.id === "MEM-XXX") {
            entry.id = getNextMemoryId();
          }

          // Validate entry against canonical schema
          const validation = validateMemoryEntry(entry);
          if (!validation.valid) {
            debug(`memory_write: validation failed — ${validation.error}`);
            return JSON.stringify({ error: validation.error });
          }

          // Validate tags against controlled vocabulary (warn on unknown, still accept)
          const unknownTags = (entry.tags || []).filter(t => !ALL_VALID_TAGS.has(t));
          if (unknownTags.length > 0) {
            debug(`memory_write: unknown tags detected: ${unknownTags.join(", ")} — accepted with warning`);
          }

          // Check for duplicates (search memory excluding this entry's own ID if already known)
          const duplicate = checkDuplicateMemory(entry);
          if (duplicate && duplicate.id !== entry.id) {
            debug(`memory_write: duplicate detected — existing=${duplicate.id}, skipped`);
            return JSON.stringify({ message: "Duplicate entry detected, skipped", existing: duplicate.id });
          }

          // Write entry to disk
          const entryId = entry.id.replace("MEM-", "");
          const filePath = join(MEMORY_DIR, `entry-${entryId}.json`);
          try {
            writeFileSync(filePath, JSON.stringify(entry, null, 2), "utf8");
            // Invalidate cache so next search picks up the new entry
            memoryCache.entries = null;
            memoryCache.lastLoaded = null;
            debug(`memory_write: written ${filePath}`);
            return JSON.stringify({ message: "Memory entry written", id: entry.id });
          } catch (e) {
            debug(`memory_write: write failed — ${e.message}`);
            return JSON.stringify({ error: `Failed to write memory entry: ${e.message}` });
          }
        }
      }),
      memory_update: tool({
        description: "Update an existing memory entry in knowledge/memory/. Only Scribe may update. Args: id (string MEM-XXX), entry (object with any of: topic, insight, tags, source_kd, type, superseded_by). Preserves id/created/session/version. Setting superseded_by to a MEM-XXX ID tombstones the entry: it is excluded from future memory_search results. Passing \"\" or null as superseded_by clears the tombstone and restores the entry to search visibility.",
        args: {
          id: tool.schema.string().describe("Memory entry ID to update (MEM-XXX)"),
          entry: tool.schema.object({
            topic: tool.schema.string().optional().describe("Topic ≤100 chars"),
            insight: tool.schema.string().optional().describe("Insight ≤500 chars"),
            tags: tool.schema.array(tool.schema.string()).optional().describe("2-8 tags from controlled vocabulary"),
            source_kd: tool.schema.string().optional().describe("Source KD path"),
            type: tool.schema.enum(["fact", "decision", "pattern", "warning", "context"]).optional().describe("Entry type"),
            superseded_by: tool.schema.string().optional().nullable().describe("Optional tombstone: MEM-XXX ID of the replacing entry; pass \"\" or null to clear")
          })
        },
        async execute(args, context) {
          const { id, entry } = args;
          const agent = (context.agent || sessionAgentMap.get(context.sessionID) || "").toLowerCase();

          // Permission check: only Scribe can update memory entries
          if (agent !== "scribe") {
            debug(`memory_update: rejected — called by non-Scribe agent "${agent}"`);
            return JSON.stringify({ error: "Only Scribe agent has permission to update memory entries. Called by: " + (agent || "unknown") });
          }

          // id must match the canonical format (also guards path traversal)
          if (typeof id !== "string" || !/^MEM-\d{3}$/.test(id)) {
            debug(`memory_update: invalid or missing id — ${id}`);
            return JSON.stringify({ error: "Memory entry not found: " + id });
          }
          const filePath = join(MEMORY_DIR, `entry-${id.replace("MEM-", "")}.json`);
          if (!existsSync(filePath)) {
            debug(`memory_update: entry not found — ${id}`);
            return JSON.stringify({ error: "Memory entry not found: " + id });
          }

          // Empty patch — no updatable field supplied
          const UPDATABLE_FIELDS = ["topic", "insight", "tags", "source_kd", "type", "superseded_by"];
          if (!entry || typeof entry !== "object" || !UPDATABLE_FIELDS.some(f => f in entry)) {
            return JSON.stringify({ error: "Nothing to update" });
          }

          // Tombstone format check (format-only; entries are self-contained).
          // "" and null are explicit clear sentinels — they remove the tombstone
          // instead of validating as replacement IDs (the un-supersede path).
          if (
            entry.superseded_by !== undefined &&
            entry.superseded_by !== null &&
            entry.superseded_by !== "" &&
            !/^MEM-\d{3}$/.test(entry.superseded_by)
          ) {
            return JSON.stringify({ error: `superseded_by must match MEM-\\d{3}, got "${entry.superseded_by}"` });
          }

          // Load the existing entry and merge the partial patch
          let existing;
          try {
            existing = JSON.parse(readFileSync(filePath, "utf8"));
          } catch (e) {
            debug(`memory_update: failed to read ${filePath} — ${e.message}`);
            return JSON.stringify({ error: "Memory entry not found: " + id });
          }

          const merged = { ...existing, ...entry };
          // Preserve immutable fields from the on-disk entry
          merged.id = existing.id;
          merged.created = existing.created;
          merged.session = existing.session;
          merged.version = existing.version;

          // Validate the merged entry before writing
          const validation = validateMemoryEntry(merged);
          if (!validation.valid) {
            debug(`memory_update: validation failed — ${validation.error}`);
            return JSON.stringify({ error: validation.error });
          }

          try {
            writeFileSync(filePath, JSON.stringify(merged, null, 2), "utf8");
            // Invalidate cache so next search picks up the updated entry
            memoryCache.entries = null;
            memoryCache.lastLoaded = null;
            debug(`memory_update: updated ${filePath}`);
            return JSON.stringify({ message: "Memory entry updated", id: existing.id });
          } catch (e) {
            debug(`memory_update: write failed — ${e.message}`);
            return JSON.stringify({ error: `Failed to update memory entry: ${e.message}` });
          }
        }
      }),
      memory_delete: tool({
        description: "Delete a memory entry from knowledge/memory/. Only Scribe may delete. Args: id (string MEM-XXX). Removes entry-{num}.json permanently — there is no VCS recovery (knowledge/ is gitignored). Prefer memory_update with superseded_by for supersession.",
        args: {
          id: tool.schema.string().describe("Memory entry ID to delete (MEM-XXX)")
        },
        async execute(args, context) {
          const { id } = args;
          const agent = (context.agent || sessionAgentMap.get(context.sessionID) || "").toLowerCase();

          // Permission check: only Scribe can delete memory entries
          if (agent !== "scribe") {
            debug(`memory_delete: rejected — called by non-Scribe agent "${agent}"`);
            return JSON.stringify({ error: "Only Scribe agent has permission to delete memory entries. Called by: " + (agent || "unknown") });
          }

          // id must match the canonical format (also guards path traversal)
          if (typeof id !== "string" || !/^MEM-\d{3}$/.test(id)) {
            debug(`memory_delete: invalid or missing id — ${id}`);
            return JSON.stringify({ error: "Memory entry not found: " + id });
          }
          const filePath = join(MEMORY_DIR, `entry-${id.replace("MEM-", "")}.json`);
          if (!existsSync(filePath)) {
            debug(`memory_delete: entry not found — ${id}`);
            return JSON.stringify({ error: "Memory entry not found: " + id });
          }

          try {
            unlinkSync(filePath);
            // Invalidate cache so next search drops the deleted entry
            memoryCache.entries = null;
            memoryCache.lastLoaded = null;
            debug(`memory_delete: deleted ${filePath}`);
            return JSON.stringify({ message: "Memory entry deleted", id });
          } catch (e) {
            debug(`memory_delete: delete failed — ${e.message}`);
            return JSON.stringify({ error: `Failed to delete memory entry: ${e.message}` });
          }
        }
      }),
      memory_note: tool({
        description: "Write a short-term memory note to knowledge/short-term/{session}/{agent}/. Every agent may write into its own namespace for the current session; the note is session-scoped scratch state. At 100 notes per agent per session the oldest note is evicted. Args: topic (string ≤100 chars), content (string ≤2000 chars), tags (optional, 0-5 strings). Returns { message, id } or { error }.",
        args: {
          topic: tool.schema.string().describe("Topic ≤100 chars"),
          content: tool.schema.string().describe("Content ≤2000 chars"),
          tags: tool.schema.array(tool.schema.string()).optional().describe("Optional tags 0-5")
        },
        async execute(args, context) {
          const agent = (context.agent || sessionAgentMap.get(context.sessionID) || "").toLowerCase();
          const session = context.sessionID || "";
          const { topic = "", content = "", tags } = args;

          if (!agent || !session) {
            return JSON.stringify({ error: "Unable to determine caller agent or session" });
          }

          // Cheap write path — validates only the note schema + cap, with no
          // long-term search or dedup, so agents persist in-flight state
          // without predicting compaction.
          if (typeof topic !== "string" || topic.length > 100) {
            return JSON.stringify({ error: `topic must be a string ≤100 chars, got length ${topic?.length || 0}` });
          }
          if (typeof content !== "string" || content.length > 2000) {
            return JSON.stringify({ error: `content must be a string ≤2000 chars, got length ${content?.length || 0}` });
          }
          if (tags !== undefined) {
            if (!Array.isArray(tags) || tags.length > 5 || tags.some(t => typeof t !== "string")) {
              return JSON.stringify({ error: "tags must be an array with 0-5 string items" });
            }
          }

          // The namespace is derived from caller identity — memory_note takes
          // no agent/session args, so a write can never target another agent's
          // namespace. Sanitization rejects traversal-shaped tokens before the
          // path join (the tool-level write boundary, mirroring memory_write).
          const dir = noteDirFor(session, agent);
          if (!dir) {
            debug(`memory_note: rejected tokens session="${session}" agent="${agent}"`);
            return JSON.stringify({ error: "Invalid session or agent token" });
          }

          evictOldestIfAtCap(session, agent);
          const next = getNextNoteNumber(session, agent);
          const note = {
            id: noteIdFor(session, agent, next),
            agent,
            session,
            created: new Date().toISOString(),
            topic,
            content,
            version: NOTE_VERSION
          };
          if (tags !== undefined) note.tags = tags;

          try {
            mkdirSync(dir, { recursive: true });
            writeFileSync(noteFilePath(session, agent, next), JSON.stringify(note, null, 2), "utf8");
            debug(`memory_note: written ${noteFilePath(session, agent, next)}`);
            return JSON.stringify({ message: "Short-term note written", id: note.id });
          } catch (e) {
            debug(`memory_note: write failed — ${e.message}`);
            return JSON.stringify({ error: `Failed to write short-term note: ${e.message}` });
          }
        }
      }),
      memory_note_read: tool({
        description: "Read short-term memory notes from knowledge/short-term/. Args: id (string ST-...) to read one note; agent and/or session (strings) to read a namespace (Scribe only — the promotion path). Agents may read only their own notes; Scribe may read any agent's notes. Returns the note object, an array of note objects, or { error }.",
        args: {
          id: tool.schema.string().optional().describe("Note ID (ST-{session}-{agent}-{NNN})"),
          agent: tool.schema.string().optional().describe("Agent namespace to read (Scribe only)"),
          session: tool.schema.string().optional().describe("Session for the namespace read, defaults to the current session (Scribe only)")
        },
        async execute(args, context) {
          const caller = (context.agent || sessionAgentMap.get(context.sessionID) || "").toLowerCase();
          const currentSession = context.sessionID || "";
          const { id, agent, session } = args;

          if (id) {
            const parsed = parseNoteId(id);
            if (!parsed) {
              debug(`memory_note_read: invalid id — ${id}`);
              return JSON.stringify({ error: "Invalid note id: " + id });
            }
            // Owner reads own; Scribe reads any (promotion path prerequisite).
            if (caller !== "scribe" && parsed.agent !== caller) {
              debug(`memory_note_read: rejected — ${caller} tried to read ${parsed.agent}'s note`);
              return JSON.stringify({ error: "Permission denied: agents may read only their own short-term notes. Called by: " + (caller || "unknown") });
            }
            const filePath = noteFilePath(parsed.session, parsed.agent, Number(parsed.num));
            if (!filePath || !existsSync(filePath)) {
              return JSON.stringify({ error: "Short-term note not found: " + id });
            }
            try {
              return JSON.stringify(JSON.parse(readFileSync(filePath, "utf8")), null, 2);
            } catch (e) {
              debug(`memory_note_read: malformed note ${filePath}: ${e.message}`);
              return JSON.stringify({ error: "Short-term note not found: " + id });
            }
          }

          // Namespace read — Scribe only.
          if (agent !== undefined || session !== undefined) {
            if (caller !== "scribe") {
              debug(`memory_note_read: rejected — non-Scribe ${caller} requested a namespace read`);
              return JSON.stringify({ error: "Permission denied: only Scribe may read other agents' short-term notes. Called by: " + (caller || "unknown") });
            }
            if (agent === undefined) {
              return JSON.stringify({ error: "Namespace read requires an agent; list a whole session with memory_notes_list" });
            }
            const notes = readNotesFromDisk(session || currentSession, agent);
            return JSON.stringify(notes, null, 2);
          }

          return JSON.stringify({ error: "Specify id or agent to read" });
        }
      }),
      memory_notes_list: tool({
        description: "List short-term memory notes in knowledge/short-term/. Returns a summary array [{ id, agent, created, topic }]. Non-Scribe agents see only their own notes in the current session; Scribe sees any agent's notes — or all agents' notes in a session when no agent is given.",
        args: {
          agent: tool.schema.string().optional().describe("Agent namespace to list (Scribe only)"),
          session: tool.schema.string().optional().describe("Session to list, defaults to the current session (Scribe only)")
        },
        async execute(args, context) {
          const caller = (context.agent || sessionAgentMap.get(context.sessionID) || "").toLowerCase();
          const currentSession = context.sessionID || "";
          const { agent, session } = args || {};

          const targetSession = session || currentSession;
          const targetAgent = agent || caller;

          // Owner scope: a non-Scribe may list only its own namespace.
          if (caller !== "scribe" && (targetAgent !== caller || targetSession !== currentSession)) {
            debug(`memory_notes_list: rejected — ${caller} requested ${targetAgent}/${targetSession}`);
            return JSON.stringify({ error: "Permission denied: agents may list only their own short-term notes. Called by: " + (caller || "unknown") });
          }

          const toSummary = note => ({ id: note.id, agent: note.agent, created: note.created, topic: note.topic });

          if (caller === "scribe" && agent === undefined) {
            // Scribe listing a whole session — the promotion path scans every
            // agent namespace under the session tree.
            const safeSession = sanitizeToken(targetSession);
            if (!safeSession) return JSON.stringify({ error: "Invalid session token" });
            const sessionRoot = join(SHORT_TERM_DIR, safeSession);
            let entries = [];
            try {
              entries = existsSync(sessionRoot) ? readdirSync(sessionRoot, { withFileTypes: true }) : [];
            } catch (e) {
              debug(`memory_notes_list: failed to read ${sessionRoot}: ${e.message}`);
              return JSON.stringify([]);
            }
            const summaries = [];
            for (const entry of entries) {
              if (!entry.isDirectory()) continue;
              const safeAgent = sanitizeToken(entry.name);
              if (!safeAgent) continue;
              for (const note of readNotesFromDisk(safeSession, safeAgent)) summaries.push(toSummary(note));
            }
            return JSON.stringify(summaries, null, 2);
          }

          const notes = readNotesFromDisk(targetSession, targetAgent);
          return JSON.stringify(notes.map(toSummary), null, 2);
        }
      }),
      memory_note_delete: tool({
        description: "Delete a short-term memory note from knowledge/short-term/. Args: id (string ST-...). The owner may delete own notes; Scribe may delete any agent's notes. Removes note-{NNN}.json permanently — the short-term store is session-scoped scratch state.",
        args: {
          id: tool.schema.string().describe("Note ID to delete (ST-{session}-{agent}-{NNN})")
        },
        async execute(args, context) {
          const { id } = args;
          const caller = (context.agent || sessionAgentMap.get(context.sessionID) || "").toLowerCase();
          const parsed = parseNoteId(id);
          if (!parsed) {
            debug(`memory_note_delete: invalid id — ${id}`);
            return JSON.stringify({ error: "Invalid note id: " + id });
          }
          // Owner deletes own; Scribe deletes any (promotion path cleanup).
          if (caller !== "scribe" && parsed.agent !== caller) {
            debug(`memory_note_delete: rejected — ${caller} tried to delete ${parsed.agent}'s note`);
            return JSON.stringify({ error: "Permission denied: agents may delete only their own short-term notes. Called by: " + (caller || "unknown") });
          }
          const filePath = noteFilePath(parsed.session, parsed.agent, Number(parsed.num));
          if (!filePath || !existsSync(filePath)) {
            return JSON.stringify({ error: "Short-term note not found: " + id });
          }
          try {
            unlinkSync(filePath);
            debug(`memory_note_delete: deleted ${filePath}`);
            return JSON.stringify({ message: "Short-term note deleted", id });
          } catch (e) {
            debug(`memory_note_delete: delete failed — ${e.message}`);
            return JSON.stringify({ error: `Failed to delete short-term note: ${e.message}` });
          }
        }
      })
    };

    // --- Hook: chat.params ---
    // Track which agent is running in each session for memory_search routing.
    async function chatParams(input, output) {
      const { sessionID, agent } = input;
      if (agent) {
        sessionAgentMap.set(sessionID, agent.toLowerCase());
      }
    }

    // --- Hook: tool.definition ---
    // Re-assert the memory tool descriptions on every LLM call. The tools are
    // registered via the tool hook (memoryTools above); this hook keeps the
    // LLM-facing description stable across tool.definition passes.
    async function toolDefinition(input, output) {
      const { toolID } = input;

      if (toolID === "memory_search") {
        output.description = "Search knowledge/memory/ for prior session insights. Args: tags (string array), topic (string), limit (integer, default 5). Returns JSON array of matching entries.";
        debug(`toolDefinition: provided description for memory_search`);
      }

      if (toolID === "memory_write") {
        output.description = "Write a validated memory entry to knowledge/memory/. Args: entry (object with fields: id (optional), source_kd, tags, topic, insight, type, created, session, version). Validates schema, checks tags against controlled vocabulary, deduplicates, auto-assigns ID, and writes to disk. Only Scribe agent has permission to write.";
        debug(`toolDefinition: provided description for memory_write`);
      }

      if (toolID === "memory_note") {
        output.description = "Write a short-term memory note to knowledge/short-term/{session}/{agent}/. Every agent may write into its own namespace for the current session; the note is session-scoped scratch state. At 100 notes per agent per session the oldest note is evicted. Args: topic (string ≤100 chars), content (string ≤2000 chars), tags (optional, 0-5 strings). Returns { message, id } or { error }.";
        debug(`toolDefinition: provided description for memory_note`);
      }

      if (toolID === "memory_note_read") {
        output.description = "Read short-term memory notes from knowledge/short-term/. Args: id (string ST-...) to read one note; agent and/or session (strings) to read a namespace (Scribe only — the promotion path). Agents may read only their own notes; Scribe may read any agent's notes. Returns the note object, an array of note objects, or { error }.";
        debug(`toolDefinition: provided description for memory_note_read`);
      }

      if (toolID === "memory_notes_list") {
        output.description = "List short-term memory notes in knowledge/short-term/. Returns a summary array [{ id, agent, created, topic }]. Non-Scribe agents see only their own notes in the current session; Scribe sees any agent's notes — or all agents' notes in a session when no agent is given.";
        debug(`toolDefinition: provided description for memory_notes_list`);
      }

      if (toolID === "memory_note_delete") {
        output.description = "Delete a short-term memory note from knowledge/short-term/. Args: id (string ST-...). The owner may delete own notes; Scribe may delete any agent's notes. Removes note-{NNN}.json permanently — the short-term store is session-scoped scratch state.";
        debug(`toolDefinition: provided description for memory_note_delete`);
      }
    }

    // --- Hook: experimental.chat.system.transform ---
    // Dynamic memory hint injection using the Library Model (hint + pull).
    // Derives search tags from agent type, searches memory, and appends
    // compact hint lines when relevant entries exist.
    // Mechanical agent types (committer) get zero hint overhead.
    async function systemTransform(input, output) {
      const sessionID = input.sessionID;
      const agent = sessionAgentMap.get(sessionID) || input.agent?.toLowerCase();

      // All agents get memory_search read access to query prior session insights
      output.system.push(
        `[Knowledge Gate] You have access to the memory_search tool. ` +
        `Call it with tags (array), topic (string), or limit (integer) to query ` +
        `prior session insights from knowledge/memory/.`
      );

      // Dynamic memory hint: derive from agent context and append if relevant
      // At systemTransform time, mode/scope are not available (they come at dispatch),
      // so we use agent-type-only tags per PF-001
      const hintContext = { mode: "", agentType: agent, phase: "", scope: "" };
      const { hints } = deriveSearchHints(hintContext);
      for (const hint of hints) {
        output.system.push(`[Knowledge Gate] ${hint}`);
      }

      // Scribe additionally gets write instructions via memory_write tool
      if (agent === "scribe") {
        output.system.push(
          `[Knowledge Gate] After composing a COMPOSED KD, write distilled insights ` +
          `via the memory_write tool. The tool validates schema, checks tags against ` +
          `controlled vocabulary, deduplicates, auto-assigns sequential ID, and writes to disk.`
        );
      }

      // During EVOLVE phase, inject issue tracking instructions for habit-builder:
      // creation (step 5 "Track Issues") and closing (step 6 "Close Issues").
      if (agent === "habit-builder") {
        output.system.push(
          `[Knowledge Gate] When process friction requires tracking, create issue files directly. ` +
          `Write to knowledge/issues/issue-{id}.md with YAML frontmatter: id, title, severity, status, created, session, assigned_to, tags. ` +
          `Include body sections: Description, Source KD Reference, Recommended Fix, Acceptance Criteria. ` +
          `Use the next sequential issue ID from existing files in knowledge/issues/.`
        );

        // Surface open issues so the habit-builder can close ones whose fix is
        // already demonstrated in lifecycle KDs — mirrors the INTENT loop below.
        const openIssues = scanOpenIssues();
        if (openIssues.length > 0) {
          const issueSummary = openIssues.map(i =>
            `- [${i.id}] (${i.severity}) ${i.title} — assigned to ${i.assigned_to || "unassigned"}`
          ).join("\n");
          output.system.push(
            `[Knowledge Gate] Open issues detected:\n${issueSummary}\n` +
            `Apply the Close Issues step (agents/habit-builder.md step 6): for each open issue ` +
            `whose Recommended Fix is verified addressed in lifecycle KDs (impl/review/audit/composed) ` +
            `— no heavy investigation needed — flip status to resolved and append a ` +
            `## Resolution (YYYY-MM-DD) section referencing the closing evidence. ` +
            `Closing without evidence is prohibited; keep the issue schema intact.`
          );
          debug(`EVOLVE: surfaced ${openIssues.length} open issues to habit-builder`);
        }
      }

      // On every Overseer systemTransform (not phase-gated), scan for open issues from
      // prior sessions and surface them in Triage Notes. The guard is agent === "overseer"
      // only — injection is intentionally NOT phase-gated, so issues stay visible across
      // the whole lifecycle. This closes the issue tracking feedback loop.
      // The injected set is bounded (KNOWLEDGE_GATE_MAX_OPEN_ISSUES cap,
      // default 10) and optionally routed (KNOWLEDGE_GATE_ISSUE_AUDIENCE filter);
      // the filter runs BEFORE the cap so the cap measures the audience-matched set.
      // The habit-builder EVOLVE branch above stays unfiltered and uncapped.
      if (agent === "overseer") {
        let openIssues = filterByAudience(scanOpenIssues(), process.env.KNOWLEDGE_GATE_ISSUE_AUDIENCE);
        openIssues = applyCap(openIssues, envOpenIssueCap());
        if (openIssues.length > 0) {
          const issueSummary = openIssues.map(i =>
            `- [${i.id}] (${i.severity}) ${i.title} — assigned to ${i.assigned_to || "unassigned"}`
          ).join("\n");
          // The machine-checkable marker line starts the injected block.
          // {count} equals the number of lines actually injected (post
          // audience-filter/cap) so an INTENT KD transcription can be verified
          // against the issue registry.
          output.system.push(
            `[Knowledge Gate] Open issues from prior sessions detected:\n` +
            `<!-- issues-snapshot v1: ${openIssues.length} open, stable order -->\n${issueSummary}\n` +
            `Include these in the Triage Notes section of your intent KD. ` +
            `Reference the issue IDs and recommend which ones to address in this session.`
          );
          debug(`INTENT: surfaced ${openIssues.length} open issues to Overseer`);
        }
      }
    }

    return {
      "chat.params": chatParams,
      "tool.definition": toolDefinition,
      "experimental.chat.system.transform": systemTransform,
      // Registered custom tools — exposed to the agent's callable tool list
      tool: memoryTools,
      // Test-accessible internals
      searchMemory,
      scanHighSeverityIssues,
      scanOpenIssues,
      parseIssueFile,
      getNextIssueId,
      getNextMemoryId,
      validateMemoryEntry,
      formatMemoryEntry,
      deriveSearchHints,
      generateHintLines,
      checkDuplicateMemory,
      MEMORY_DIR,
      ISSUES_DIR
    };
  }
};


