// plugins/dispatch-gate/index.js
// Intercepts `task` tool calls via tool.execute.before hook.
// For structured dispatches (mode + intent_kd): generates prompt via template engine,
// validates the generated prompt, routes to target agent via SDK, logs to audit.
// For legacy Overseer dispatches ("DISPATCH TO:"): rejects with migration message.
// For non-Overseer calls: passes through unconditionally.

import fs from "fs";
import path from "path";
import { fillTemplate } from "./template-engine.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// --- Structured dispatch detection ---

/**
 * Detect whether the task call is a structured dispatch.
 * Structured dispatches pass an object with `mode` and `intent_kd` fields.
 */
function isStructuredDispatch(args) {
  if (typeof args !== "object" || args === null) return false;
  return !!(args.mode && args.intent_kd);
}

// --- Legacy format detection ---

/**
 * Detect whether the prompt is a legacy Overseer-format dispatch.
 * Checks if the prompt begins with "DISPATCH TO:" as its first significant content.
 */
function isLegacyOverseerFormat(prompt) {
  if (!prompt) return false;
  return /^DISPATCH TO:/i.test(String(prompt).trimStart());
}

// --- Structural format validation (same as before) ---

/**
 * Extract the DISPATCH TO agent from a dispatch prompt.
 */
function extractTargetAgent(prompt) {
  if (!prompt) return null;
  const match = prompt.match(/DISPATCH TO:[ \t]+(\S+)/i);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Extract KD path references from a dispatch prompt (lines with `- knowledge/...`).
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
 * Validate that an Overseer dispatch contains all required structural fields.
 */
function validateStructuralFields(prompt) {
  if (!/^DISPATCH TO:[ \t]+\S+/m.test(prompt)) {
    throw new Error(
      "DISPATCH REJECTED: MISSING_DISPATCH_TO — The required field 'DISPATCH TO:' was not found or has no value"
    );
  }
  if (!/^ACTION:[ \t]+\S+/m.test(prompt)) {
    throw new Error(
      "DISPATCH REJECTED: MISSING_ACTION — The required field 'ACTION:' was not found or has no value"
    );
  }
  if (!/^ARTIFACT:[ \t]+\S+/m.test(prompt)) {
    throw new Error(
      "DISPATCH REJECTED: MISSING_ARTIFACT — The required field 'ARTIFACT:' was not found or has no value"
    );
  }
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

// ---------------------------------------------------------------------------
// Audit logging
// ---------------------------------------------------------------------------

/**
 * Append an audit entry to the knowledge/audit-dispatch-engine-*.md file.
 * Creates the file if it does not exist.
 */
function logAuditEntry(workspaceRoot, entry) {
  const auditDir = path.join(workspaceRoot, "knowledge");
  const today = new Date().toISOString().slice(0, 10);
  const auditPath = path.join(auditDir, `audit-dispatch-engine-${today}.md`);

  try {
    if (!fs.existsSync(auditDir)) {
      fs.mkdirSync(auditDir, { recursive: true });
    }

    const timestamp = new Date().toISOString();
    const line = `- **${timestamp}** — ${entry.mode} → ${entry.target_agent}: ${entry.status}${entry.error ? " — " + entry.error : ""}`;

    let existing = "";
    if (fs.existsSync(auditPath)) {
      existing = fs.readFileSync(auditPath, "utf-8");
    }

    // If no header exists yet, add one
    if (!existing.startsWith("# AUDIT:")) {
      existing = `# AUDIT: Dispatch Engine — ${today}\n\n`;
    }

    fs.writeFileSync(auditPath, existing + line + "\n", "utf-8");
  } catch (err) {
    console.warn("[dispatch-gate] Failed to write audit log: " + err.message);
  }
}

// ---------------------------------------------------------------------------
// Structured dispatch handler
// ---------------------------------------------------------------------------

/**
 * Handle a structured dispatch call: generate prompt, validate, route via SDK.
 *
 * @param {object} args — The structured dispatch args ({ mode, intent_kd, session_date?, scope? })
 * @param {object} ctx — The hook context ({ tool, sessionID, callID })
 * @param {object} input — The PluginInput object
 * @param {string} workspaceRoot — Workspace root directory
 * @param {string[]} knownAgents — List of known agent names
 * @returns {Promise<object>} — The routing result
 */
async function handleStructuredDispatch(args, ctx, input, workspaceRoot, knownAgents) {
  const { mode, intent_kd, session_date, scope } = args;

  // Step 1: Generate dispatch prompt from template engine
  let result;
  try {
    result = fillTemplate(mode, intent_kd, {
      session_date,
      scope,
      workspaceRoot,
    });
  } catch (err) {
    logAuditEntry(workspaceRoot, {
      mode,
      target_agent: "unknown",
      status: "rejected",
      error: err.message,
    });
    throw err;
  }

  // Step 2: Validate the generated prompt as a safety check
  try {
    validateStructuralFields(result.prompt);
    const kdViolations = validateKDReferences(result.prompt);
    if (kdViolations.length > 0) {
      throw new Error("DISPATCH REJECTED: INVALID_KD_PATH — " + kdViolations.join("; "));
    }
  } catch (err) {
    logAuditEntry(workspaceRoot, {
      mode,
      target_agent: result.target_agent,
      status: "validation_failed",
      error: err.message,
    });
    throw err;
  }

  // Step 3: Validate target agent
  if (!knownAgents.includes(result.target_agent)) {
    const errMsg = `DISPATCH REJECTED: UNKNOWN_AGENT — "${result.target_agent}" is not a registered agent`;
    logAuditEntry(workspaceRoot, {
      mode,
      target_agent: result.target_agent,
      status: "rejected",
      error: errMsg,
    });
    throw new Error(errMsg);
  }

  // Step 4: Self-execute mode (report) — return template data, no agent dispatch
  if (result.self_execute) {
    logAuditEntry(workspaceRoot, {
      mode,
      target_agent: result.target_agent,
      status: "self_execute",
      error: null,
    });
    return {
      status: "self_execute",
      mode,
      prompt: result.prompt,
      dispatch_fields: result.dispatch_fields,
    };
  }

  // Step 5: Route to target agent via SDK
  try {
    // Create a child session with the target agent
    const childSession = await input.client.session.create({
      parentID: ctx.sessionID,
      title: `${mode}: ${intent_kd}`,
    });

    // Send the generated dispatch prompt to the child session
    const promptResult = await input.client.session.prompt({
      id: childSession.id,
      agent: result.target_agent,
      noReply: true,
      parts: [
        {
          type: "text",
          text: result.prompt,
        },
      ],
    });

    logAuditEntry(workspaceRoot, {
      mode,
      target_agent: result.target_agent,
      status: "dispatched",
      error: null,
    });

    return {
      status: "dispatched",
      session_id: childSession.id,
      target_agent: result.target_agent,
      mode,
    };
  } catch (err) {
    logAuditEntry(workspaceRoot, {
      mode,
      target_agent: result.target_agent,
      status: "routing_failed",
      error: err.message,
    });

    // Fallback: return the generated prompt for manual forwarding
    console.warn("[dispatch-gate] SDK routing failed, returning generated prompt as fallback: " + err.message);
    return {
      status: "routing_failed",
      fallback: true,
      mode,
      prompt: result.prompt,
      target_agent: result.target_agent,
      dispatch_fields: result.dispatch_fields,
      error: err.message,
    };
  }
}

// ---------------------------------------------------------------------------
// Plugin entry point
// ---------------------------------------------------------------------------

/**
 * Plugin entry point — called by opencode on load.
 */
export default async function dispatchGatePlugin(input) {
  const workspaceRoot = input.directory || process.cwd();
  const KNOWN_AGENTS = discoverAgents(workspaceRoot);

  return {
    /**
     * Intercepts all tool executions before they run.
     * Only intercepts `task` tool calls for dispatch validation/generation.
     */
    "tool.execute.before": async (ctx, output) => {
      if (ctx.tool !== "task") return;

      const args = output.args;
      const prompt = typeof args === "string" ? args : (args.prompt || "");

      // --- Detection order ---

      // 1. Structured dispatch check (mode + intent_kd in args object)
      if (isStructuredDispatch(args)) {
        try {
          const result = await handleStructuredDispatch(args, ctx, input, workspaceRoot, KNOWN_AGENTS);
          // Modify the output args to signal completion
          // The plugin can't easily abort the original task call, so we
          // set the prompt to indicate routing was handled
          output.args = {
            prompt: "[Dispatched via template engine]",
            subagent_type: args.subagent_type || args.mode,
            _dispatch_result: result,
          };
          return;
        } catch (err) {
          throw err;
        }
      }

      // 2. Legacy Overseer format check (starts with "DISPATCH TO:")
      if (isLegacyOverseerFormat(prompt)) {
        throw new Error(
          "DISPATCH REJECTED: LEGACY_FORMAT — Use structured dispatch format instead. " +
          "Call task with { mode, intent_kd, session_date } parameters. " +
          "See templates.json for available modes and their configurations."
        );
      }

      // 3. Non-Overseer / non-dispatch — pass through unconditionally
      return;
    }
  };
}
