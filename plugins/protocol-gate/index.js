/**
 * Protocol Gate Plugin — Overseer Protocol Enforcement
 *
 * Three-phase lifecycle for Overseer sessions:
 *   PROTOCOL_NOT_LOADED → PROTOCOL_LOADED → INTENT_WRITTEN
 *
 * Hooks: chat.params (identity tracking), tool.execute.before (gating).
 * Non-Overseer agents: fail-open.
 *
 * Environment:
 *   PROTOCOL_GATE_DEBUG=true — file logging
 */

import fs from "fs";
import path from "path";
import os from "os";

// --- Phases ---

const PROTOCOL_NOT_LOADED = 0;
const PROTOCOL_LOADED = 1;
const INTENT_WRITTEN = 2;

// --- Lifecycle keywords ---

const LIFECYCLE_KEYWORDS = [
  "INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN",
  "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "COMMIT", "REPORT",
];

// --- Logging ---

const LOG_DIR =
  process.env._PROTOCOL_GATE_LOG_DIR ||
  path.join(os.homedir(), ".config", "opencode", "logs");
const LOG_FILE = path.join(LOG_DIR, "protocol-gate.log");

function log(event, details) {
  if (!process.env.PROTOCOL_GATE_DEBUG) return;
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, `[PROTOCOL-GATE] ${new Date().toISOString()} | ${event} | ${details}\n`);
  } catch (_) {}
}

// --- Session state ---

const sessionAgentMap = new Map();
const sessionPhaseMap = new Map();

// --- Helpers ---

const INTENT_KD_PATTERN = /knowledge\/intent-.+\.md$/;

function isIntentKD(filePath) {
  return INTENT_KD_PATTERN.test((filePath || "").replace(/^\.\//, ""));
}

function containsLifecycleKeywords(items) {
  if (!Array.isArray(items)) return false;
  const text = items
    .map((i) => (typeof i === "string" ? i : i?.content || ""))
    .join(" ")
    .toUpperCase();
  return LIFECYCLE_KEYWORDS.some((kw) => text.includes(kw));
}

function extractTodoItems(args) {
  if (!args || typeof args !== "object") return null;
  for (const key of ["items", "todos", "tasks", "entries"]) {
    if (Array.isArray(args[key])) return args[key];
  }
  for (const key of Object.keys(args)) {
    if (Array.isArray(args[key])) return args[key];
  }
  return null;
}

// --- Error class ---

class ProtocolGateError extends Error {
  constructor({ code, message, guidance }) {
    super(message);
    this.name = "ProtocolGateError";
    this.code = code;
    this.guidance = guidance;
  }
}

const ERRORS = Object.freeze({
  BLOCKED_NOT_LOADED: Object.freeze({
    code: "BLOCKED_NOT_LOADED",
    message: "Load the protocol via todowrite first.",
    guidance: "Call todowrite with items containing lifecycle keywords (INTENT, EXPLORE, etc.) before using file tools.",
  }),
  BLOCKED_NO_LIFECYCLE: Object.freeze({
    code: "BLOCKED_NO_LIFECYCLE",
    message: "todowrite must include lifecycle protocol keywords.",
    guidance: "Include at least one keyword: INTENT, PREFLIGHT, EXPLORE, INVESTIGATE, ALIGN, DECOMPOSE, SWARM, VERIFY, EXTRACT, EVOLVE, COMMIT, REPORT.",
  }),
  BLOCKED_NO_INTENT: Object.freeze({
    code: "BLOCKED_NO_INTENT",
    message: "Write the INTENT KD first.",
    guidance: "Write knowledge/intent-<name>-<YYYY-MM-DD>.md before accessing other files.",
  }),
});

function reject(ctx, output, errorKey) {
  const err = ERRORS[errorKey];
  log("BLOCKED", `session=${ctx.sessionID} tool=${ctx.tool} code=${err.code}`);
  output.error = { code: err.code, message: err.message, guidance: err.guidance };
}

// --- Plugin ---

export default async function protocolGatePlugin() {
  log("PLUGIN_LOADED", "protocol-gate initializing");

  return {
    "chat.params": async (input, _output) => {
      if (!input.sessionID || !input.agent) return;
      sessionAgentMap.set(input.sessionID, input.agent);
      if (input.agent === "overseer") {
        if (!sessionPhaseMap.has(input.sessionID)) {
          sessionPhaseMap.set(input.sessionID, PROTOCOL_NOT_LOADED);
          log("PHASE_INIT", `session=${input.sessionID} phase=PROTOCOL_NOT_LOADED`);
        }
      } else {
        sessionPhaseMap.delete(input.sessionID);
      }
    },

    "tool.execute.before": async (ctx, output) => {
      const { tool, sessionID } = ctx;
      const agent = sessionAgentMap.get(sessionID);
      if (agent !== "overseer") return;
      const phase = sessionPhaseMap.get(sessionID);
      if (phase === undefined) return;

      // --- PROTOCOL_NOT_LOADED: block everything except lifecycle todowrite ---
      if (phase === PROTOCOL_NOT_LOADED) {
        if (tool === "todowrite") {
          const items = extractTodoItems(output.args);
          if (containsLifecycleKeywords(items)) {
            sessionPhaseMap.set(sessionID, PROTOCOL_LOADED);
            log("PHASE_ADVANCE", `session=${sessionID} → PROTOCOL_LOADED`);
            return;
          }
          reject(ctx, output, "BLOCKED_NO_LIFECYCLE");
          return;
        }
        reject(ctx, output, "BLOCKED_NOT_LOADED");
        return;
      }

      // --- PROTOCOL_LOADED: allow todowrite + intent KD read/write only ---
      if (phase === PROTOCOL_LOADED) {
        if (tool === "todowrite") return;
        if (tool === "read" || tool === "write") {
          if (isIntentKD(output.args?.filePath)) {
            if (tool === "write") {
              sessionPhaseMap.set(sessionID, INTENT_WRITTEN);
              log("PHASE_ADVANCE", `session=${sessionID} → INTENT_WRITTEN`);
            }
            return;
          }
        }
        reject(ctx, output, "BLOCKED_NO_INTENT");
        return;
      }

      // --- INTENT_WRITTEN: all tools allowed ---
      log("ALLOWED", `session=${sessionID} tool=${tool}`);
    },
  };
}

// Attach for test access — avoids named exports that poison the legacy plugin loader
protocolGatePlugin.PROTOCOL_NOT_LOADED = PROTOCOL_NOT_LOADED;
protocolGatePlugin.PROTOCOL_LOADED = PROTOCOL_LOADED;
protocolGatePlugin.INTENT_WRITTEN = INTENT_WRITTEN;
protocolGatePlugin.LIFECYCLE_KEYWORDS = LIFECYCLE_KEYWORDS;
protocolGatePlugin.containsLifecycleKeywords = containsLifecycleKeywords;
protocolGatePlugin.extractTodoItems = extractTodoItems;
protocolGatePlugin.isIntentKD = isIntentKD;
protocolGatePlugin.sessionAgentMap = sessionAgentMap;
protocolGatePlugin.sessionPhaseMap = sessionPhaseMap;
protocolGatePlugin.ProtocolGateError = ProtocolGateError;
protocolGatePlugin.ERRORS = ERRORS;
