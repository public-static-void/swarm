/**
 * Delegation Gate Plugin
 *
 * Enforces structured delegation rules for ALL agents. Intercepts task()
 * calls to route structured dispatches through templates.
 *
 * Plugin responsibility: task tool only.
 * protocol-gate handles file tools (read/glob/write) — zero tool overlap.
 *
 * Two hooks:
 *   1. tool.definition — appends delegation format hint to description text
 *      and adds structured fields (mode, intent_kd, session_date, scope) to
 *      the parameters schema so the model can pass them as tool call args.
 *   2. tool.execute.before — resolves templates for structured dispatches,
 *      provides positive guidance for rejections.
 *
 * Environment variables:
 *   DELEGATION_GATE_DEBUG=true — enables file logging
 *   _DELEGATION_GATE_LOG_DIR — override log directory
 */

import fs from "fs";
import path from "path";
import os from "os";
import { resolveTemplate } from "./template-engine.js";
import templates from "./templates.json" with { type: "json" };

// ---------------------------------------------------------------------------
// File logging
// ---------------------------------------------------------------------------

const LOG_DIR =
  process.env._DELEGATION_GATE_LOG_DIR ||
  path.join(os.homedir(), ".config", "opencode", "logs");
const LOG_FILE = path.join(LOG_DIR, "delegation-gate.log");

