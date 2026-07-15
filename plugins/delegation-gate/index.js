/**
 * Delegation Gate Plugin — Prompt Content Validator
 *
 * Validates that task tool prompts contain only KD path references and
 * template keywords. Blocks free-form injection, code blocks, and
 * foreign file paths.
 *
 * Hook: tool.execute.before on `task` only.
 * No tool.definition hook — zero schema mutations.
 *
 * Environment:
 *   DELEGATION_GATE_DEBUG=true — file logging
 */

import fs from "fs";
import path from "path";
import os from "os";

// --- Logging ---

const LOG_DIR =
  process.env._DELEGATION_GATE_LOG_DIR ||
  path.join(os.homedir(), ".config", "opencode", "logs");
const LOG_FILE = path.join(LOG_DIR, "delegation-gate.log");

function log(event, details) {
  if (!process.env.DELEGATION_GATE_DEBUG) return;
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, `[DELEGATION-GATE] ${new Date().toISOString()} | ${event} | ${details}\n`);
  } catch (_) {}
}

// --- Error class ---

class DelegationGateError extends Error {
  constructor({ code, message, guidance }) {
    super(message);
    this.name = "DelegationGateError";
    this.code = code;
    this.guidance = guidance;
  }
}

const ERRORS = Object.freeze({
  CODE_BLOCK: Object.freeze({
    code: "CODE_BLOCK",
    message: "Prompt contains code blocks. Dispatch templates do not include code.",
    guidance: "Remove code blocks from the prompt. Use structured dispatch fields only.",
  }),
  FOREIGN_PATH: Object.freeze({
    code: "FOREIGN_PATH",
    message: "Prompt contains file paths outside knowledge/.",
    guidance: "Only knowledge/*.md references are allowed in dispatch prompts.",
  }),
  BARE_KD_PATH: Object.freeze({
    code: "BARE_KD_PATH",
    message: "Prompt is a bare KD path without dispatch structure.",
    guidance: "Use the delegation-gate template format: DISPATCH TO / ACTION / KDS / RETURN / ACCEPTANCE.",
  }),
  INJECTED_INSTRUCTION: Object.freeze({
    code: "INJECTED_INSTRUCTION",
    message: "Prompt contains instructions outside the dispatch template.",
    guidance: "Remove free-form instructions. The dispatch template provides all instructions to the subagent.",
  }),
});

// --- Constants ---

const TEMPLATE_KEYWORDS = [
  "DISPATCH TO:", "ACTION:", "ARTIFACT:", "SCOPE:",
  "KDS:", "RETURN:", "ACCEPTANCE:", "MODE:",
];

const IMPERATIVE_VERBS = [
  "read", "write", "send", "return", "copy", "fetch",
  "execute", "run", "delete", "remove", "create", "make",
  "build", "compile", "install",
];

const KD_PATH_PATTERN = /knowledge\/[^\/\s]+\.(md|txt)/i;
// Catches absolute paths (/etc/passwd), Windows paths (C:\...), ./relative paths,
// and bare relative paths (agents/overseer.md, src/main.js)
const FOREIGN_PATH_PATTERN =
  /(?:^|\s)(\/\S+|[a-zA-Z]:\\\S+|(?:\.\.?\/)+\S+|\w+\/[\w./-]*\.\w{1,10})\b/;

// --- Validation ---

function hasCodeBlocks(text) {
  return text.includes("```") || text.includes("~~~");
}

function hasForeignPaths(text) {
  const lines = text.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (TEMPLATE_KEYWORDS.some(kw => trimmed.startsWith(kw))) continue;
    if (KD_PATH_PATTERN.test(trimmed)) continue;
    if (FOREIGN_PATH_PATTERN.test(trimmed)) return true;
  }
  return false;
}

function isBareKDPath(text) {
  const trimmed = text.trim();
  if (!TEMPLATE_KEYWORDS.some(kw => trimmed.startsWith(kw))) {
    if (/^knowledge\/\S+\.md$/i.test(trimmed)) return true;
  }
  return false;
}

function hasInjectedInstructions(text) {
  const lines = text.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (TEMPLATE_KEYWORDS.some(kw => trimmed.startsWith(kw))) continue;
    if (KD_PATH_PATTERN.test(trimmed)) continue;
    const words = trimmed.toLowerCase().split(/\s+/);
    if (words.some(w => IMPERATIVE_VERBS.includes(w))) return true;
  }
  return false;
}

// --- Plugin ---

export default async function delegationGatePlugin() {
  log("PLUGIN_LOADED", "delegation-gate initializing");
  return {
    "tool.execute.before": async (ctx, output) => {
      if (ctx.tool !== "task") return;

      const prompt = output.args?.prompt;
      if (!prompt || typeof prompt !== "string") return;

      log("RECEIVED", `prompt_length=${prompt.length}`);

      if (hasCodeBlocks(prompt)) {
        const err = new DelegationGateError(ERRORS.CODE_BLOCK);
        log("REJECTED", err.code);
        throw err;
      }

      if (hasForeignPaths(prompt)) {
        const err = new DelegationGateError(ERRORS.FOREIGN_PATH);
        log("REJECTED", err.code);
        throw err;
      }

      if (isBareKDPath(prompt)) {
        const err = new DelegationGateError(ERRORS.BARE_KD_PATH);
        log("REJECTED", err.code);
        throw err;
      }

      // Check for injected instructions when prompt has KD refs or template keywords
      const hasKDRefs = KD_PATH_PATTERN.test(prompt);
      const hasKeywords = TEMPLATE_KEYWORDS.some(kw => prompt.includes(kw));
      if ((hasKeywords || hasKDRefs) && hasInjectedInstructions(prompt)) {
        const err = new DelegationGateError(ERRORS.INJECTED_INSTRUCTION);
        log("REJECTED", err.code);
        throw err;
      }

      log("PASSED", "prompt validated");
    },
  };
}

export { DelegationGateError, ERRORS };
