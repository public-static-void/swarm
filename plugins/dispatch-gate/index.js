// plugins/dispatch-gate/index.js
// Intercepts `task` tool calls via tool.execute.before hook.
// Validates dispatches against structural rules before they reach the target agent.
// Blocks: file paths, inline code, file extensions, read verbs, non-KD paths, unknown agents.

const KNOWN_AGENTS = [
  "explorer", "spec-weaver", "pathfinder", "analyzer",
  "artisan", "committer", "inspector", "scribe", "habit-builder"
];

const KD_PATH_PATTERN = /^knowledge\/[a-z]+-[a-z0-9-]+-\d{4}-\d{2}-\d{2}\.md$/;

// Patterns for detecting source file paths in dispatch content
const FILE_PATH_PATTERNS = [
  /\/home\//, /\.\//, /\bsrc\//, /^refs\//, /^\/[a-zA-Z]/
];

const FILE_EXTENSIONS = /\.(py|ts|rs|md|json|yaml|yml|toml|cfg|ini|sh|js|jsx|tsx|css|scss|html|sql|go|rb|java|kt|swift|c|cpp|h|hpp)$/;

const READ_VERBS = /\b(read|return contents|list files|get the file|cat |view file)\b/i;

/**
 * Scan value for markdown code fences or inline backtick code.
 */
function scanForInlineCode(value) {
  if (!value) return null;
  const str = String(value);
  if (/```/.test(str)) return "triple-backtick code block detected";
  if (/`[^`\n]+`/.test(str)) return "inline backtick code detected";
  return null;
}

/**
 * Scan value for source file path patterns (/home/, ./, src/, etc.).
 */
function scanForFilePaths(value) {
  if (!value) return null;
  const str = String(value);
  for (const pattern of FILE_PATH_PATTERNS) {
    if (pattern.test(str)) {
      return `source file path pattern '${pattern.source}' detected`;
    }
  }
  return null;
}

/**
 * Scan value for file extensions (.py, .ts, .rs, etc.).
 */
function scanForFileExtension(value) {
  if (!value) return null;
  const match = FILE_EXTENSIONS.exec(String(value));
  if (match) return `file extension '${match[0]}' detected`;
  return null;
}

/**
 * Scan value for read/return-contents verbs.
 */
function scanForReadVerbs(value) {
  if (!value) return null;
  const match = READ_VERBS.exec(String(value));
  if (match) return `read verb '${match[0]}' detected`;
  return null;
}

/**
 * Extract KD path references from a dispatch prompt (lines with `- knowledge/...`).
 * Validates each against the KD path pattern.
 */
function validateKDReferences(prompt) {
  if (!prompt) return [];
  const violations = [];
  const kdLines = prompt.match(/^\s*-\s*(knowledge\/\S+\.md)\s*$/gm);
  if (!kdLines) return violations;
  for (const line of kdLines) {
    const path = line.replace(/^\s*-\s*/, "").trim();
    if (!KD_PATH_PATTERN.test(path)) {
      violations.push(`'${path}' does not match knowledge/{type}-{name}-{date}.md pattern`);
    }
  }
  return violations;
}

/**
 * Extract the DISPATCH TO agent from a dispatch prompt.
 */
function extractTargetAgent(prompt) {
  if (!prompt) return null;
  const match = prompt.match(/DISPATCH TO:\s*(\S+)/i);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Validate a task tool call against all dispatch gate rules.
 * Throws on first violation with a descriptive error message.
 */
function validateTaskCall(args) {
  // Extract text content to scan — args can be an object with prompt/description or a raw string
  const prompt = typeof args === "string" ? args : (args.prompt || "");
  const description = typeof args === "string" ? "" : (args.description || "");
  const combinedText = prompt + " " + description;

  // 1. Inline code check
  const codeViolation = scanForInlineCode(combinedText);
  if (codeViolation) {
    throw new Error("DISPATCH REJECTED: INLINE_CODE_DETECTED — " + codeViolation);
  }

  // 2. File path check
  const pathViolation = scanForFilePaths(combinedText);
  if (pathViolation) {
    throw new Error("DISPATCH REJECTED: FILE_PATH_DETECTED — " + pathViolation);
  }

  // 3. File extension check in prompt
  const extViolation = scanForFileExtension(combinedText);
  if (extViolation) {
    throw new Error("DISPATCH REJECTED: FILE_EXTENSION_DETECTED — " + extViolation);
  }

  // 4. Read verb check
  const readViolation = scanForReadVerbs(combinedText);
  if (readViolation) {
    throw new Error("DISPATCH REJECTED: READ_VERB_DETECTED — " + readViolation);
  }

  // 5. KD path validation — only check if the prompt contains KDS section
  const kdViolations = validateKDReferences(prompt);
  if (kdViolations.length > 0) {
    throw new Error("DISPATCH REJECTED: INVALID_KD_PATH — " + kdViolations.join("; "));
  }

  // 6. Target agent validation (from DISPATCH TO: line in prompt)
  const targetAgent = extractTargetAgent(prompt);
  if (targetAgent && !KNOWN_AGENTS.includes(targetAgent)) {
    throw new Error("DISPATCH REJECTED: UNKNOWN_AGENT — \"" + targetAgent + "\" is not a registered agent");
  }

  // 7. subagent_type validation (task tool param)
  if (typeof args === "object" && args && args.subagent_type) {
    const agent = args.subagent_type.toLowerCase();
    if (!KNOWN_AGENTS.includes(agent)) {
      throw new Error("DISPATCH REJECTED: UNKNOWN_AGENT — \"" + agent + "\" is not a registered agent");
    }
  }
}

/**
 * Plugin entry point — called by opencode on load.
 * Receives PluginInput with { client, project, directory, worktree, serverUrl, $ }.
 * Returns Hooks object with tool.execute.before interceptor.
 */
export default async function dispatchGatePlugin(input) {
  return {
    /**
     * Intercepts all tool executions before they run.
     * Only intercepts `task` tool calls for dispatch validation.
     *
     * ctx: { tool, sessionID, callID }
     * output: { args } — the tool call parameters
     *
     * To ALLOW: return without modifying output
     * To BLOCK: throw an Error (caught by opencode, surfaced to caller)
     */
    "tool.execute.before": async (ctx, output) => {
      if (ctx.tool !== "task") return;

      try {
        validateTaskCall(output.args);
      } catch (err) {
        // Re-throw to block the tool call.
        // opencode surfaces this error to the tool caller (LLM).
        throw err;
      }
    }
  };
}
