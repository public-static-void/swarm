// plugins/dispatch-gate/index.js
// Intercepts `task` tool calls to enforce structured dispatch format.
//
// Two hooks work together:
//   1. tool.definition — modifies jsonSchema (mutable JSON Schema 7 plain
//      object) to add structured dispatch fields as REQUIRED properties.
//      This guides the LLM to generate structured calls. NOTE: jsonSchema
//      is LLM guidance, not structural enforcement — the LLM may still
//      generate free-text calls despite the schema hints.
//   2. tool.execute.before — resolves templates for structured dispatches,
//      throws for free-text rejection, throws for unknown mode. Uses
//      property mutation (not object replacement) so framework retains
//      the same args reference. Uses `delete` to remove structured fields
//      after transformation.
//
// Same handler for ALL callers — no Overseer/Artisan distinction.

import fs from "fs";
import path from "path";
import os from "os";
import { resolveTemplate } from "./template-engine.js";
import templates from "./templates.json" with { type: "json" };

// ---------------------------------------------------------------------------
// File logging — replaces console.log to avoid TUI spill
// ---------------------------------------------------------------------------

const LOG_DIR =
  process.env._DISPATCH_GATE_LOG_DIR ||
  path.join(os.homedir(), ".config", "opencode", "logs");
const LOG_FILE = path.join(LOG_DIR, "dispatch-gate.log");

function logToFile(event, details) {
  if (!process.env.DISPATCH_GATE_DEBUG) return;
  try {
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    }
    const timestamp = new Date().toISOString();
    const line = `[DISPATCH-GATE] ${timestamp} | ${event} | ${details}\n`;
    fs.appendFileSync(LOG_FILE, line);
  } catch (e) {
    // Silently fail — logging should never break the plugin
  }
}

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
    //      Resolves the template, property-mutates prompt/description/
    //      subagent_type, deletes structured fields. Preserves task_id
    //      and command passthrough fields.
    //
    //   2. FREE-TEXT DISPATCH (prompt/description/subagent_type but no
    //      structured fields): Throws Error with positive-framed guidance
    //      telling the caller what fields TO provide.
    //
    //   3. NO DISPATCH FIELDS: Pass through — not a dispatch call.

    "tool.execute.before": async (ctx, output) => {
      // M2-T6: Non-task tools produce zero dispatch-gate logging
      if (ctx.tool !== "task") return;
      if (!output.args || typeof output.args !== "object") return;

      const args = output.args;

      // M2-T1: Log every dispatch arrival with identifying fields
      logToFile(
        "RECEIVED",
        `mode=${args.mode || "(none)"} intent_kd=${args.intent_kd ? args.intent_kd.replace("knowledge/", "") : "(none)"} session_date=${args.session_date || "(none)"}`,
      );

      // --- PATH 1: Structured dispatch (mode + intent_kd + session_date) ---
      if (args.mode && args.intent_kd && args.session_date) {
        const templateEntry = findTemplate(args.mode);
        if (!templateEntry) {
          // M2-T2: Log rejection before throw
          logToFile(
            "REJECTED",
            `unknown mode "${args.mode}"`,
          );
          // Uses throw to abort execution — framework catches the rejection
          throw new Error(
            "Provide one of the following modes: explore, investigate, align, decompose, swarm, verify, extract, evolve, commit, report, checkpoint, preflight",
          );
        }

        let prompt;
        try {
          prompt = await resolveTemplate(
            templateEntry.template,
            args,
          );
        } catch (err) {
          // M2-T5: Log template resolution errors then re-throw
          logToFile(
            "ERROR",
            `template resolution failed: ${err.message}`,
          );
          throw err;
        }

        // Property mutation (not object replacement) so the framework's
        // reference to output.args remains valid
        output.args.prompt = prompt;
        output.args.description = templateEntry.description;
        output.args.subagent_type = templateEntry.target_agent;

        // Capture mode before deleting for logging
        const resolvedMode = args.mode;

        // Clean up structured fields — they were consumed by template resolution
        delete output.args.mode;
        delete output.args.intent_kd;
        delete output.args.session_date;
        delete output.args.scope;

        // M2-T3: Log successful transformation
        logToFile(
          "TRANSFORMED",
          `mode=${resolvedMode} target=${templateEntry.target_agent}`,
        );

        // Passthrough fields (task_id, command) auto-preserve since they
        // are not in the structured fields set and we use mutation + delete

        return;
      }

      // --- PATH 2: Free-text or incomplete dispatch ---
      // Has prompt/description/subagent_type but missing structured fields.
      // Uses throw to abort execution — framework catches the rejection.
      if (args.prompt || args.description || args.subagent_type) {
        // M2-T2: Log rejection before throw
        logToFile(
          "REJECTED",
          "free-text dispatch blocked",
        );
        throw new Error(
          "Provide mode, intent_kd, and session_date fields for structured dispatch",
        );
      }

      // M2-T4: Log pass-through for non-dispatch task calls
      logToFile(
        "PASSED",
        "no dispatch fields",
      );

      // --- PATH 3: No dispatch fields — pass through ---
      return;
    },
  };
}
