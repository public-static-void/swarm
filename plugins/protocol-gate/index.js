/**
 * Protocol Gate Plugin — Two-Step Structural Guard Rail
 *
 * Enforces a three-phase lifecycle for Overseer sessions:
 *   Phase 0 (Pre-todowrite): Block ALL tools except todowrite.
 *                              todowrite must contain lifecycle keywords to advance.
 *   Phase 1 (Pre-intent):    Block ALL tools except todowrite, read/write for intent KDs.
 *                              write to intent KD advances to Phase 2.
 *   Phase 2 (Post-intent):   Allow all tools (normal operation).
 *
 * Non-Overseer agents: fail-open (no blocking).
 *
 * Hooks:
 *   1. chat.params — captures sessionID → agent mapping
 *   2. tool.execute.before — enforces phase-based tool gating
 *
 * Environment variables:
 *   PROTOCOL_GATE_DEBUG=true — enables file logging
 *   _PROTOCOL_GATE_LOG_DIR — override log directory
 */

import fs from "fs";
import path from "path";
import os from "os";

// ---------------------------------------------------------------------------
// Phase constants
// ---------------------------------------------------------------------------

const PHASE_0_PRE_TODOWRITE = 0;
const PHASE_1_PRE_INTENT = 1;
const PHASE_2_POST_INTENT = 2;

// ---------------------------------------------------------------------------
// Lifecycle keywords — the 12 phases of the Overseer protocol
// ---------------------------------------------------------------------------

const LIFECYCLE_KEYWORDS = [
  "INTENT",
  "PREFLIGHT",
  "EXPLORE",
  "INVESTIGATE",
  "ALIGN",
  "DECOMPOSE",
  "SWARM",
  "VERIFY",
  "EXTRACT",
  "EVOLVE",
  "COMMIT",
  "REPORT",
];

// ---------------------------------------------------------------------------
// File logging
// ---------------------------------------------------------------------------

const LOG_DIR =
  process.env._PROTOCOL_GATE_LOG_DIR ||
  path.join(os.homedir(), ".config", "opencode", "logs");
const LOG_FILE = path.join(LOG_DIR, "protocol-gate.log");

function logToFile(event, details) {
  if (!process.env.PROTOCOL_GATE_DEBUG) return;
  try {
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    }
    const timestamp = new Date().toISOString();
    const line = `[PROTOCOL-GATE] ${timestamp} | ${event} | ${details}\n`;
    fs.appendFileSync(LOG_FILE, line);
  } catch (e) {
    // Silent fail — logging must never break the plugin
  }
}

// ---------------------------------------------------------------------------
// Agent identity tracking
// ---------------------------------------------------------------------------

/** Module-level map: sessionID → agent name. Populated by chat.params hook. */
const sessionAgentMap = new Map();

// ---------------------------------------------------------------------------
// Phase tracking
// ---------------------------------------------------------------------------

/**
 * Tracks the current phase for each Overseer session.
 * Starts at PHASE_0_PRE_TODOWRITE, advances through PHASE_1 → PHASE_2.
 */
const sessionPhaseMap = new Map();

// ---------------------------------------------------------------------------
// Intent KD pattern
// ---------------------------------------------------------------------------

const INTENT_KD_PATTERN = /knowledge\/intent-.+\.md$/;

function isIntentKD(filePath) {
  const normalized = filePath.replace(/^\.\//, "");
  return INTENT_KD_PATTERN.test(normalized);
}

// ---------------------------------------------------------------------------
// Lifecycle keyword detection
// ---------------------------------------------------------------------------

function containsLifecycleKeywords(items) {
  if (!Array.isArray(items)) return false;
  const text = items
    .map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object") return item.content || "";
      return "";
    })
    .join(" ")
    .toUpperCase();
  return LIFECYCLE_KEYWORDS.some((kw) => text.includes(kw));
}

// ---------------------------------------------------------------------------
// Protocol error class
// ---------------------------------------------------------------------------

class ProtocolGateError extends Error {
  constructor({ code, message, guidance, fields }) {
    super(message);
    this.name = "ProtocolGateError";
    this.code = code;
    this.guidance = guidance;
    this.fields = fields;
  }
}

const PROTOCOL_ERRORS = Object.freeze({
  BLOCKED_NO_LIFECYCLE: Object.freeze({
    code: "BLOCKED_NO_LIFECYCLE",
    message:
      "todowrite must include lifecycle protocol keywords (INTENT, PREFLIGHT, EXPLORE, etc.).",
    guidance:
      "Load the 12-phase lifecycle protocol before creating a todo list.",
  }),
  BLOCKED_PHASE_0: Object.freeze({
    code: "BLOCKED_PHASE_0",
    message: "Tool blocked: Phase 0 requires todowrite with lifecycle protocol.",
    guidance:
      "Call todowrite with items containing lifecycle keywords to advance.",
  }),
  BLOCKED_PHASE_1: Object.freeze({
    code: "BLOCKED_PHASE_1",
    message:
      "Tool blocked: Phase 1 restricts access to intent KD files only.",
    guidance:
      "Read or write knowledge/intent-*.md files, or use todowrite for updates.",
  }),
});

