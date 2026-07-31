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
  BARE_KD_PATH: { code: "BARE_KD_PATH", message: "Bare KD path without structured fields", guidance: "Include required fields: agent, mode, intent_kd, session_date" },
  MISSING_STRUCTURED_FIELDS: { code: "MISSING_STRUCTURED_FIELDS", message: "Missing required structured fields", guidance: "Include agent, mode, intent_kd, session_date" },
  INVALID_SCOPE: { code: "INVALID_SCOPE", message: "Scope validation failed", guidance: "Scope should not contain code blocks (security) or absolute /home/ paths (info leak)" },
  INVALID_RESULT_KD: { code: "INVALID_RESULT_KD", message: "Invalid result KD path", guidance: "When provided, result KD must match knowledge/*.md pattern" },
  MISSING_KD_REFERENCE: { code: "MISSING_KD_REFERENCE", message: "No KD path reference found", guidance: "Include at least one knowledge/*.md path" },
  MISSING_RESULT_KD: { code: "MISSING_RESULT_KD", message: "KD-producing mode requires result_kd field", guidance: "Include result_kd: knowledge/<type>-<name>.md" }
};

// All recognized delegation modes — used for template lookup and natural-language inference.
const KNOWN_MODES = [
  "checkpoint", "preflight", "cleanup",
  "explore", "investigate", "align", "decompose",
  "swarm", "verify", "extract", "evolve"
];

// Modes that produce Knowledge Documents — result_kd is mandatory for these.
const KD_PRODUCING_MODES = [
  "preflight",
  "explore", "investigate", "align", "decompose",
  "swarm", "verify", "extract", "evolve",
  "checkpoint", "cleanup"
];

// Maps each delegation mode to the KD type prefix(es) it produces.
// verify produces two KDs (review + audit); all others produce one.
const MODE_TO_KD_PREFIXES = {
  explore:     ["exploration"],
  investigate: ["analysis"],
  align:       ["spec"],
  decompose:   ["plan"],
  swarm:       ["impl"],
  verify:      ["review", "audit"],
  extract:     ["composed"],
  evolve:      ["process"],
  preflight:   ["preflight"],
  checkpoint:  ["checkpoint"],
  cleanup:     ["cleanup"]
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
    checkpoint: "Load the kd-system skill. Load the committer-checkpoint skill. Create a checkpoint commit per the scope above. Write a CHECKPOINT KD at the RESULT KD path.",
    cleanup: "Load the kd-system skill. Load the committer-cleanup skill. Read the INTENT KD at {intent_kd}. Commit and push remaining changes per the scope above. Write a CLEANUP KD at {result_kd} using the template-cleanup.md template to signal completion.",
    preflight: "Load the kd-system skill and the committer-preflight skill. Read the INTENT KD at {intent_kd}. Perform preflight checks per the scope above. Write a PREFLIGHT KD at {result_kd} using the template-preflight.md template to signal completion."
  };

  for (const [mode, content] of Object.entries(defaultTemplates)) {
    try {
      const templatePath = join(PLUGIN_DIR, templatesDir, `${mode}.json`);
      const templateData = JSON.parse(readFileSync(templatePath, "utf8"));
      if (!templateData.template || typeof templateData.template !== "string") {
        debug(`Template ${mode}: disk file missing 'template' field — using fallback`);
        templates[mode] = `DISPATCH TO: {agent}\nMODE: ${mode}\nINTENT KD: {intent_kd}\nSESSION DATE: {session_date}\nSESSION ID: {session_id}\nGENERATION: {generation}\nSCOPE: {scope}\nRESULT KD: {result_kd}\n\n---\n\n${content}`;
      } else {
        debug(`Template ${mode}: loaded from disk`);
        templates[mode] = templateData.template;
      }
    } catch (e) {
      debug(`Template ${mode}: not found on disk — using fallback`);
      templates[mode] = `DISPATCH TO: {agent}\nMODE: ${mode}\nINTENT KD: {intent_kd}\nSESSION DATE: {session_date}\nSESSION ID: {session_id}\nSCOPE: {scope}\nRESULT KD: {result_kd}\n\n---\n\n${content}`;
    }
  }

  return templates;
}

