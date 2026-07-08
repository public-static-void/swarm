// plugins/dispatch-gate/index.js
// Intercepts `task` tool calls to enforce structured dispatch format.
//
// Two hooks work together:
//   1. tool.definition — modifies jsonSchema (mutable JSON Schema 7 plain
//      object) to add structured dispatch fields as REQUIRED properties.
//      This guides the LLM to generate structured calls. NOTE: jsonSchema
//      is LLM guidance, not structural enforcement — the LLM may still
//      generate free-text calls despite the schema hints.
//   2. tool.execute.before — resolves templates for structured dispatches.
//      Rejects free-text/incomplete dispatches by nulling the prompt field,
//      which causes the Effect Schema decode inside the task tool to fail
//      with InvalidArgumentsError.
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
    // Hook 1: Modify the task tool JSON Schema
    // -----------------------------------------------------------------------
    // Runs when the tool definition is built (before sending to the LLM).
    // Modifies output.jsonSchema (a mutable JSON Schema 7 object) to add
    // structured dispatch fields. The LLM sees mode, intent_kd, session_date
    // as REQUIRED. prompt/description/subagent_type are removed from
    // required — the plugin injects them from templates.
    //
    // NOTE: output.parameters is an Effect Schema.Struct (function/class)
    // with NO .properties — modifying it is a no-op. The mutable schema
    // is output.jsonSchema.

    "tool.definition": async (input, output) => {
      if (input.toolID !== "task") return;

      // output.parameters is Effect Schema.Struct — no .properties
      // output.jsonSchema is a mutable JSONSchema7 object — use it
      const schema = output.jsonSchema || output.parameters;
      if (!schema || !schema.properties) return;

      // Add structured dispatch fields
      schema.properties.mode = {
        type: "string",
        enum: [
          "explore", "investigate", "align", "decompose", "swarm",
          "verify", "extract", "evolve", "commit", "report",
          "checkpoint", "preflight",
        ],
        description:
          "Dispatch mode — required for structured dispatch",
      };
      schema.properties.intent_kd = {
        type: "string",
        description:
          "Path to the INTENT KD for this session " +
          "(e.g., knowledge/intent-auth-flow-2026-07-07.md)",
      };
      schema.properties.session_date = {
        type: "string",
        pattern: "^\\d{4}-\\d{2}-\\d{2}$",
        description: "Session date in YYYY-MM-DD format",
      };
      schema.properties.scope = {
        type: "string",
        description: "Optional scope / domain context for the dispatch",
      };

      // Make mode, intent_kd, session_date REQUIRED so LLM sees
      // them as mandatory. prompt, description, subagent_type are
      // optional — the plugin injects them.
      if (Array.isArray(schema.required)) {
        schema.required = schema.required.filter(
          (f) => f !== "prompt" && f !== "description" && f !== "subagent_type",
        );
        if (!schema.required.includes("mode"))
          schema.required.push("mode");
        if (!schema.required.includes("intent_kd"))
          schema.required.push("intent_kd");
        if (!schema.required.includes("session_date"))
          schema.required.push("session_date");
      }
    },

    // -----------------------------------------------------------------------
    // Hook 2: Transform/reject dispatches before execution
    // -----------------------------------------------------------------------
    // Fires when the tool executes. Three paths:
    //
    //   1. STRUCTURED DISPATCH (mode + intent_kd + session_date present):
    //      Resolves the template and injects prompt/description/subagent_type.
    //      Preserves task_id and command passthrough fields.
    //
    //   2. FREE-TEXT DISPATCH (prompt/description/subagent_type but no mode):
    //      Rejects by setting prompt to null. The Effect Schema decode
    //      inside the task tool requires prompt: Schema.String, so null
    //      causes InvalidArgumentsError — the only structural rejection
    //      point in the framework.
    //
    //   3. NO DISPATCH FIELDS (no prompt, no mode, no dispatch fields):
    //      Pass through — not a dispatch call.

    "tool.execute.before": async (ctx, output) => {
      if (ctx.tool !== "task") return;
      if (!output.args || typeof output.args !== "object") return;

      const args = output.args;

      // --- PATH 1: Structured dispatch (mode + intent_kd + session_date) ---
      if (args.mode && args.intent_kd && args.session_date) {
        const templateEntry = findTemplate(args.mode);
        if (!templateEntry) {
          // Unknown mode with structured fields — reject via in-place mutation
          output.args.prompt = null;
          if (output.args.description) output.args.description = null;
          if (output.args.subagent_type) output.args.subagent_type = null;
          return output;
        }

        const prompt = await resolveTemplate(
          templateEntry.template,
          args,
        );

        output.args = {
          prompt,
          description: templateEntry.description,
          subagent_type: templateEntry.target_agent,
        };

        // Preserve passthrough fields if present
        if (args.task_id) output.args.task_id = args.task_id;
        if (args.command) output.args.command = args.command;

        return output;
      }

      // --- PATH 2: Free-text or incomplete dispatch ---
      // Has prompt/description/subagent_type but missing structured fields
      // Nulls fields via in-place property mutation so any reference the
      // framework holds to the original args object sees the null values.
      // The Effect Schema decode inside the task tool requires prompt as
      // Schema.String, so null causes InvalidArgumentsError.
      if (args.prompt || args.description || args.subagent_type) {
        output.args.prompt = null;
        if (output.args.description) output.args.description = null;
        if (output.args.subagent_type) output.args.subagent_type = null;
        return output;
      }

      // --- PATH 3: No dispatch fields — pass through ---
      return output;
    },
  };
}
