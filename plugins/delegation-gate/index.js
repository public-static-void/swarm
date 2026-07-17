// Delegation-Gate Plugin — HOW: prompt validation, field extraction, template injection
//
// Hooks: tool.execute.before (task tool only)
// Scope: All dispatching agents (Overseer, Artisan, any agent that delegates via task).
//
// Extracts structured fields from delegation prompts, validates completeness,
// loads the appropriate template from plugins/delegation-gate/templates/, renders
// it with the extracted fields, and replaces the prompt with the rendered output.
// Also injects delegation format into tool docs so agents know how to structure
// prompts before the first delegation attempt.
//
// This plugin owns delegation prompt formatting. Protocol-gate owns state machine
// enforcement (WHEN). They are independent — either can be deactivated without
// breaking the other.
//
// Debug logging: set DELEGATION_GATE_DEBUG=1 in environment to enable.
import { appendFileSync, mkdirSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const PLUGIN_DIR = dirname(__filename);

class DelegationGateError extends Error {
  constructor(code, message, guidance) {
    super(message);
    this.name = "DelegationGateError";
    this.code = code;
    this.guidance = guidance;
  }
}

const ERRORS = {
  CODE_BLOCK: { code: "CODE_BLOCK", message: "Code blocks detected in prompt", guidance: "Remove all code blocks from delegation prompt" },
  FOREIGN_PATH: { code: "FOREIGN_PATH", message: "Foreign paths detected", guidance: "Use only knowledge/*.md paths" },
  BARE_KD_PATH: { code: "BARE_KD_PATH", message: "Bare KD path without structured fields", guidance: "Include all required fields: agent, mode, kd_paths, scope, result_kd" },
  MISSING_STRUCTURED_FIELDS: { code: "MISSING_STRUCTURED_FIELDS", message: "Missing required structured fields", guidance: "Include agent, mode, kd_paths, scope, result_kd" },
  INVALID_SCOPE: { code: "INVALID_SCOPE", message: "Scope validation failed", guidance: "Scope must be a concise description (1-200 chars). No file paths, URLs, multi-sentence instructions, or negative framing" },
  INVALID_RESULT_KD: { code: "INVALID_RESULT_KD", message: "Invalid result KD path", guidance: "Result KD must match knowledge/*.md pattern" },
  MISSING_KD_REFERENCE: { code: "MISSING_KD_REFERENCE", message: "No KD path reference found", guidance: "Include at least one knowledge/*.md path" }
};

let _logFile = null;

function getLogFile() {
  if (!_logFile) {
    const logDir = join(PLUGIN_DIR, "..", "logs");
    try { mkdirSync(logDir, { recursive: true }); } catch (_) {}
    _logFile = join(logDir, "delegation-gate.log");
  }
  return _logFile;
}

function debug(msg) {
  if (process.env.DELEGATION_GATE_DEBUG) {
    try {
      appendFileSync(getLogFile(), `[${new Date().toISOString()}] [delegation-gate] ${msg}\n`);
    } catch (_) {
      process.stderr.write(`[delegation-gate] ${msg}\n`);
    }
  }
}

function loadConfig() {
  try {
    const configPath = join(PLUGIN_DIR, "config.json");
    return JSON.parse(readFileSync(configPath, "utf8"));
  } catch (e) {
    debug("Config load failed, using defaults");
    return { templatesDir: "templates" };
  }
}

function loadTemplates(config) {
  const templates = {};
  const templatesDir = config.templatesDir || "templates";

  const defaultTemplates = {
    explore: "Load the kd-system skill. Read the INTENT KD at {intent_kd}. Explore the codebase per the scope above. Produce an EXPLORATION KD at {result_kd}.",
    investigate: "Load the kd-system skill. Read the INTENT KD at {intent_kd}. Investigate the codebase per the scope above. Produce an ANALYSIS KD at {result_kd}.",
    align: "Load the kd-system skill. Read the INTENT KD at {intent_kd}. Align the requirements per the scope above. Produce a SPEC KD at {result_kd}.",
    decompose: "Load the kd-system skill. Read the INTENT KD at {intent_kd}. Decompose the project per the scope above. Produce a PLAN KD at {result_kd}.",
    swarm: "Load the kd-system skill. Read the INTENT KD at {intent_kd}. Execute the swarm phase per the scope above. Produce an IMPLEMENTATION SUMMARY KD at {result_kd}.",
    verify: "Load the kd-system skill. Read the INTENT KD at {intent_kd}. Verify the implementation per the scope above. Produce REVIEW and AUDIT KDs at {result_kd}.",
    extract: "Load the kd-system skill. Read the INTENT KD at {intent_kd}. Extract and compose the documentation per the scope above. Produce a COMPOSED KD at {result_kd}.",
    evolve: "Load the kd-system skill. Read the INTENT KD at {intent_kd}. Evolve the process per the scope above. Produce a PROCESS KD at {result_kd}.",
    commit: "Load the kd-system skill. Read the INTENT KD at {intent_kd}. Commit the changes per the scope above.",
    checkpoint: "Load the kd-system skill. Read the INTENT KD at {intent_kd}. Create a checkpoint commit per the scope above.",
    preflight: "Load the kd-system skill. Read the INTENT KD at {intent_kd}. Perform preflight checks per the scope above. Produce a PLAN KD at {result_kd}."
  };

  for (const [mode, content] of Object.entries(defaultTemplates)) {
    try {
      const templatePath = join(PLUGIN_DIR, templatesDir, `${mode}.json`);
      const templateData = JSON.parse(readFileSync(templatePath, "utf8"));
      if (!templateData.template || typeof templateData.template !== "string") {
        debug(`Template ${mode}: disk file missing 'template' field — using fallback`);
        templates[mode] = `DISPATCH TO: {agent}\nMODE: ${mode}\nINTENT KD: {intent_kd}\nSESSION DATE: {session_date}\nSCOPE: {scope}\nRESULT KD: {result_kd}\n\n---\n\n${content}`;
      } else {
        debug(`Template ${mode}: loaded from disk`);
        templates[mode] = templateData.template;
      }
    } catch (e) {
      debug(`Template ${mode}: not found on disk — using fallback`);
      templates[mode] = `DISPATCH TO: {agent}\nMODE: ${mode}\nINTENT KD: {intent_kd}\nSESSION DATE: {session_date}\nSCOPE: {scope}\nRESULT KD: {result_kd}\n\n---\n\n${content}`;
    }
  }

  return templates;
}

function extractFieldsFromPrompt(prompt) {
  const fields = {};
  const lines = prompt.split("\n");
  for (const line of lines) {
    // Templates use "DISPATCH TO:" but agents may send raw "AGENT:" format — accept both
    const agentMatch = line.match(/^(AGENT|DISPATCH TO):\s*(.*)/i);
    if (agentMatch) {
      fields["agent"] = agentMatch[2].trim();
      continue;
    }
    const match = line.match(/^(MODE|INTENT KD|SESSION DATE|SCOPE|RESULT KD|KD PATHS):\s*(.*)/i);
    if (match) {
      fields[match[1].toLowerCase().replace(/\s+/g, "_")] = match[2].trim();
    }
  }
  return fields;
}

// Scope must be a concise description, not free-form instructions.
// These patterns detect scope that's been abused as a job-assignment vector.
function validateScope(scope) {
  if (!scope || scope.trim() === "") {
    return false;
  }
  if (scope.length > 200) {
    return false;
  }
  const negativePatterns = /\b(do not|don't|avoid|never|must not|cannot|can't|shouldn't|wont|won't)\b/i;
  if (negativePatterns.test(scope)) {
    return false;
  }
  // File paths indicate the scope contains specific file references — too detailed for a description
  const filePathPattern = /\b\S+\.(md|js|ts|json|yaml|yml|py|rb|go|rs|java|c|cpp|h|sh|bash|txt|csv|xml|html|css|scss)\b/i;
  if (filePathPattern.test(scope)) {
    return false;
  }
  // URLs indicate the scope contains external references — should be a description, not a link
  const urlPattern = /https?:\/\//i;
  if (urlPattern.test(scope)) {
    return false;
  }
  // Multiple sentences indicate multi-step instructions — scope should be a single phrase
  const multiSentencePattern = /[.!?]\s+[A-Z]/;
  if (multiSentencePattern.test(scope)) {
    return false;
  }
  // Multi-step conjunctions indicate procedural instructions
  const multiStepPattern = /\b(and then|after that|first .+ then|next .+ then)\b/i;
  if (multiStepPattern.test(scope)) {
    return false;
  }
  return true;
}

function validateKDPath(path) {
  return /^knowledge\/[a-zA-Z0-9_-]+\.md$/.test(path);
}

function detectCodeBlocks(prompt) {
  return /```[\s\S]*?```|~~~[\s\S]*?~~~/.test(prompt);
}

function detectForeignPaths(prompt) {
  const lines = prompt.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || /^(AGENT|DISPATCH TO|MODE|INTENT KD|SESSION DATE|SCOPE|RESULT KD|KD PATHS):/i.test(trimmed)) continue;
    if (/^knowledge\/[a-zA-Z0-9_-]+\.md$/i.test(trimmed)) continue;
    if (/^\//.test(trimmed)) return true;
    if (/^[A-Z]:\\/.test(trimmed)) return true;
    if (/\.\.[\/\\]/.test(trimmed)) return true;
    // Allow lines containing knowledge/*.md paths (positive whitelist)
    // This handles KD paths embedded in body text from template rendering or agent text
    if (/knowledge\/[a-zA-Z0-9_-]+\.md/i.test(trimmed)) continue;
    // Relative paths with file extensions are foreign — knowledge/*.md paths are the only allowed format
    if (/\.\w{1,5}$/.test(trimmed)) return true;
  }
  return false;
}