// ---------------------------------------------------------------------------
// Plugin entry point
// ---------------------------------------------------------------------------

export default async function protocolGatePlugin() {
  logToFile("PLUGIN_LOADED", "protocol-gate initializing");

  return {
    // -----------------------------------------------------------------------
    // Hook 1: Track agent identity via chat.params
    // -----------------------------------------------------------------------

    "chat.params": async (input, output) => {
      if (input.sessionID && input.agent) {
        sessionAgentMap.set(input.sessionID, input.agent);

        // Initialize phase for Overseer sessions
        if (input.agent === "overseer") {
          if (!sessionPhaseMap.has(input.sessionID)) {
            sessionPhaseMap.set(input.sessionID, PHASE_0_PRE_TODOWRITE);
            logToFile(
              "PHASE_INIT",
              `session=${input.sessionID} phase=0`,
            );
          }
        } else {
          // Non-overseer: clean up any stale phase entry
          sessionPhaseMap.delete(input.sessionID);
        }
      }
    },

    // -----------------------------------------------------------------------
    // Hook 2: Phase-based tool gating via tool.execute.before
    // -----------------------------------------------------------------------
    // All blocking happens here. Non-overseer agents pass through (fail-open).

    "tool.execute.before": async (ctx, output) => {
      const { tool, sessionID } = ctx;

      // Agent identity — fail-open for non-overseer
      const agent = sessionAgentMap.get(sessionID);
      if (agent !== "overseer") {
        return;
      }

      const phase = sessionPhaseMap.get(sessionID);

      // Unknown session — fail-open
      if (phase === undefined) {
        return;
      }

      // --- PHASE 0: Pre-todowrite ---
      // Block ALL tools except todowrite
      if (phase === PHASE_0_PRE_TODOWRITE) {
        if (tool !== "todowrite") {
          logToFile(
            "BLOCKED_PHASE_0",
            `session=${sessionID} tool=${tool}`,
          );
          output.error = {
            code: PROTOCOL_ERRORS.BLOCKED_PHASE_0.code,
            message: PROTOCOL_ERRORS.BLOCKED_PHASE_0.message,
            guidance: PROTOCOL_ERRORS.BLOCKED_PHASE_0.guidance,
          };
          return;
        }

        // todowrite: verify lifecycle keywords in items
        const items = output.args?.items;
        if (!containsLifecycleKeywords(items)) {
          logToFile(
            "BLOCKED_NO_LIFECYCLE",
            `session=${sessionID} items_missing_keywords`,
          );
          output.error = {
            code: PROTOCOL_ERRORS.BLOCKED_NO_LIFECYCLE.code,
            message: PROTOCOL_ERRORS.BLOCKED_NO_LIFECYCLE.message,
            guidance: PROTOCOL_ERRORS.BLOCKED_NO_LIFECYCLE.guidance,
          };
          return;
        }

        // Lifecycle keywords present — advance to Phase 1
        sessionPhaseMap.set(sessionID, PHASE_1_PRE_INTENT);
        logToFile(
          "PHASE_ADVANCE",
          `session=${sessionID} phase=0→1`,
        );
        return;
      }

      // --- PHASE 1: Pre-intent ---
      // Allow: todowrite, read/write for knowledge/intent-*.md
      // Block: everything else
      if (phase === PHASE_1_PRE_INTENT) {
        // todowrite always allowed for progress updates
        if (tool === "todowrite") {
          return;
        }

        // read/write for intent KD — allowed
        if (tool === "read" || tool === "write") {
          const filePath = output.args?.filePath || "";
          if (isIntentKD(filePath)) {
            // Write to intent KD advances to Phase 2
            if (tool === "write") {
              sessionPhaseMap.set(sessionID, PHASE_2_POST_INTENT);
              logToFile(
                "PHASE_ADVANCE",
                `session=${sessionID} phase=1→2 file=${filePath}`,
              );
            }
            return;
          }
        }

        // Everything else blocked
        logToFile(
          "BLOCKED_PHASE_1",
          `session=${sessionID} tool=${tool}`,
        );
        output.error = {
          code: PROTOCOL_ERRORS.BLOCKED_PHASE_1.code,
          message: PROTOCOL_ERRORS.BLOCKED_PHASE_1.message,
          guidance: PROTOCOL_ERRORS.BLOCKED_PHASE_1.guidance,
        };
        return;
      }

      // --- PHASE 2: Post-intent ---
      // All tools allowed — normal operation
      logToFile(
        "ALLOWED_PHASE_2",
        `session=${sessionID} tool=${tool}`,
      );
    },
  };
}

// Export for testing
export {
  PHASE_0_PRE_TODOWRITE,
  PHASE_1_PRE_INTENT,
  PHASE_2_POST_INTENT,
  LIFECYCLE_KEYWORDS,
  containsLifecycleKeywords,
  isIntentKD,
  sessionAgentMap,
  sessionPhaseMap,
  ProtocolGateError,
  PROTOCOL_ERRORS,
};
