/**
 * Dispatch Gate Plugin
 *
 * Intercepts task() calls to enforce structured dispatch format.
 *
 * Environment variables:
 *   DISPATCH_GATE_DEBUG=true — enables file logging to
 *     ~/.config/opencode/logs/dispatch-gate.log
 *   (Default: logging disabled. Set to "true" to enable debug logs.)
 *   _DISPATCH_GATE_LOG_DIR — override log directory (default: ~/.config/opencode/logs)
 *
 * Behavior:
 *   - Structured dispatch (mode+intent_kd+session_date): generates prompt from template
 *   - Free-text dispatch (no structured fields): throws rejection error
 *   - Non-task tools: passes through unchanged
 *
 * Two hooks work together:
 *   1. tool.definition — modifies jsonSchema (mutable JSON Schema 7 plain
 *      object) to add structured dispatch fields as REQUIRED properties.
 *      This guides the LLM to generate structured calls. NOTE: jsonSchema
 *      is LLM guidance, not structural enforcement — the LLM may still
 *      generate free-text calls despite the schema hints.
 *   2. tool.execute.before — resolves templates for structured dispatches,
 *      throws for free-text rejection, throws for unknown mode. Uses
 *      property mutation (not object replacement) so framework retains
 *      the same args reference. Uses `delete` to remove structured fields
 *      after transformation.
 *
 * Same handler for ALL callers — no Overseer/Artisan distinction.
 */

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

/**
 * Valid dispatch mode values — used for schema enum and error guidance.
 */
const VALID_MODES = [
  "explore", "investigate", "align", "decompose", "swarm",
  "verify", "extract", "evolve", "report",
  "checkpoint", "cleanup", "preflight",
];

// FR-05: Circuit breaker state — tracks consecutive rejections to break
// deadlock spirals where the LLM gets stuck in a rejection loop.
// Module-level so state persists across task() calls within a session.
let rejectionState = { consecutiveFailures: 0 };
const CIRCUIT_BREAKER_LIMIT = 3;
const CIRCUIT_BREAKER_DISABLE_LIMIT = 5;

/**
 * Apply circuit breaker prefix to error message based on consecutive failure count.
 * After 3: tells LLM to STOP and restart with structured dispatch.
 * After 5: additionally suggests the user disable the plugin.
 */
function applyCircuitBreaker(err) {
  rejectionState.consecutiveFailures++;
  if (rejectionState.consecutiveFailures >= CIRCUIT_BREAKER_DISABLE_LIMIT) {
    err.message =
      `[DISPATCH CIRCUIT BREAKER] ${err.message}` +
      " — After 5 consecutive rejections, consider disabling the dispatch-gate plugin for this session.";
  } else if (rejectionState.consecutiveFailures >= CIRCUIT_BREAKER_LIMIT) {
    err.message =
      `[DISPATCH CIRCUIT BREAKER] ${err.message}` +
      " — Please STOP and restart with a structured dispatch using only: mode, intent_kd, session_date." +
      ' Example: task({ mode: "explore", intent_kd: "knowledge/intent-<name>-<date>.md", session_date: "YYYY-MM-DD" })';
  }
}

/**
 * Reset circuit breaker state — exported for test isolation (FR-05-07).
 */
export function resetRejectionState() {
  rejectionState.consecutiveFailures = 0;
}

/**
 * Static error configurations for each structured dispatch failure mode.
 * All message strings are static constants (NFR003) — no dynamic
 * generation from model output.
 */
const ERROR_CONFIGS = Object.freeze({
  MISSING_MODE: Object.freeze({
    code: "MISSING_MODE",
    message: "Structured dispatch missing required field: mode.",
    guidance:
      "Add 'mode' as a tool call parameter (not in prompt text). " +
      "The fields intent_kd, session_date, and scope must also be provided as parameters.",
    example:
      '{ mode: "explore", intent_kd: "knowledge/intent-<name>-<date>.md", session_date: "YYYY-MM-DD" }',
  }),
  MISSING_ALL_FIELDS: Object.freeze({
    code: "MISSING_ALL_FIELDS",
    message: "Free-form delegation is not supported. Use structured dispatch fields.",
    guidance:
      "Add mode, intent_kd, and session_date as tool call parameter fields " +
      "(not in prompt or description text).",
    example:
      '{ mode: "explore", intent_kd: "knowledge/intent-<name>-<date>.md", session_date: "YYYY-MM-DD" }',
  }),
  FIELDS_IN_PROMPT: Object.freeze({
    code: "FIELDS_IN_PROMPT",
    message: "Structured dispatch fields must be tool call parameters, not text content.",
    guidance:
      "Move mode, intent_kd, and session_date out of prompt/description text " +
      "and into the structured parameter fields of the tool call.",
    example:
      '{ mode: "explore", intent_kd: "knowledge/intent-<name>-<date>.md", session_date: "YYYY-MM-DD" }',
  }),
  INVALID_MODE_VALUE: Object.freeze({
    code: "INVALID_MODE_VALUE",
    message: "Invalid dispatch mode value.",
    guidance:
      "Provide one of the valid mode values as a tool call parameter: " +
      `${VALID_MODES.join(", ")}.`,
    example:
      '{ mode: "explore", intent_kd: "knowledge/intent-<name>-<date>.md", session_date: "YYYY-MM-DD" }',
  }),
  MISSING_REQUIRED_FIELDS: Object.freeze({
    code: "MISSING_REQUIRED_FIELDS",
    message:
      "Structured dispatch requires all three fields: mode, intent_kd, and session_date.",
    guidance:
      "Provide all required fields as tool call parameters. " +
      "intent_kd and session_date are mandatory when mode is present.",
    example:
      '{ mode: "explore", intent_kd: "knowledge/intent-<name>-<date>.md", session_date: "YYYY-MM-DD" }',
  }),
});

