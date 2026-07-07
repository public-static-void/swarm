// plugins/dispatch-gate/index.js
// Intercepts `task` tool calls via tool.execute.before hook.
// Generates dispatch prompts from templates using structured fields:
//   mode, intent_kd, session_date, scope (optional)
// Same handler for ALL callers — no Overseer/Artisan distinction.
// Rejects free-text prompts with positive guidance about the required fields.

import { resolveTemplate } from "./template-engine.js";
import templates from "./templates.json" with { type: "json" };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check if args contain structured dispatch fields.
 * Structured calls have: mode, intent_kd, session_date
 */
function isStructuredDispatch(args) {
  if (!args || typeof args !== "object") return false;
  return !!(args.mode && args.intent_kd && args.session_date);
}

/**
 * Extract structured fields from task args.
 */
function extractFields(args) {
  return {
    mode: args.mode || "",
    intent_kd: args.intent_kd || "",
    session_date: args.session_date || "",
    scope: args.scope || "",
  };
}

/**
 * Build the rejection message telling the caller what fields to provide.
 * Uses positive framing — tells what TO do, not what to avoid.
 */
function buildRejectionMessage() {
  return (
    "DISPATCH REJECTED: Use structured dispatch format. " +
    "Provide the required fields: mode (explore, investigate, align, " +
    "decompose, swarm, verify, extract, evolve, commit, report, " +
    "checkpoint, preflight), intent_kd (path to INTENT KD), " +
    "and session_date (YYYY-MM-DD). Optionally include scope for context."
  );
}

/**
 * Find the template entry for a given mode.
 * Returns the template entry or null if not found.
 */
function findTemplate(mode) {
  return templates[mode] || null;
}

/**
 * Validate that all required fields for template generation are present.
 */
function validateTemplateFields(fields) {
  if (!fields.mode) return false;
  if (!fields.intent_kd) return false;
  if (!fields.session_date) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Plugin entry point
// ---------------------------------------------------------------------------

/**
 * Plugin entry point — called by opencode on load.
 */
export default async function dispatchGatePlugin() {
  return {
    /**
     * Intercepts all tool executions before they run.
     * For `task` tool: checks for structured dispatch fields.
     * If structured → resolves template → routes prompt to target agent.
     * If free-text → rejects with positive guidance.
     */
    "tool.execute.before": async (ctx, output) => {
      if (ctx.tool !== "task") return;

      const args = output.args;
      if (!args || typeof args !== "object") {
        throw new Error(buildRejectionMessage());
      }

      // Check for structured dispatch fields
      if (!isStructuredDispatch(args)) {
        throw new Error(buildRejectionMessage());
      }

      const fields = extractFields(args);
      if (!validateTemplateFields(fields)) {
        throw new Error(buildRejectionMessage());
      }

      // Find the template for this mode
      const templateEntry = findTemplate(fields.mode);
      if (!templateEntry) {
        throw new Error(
          `DISPATCH REJECTED: Unknown mode "${fields.mode}". ` +
          "Provide one of: explore, investigate, align, decompose, " +
          "swarm, verify, extract, evolve, commit, report, checkpoint, preflight."
        );
      }

      // Skip template generation for report mode (used internally by Overseer)
      if (fields.mode === "report") {
        return;
      }

      // Resolve template placeholders
      const prompt = await resolveTemplate(templateEntry.template, fields);

      // Route to the target agent
      output.args = {
        subagent_type: templateEntry.target_agent,
        prompt,
        description: templateEntry.description,
      };
    },
  };
}
