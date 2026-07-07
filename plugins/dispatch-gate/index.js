// plugins/dispatch-gate/index.js
// Intercepts `task` tool calls via tool.execute.before hook.
// Validates Overseer dispatches against structural template rules.
// Non-Overseer dispatches pass through unconditionally.
// No pattern-based rejection — only structural format checks.

import fs from "fs";
import path from "path";

/**
 * Discover agent names from the agents/ directory at the workspace root.
 * Strips .md extension to derive agent names.
 * Returns an empty array and logs a warning if directory is missing or unreadable.
 */
function discoverAgents(workspaceRoot) {
  const agentsDir = path.join(workspaceRoot, "agents");
  try {
    if (!fs.existsSync(agentsDir)) {
      console.warn("[dispatch-gate] Agents directory not found at " + agentsDir + ". Using empty agent list.");
      return [];
    }
    const files = fs.readdirSync(agentsDir);
    return files
      .filter(function (f) { return f.endsWith(".md"); })
      .map(function (f) { return f.slice(0, -3).toLowerCase(); });
  } catch (err) {
    console.warn("[dispatch-gate] Failed to read agents directory: " + err.message + ". Using empty agent list.");
    return [];
  }
}

const KD_PATH_PATTERN = /^knowledge\/[a-z]+-[a-z0-9-]+-\d{4}-\d{2}-\d{2}\.md$/;

// --- Structural format validation ---

/**
 * Extract the DISPATCH TO agent from a dispatch prompt.
 * Requires at least one horizontal space between colon and value for a valid match.
 */
function extractTargetAgent(prompt) {
  if (!prompt) return null;
  const match = prompt.match(/DISPATCH TO:[ \t]+(\S+)/i);
  return match ? match[1].toLowerCase() : null;
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
    const filePath = line.replace(/^\s*-\s*/, "").trim();
    if (!KD_PATH_PATTERN.test(filePath)) {
      violations.push(`'${filePath}' does not match knowledge/{type}-{name}-{date}.md pattern`);
    }
  }
  return violations;
}

/**
 * Detect whether the prompt is an Overseer-format dispatch.
 * Checks if the prompt begins with "DISPATCH TO:" as its first significant content.
 */
function isOverseerFormat(prompt) {
  if (!prompt) return false;
  return /^DISPATCH TO:/i.test(String(prompt).trimStart());
}

/**
 * Validate that an Overseer dispatch contains all required structural fields.
 * Throws on the first missing field with a descriptive rejection code.
 * Uses /m flag and horizontal whitespace to ensure values are on the same line,
 * preventing cross-line false matches (e.g., ACTION: with no value should not
 * consume the next field name).
 */
function validateStructuralFields(prompt) {
  // DISPATCH TO: must be present with a value on the same line
  if (!/^DISPATCH TO:[ \t]+\S+/m.test(prompt)) {
    throw new Error(
      "DISPATCH REJECTED: MISSING_DISPATCH_TO — The required field 'DISPATCH TO:' was not found or has no value"
    );
  }

  // ACTION: must be present with a value on the same line
  if (!/^ACTION:[ \t]+\S+/m.test(prompt)) {
    throw new Error(
      "DISPATCH REJECTED: MISSING_ACTION — The required field 'ACTION:' was not found or has no value"
    );
  }

  // ARTIFACT: must be present with a value on the same line
  if (!/^ARTIFACT:[ \t]+\S+/m.test(prompt)) {
    throw new Error(
      "DISPATCH REJECTED: MISSING_ARTIFACT — The required field 'ARTIFACT:' was not found or has no value"
    );
  }

  // One of DOMAIN:, SCOPE:, or MODE: must be present with a value on the same line
  const hasDomainOrScopeOrMode = (
    /^DOMAIN:[ \t]+\S+/m.test(prompt) ||
    /^SCOPE:[ \t]+\S+/m.test(prompt) ||
    /^MODE:[ \t]+\S+/m.test(prompt)
  );
  if (!hasDomainOrScopeOrMode) {
    throw new Error(
      "DISPATCH REJECTED: MISSING_DOMAIN_OR_SCOPE_OR_MODE — One of 'DOMAIN:', 'SCOPE:', or 'MODE:' must be present with a value"
    );
  }
}

/**
 * Plugin entry point — called by opencode on load.
 * Receives PluginInput with { client, project, directory, worktree, serverUrl, $ }.
 * Discovers agent names from the agents/ directory at the workspace root.
 * Returns Hooks object with tool.execute.before interceptor.
 */
export default async function dispatchGatePlugin(input) {
  const workspaceRoot = input.directory || process.cwd();
  const KNOWN_AGENTS = discoverAgents(workspaceRoot);

  /**
   * Validate a task tool call against dispatch gate rules.
   *
   * For Overseer dispatches (prompt starts with "DISPATCH TO:"):
   *   Validates all required structural fields are present.
   *   Also validates KD path references and target agent.
   *
   * For non-Overseer dispatches:
   *   Passes through unconditionally without validation.
   */
  function validateTaskCall(args) {
    const prompt = typeof args === "string" ? args : (args.prompt || "");

    // Detect if this is an Overseer-format dispatch
    if (!isOverseerFormat(prompt)) {
      // Non-Overseer dispatch — allow unconditionally
      return;
    }

    // Overseer dispatch — validate structural fields
    validateStructuralFields(prompt);

    // KD path format validation
    const kdViolations = validateKDReferences(prompt);
    if (kdViolations.length > 0) {
      throw new Error("DISPATCH REJECTED: INVALID_KD_PATH — " + kdViolations.join("; "));
    }

    // Target agent validation
    const targetAgent = extractTargetAgent(prompt);
    if (targetAgent && !KNOWN_AGENTS.includes(targetAgent)) {
      throw new Error(
        'DISPATCH REJECTED: UNKNOWN_AGENT — "' + targetAgent + '" is not a registered agent'
      );
    }

    // subagent_type validation
    if (typeof args === "object" && args && args.subagent_type) {
      const agent = args.subagent_type.toLowerCase();
      if (!KNOWN_AGENTS.includes(agent)) {
        throw new Error(
          'DISPATCH REJECTED: UNKNOWN_AGENT — "' + agent + '" is not a registered agent'
        );
      }
    }
  }

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
