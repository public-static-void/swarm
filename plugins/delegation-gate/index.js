import { readFileSync } from "fs";
import { join } from "path";

function delegationGatePlugin() {
  const config = loadConfig();
  const templates = loadTemplates(config);

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
    INVALID_SCOPE: { code: "INVALID_SCOPE", message: "Scope validation failed", guidance: "Scope must be 1-200 chars, no negative framing" },
    INVALID_RESULT_KD: { code: "INVALID_RESULT_KD", message: "Invalid result KD path", guidance: "Result KD must match knowledge/*.md pattern" },
    MISSING_KD_REFERENCE: { code: "MISSING_KD_REFERENCE", message: "No KD path reference found", guidance: "Include at least one knowledge/*.md path" }
  };

  function debug(msg) {
    if (process.env.DELEGATION_GATE_DEBUG) {
      console.log(`[delegation-gate] ${msg}`);
    }
  }

  function loadConfig() {
    try {
      const configPath = join(process.cwd(), "plugins", "delegation-gate", "config.json");
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
        const templatePath = join(process.cwd(), "plugins", "delegation-gate", templatesDir, `${mode}.json`);
        const templateData = JSON.parse(readFileSync(templatePath, "utf8"));
        templates[mode] = templateData.template;
      } catch (e) {
        templates[mode] = `DISPATCH TO: {agent}\nMODE: ${mode}\nINTENT KD: {intent_kd}\nSESSION DATE: {session_date}\nSCOPE: {scope}\nRESULT KD: {result_kd}\n\n---\n\n${content}`;
      }
    }

    return templates;
  }

  function extractFieldsFromPrompt(prompt) {
    const fields = {};
    const lines = prompt.split("\n");
    for (const line of lines) {
      const match = line.match(/^(AGENT|MODE|INTENT KD|SESSION DATE|SCOPE|RESULT KD|KD PATHS):\s*(.*)/i);
      if (match) {
        fields[match[1].toLowerCase().replace(/\s+/g, "_")] = match[2].trim();
      }
    }
    return fields;
  }

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
    return true;
  }

  function validateKDPath(path) {
    return /^knowledge\/[a-zA-Z0-9_-]+\.md$/.test(path);
  }

  function detectCodeBlocks(prompt) {
    return /```[\s\S]*?```|~~~[\s\S]*?~~~/.test(prompt);
  }

  function detectForeignPaths(prompt) {
    // Match absolute paths, Windows paths, or relative paths outside knowledge/
    // Exclude knowledge/*.md paths and structured field lines (AGENT: ..., etc.)
    const lines = prompt.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      // Skip empty lines and structured field lines
      if (!trimmed || /^(AGENT|MODE|INTENT KD|SESSION DATE|SCOPE|RESULT KD|KD PATHS):/i.test(trimmed)) continue;
      // Skip knowledge/*.md paths
      if (/^knowledge\/[a-zA-Z0-9_-]+\.md$/i.test(trimmed)) continue;
      // Check for absolute paths
      if (/^\//.test(trimmed)) return true;
      // Check for Windows paths
      if (/^[A-Z]:\\/.test(trimmed)) return true;
      // Check for relative paths outside knowledge/
      if (/\.\.[\/\\]/.test(trimmed)) return true;
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
AGENT: <target_agent>
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

  async function handler(ctx) {
    const { type } = ctx;
    
    if (type === "tool.execute.before") {
      const { input, output } = ctx;
      const { tool, args } = input;
      
      if (tool !== "task") return;
      
      injectToolDocs(output);
      
      const prompt = args?.prompt || "";
      
      if (isBareKDPath(prompt)) {
        throw new DelegationGateError(ERRORS.BARE_KD_PATH.code, ERRORS.BARE_KD_PATH.message, ERRORS.BARE_KD_PATH.guidance);
      }
      
      if (detectCodeBlocks(prompt)) {
        throw new DelegationGateError(ERRORS.CODE_BLOCK.code, ERRORS.CODE_BLOCK.message, ERRORS.CODE_BLOCK.guidance);
      }
      
      if (detectForeignPaths(prompt)) {
        throw new DelegationGateError(ERRORS.FOREIGN_PATH.code, ERRORS.FOREIGN_PATH.message, ERRORS.FOREIGN_PATH.guidance);
      }
      
      const fields = extractFieldsFromPrompt(prompt);
      const requiredFields = ["agent", "mode", "intent_kd", "session_date", "scope", "result_kd"];
      
      for (const field of requiredFields) {
        if (fields[field] === undefined || fields[field] === null) {
          throw new DelegationGateError(ERRORS.MISSING_STRUCTURED_FIELDS.code, ERRORS.MISSING_STRUCTURED_FIELDS.message, ERRORS.MISSING_STRUCTURED_FIELDS.guidance);
        }
      }
      
      if (!validateScope(fields.scope)) {
        throw new DelegationGateError(ERRORS.INVALID_SCOPE.code, ERRORS.INVALID_SCOPE.message, ERRORS.INVALID_SCOPE.guidance);
      }
      
      if (!validateKDPath(fields.result_kd)) {
        throw new DelegationGateError(ERRORS.INVALID_RESULT_KD.code, ERRORS.INVALID_RESULT_KD.message, ERRORS.INVALID_RESULT_KD.guidance);
      }
      
      if (fields.kd_paths) {
        const paths = fields.kd_paths.split(",").map(p => p.trim());
        for (const path of paths) {
          if (!validateKDPath(path)) {
            throw new DelegationGateError(ERRORS.FOREIGN_PATH.code, ERRORS.FOREIGN_PATH.message, ERRORS.FOREIGN_PATH.guidance);
          }
        }
      }
      
      const template = templates[fields.mode];
      if (!template) {
        throw new DelegationGateError(ERRORS.MISSING_STRUCTURED_FIELDS.code, `No template found for mode: ${fields.mode}`, "Check plugins/delegation-gate/templates directory");
      }
      
      const rendered = renderTemplate(template, fields);
      output.args.prompt = rendered;
    }
  }

  handler.DelegationGateError = DelegationGateError;
  handler.ERRORS = ERRORS;
  handler.templates = templates;

  return handler;
}

export default delegationGatePlugin;