// Scan a text block for structured delegation fields. Returns fields found.
// When override is true, existing field values are overwritten (used for prompt-after-description).
function extractFromText(text, fields, override = false) {
  if (!text) return;
  for (const line of text.split("\n")) {
    // Accept both "AGENT:" and "DISPATCH TO:" with optional Markdown heading prefix (##, ###, etc.)
    const agentMatch = line.match(/^(?:#{1,6}\s*)?(?:\*\*)?(AGENT|DISPATCH TO)(?:\*\*)?:\s*(.*)/i);
    if (agentMatch) {
      // Strip Markdown bold markers — agents sometimes write `**Mode:** **checkpoint**`
      if (override || !fields["agent"]) fields["agent"] = agentMatch[2].trim().replace(/\*\*/g, "").trim();
      continue;
    }
    const match = line.match(/^(?:#{1,6}\s*)?(?:\*\*)?(MODE|INTENT[. _]KD|SESSION[. _]DATE|SESSION[. _]ID|GENERATION|SCOPE|RESULT[. _]KD|KD[. _]PATHS)(?:\*\*)?:\s*(.*)/i);
    if (match) {
      const key = match[1].toLowerCase().replace(/[\s.]+/g, "_");
      if (override || !fields[key]) fields[key] = match[2].trim().replace(/\*\*/g, "").trim();
    }
  }
}

// subagentType is the primary agent source — the Overseer puts agent in
// output.args.subagent_type, not in prompt text. Description is scanned as
// a lower-priority fallback: if prompt doesn't contain a field, try description.
// Prompt overrides description.
// Format hints (e.g. INTENT KD: knowledge/intent-<name>.md) use <name> as
// placeholder — these get overridden by any real value found in prompt, or
// accepted as-is when no prompt value exists (better than hard failure).
//
// Agent resolution: subagentType always wins when available, because it comes
// from the structured task() call args, not from free-form prompt text. This
// prevents incorrect agent values from prompt hallucinations or template
// leftovers from overriding the caller's explicit subagent_type.
function extractFieldsFromPrompt(prompt, subagentType, description) {
  const fields = {};
  if (description) extractFromText(description, fields);  // lower priority
  extractFromText(prompt, fields, true);                   // higher priority, overrides description

  // Track whether prompt explicitly contains an agent directive (DISPATCH TO: or AGENT:).
  // If not, subagent_type is the only source. If yes, subagent_type still wins when
  // available — it reflects the caller's intent, whereas prompt-extracted agent may
  // be stale text from a template or hallucination.
  const promptHasExplicitAgent = prompt && /(?:#{1,6}\s*)?(?:\*\*)?(?:AGENT|DISPATCH TO)(?:\*\*)?:/i.test(prompt);

  if (subagentType) {
    fields["agent"] = subagentType;
  } else if (!fields["agent"] && !promptHasExplicitAgent) {
    // No subagentType and no explicit agent in prompt — already undefined, will fail validation
  }
  // Fallback: extract intent_kd from prose-format prompts when structured
  // extraction missed it. Searches the full text for knowledge/intent-*.md
  // patterns associated with intent_kd keywords (not just at line starts).
  if (!fields["intent_kd"] && prompt) {
    const intentMatch = prompt.match(/(?:intent[_ ]kd|INTENT[ _]KD)\s+(?:at\s+)?(knowledge\/intent-[a-zA-Z0-9][a-zA-Z0-9_.+-]*\.md)/i);
    if (intentMatch) {
      fields["intent_kd"] = intentMatch[1];
    }
  }

  // Infer mode from natural language when no explicit MODE: field found —
  // agents sometimes write "in checkpoint mode" instead of "MODE: checkpoint".
  // Explicit MODE: always takes precedence because extractFromText runs first.
  if (!fields["mode"] && prompt) {
    for (const mode of KNOWN_MODES) {
      const pattern = new RegExp(`\\b${mode}\\b`, "i");
      if (pattern.test(prompt)) {
        fields["mode"] = mode;
        break;
      }
    }
  }
  return fields;
}

// Scope is advisory — validates quality but never blocks delegation.
// Only rejects code blocks (security concern) and absolute home paths (info leak).
function validateScope(scope) {
  if (!scope || scope.trim() === "") {
    return false;
  }
  // Code blocks in scope are a security concern — could inject instructions
  if (/```[\s\S]*?```|~~~[\s\S]*?~~~/.test(scope)) {
    return false;
  }
  // Absolute paths under /home/ leak local filesystem structure
  if (/\/home\/\S+/.test(scope)) {
    return false;
  }
  return true;
}

function validateKDPath(path) {
  // Accept knowledge/<name>.md where name may contain letters, digits, hyphens,
  // underscores, and dots. Reject globs (*), absolute paths, and nested dirs.
  // Normalize backslashes to forward slashes for cross-platform compatibility.
  const normalized = path.replace(/\\/g, "/");
  return /^knowledge\/[a-zA-Z0-9][a-zA-Z0-9_.+-]*\.md$/.test(normalized);
}

function detectCodeBlocks(prompt) {
  return /```[\s\S]*?```|~~~[\s\S]*?~~~/.test(prompt);
}

function detectForeignPaths(prompt) {
  const lines = prompt.split("\n");
  for (const line of lines) {
    const trimmed = line.trim().replace(/\\/g, "/");
    if (!trimmed || /^(?:\*\*)?(AGENT|DISPATCH TO|MODE|INTENT[. _]KD|SESSION[. _]DATE|SESSION[. _]ID|GENERATION|SCOPE|RESULT[. _]KD|KD[. _]PATHS)(?:\*\*)?:/i.test(trimmed)) continue;
    if (/^knowledge\/[a-zA-Z0-9][a-zA-Z0-9_.+-]*\.md$/i.test(trimmed)) continue;
    if (/^\//.test(trimmed)) return true;
    if (/^[A-Z]:\\/.test(trimmed)) return true;
    if (/\.\.[\/\\]/.test(trimmed)) return true;
    // Allow lines containing knowledge/*.md paths (positive whitelist)
    // This handles KD paths embedded in body text from template rendering or agent text
    if (/knowledge\/[a-zA-Z0-9][a-zA-Z0-9_.+-]*\.md/i.test(trimmed)) continue;
  }
  return false;
}

function isBareKDPath(prompt) {
  // Normalize backslashes to forward slashes for cross-platform compatibility.
  const normalized = prompt.trim().replace(/\\/g, "/");
  return /^knowledge\/[a-zA-Z0-9][a-zA-Z0-9_.+-]*\.md$/.test(normalized);
}

// Detects literal placeholder patterns like {scope} or {result_kd} that the
// Overseer failed to fill in — these pass structural extraction but are meaningless.
function containsPlaceholder(value) {
  return /^\{[a-zA-Z_][a-zA-Z0-9_]*\}$/.test(value.trim());
}

function renderTemplate(template, fields) {
  let result = template;
  for (const [key, value] of Object.entries(fields)) {
    // Function replacement avoids $-special-character interpretation in replacement strings
    result = result.replace(new RegExp(`\\{${key}\\}`, "g"), () => value);
  }
  // Strip unresolved placeholders (e.g. {scope} when scope wasn't provided)
  result = result.replace(/\{[a-zA-Z_][a-zA-Z0-9_]*\}/g, "");
  return result;
}

function injectToolDocs(output, agentName, mode, generation) {
  const today = new Date().toISOString().slice(0, 10);
  const displayAgent = agentName || "explorer";
  const displayMode = mode || "explore";
  // Generation suffix (P004/R002 Option A): when a lifecycle generation is
  // known, KD names carry `-gen{N}` after the session ID so stale prior-lifecycle
  // KDs never match. Generation 0 / unknown keeps the legacy bare suffix.
  const genSuffix = generation !== undefined && generation !== "" ? `-gen${generation}` : "";
  // Concrete examples prevent LLMs from copying placeholder syntax literally.
  // <name> and <optional context> are genuine variables — angle brackets signal variability.
  // MODE_TO_KD_PREFIXES maps current mode to its KD type prefix(es) — only the relevant
  // entry is injected so the LLM sees only the naming convention for this dispatch.
  const modePrefixes = MODE_TO_KD_PREFIXES[displayMode] || ["<type>"];
  const resultKdExamples = modePrefixes
    .map(p => `knowledge/${p}-<name>-<session_id>${genSuffix}.md`)
    .join(", ");
  const formatHint = `
Delegation Prompt Format:
DISPATCH TO: ${displayAgent}
MODE: ${displayMode}
INTENT KD: knowledge/intent-<name>.md
SESSION DATE: ${today}
SESSION ID: <session-id>
GENERATION: <generation>
SCOPE: <optional context>
RESULT KD: ${resultKdExamples} (when subagent produces a KD)

RESULT KD Naming Convention${modePrefixes.length > 1 ? "s" : ""}:
- ${displayMode}: ${resultKdExamples}
`;

  if (!output.args) output.args = {};
  if (!output.args.description?.includes("Delegation Prompt Format:")) {
    output.args.description = (output.args.description || "") + formatHint;
  }
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

      // Capture original description before injectToolDocs appends format hint
      const prompt = args?.prompt || "";
      // The Overseer puts agent in subagent_type, not in prompt text — pass as fallback
      const subagentType = args?.subagent_type || "";
      const description = args?.description || "";

      // Log raw inputs before any mutation — critical for debugging delegation failures
      debug(`RAW PROMPT (${prompt.length} chars): ${prompt.substring(0, 500)}`);
      debug(`RAW DESCRIPTION (${description.length} chars): ${description.substring(0, 500)}`);
      debug(`RAW SUBAGENT_TYPE: ${subagentType}`);

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

      const fields = extractFieldsFromPrompt(prompt, subagentType, description);

      // session_id from opencode hook input — fills {session_id} when prompt omits SESSION ID:
      if (!fields["session_id"] && sessionID) {
        fields["session_id"] = sessionID;
      }

      // generation from protocol-gate state file — fills {generation} when the
      // prompt omits GENERATION: (P004). Mirrors the SESSION ID fallback above;
      // saveState always writes generation, so an active session has a value.
      if (!fields["generation"] && sessionID) {
        try {
          const statePath = join(PLUGIN_DIR, "..", "protocol-gate", ".state", `.protocol-state-${sessionID}.json`);
          const stateData = JSON.parse(readFileSync(statePath, "utf8"));
          if (stateData.generation !== undefined) {
            fields["generation"] = String(stateData.generation);
            debug(`GENERATION fallback: read generation=${stateData.generation} from protocol-gate state`);
          }
        } catch (_) {
          debug(`GENERATION fallback: no protocol-gate state file for ${sessionID}`);
        }
      }

      // scope is optional — provides domain context but doesn't block delegation
      // R009: intent_kd is not required for checkpoint mode — the checkpoint
      // template doesn't render intent_kd, so requiring it serves no purpose.
      // Only non-checkpoint modes need intent_kd to identify the upstream KD.
      const requiredFields = ["agent", "mode", "session_date"];
      if (fields.mode?.toLowerCase() !== "checkpoint") {
        requiredFields.push("intent_kd");
      }

      debug(`Extracted fields: ${Object.keys(fields).join(", ")}`);

      // Reject literal placeholder patterns (e.g. {scope}, {result_kd}) — these indicate
      // the Overseer failed to substitute values into the delegation prompt.
      for (const [key, value] of Object.entries(fields)) {
        if (containsPlaceholder(value)) {
          debug(`VALIDATION FAILED: field '${key}' contains unresolved placeholder '${value}'`);
          throw new DelegationGateError(ERRORS.MISSING_STRUCTURED_FIELDS.code, `Field '${key}' contains unresolved placeholder '${value}'`, `Provide actual values for all delegation fields`);
        }
      }

      for (const field of requiredFields) {
        if (fields[field] === undefined || fields[field] === null) {
          debug(`VALIDATION FAILED: missing required field '${field}'`);
          throw new DelegationGateError(ERRORS.MISSING_STRUCTURED_FIELDS.code, ERRORS.MISSING_STRUCTURED_FIELDS.message, ERRORS.MISSING_STRUCTURED_FIELDS.guidance);
        }
      }

      // Scope validation — advisory only, never blocks delegation
      if (fields.scope !== undefined && !validateScope(fields.scope)) {
        debug(`WARNING: scope validation failed (len=${fields.scope.length}, content='${fields.scope.substring(0, 50)}...') — proceeding anyway`);
      }

      // R008: SWARM mode multi-milestone scope warning — large plans overload artisan context.
      // Advisory only: warns but does not block delegation. The structural fix (one artisan
      // per milestone) requires Pathfinder to produce milestone-scoped plans.
      if (fields.mode?.toLowerCase() === "swarm" && fields.scope) {
        if (/M\d+.*M\d+|milestones?\s*\d[\s,]*\d/i.test(fields.scope)) {
          debug(`WARNING: SWARM mode scope references multiple milestones — artisan overload risk. Consider one artisan per milestone.`);
        }
      }

      // Validate result_kd only when provided — falsy check treats "" same as omitted
      if (fields.result_kd && !validateKDPath(fields.result_kd)) {
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

      debug(`ALLOW delegation: agent=${fields.agent} mode=${fields.mode} intent_kd=${fields.intent_kd} result_kd=${fields.result_kd}`);

      // Inject format hint after field extraction — mode is now available
      injectToolDocs(output, fields.agent, fields.mode, fields.generation);

      const template = templates[fields.mode?.toLowerCase()];
      if (!template) {
        debug(`VALIDATION FAILED: no template found for mode '${fields.mode}'`);
        throw new DelegationGateError(ERRORS.MISSING_STRUCTURED_FIELDS.code, `No template found for mode: ${fields.mode}`, "Check plugins/delegation-gate/templates directory");
      }

      // KD-producing modes must have result_kd — without it, templates render empty path "at ."
      if (KD_PRODUCING_MODES.includes(fields.mode?.toLowerCase()) && !fields.result_kd) {
        debug(`VALIDATION FAILED: KD-producing mode '${fields.mode}' requires result_kd`);
        throw new DelegationGateError(ERRORS.MISSING_RESULT_KD.code, ERRORS.MISSING_RESULT_KD.message, ERRORS.MISSING_RESULT_KD.guidance);
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
