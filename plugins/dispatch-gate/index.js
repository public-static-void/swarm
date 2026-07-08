// plugins/dispatch-gate/index.js
// Intercepts `task` tool calls to enforce structured dispatch format.
//
// Two hooks work together:
//   1. tool.definition — extends the task tool's JSON Schema so that
//      structured fields (mode, intent_kd, session_date) are REQUIRED
//      and prompt/description/subagent_type are optional. Schema
//      validation rejects calls missing structured fields BEFORE the
//      execute hook runs — this is the only structurally sound way to
//      block free-text dispatches given that tool.execute.before cannot
//      abort execution.
//   2. tool.execute.before — resolves the template for the given mode,
//      injects prompt/description/subagent_type into args, and removes
//      the structured fields. Never throws — schema handles rejection.
//
// Same handler for ALL callers — no Overseer/Artisan distinction.

import { resolveTemplate } from "./template-engine.js";
import templates from "./templates.json" with { type: "json" };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    // Adds structured dispatch fields as REQUIRED properties. Schema
    // validation rejects any task() call that omits mode, intent_kd, or
    // session_date — this is the ONLY mechanism that structurally prevents
    // free-text dispatches.

    "tool.definition": async (input, output) => {
      if (input.toolID !== "task") return;
      if (!output.parameters || !output.parameters.properties) return;

      // Add structured dispatch fields
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

      // Make mode, intent_kd, session_date REQUIRED so schema validation
      // rejects calls without them. prompt, description, subagent_type
      // are removed from required — the plugin injects them.
      if (Array.isArray(output.parameters.required)) {
        output.parameters.required = output.parameters.required.filter(
          (f) => f !== "prompt" && f !== "description" && f !== "subagent_type",
        );
        output.parameters.required.push("mode", "intent_kd", "session_date");
      }
    },

    // -----------------------------------------------------------------------
    // Hook 2: Transform structured dispatches before execution
    // -----------------------------------------------------------------------
    // Fires after schema validation passes. By this point the schema has
    // already confirmed mode+intent_kd+session_date are present. This hook
    // resolves the template and injects standard task tool fields.
    // Never throws — schema handles all rejection.

    "tool.execute.before": async (ctx, output) => {
      if (ctx.tool !== "task") return;
      if (!output.args || typeof output.args !== "object") return;

      const templateEntry = findTemplate(output.args.mode);
      if (!templateEntry) return;

      const prompt = await resolveTemplate(templateEntry.template, output.args);

      output.args = {
        subagent_type: templateEntry.target_agent,
        prompt,
        description: templateEntry.description,
      };
    },
  };
}
