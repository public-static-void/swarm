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
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const PLUGIN_DIR = dirname(__filename);
const PROJECT_ROOT = join(PLUGIN_DIR, "..", "..");

const MEMORY_DIR = join(PROJECT_ROOT, "knowledge", "memory");
const ISSUES_DIR = join(PROJECT_ROOT, "knowledge", "issues");

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

// --- Memory search ---

/**
 * Scans knowledge/memory/ for JSON entries matching query parameters.
 * Returns entries sorted by tag-match count (descending), then recency.
 */
function searchMemory(query) {
  const { tags = [], topic = "", limit = 5 } = query;

  if (!existsSync(MEMORY_DIR)) {
    debug("searchMemory: memory dir does not exist");
    return [];
  }

  let files;
  try {
    files = readdirSync(MEMORY_DIR).filter(f => f.endsWith(".json"));
  } catch (e) {
    debug(`searchMemory: failed to read memory dir: ${e.message}`);
    return [];
  }

  const entries = [];
  for (const file of files) {
    try {
      const raw = readFileSync(join(MEMORY_DIR, file), "utf8");
      const entry = JSON.parse(raw);
      entries.push(entry);
    } catch (e) {
      debug(`searchMemory: skipping malformed ${file}: ${e.message}`);
    }
  }

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

// --- Issue scanning ---

/**
 * Scans knowledge/issues/ for open, high-severity issues.
 * Returns array of parsed issue objects.
 */
function scanHighSeverityIssues() {
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
    }

    // --- Hook: experimental.chat.system.transform ---
    // Inject memory_search availability into system prompts for agents that have
    // read permission on knowledge/memory/.
    async function systemTransform(input, output) {
      const sessionID = input.sessionID;
      const agent = sessionAgentMap.get(sessionID);

      // Scribe and agents with memory access get the memory_search instruction
      if (agent === "scribe") {
        output.system.push(
          `[Knowledge Gate] You have access to the memory_search tool. ` +
          `Use it to query prior session insights before composing new COMPOSED KDs. ` +
          `Call memory_search with tags (array), topic (string), or limit (integer). ` +
          `After composing a COMPOSED KD, write distilled insights to knowledge/memory/ as JSON files. ` +
          `Each file: entry-{sequential-id}.json with fields: id, source_kd, tags, topic, insight, created, session, version.`
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
      MEMORY_DIR,
      ISSUES_DIR
    };
  }
};