function logToFile(event, details) {
  if (!process.env.DELEGATION_GATE_DEBUG) return;
  try {
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    }
    const timestamp = new Date().toISOString();
    const line = `[DELEGATION-GATE] ${timestamp} | ${event} | ${details}\n`;
    fs.appendFileSync(LOG_FILE, line);
  } catch (e) {
    // Silently fail — logging should never break the plugin
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findTemplate(mode) {
  return templates[mode] || null;
}

const VALID_MODES = [
  "explore", "investigate", "align", "decompose", "swarm",
  "verify", "extract", "evolve", "report",
  "checkpoint", "cleanup", "preflight",
];

// Scope character limit — enforced on PATH 2 extracted scope
const SCOPE_CHAR_LIMIT = 200;

// FR-05: Circuit breaker — progressive guidance for rejection spirals
let rejectionState = { consecutiveFailures: 0 };
const CIRCUIT_BREAKER_LIMIT = 3;
const CIRCUIT_BREAKER_DISABLE_LIMIT = 5;

function applyCircuitBreaker(err, attemptedMode = null) {
  rejectionState.consecutiveFailures++;
  const mode = attemptedMode && VALID_MODES.includes(attemptedMode) ? attemptedMode : "explore";
  if (rejectionState.consecutiveFailures >= CIRCUIT_BREAKER_DISABLE_LIMIT) {
    err.message =
      "Use these fields as tool parameters: mode, intent_kd, session_date.\n" +
      `task({ mode: "${mode}", intent_kd: "knowledge/intent-<name>-<date>.md", session_date: "2026-07-12" })`;
  } else if (rejectionState.consecutiveFailures >= CIRCUIT_BREAKER_LIMIT) {
    err.message =
      "Example — use this format:\n" +
      `task({ mode: "${mode}", intent_kd: "knowledge/intent-<name>-<date>.md", session_date: "YYYY-MM-DD" })`;
  }
}

/**
 * Reset circuit breaker state. NOT exported directly (opencode treats all
 * named exports as plugin initializers). Attached to default export for tests.
 */
function resetRejectionState() {
  rejectionState.consecutiveFailures = 0;
}

/**
 * Extract structured dispatch fields from free-form prompt text.
 * Returns { mode, intent_kd, session_date } — absent fields are omitted.
 */
function extractFieldsFromPrompt(text) {
  if (!text || typeof text !== "string") return {};

  const result = {};

  const modeRegex = /\bmode\b\s*"?\s*[:=]\s*"?(\S+?)"?\s*(?:\n|,|;|\)|\]|}|$|\s)/gi;
  const modeMatches = [...text.matchAll(modeRegex)];
  for (const match of modeMatches) {
    const raw = match[1].replace(/["']+$/g, "").toLowerCase();
    if (VALID_MODES.includes(raw)) {
      result.mode = raw;
      break;
    }
  }

  const ikdMatch = text.match(/\bintent_kd\b\s*"?\s*[:=]\s*"?([^\s"]+\.md)"?/i);
  if (ikdMatch) {
    result.intent_kd = ikdMatch[1];
  }

  const sdMatch = text.match(/\bsession_date\b\s*"?\s*[:=]\s*"?(\d{4}-\d{2}-\d{2})"?/i);
  if (sdMatch) {
    result.session_date = sdMatch[1];
  }

  const scopeMatch = text.match(/\bscope\b\s*"?\s*[:=]\s*"?([^\n"]+)"?/i);
  if (scopeMatch) {
    result.scope = scopeMatch[1].trim();
  }

  return result;
}

// ---------------------------------------------------------------------------
// Absorbed validation patterns (moved from protocol-gate)
// ---------------------------------------------------------------------------

const INTENT_KD_PATTERN = /^knowledge\/intent-.+-(\d{4}-\d{2}-\d{2})\.md$/;
const SESSION_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Resolve a structured dispatch through PATH 1: template resolution,
 * prompt/description/subagent_type injection, confirmation signal,
 * structured field cleanup, and circuit breaker reset.
 */
async function resolveStructuredDispatch(args, output) {
  const templateEntry = findTemplate(args.mode);
  if (!templateEntry) {
    const err = buildDelegationGateError("INVALID_MODE_VALUE", {
      mode: args.mode,
      intent_kd: args.intent_kd,
      session_date: args.session_date,
    });
    logToFile("REJECTED", `${err.code}: ${err.message} | mode="${args.mode}"`);
    applyCircuitBreaker(err, args.mode);
    throw err;
  }

  let prompt;
  try {
    prompt = await resolveTemplate(templateEntry.template, args);
  } catch (err) {
    logToFile("ERROR", `template resolution failed: ${err.message}`);
    throw err;
  }

  const returnMatch = prompt.match(/RETURN:\s*(.+)/);
  const resolvedReturnPath = returnMatch ? returnMatch[1].trim() : "";

  output.args.prompt = prompt;
  output.args.description = templateEntry.description;
  output.args.subagent_type = templateEntry.target_agent;

  const resolvedMode = args.mode;

  output.args._dispatch_confirmation = {
    status: "dispatched",
    mode: resolvedMode,
    targetAgent: templateEntry.target_agent,
    kds: [args.intent_kd],
    returnPath: resolvedReturnPath,
  };

  delete output.args.mode;
  delete output.args.intent_kd;
  delete output.args.session_date;
  delete output.args.scope;

  logToFile(
    "TRANSFORMED",
    `mode=${resolvedMode} target=${templateEntry.target_agent} confirmed`,
  );

  rejectionState.consecutiveFailures = 0;

  return resolvedMode;
}

// ---------------------------------------------------------------------------
// Error configuration
// ---------------------------------------------------------------------------

const ERROR_CONFIGS = Object.freeze({
  MISSING_MODE: Object.freeze({
    code: "MISSING_MODE",
    message: "Provide a dispatch mode: mode, intent_kd, session_date, scope.",
    guidance:
      "Include 'mode' as a tool call parameter. " +
      "Also provide intent_kd, session_date, and scope.",
    example:
      '{ mode: "explore", intent_kd: "knowledge/intent-<name>-<date>.md", session_date: "YYYY-MM-DD", scope: "auth module analysis" }',
  }),
  MISSING_ALL_FIELDS: Object.freeze({
    code: "MISSING_ALL_FIELDS",
    message: "Use structured dispatch fields: mode, intent_kd, session_date, scope.",
    guidance:
      "Provide mode, intent_kd, session_date, and scope as tool call parameters.",
    example:
      '{ mode: "explore", intent_kd: "knowledge/intent-<name>-<date>.md", session_date: "YYYY-MM-DD", scope: "auth module analysis" }',
  }),
  FIELDS_IN_PROMPT: Object.freeze({
    code: "FIELDS_IN_PROMPT",
    message: "Use mode, intent_kd, session_date, scope as tool call parameters.",
    guidance:
      "Set mode, intent_kd, session_date, and scope as tool call parameters. " +
      "The plugin generates the dispatch prompt from these fields.",
    example:
      '{ mode: "explore", intent_kd: "knowledge/intent-<name>-<date>.md", session_date: "YYYY-MM-DD", scope: "auth module analysis" }',
  }),
  INVALID_MODE_VALUE: Object.freeze({
    code: "INVALID_MODE_VALUE",
    message: "Use a valid dispatch mode.",
    guidance:
      "Provide one of the valid mode values as a tool call parameter: " +
      `${VALID_MODES.join(", ")}.`,
    example:
      '{ mode: "explore", intent_kd: "knowledge/intent-<name>-<date>.md", session_date: "YYYY-MM-DD", scope: "auth module analysis" }',
  }),
  MISSING_REQUIRED_FIELDS: Object.freeze({
    code: "MISSING_REQUIRED_FIELDS",
    message:
      "Provide all four fields: mode, intent_kd, session_date, scope.",
    guidance:
      "Provide all required fields as tool call parameters. " +
      "intent_kd, session_date, and scope are mandatory when mode is present.",
    example:
      '{ mode: "explore", intent_kd: "knowledge/intent-<name>-<date>.md", session_date: "YYYY-MM-DD", scope: "auth module analysis" }',
  }),
  INVALID_INTENT_KD_PATH: Object.freeze({
    code: "INVALID_INTENT_KD_PATH",
    message: "intent_kd must match knowledge/intent-{name}-{YYYY-MM-DD}.md",
    guidance:
      "Use format: intent-<descriptive-name>-<YYYY-MM-DD>.md " +
      "for the intent_kd parameter.",
    example:
      '{ mode: "explore", intent_kd: "knowledge/intent-<name>-<date>.md", session_date: "YYYY-MM-DD", scope: "auth module analysis" }',
  }),
  INVALID_SESSION_DATE: Object.freeze({
    code: "INVALID_SESSION_DATE",
    message: "session_date must be YYYY-MM-DD format.",
    guidance:
      "Use format: YYYY-MM-DD (e.g., 2026-07-14)",
    example:
      '{ mode: "explore", intent_kd: "knowledge/intent-<name>-<date>.md", session_date: "YYYY-MM-DD", scope: "auth module analysis" }',
  }),
  SCOPE_TOO_LONG: Object.freeze({
    code: "SCOPE_TOO_LONG",
    message: "scope exceeds 200 character limit.",
    guidance:
      "Shorten the scope text to 200 characters or fewer. " +
      "scope provides free-text context for the dispatched agent.",
    example:
      '{ mode: "explore", intent_kd: "knowledge/intent-<name>-<date>.md", session_date: "YYYY-MM-DD", scope: "auth module analysis" }',
  }),
  MISSING_SCOPE: Object.freeze({
    code: "MISSING_SCOPE",
    message: "Provide a scope field describing the work context.",
    guidance:
      "Include 'scope' as a tool call parameter. " +
      "scope describes the work context for the dispatched agent (max 200 chars).",
    example:
      '{ mode: "explore", intent_kd: "knowledge/intent-<name>-<date>.md", session_date: "YYYY-MM-DD", scope: "auth module analysis" }',
  }),
});

class DelegationGateError extends Error {
  constructor({ code, message, fieldsReceived, guidance, example }) {
    super(message);
    this.name = "DelegationGateError";
    this.code = code;
    this.fieldsReceived = fieldsReceived;
    this.guidance = guidance;
    this.example = example;
  }
}

function buildDelegationGateError(configKey, fieldsReceived = {}) {
  const config = ERROR_CONFIGS[configKey];
  if (!config) throw new Error(`Unknown error config: ${configKey}`);
  return new DelegationGateError({ ...config, fieldsReceived });
}

// ---------------------------------------------------------------------------
// Description hint (derived from templates.json, used by tool.definition)
// ---------------------------------------------------------------------------

let cachedHint = null;

/**
 * Build the delegation format hint appended to the task tool description.
 * Derived from templates.json keys at load time. Under 200 chars.
 */
function buildDescriptionHint() {
  if (cachedHint) return cachedHint;

  let modes;
  try {
    modes = Object.keys(templates);
  } catch {
    modes = [...VALID_MODES];
  }

  cachedHint =
    `Delegation: pass mode, intent_kd, session_date, scope as tool parameters (not in prompt).\n` +
    `Example: task({ mode: "${modes[0]}", intent_kd: "knowledge/intent-<name>-<YYYY-MM-DD>.md", session_date: "YYYY-MM-DD", scope: "<free-text, max 200 chars>" })\n` +
    `Modes: ${modes.join(", ")}`;

  return cachedHint;
}

// ---------------------------------------------------------------------------
// Plugin entry point
// ---------------------------------------------------------------------------

export default async function delegationGatePlugin() {
  logToFile("PLUGIN_LOADED", "delegation-gate initializing");
  return {
    // -----------------------------------------------------------------------
    // Hook 1: Enhance task tool description with format hint
    // -----------------------------------------------------------------------
    // Description enhancement + schema property injection.
    // Adds mode, intent_kd, session_date, scope as actual tool parameters
    // so the model can pass them directly in tool call args.

    "tool.definition": async (input, output) => {
      if (input.toolID !== "task") return;

      const hint = buildDescriptionHint();
      const existing = output.description || "";
      output.description = existing
        ? `${existing}\n\n${hint}`
        : hint;

      // Add structured fields to parameters schema
      if (output.parameters && typeof output.parameters === "object") {
        if (!output.parameters.properties) {
          output.parameters.properties = {};
        }
        output.parameters.properties.mode = {
          type: "string",
          description: "Dispatch mode",
          enum: [...VALID_MODES],
        };
        output.parameters.properties.intent_kd = {
          type: "string",
          description: "Path to intent KD: knowledge/intent-<name>-<YYYY-MM-DD>.md",
        };
        output.parameters.properties.session_date = {
          type: "string",
          description: "Session date: YYYY-MM-DD",
        };
        output.parameters.properties.scope = {
          type: "string",
          description: "Work context description, max 200 chars",
        };
      }
    },

    // -----------------------------------------------------------------------
    // Hook 2: Transform/guide dispatches before execution
    // -----------------------------------------------------------------------
    // Four paths:
    //   PATH 1 — Structured (mode + intent_kd + session_date)
    //   FR-04  — Mode present, missing required fields
    //   R001   — Partial fields (no mode)
    //   PATH 2 — Free-text extraction
    //   PATH 3 — No dispatch fields (passthrough)

    "tool.execute.before": async (ctx, output) => {
      if (ctx.tool !== "task") return;
      if (!output.args || typeof output.args !== "object") return;

      const args = output.args;

      logToFile(
        "RECEIVED",
        `mode=${args.mode || "(none)"} intent_kd=${args.intent_kd ? args.intent_kd.replace("knowledge/", "") : "(none)"} session_date=${args.session_date || "(none)"}`,
      );

      // FR-03: Extract fields from _dispatch_confirmation when primary fields empty
      if ((!args.mode || !args.intent_kd || !args.session_date) && args._dispatch_confirmation) {
        const conf = args._dispatch_confirmation;
        if (!args.mode && conf.mode) args.mode = conf.mode;
        if (!args.intent_kd && conf.intent_kd) args.intent_kd = conf.intent_kd;
        if (!args.session_date && conf.session_date) args.session_date = conf.session_date;
        delete args._dispatch_confirmation;
      }

      // --- PATH 1: Structured dispatch ---
      if (args.mode && args.intent_kd && args.session_date) {
        // Absorbed validation: intent_kd path format
        if (!INTENT_KD_PATTERN.test(args.intent_kd)) {
          const err = buildDelegationGateError("INVALID_INTENT_KD_PATH", {
            intent_kd: args.intent_kd,
          });
          logToFile("REJECTED", `${err.code}: intent_kd="${args.intent_kd}"`);
          applyCircuitBreaker(err, args.mode);
          throw err;
        }

        // Absorbed validation: session_date format
        if (!SESSION_DATE_PATTERN.test(args.session_date)) {
          const err = buildDelegationGateError("INVALID_SESSION_DATE", {
            session_date: args.session_date,
          });
          logToFile("REJECTED", `${err.code}: session_date="${args.session_date}"`);
          applyCircuitBreaker(err, args.mode);
          throw err;
        }

        // Absorbed validation: scope is mandatory
        if (!args.scope || typeof args.scope !== "string" || !args.scope.trim()) {
          const fieldsReceived = {
            mode: args.mode,
            intent_kd: args.intent_kd,
            session_date: args.session_date,
          };
          if (args.scope !== undefined) fieldsReceived.scope = args.scope;
          const err = buildDelegationGateError("MISSING_SCOPE", fieldsReceived);
          logToFile("REJECTED", `${err.code}: ${err.message} | received: ${JSON.stringify(fieldsReceived)}`);
          applyCircuitBreaker(err, args.mode);
          throw err;
        }

        await resolveStructuredDispatch(args, output);
        return;
      }

      // --- FR-04: Mode present, missing required fields ---
      if (args.mode && (!args.intent_kd || !args.session_date)) {
        const fieldsReceived = { mode: args.mode };
        if (args.intent_kd) fieldsReceived.intent_kd = args.intent_kd;
        if (args.session_date) fieldsReceived.session_date = args.session_date;
        if (args.scope) fieldsReceived.scope = args.scope;
        const err = buildDelegationGateError("MISSING_REQUIRED_FIELDS", fieldsReceived);
        logToFile("REJECTED", `${err.code}: ${err.message} | received: ${JSON.stringify(fieldsReceived)}`);
        applyCircuitBreaker(err, args.mode);
        throw err;
      }

      // --- R001: Partial fields — has intent_kd/session_date but no mode ---
      if ((args.intent_kd || args.session_date) && !args.mode) {
        const fieldsReceived = {};
        if (args.intent_kd) fieldsReceived.intent_kd = args.intent_kd;
        if (args.session_date) fieldsReceived.session_date = args.session_date;
        if (args.scope) fieldsReceived.scope = args.scope;
        const err = buildDelegationGateError("MISSING_MODE", fieldsReceived);
        logToFile("REJECTED", `${err.code}: ${err.message} | received: ${JSON.stringify(fieldsReceived)}`);
        applyCircuitBreaker(err, null);
        throw err;
      }

      // --- PATH 2: Free-text dispatch ---
      if (args.prompt || args.description || args.subagent_type) {
        const textContent = [args.prompt, args.description, args.subagent_type]
          .filter(Boolean).join(" ");
        const hasFieldKeywords = /(?:\b(mode|intent_kd|session_date)\b\s*"?\s*[:=])/gi.test(textContent);

        if (hasFieldKeywords) {
          const extracted = extractFieldsFromPrompt(textContent);

          if (extracted.mode && extracted.intent_kd && extracted.session_date) {
            logToFile(
              "EXTRACTED",
              `mode=${extracted.mode} intent_kd=${extracted.intent_kd} session_date=${extracted.session_date}`,
            );

            args.mode = extracted.mode;
            args.intent_kd = extracted.intent_kd;
            args.session_date = extracted.session_date;

            // Scope is mandatory for extracted dispatches
            if (!extracted.scope || !extracted.scope.trim()) {
              const fieldsReceived = {
                mode: extracted.mode,
                intent_kd: extracted.intent_kd,
                session_date: extracted.session_date,
              };
              const err = buildDelegationGateError("MISSING_SCOPE", fieldsReceived);
              logToFile("REJECTED", `${err.code}: ${err.message} | received: ${JSON.stringify(fieldsReceived)}`);
              applyCircuitBreaker(err, extracted.mode);
              throw err;
            }

            // Validate scope length before dispatch
            if (extracted.scope.length > SCOPE_CHAR_LIMIT) {
              const err = buildDelegationGateError("SCOPE_TOO_LONG", {
                mode: extracted.mode,
                intent_kd: extracted.intent_kd,
                session_date: extracted.session_date,
                scopeLength: extracted.scope.length,
              });
              logToFile("REJECTED", `${err.code}: scope length=${extracted.scope.length}`);
              applyCircuitBreaker(err, extracted.mode);
              throw err;
            }

            // Pass extracted scope to args (template uses {{scope}})
            if (extracted.scope) {
              args.scope = extracted.scope;
            }

            await resolveStructuredDispatch(args, output);

            return;
          }

          const err = buildDelegationGateError("FIELDS_IN_PROMPT");
          logToFile("REJECTED", `${err.code}: ${err.message}`);
          applyCircuitBreaker(err, extracted.mode || null);
          throw err;
        }

        const err = buildDelegationGateError("MISSING_ALL_FIELDS");
        logToFile("REJECTED", `${err.code}: ${err.message}`);
        applyCircuitBreaker(err, null);
        throw err;
      }

      logToFile("PASSED", "no dispatch fields");

      // --- PATH 3: No dispatch fields — pass through ---
      return;
    },
  };
}

delegationGatePlugin.resetRejectionState = resetRejectionState;