/**
 * Structured error for dispatch gate rejections.
 * Carries code, fieldsReceived, guidance, and example for self-correction.
 */
class DispatchGateError extends Error {
  constructor({ code, message, fieldsReceived, guidance, example }) {
    super(message);
    this.name = "DispatchGateError";
    this.code = code;
    this.fieldsReceived = fieldsReceived;
    this.guidance = guidance;
    this.example = example;
  }
}

/**
 * Build a DispatchGateError from a config key and the fields received.
 */
function buildDispatchGateError(configKey, fieldsReceived = {}) {
  const config = ERROR_CONFIGS[configKey];
  if (!config) throw new Error(`Unknown error config: ${configKey}`);
  return new DispatchGateError({ ...config, fieldsReceived });
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
        enum: [...VALID_MODES],
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

      // FR-06: Remove native task fields from schema so LLM only sees
      // structured dispatch fields. Field injection in tool.execute.before
      // still works — the framework doesn't validate against the schema.
      delete schema.properties.prompt;
      delete schema.properties.description;
      delete schema.properties.subagent_type;
    },

    // -----------------------------------------------------------------------
    // Hook 2: Transform/reject dispatches before execution
    // -----------------------------------------------------------------------
    // Fires when the tool executes. Four paths:
    //
    //   PATH 1 — STRUCTURED DISPATCH (mode + intent_kd + session_date):
    //     Resolves the template, property-mutates prompt/description/
    //     subagent_type, injects _dispatch_confirmation, deletes structured
    //     fields. Preserves task_id and command passthrough fields.
    //     Throws INVALID_MODE_VALUE if mode is not in VALID_MODES.
    //
    //   NEW PATH — PARTIAL STRUCTURED FIELDS (intent_kd || session_date,
    //     but no mode): Throws MISSING_MODE error with fields received.
    //
    //   PATH 2 — FREE-TEXT DISPATCH (prompt/description/subagent_type,
    //     no structured fields): Throws FIELDS_IN_PROMPT if text contains
    //     field keywords, otherwise MISSING_ALL_FIELDS.
    //
    //   PATH 3 — NO DISPATCH FIELDS: Pass through unchanged.

    "tool.execute.before": async (ctx, output) => {
      // Non-task tools pass through unaffected — plugin scope is task dispatch only
      if (ctx.tool !== "task") return;
      if (!output.args || typeof output.args !== "object") return;

      const args = output.args;

      // Log every dispatch arrival with key identifiers for traceability
      logToFile(
        "RECEIVED",
        `mode=${args.mode || "(none)"} intent_kd=${args.intent_kd ? args.intent_kd.replace("knowledge/", "") : "(none)"} session_date=${args.session_date || "(none)"}`,
      );

      // FR-03: Extract fields from _dispatch_confirmation as fallback when
      // primary fields are empty. The Overseer sends back the confirmation
      // object thinking it passes structured fields — extract and clean up.
      if ((!args.mode || !args.intent_kd || !args.session_date) && args._dispatch_confirmation) {
        const conf = args._dispatch_confirmation;
        if (!args.mode && conf.mode) args.mode = conf.mode;
        if (!args.intent_kd && conf.intent_kd) args.intent_kd = conf.intent_kd;
        if (!args.session_date && conf.session_date) args.session_date = conf.session_date;
        delete args._dispatch_confirmation;
      }

      // --- PATH 1: Structured dispatch (mode + intent_kd + session_date) ---
      if (args.mode && args.intent_kd && args.session_date) {
        const templateEntry = findTemplate(args.mode);
        if (!templateEntry) {
          // R003(d): Invalid mode value — not in VALID_MODES
          const err = buildDispatchGateError("INVALID_MODE_VALUE", {
            mode: args.mode,
            intent_kd: args.intent_kd,
            session_date: args.session_date,
          });
          logToFile("REJECTED", `${err.code}: ${err.message} | mode="${args.mode}"`);
          applyCircuitBreaker(err);
          throw err;
        }

        let prompt;
        try {
          prompt = await resolveTemplate(
            templateEntry.template,
            args,
          );
        } catch (err) {
          // Log template errors before re-throw so failure context is preserved
          logToFile(
            "ERROR",
            `template resolution failed: ${err.message}`,
          );
          throw err;
        }

        // Extract RETURN path from resolved prompt for confirmation
        const returnMatch = prompt.match(/RETURN:\s*(.+)/);
        const resolvedReturnPath = returnMatch ? returnMatch[1].trim() : "";

        // Property mutation (not object replacement) so the framework's
        // reference to output.args remains valid
        output.args.prompt = prompt;
        output.args.description = templateEntry.description;
        output.args.subagent_type = templateEntry.target_agent;

        // Capture mode before deleting for confirmation and logging
        const resolvedMode = args.mode;

        // R004: Success confirmation signal — structured metadata for caller
        output.args._dispatch_confirmation = {
          status: "dispatched",
          mode: resolvedMode,
          targetAgent: templateEntry.target_agent,
          kds: [args.intent_kd],
          returnPath: resolvedReturnPath,
        };

        // Clean up structured fields — they were consumed by template resolution
        delete output.args.mode;
        delete output.args.intent_kd;
        delete output.args.session_date;
        delete output.args.scope;

        // Log successful transformation with dispatch metadata for monitoring
        logToFile(
          "TRANSFORMED",
          `mode=${resolvedMode} target=${templateEntry.target_agent} confirmed`,
        );

        // FR-05: Reset circuit breaker on successful dispatch
        rejectionState.consecutiveFailures = 0;

        // Passthrough fields (task_id, command) auto-preserve since they
        // are not in the structured fields set and we use mutation + delete

        return;
      }

      // --- FR-04: mode present but missing required intent_kd or session_date ---
      if (args.mode && (!args.intent_kd || !args.session_date)) {
        const fieldsReceived = { mode: args.mode };
        if (args.intent_kd) fieldsReceived.intent_kd = args.intent_kd;
        if (args.session_date) fieldsReceived.session_date = args.session_date;
        if (args.scope) fieldsReceived.scope = args.scope;
        const err = buildDispatchGateError("MISSING_REQUIRED_FIELDS", fieldsReceived);
        logToFile("REJECTED", `${err.code}: ${err.message} | received: ${JSON.stringify(fieldsReceived)}`);
        applyCircuitBreaker(err);
        throw err;
      }

      // --- NEW PATH (R001): Partial structured fields — has intent_kd/session_date but no mode ---
      if ((args.intent_kd || args.session_date) && !args.mode) {
        const fieldsReceived = {};
        if (args.intent_kd) fieldsReceived.intent_kd = args.intent_kd;
        if (args.session_date) fieldsReceived.session_date = args.session_date;
        if (args.scope) fieldsReceived.scope = args.scope;
        const err = buildDispatchGateError("MISSING_MODE", fieldsReceived);
        logToFile("REJECTED", `${err.code}: ${err.message} | received: ${JSON.stringify(fieldsReceived)}`);
        applyCircuitBreaker(err);
        throw err;
      }

      // --- PATH 2: Free-text or incomplete dispatch ---
      // Has prompt/description/subagent_type but no structured fields.
      // Distinguishes between:
      //   (b) No structured fields at all → MISSING_ALL_FIELDS
      //   (c) Field keywords found in prompt text → FIELDS_IN_PROMPT
      if (args.prompt || args.description || args.subagent_type) {
        // Check if text content contains structured field keywords (R003(c))
        const textContent = [args.prompt, args.description, args.subagent_type]
          .filter(Boolean).join(" ");
        // FR-02: Only match field keywords when followed by optional quotes + : or =
        // to avoid false positives on filenames like "cleanup-mode-2026.md"
        const hasFieldKeywords = /(?:\b(mode|intent_kd|session_date)\b\s*"?\s*[:=])/gi.test(textContent);

        if (hasFieldKeywords) {
          // R003(c): Fields appear in text content rather than as parameters
          const err = buildDispatchGateError("FIELDS_IN_PROMPT");
          logToFile("REJECTED", `${err.code}: ${err.message}`);
          applyCircuitBreaker(err);
          throw err;
        }

        // R003(b): No structured fields at all
        const err = buildDispatchGateError("MISSING_ALL_FIELDS");
        logToFile("REJECTED", `${err.code}: ${err.message}`);
        applyCircuitBreaker(err);
        throw err;
      }

      // Pass-through calls are logged so the operator can see which calls escape dispatch
      logToFile(
        "PASSED",
        "no dispatch fields",
      );

      // --- PATH 3: No dispatch fields — pass through ---
      return;
    },
  };
}
