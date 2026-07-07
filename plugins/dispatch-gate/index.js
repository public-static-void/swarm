// plugins/dispatch-gate/index.js
// Intercepts `task` tool calls to enforce structured dispatch format.
//
// Two hooks work together:
//   1. tool.definition — extends the task tool's JSON Schema so that
//      structured fields (mode, intent_kd, session_date, scope) are
//      valid parameters and prompt/description/subagent_type are optional.
//   2. tool.execute.before — detects structured dispatch calls, resolves
//      the template for the given mode, injects prompt/description/
//      subagent_type into args, and removes the structured fields.
//
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

// ---------------------------------------------------------------------------
// Plugin entry point
// ---------------------------------------------------------------------------

/**
 * Plugin entry point — called by opencode on load.
 */
export default async function dispatchGatePlugin() {
  return {
    // -----------------------------------------------------------------------
    // Hook 1: Modify the task tool schema
    // -----------------------------------------------------------------------
    // Runs when the tool definition is built (before sending to the LLM).
    // Adds structured dispatch fields as optional properties and removes
    // prompt/description/subagent_type from the required array. This lets
    // agents provide ONLY mode+intent_kd+session_date (no prompt) without
    // triggering a schema validation error.

    /**
     * Extends the `task` tool JSON Schema to accept structured dispatch fields.
     * This allows the Overseer to provide mode+intent_kd+session_date without
     * prompt/description/subagent_type — the plugin generates those later.
     */
    "tool.definition": async (input, output) => {
      if (input.toolID !== "task") return;
      if (!output.parameters || !output.parameters.properties) return;

      // Add structured dispatch fields as optional properties
      output.parameters.properties.mode = {
        type: "string",
        description:
          "Dispatch mode: explore, investigate, align, decompose, " +
          "swarm, verify, extract, evolve, commit, report, " +
          "checkpoint, preflight",
      };
      output.parameters.properties.intent_kd = {
        type: "string",
        description:
          "Path to the INTENT KD for this session " +
          "(e.g., knowledge/intent-auth-flow-2026-07-07.md)",
      };
      output.parameters.properties.session_date = {
        type: "string",
        description: "Session date in YYYY-MM-DD format",
      };
      output.parameters.properties.scope = {
        type: "string",
        description: "Optional scope / domain context for the dispatch",
      };

      // Make prompt, description, subagent_type optional since the plugin
      // injects them when structured dispatch fields are provided
      if (Array.isArray(output.parameters.required)) {
        output.parameters.required = output.parameters.required.filter(
          (f) => f !== "prompt" && f !== "description" && f !== "subagent_type",
        );
      }
    },

    // -----------------------------------------------------------------------
    // Hook 2: Transform structured dispatches before execution
    // -----------------------------------------------------------------------
    // Fires after schema validation. By this point the task tool schema
    // already accepts structured fields (thanks to hook 1), so the call
    // passes schema validation. This hook transforms structured fields into
    // the standard task tool fields (prompt, description, subagent_type).

    /**
     * Intercepts all tool executions before they run.
     * For `task` tool: checks for structured dispatch fields.
     * If structured → resolves template → injects into args.
     * If free-text (prompt without structured fields) → rejects.
     */
    "tool.execute.before": async (ctx, output) => {
      if (ctx.tool !== "task") return;

      const args = output.args;
      if (!args || typeof args !== "object") {
        throw new Error(buildRejectionMessage());
      }

      // Structured dispatch has mode + intent_kd + session_date
      const isStructured = isStructuredDispatch(args);

      if (isStructured) {
        const templateEntry = findTemplate(args.mode);
        if (!templateEntry) {
          throw new Error(
            `DISPATCH REJECTED: Unknown mode "${args.mode}". ` +
              "Provide one of: explore, investigate, align, decompose, " +
              "swarm, verify, extract, evolve, commit, report, " +
              "checkpoint, preflight.",
          );
        }

        // Resolve template placeholders using the structured fields
        const prompt = await resolveTemplate(templateEntry.template, args);

        // Replace args with standard task tool fields
        output.args = {
          subagent_type: templateEntry.target_agent,
          prompt,
          description: templateEntry.description,
        };
        return;
      }

      // Not a structured dispatch. If it has a prompt it's a free-text
      // dispatch — reject with positive guidance telling what to provide.
      throw new Error(buildRejectionMessage());
    },
  };
}