function isBareKDPath(prompt) {
  return /^knowledge\/[a-zA-Z0-9_-]+\.md$/.test(prompt.trim());
}

function renderTemplate(template, fields) {
  let result = template;
  for (const [key, value] of Object.entries(fields)) {
    result = result.replace(new RegExp(`\\{${key}\\}`, "g"), value);
  }
  return result;
}

function injectToolDocs(output) {
  const formatHint = `
Delegation Prompt Format:
DISPATCH TO: <target_agent>
MODE: <dispatch_mode>
INTENT KD: <intent_kd_path>
SESSION DATE: <session_date>
SCOPE: <scope_description>
RESULT KD: <result_kd_path>
KD PATHS: <kd_path1>, <kd_path2>
`;

  if (!output.args) output.args = {};
  output.args.description = (output.args.description || "") + formatHint;
}

export default {
  id: "delegation-gate",
  server: async function delegationGateServer(input, options) {
    const config = loadConfig();
    const templates = loadTemplates(config);

    debug(`Loaded config: templatesDir=${config.templatesDir || "templates"}`);
    debug(`Loaded ${Object.keys(templates).length} templates: ${Object.keys(templates).join(", ")}`);

    // --- Hook: tool.execute.before ---
    async function toolExecuteBefore(hookInput, output) {
      const { tool, sessionID, callID } = hookInput;
      // opencode API: tool args live on output.args, not input.args
      const args = output.args || {};

      if (tool !== "task") return;

      debug(`tool.execute.before: task tool — processing delegation prompt`);

      injectToolDocs(output);

      const prompt = args?.prompt || "";

      if (isBareKDPath(prompt)) {
        debug(`VALIDATION FAILED: bare KD path without structured fields`);
        throw new DelegationGateError(ERRORS.BARE_KD_PATH.code, ERRORS.BARE_KD_PATH.message, ERRORS.BARE_KD_PATH.guidance);
      }

      if (detectCodeBlocks(prompt)) {
        debug(`VALIDATION FAILED: code blocks detected in prompt`);
        throw new DelegationGateError(ERRORS.CODE_BLOCK.code, ERRORS.CODE_BLOCK.message, ERRORS.CODE_BLOCK.guidance);
      }

      if (detectForeignPaths(prompt)) {
        debug(`VALIDATION FAILED: foreign paths detected in prompt`);
        throw new DelegationGateError(ERRORS.FOREIGN_PATH.code, ERRORS.FOREIGN_PATH.message, ERRORS.FOREIGN_PATH.guidance);
      }

      const fields = extractFieldsFromPrompt(prompt);
      const requiredFields = ["agent", "mode", "intent_kd", "session_date", "scope", "result_kd"];

      debug(`Extracted fields: ${Object.keys(fields).join(", ")}`);

      for (const field of requiredFields) {
        if (fields[field] === undefined || fields[field] === null) {
          debug(`VALIDATION FAILED: missing required field '${field}'`);
          throw new DelegationGateError(ERRORS.MISSING_STRUCTURED_FIELDS.code, ERRORS.MISSING_STRUCTURED_FIELDS.message, ERRORS.MISSING_STRUCTURED_FIELDS.guidance);
        }
      }

      if (!validateScope(fields.scope)) {
        debug(`VALIDATION FAILED: scope validation failed (len=${fields.scope.length}, content='${fields.scope.substring(0, 50)}...')`);
        throw new DelegationGateError(ERRORS.INVALID_SCOPE.code, ERRORS.INVALID_SCOPE.message, ERRORS.INVALID_SCOPE.guidance);
      }

      if (!validateKDPath(fields.result_kd)) {
        debug(`VALIDATION FAILED: invalid result KD path '${fields.result_kd}'`);
        throw new DelegationGateError(ERRORS.INVALID_RESULT_KD.code, ERRORS.INVALID_RESULT_KD.message, ERRORS.INVALID_RESULT_KD.guidance);
      }

      if (fields.kd_paths) {
        const paths = fields.kd_paths.split(",").map(p => p.trim());
        for (const path of paths) {
          if (!validateKDPath(path)) {
            debug(`VALIDATION FAILED: invalid KD path '${path}'`);
            throw new DelegationGateError(ERRORS.FOREIGN_PATH.code, ERRORS.FOREIGN_PATH.message, ERRORS.FOREIGN_PATH.guidance);
          }
        }
      }

      const template = templates[fields.mode];
      if (!template) {
        debug(`VALIDATION FAILED: no template found for mode '${fields.mode}'`);
        throw new DelegationGateError(ERRORS.MISSING_STRUCTURED_FIELDS.code, `No template found for mode: ${fields.mode}`, "Check plugins/delegation-gate/templates directory");
      }

      debug(`Rendering template for mode='${fields.mode}', agent='${fields.agent}'`);
      const rendered = renderTemplate(template, fields);
      output.args.prompt = rendered;
      debug(`Prompt rendered successfully (${rendered.length} chars)`);
    }

    return {
      "tool.execute.before": toolExecuteBefore,
      // Test-access properties
      DelegationGateError,
      ERRORS,
      templates
    };
  }
};
