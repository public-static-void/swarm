// Knowledge-Gate Plugin — persistent memory search + issue tracking
//
// Hooks: chat.params, tool.execute.before, tool.definition,
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
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";

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
  mode: ["explore", "investigate", "align", "decompose", "swarm", "verify", "extract", "evolve"],
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
  verify: ["review", "audit", "quality"],
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
 *   created (ISO 8601 with time), session (string), version ("1.0.0")
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
 */
function parseIssueFile(content, filename) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const frontmatter = match[1];
  const result = { filename };

  for (const line of frontmatter.split("\n")) {
    const kv = line.match(/^(\w+):\s*"?([^"]*)"?\s*$/);
    if (kv) {
      result[kv[1]] = kv[2];
    }
    // Handle array values like tags: [auth, permission]
    const arrMatch = line.match(/^(\w+):\s*\[(.*)\]\s*$/);
    if (arrMatch) {
      result[arrMatch[1]] = arrMatch[2].split(",").map(s => s.trim());
    }
  }

  return result;
}

/**
 * Scans knowledge/issues/ for ALL open issues (any severity).
 * Used during INTENT phase to surface prior-session issues to the Overseer.
 */
function scanOpenIssues() {
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
  return openIssues;
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
        if (score >= threshold) {
          return r;
        }
      }

      return null;
    }

    debug("Knowledge Gate loaded");

    // --- Hook: chat.params ---
    // Track which agent is running in each session for memory_search routing.
    async function chatParams(input, output) {
      const { sessionID, agent } = input;
      if (agent) {
        sessionAgentMap.set(sessionID, agent.toLowerCase());
      }
    }

    // --- Hook: tool.execute.before ---
    // Intercept memory_search calls and handle them directly.
    async function toolExecuteBefore(input, output) {
      const { tool, sessionID } = input;

      if (tool === "memory_search") {
        const args = output.args || {};
        const query = {
          tags: args.tags || [],
          topic: args.topic || "",
          limit: args.limit || 5
        };

        debug(`memory_search: query=${JSON.stringify(query)} session=${sessionID}`);
        const results = searchMemory(query);
        debug(`memory_search: found ${results.length} results`);

        // Return results via the output — the agent receives this as tool output
        output.result = JSON.stringify(results, null, 2);
        // Prevent actual tool execution by marking as handled
        output.handled = true;
      }

      if (tool === "memory_write") {
        const args = output.args || {};
        const entry = args.entry || args;
        const agent = sessionAgentMap.get(sessionID)?.toLowerCase();

        // Permission check: only Scribe can write memory entries
        if (agent !== "scribe") {
          output.result = JSON.stringify({ error: "Only Scribe agent has permission to write memory entries. Called by: " + (agent || "unknown") });
          output.handled = true;
          debug(`memory_write: rejected — called by non-Scribe agent "${agent}"`);
          return;
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
          output.result = JSON.stringify({ error: validation.error });
          output.handled = true;
          debug(`memory_write: validation failed — ${validation.error}`);
          return;
        }

        // Validate tags against controlled vocabulary (warn on unknown, still accept)
        const unknownTags = (entry.tags || []).filter(t => !ALL_VALID_TAGS.has(t));
        if (unknownTags.length > 0) {
          debug(`memory_write: unknown tags detected: ${unknownTags.join(", ")} — accepted with warning`);
        }

        // Check for duplicates (search memory excluding this entry's own ID if already known)
        const duplicate = checkDuplicateMemory(entry);
        if (duplicate && duplicate.id !== entry.id) {
          output.result = JSON.stringify({ message: "Duplicate entry detected, skipped", existing: duplicate.id });
          output.handled = true;
          debug(`memory_write: duplicate detected — existing=${duplicate.id}, skipped`);
          return;
        }

        // Write entry to disk
        const entryId = entry.id.replace("MEM-", "");
        const filePath = join(MEMORY_DIR, `entry-${entryId}.json`);
        try {
          writeFileSync(filePath, JSON.stringify(entry, null, 2), "utf8");
          // Invalidate cache so next search picks up the new entry
          memoryCache.entries = null;
          memoryCache.lastLoaded = null;
          output.result = JSON.stringify({ message: "Memory entry written", id: entry.id });
          output.handled = true;
          debug(`memory_write: written ${filePath}`);
        } catch (e) {
          output.result = JSON.stringify({ error: `Failed to write memory entry: ${e.message}` });
          output.handled = true;
          debug(`memory_write: write failed — ${e.message}`);
        }
        return;
      }

      // After EVOLVE phase (habit-builder), scan for high-severity issues.
      // Detect by checking if a process-*.md KD was just written (EVOLVE output).
      // This runs on every tool call — cheap check against disk.
      if (tool === "task") {
        const agent = sessionAgentMap.get(sessionID);
        if (agent === "habit-builder") {
          const highSeverity = scanHighSeverityIssues();
          if (highSeverity.length > 0) {
            debug(`EVOLVE: found ${highSeverity.length} high-severity open issues`);
            // Store issues on the output so downstream hooks can reference them
            output._knowledgeGateIssues = highSeverity;
          }
        }
      }
    }

    // --- Hook: tool.definition ---
    // Register memory_search tool so the LLM sees it in its available tools list.
    // Without this, agents receive the system prompt instruction but cannot generate
    // a tool call to an unknown tool name.
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

      // During EVOLVE phase, inject issue creation instructions for habit-builder
      if (agent === "habit-builder") {
        output.system.push(
          `[Knowledge Gate] When process friction requires tracking, create issue files directly. ` +
          `Write to knowledge/issues/issue-{id}.md with YAML frontmatter: id, title, severity, status, created, session, assigned_to, tags. ` +
          `Include body sections: Description, Source KD Reference, Recommended Fix, Acceptance Criteria. ` +
          `Use the next sequential issue ID from existing files in knowledge/issues/.`
        );
      }

      // During INTENT phase (Overseer), scan for open issues from prior sessions
      // and surface them in Triage Notes. This closes the issue tracking feedback loop.
      if (agent === "overseer") {
        const openIssues = scanOpenIssues();
        if (openIssues.length > 0) {
          const issueSummary = openIssues.map(i =>
            `- [${i.id}] (${i.severity}) ${i.title} — assigned to ${i.assigned_to || "unassigned"}`
          ).join("\n");
          output.system.push(
            `[Knowledge Gate] Open issues from prior sessions detected:\n${issueSummary}\n` +
            `Include these in the Triage Notes section of your intent KD. ` +
            `Reference the issue IDs and recommend which ones to address in this session.`
          );
          debug(`INTENT: surfaced ${openIssues.length} open issues to Overseer`);
        }
      }
    }

    return {
      "chat.params": chatParams,
      "tool.execute.before": toolExecuteBefore,
      "tool.definition": toolDefinition,
      "experimental.chat.system.transform": systemTransform,
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


