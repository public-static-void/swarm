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
// Log directory: set DELEGATION_GATE_LOG_DIR to override plugins/logs — the
// seam the test suite uses to isolate debug writes from the real log.
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
  MISSING_STRUCTURED_FIELDS: { code: "MISSING_STRUCTURED_FIELDS", message: "Missing required structured fields", guidance: "Put the delegation fields as KEY: value lines in the prompt parameter, one per line: DISPATCH TO / MODE / SESSION DATE / SESSION ID / GENERATION / SCOPE / RESULT KD" },
  INVALID_SCOPE: { code: "INVALID_SCOPE", message: "Scope validation failed", guidance: "Scope should not contain code blocks (security) or absolute /home/ paths (info leak)" },
  INVALID_RESULT_KD: { code: "INVALID_RESULT_KD", message: "Invalid result KD path", guidance: "When provided, result KD must match knowledge/*.md pattern" },
  MISSING_KD_REFERENCE: { code: "MISSING_KD_REFERENCE", message: "No KD path reference found", guidance: "Include at least one knowledge/*.md path" },
  MISSING_RESULT_KD: { code: "MISSING_RESULT_KD", message: "KD-producing mode requires result_kd field", guidance: "Include result_kd: knowledge/<type>-<name>.md" },
  MULTI_MILESTONE: { code: "MULTI_MILESTONE", message: "Multiple milestones in single dispatch", guidance: "Include exactly one MILESTONE ID: <milestone-id> field per dispatch" },
  INVALID_MILESTONE_ID: { code: "INVALID_MILESTONE_ID", message: "Invalid MILESTONE ID format", guidance: "MILESTONE ID must match /^[A-Za-z0-9][A-Za-z0-9_-]*$/" },
  INVALID_BRANCH: { code: "INVALID_BRANCH", message: "Invalid branch name", guidance: "Branch must start alphanumeric, contain only [A-Za-z0-9._/-], no '..', and no trailing '/' or '.'" },
  RESULT_KD_MILESTONE_MISMATCH: { code: "RESULT_KD_MILESTONE_MISMATCH", message: "Swarm result KD does not match the MILESTONE ID", guidance: "Name the impl KD knowledge/impl-<milestone-id>-<name>-<session-id>[-gen{N}].md with the dispatched MILESTONE ID as the first token after impl-" }
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
  const logDir = process.env.DELEGATION_GATE_LOG_DIR || join(PLUGIN_DIR, "..", "logs");
  // Re-bind the cached path when the env seam moves the log directory — a
  // stale cache would keep appending to the previously resolved path (AC017).
  if (!_logFile || dirname(_logFile) !== logDir) {
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
    cleanup: "Load the kd-system skill. Load the committer-cleanup skill. Commit and push remaining changes per the scope above. Write a CLEANUP KD at {result_kd} using the template-cleanup.md template to signal completion.",
    preflight: "Load the kd-system skill and the committer-preflight skill. Perform preflight checks per the scope above. Write a PREFLIGHT KD at {result_kd} using the template-preflight.md template to signal completion."
  };

  // R101 (M3): preflight/cleanup fallback headers carry `BRANCH: {branch}`
  // between GENERATION and SCOPE, mirroring the disk templates. Cleanup keeps
  // its no-INTENT-KD header shape (matches templates/cleanup.json); all other
  // modes keep the shared header with INTENT KD and no BRANCH line. Both error
  // paths render the same header so the fallback can never drift from the
  // disk shape (the older fallback was also missing GENERATION entirely).
  const fallbackHeader = (mode) => {
    const intentKdLine = mode === "cleanup" ? "" : "INTENT KD: {intent_kd}\n";
    const branchLine = mode === "preflight" || mode === "cleanup" ? "BRANCH: {branch}\n" : "";
    return `DISPATCH TO: {agent}\nMODE: ${mode}\n${intentKdLine}SESSION DATE: {session_date}\nSESSION ID: {session_id}\nGENERATION: {generation}\n${branchLine}SCOPE: {scope}\nRESULT KD: {result_kd}\n\n---\n\n`;
  };

  for (const [mode, content] of Object.entries(defaultTemplates)) {
    try {
      const templatePath = join(PLUGIN_DIR, templatesDir, `${mode}.json`);
      const templateData = JSON.parse(readFileSync(templatePath, "utf8"));
      if (!templateData.template || typeof templateData.template !== "string") {
        debug(`Template ${mode}: disk file missing 'template' field — using fallback`);
        templates[mode] = fallbackHeader(mode) + content;
      } else {
        debug(`Template ${mode}: loaded from disk`);
        templates[mode] = templateData.template;
      }
    } catch (e) {
      debug(`Template ${mode}: not found on disk — using fallback`);
      templates[mode] = fallbackHeader(mode) + content;
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
    const match = line.match(/^(?:#{1,6}\s*)?(?:\*\*)?(MODE|MILESTONE[. _]ID|INTENT[. _]KD|SESSION[. _]DATE|SESSION[. _]ID|GENERATION|BRANCH[. _]NAME|BRANCH|SCOPE|RESULT[. _]KD|KD[. _]PATHS)(?:\*\*)?:\s*(.*)/i);
    if (match) {
      let key = match[1].toLowerCase().replace(/[\s.]+/g, "_");
      // R102 (M3): BRANCH_NAME / BRANCH.NAME / BRANCH NAME all normalize to `branch`
      if (key === "branch_name") key = "branch";
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

// R102 (M3): git-ref-safe branch contract (spec interface contract #7) —
// starts alphanumeric, then only [A-Za-z0-9._/-], no `..`, no trailing `/` or
// `.`. Rejecting unsafe values here (EC04) keeps them from ever reaching a
// `git checkout -b` invocation in the committer.
function validateBranch(branch) {
  if (typeof branch !== "string" || branch.trim() === "") return false;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(branch)) return false;
  if (branch.includes("..")) return false;
  if (/[./]$/.test(branch)) return false;
  return true;
}

function detectCodeBlocks(prompt) {
  return /```[\s\S]*?```|~~~[\s\S]*?~~~/.test(prompt);
}

function detectForeignPaths(prompt) {
  const lines = prompt.split("\n");
  for (const line of lines) {
    const trimmed = line.trim().replace(/\\/g, "/");
    if (!trimmed || /^(?:\*\*)?(AGENT|DISPATCH TO|MODE|MILESTONE[. _]ID|INTENT[. _]KD|SESSION[. _]DATE|SESSION[. _]ID|GENERATION|BRANCH[. _]NAME|BRANCH|SCOPE|RESULT[. _]KD|KD[. _]PATHS)(?:\*\*)?:/i.test(trimmed)) continue;
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

// Collects every MILESTONE ID field value from a prompt — one entry per
// `MILESTONE ID:` / `MILESTONE_ID:` line, with Markdown bold markers stripped.
// A comma inside a single value means multiple milestones were crammed into one
// field; both cases are rejected as MULTI_MILESTONE (R007).
function collectMilestoneIds(prompt) {
  if (!prompt) return [];
  const ids = [];
  for (const line of prompt.split("\n")) {
    const match = line.match(/^(?:#{1,6}\s*)?(?:\*\*)?MILESTONE[. _]ID(?:\*\*)?:\s*(.*)/i);
    if (match) {
      const value = match[1].trim().replace(/\*\*/g, "").trim();
      if (value) ids.push(value);
    }
  }
  return ids;
}

// Detects literal placeholder patterns like {scope} or {result_kd} that the
// Overseer failed to fill in — these pass structural extraction but are meaningless.
function containsPlaceholder(value) {
  return /^\{[a-zA-Z_][a-zA-Z0-9_]*\}$/.test(value.trim());
}

// M4 (R009/R010): Extracts the milestone token from a swarm result KD path per
// the milestone-scoped impl naming contract — the first token after `impl-`.
// Returns null when the path is not an impl KD at all.
function extractMilestoneTokenFromResultKd(resultKd) {
  if (typeof resultKd !== "string") return null;
  const base = resultKd.replace(/\\/g, "/").split("/").pop();
  if (!/^impl-/i.test(base)) return null;
  const name = base.replace(/\.md$/, "");
  return name.replace(/^impl-/i, "").split("-")[0] || null;
}

function renderTemplate(template, fields) {
  let result = template;
  for (const [key, value] of Object.entries(fields)) {
    // Function replacement avoids $-special-character interpretation in replacement strings
    result = result.replace(new RegExp(`\\{${key}\\}`, "g"), () => value);
  }
  // Strip unresolved placeholders (e.g. {scope} when scope wasn't provided)
  result = result.replace(/\{[a-zA-Z_][a-zA-Z0-9_]*\}/g, "");
  // F4 (R030–R032): KD PATHS is optional — when kd_paths is falsy, drop the
  // `KD PATHS:` header line and the "Read ... from KD PATHS." body sentence so
  // preflight/checkpoint/cleanup dispatches without upstream paths render no
  // empty header and no dangling read instruction. When kd_paths is present,
  // no post-processing — legitimate modes (swarm, verify, investigate, ...)
  // keep the header and sentence unchanged. One generic path, no per-template
  // text forks.
  if (!fields.kd_paths) {
    result = result.replace(/^KD PATHS:.*$/m, "");
    result = result.replace(/Read [^.]*KD PATHS[^.]*\./g, "");
  }
  return result;
}

// Dispatcher-visible delegation format hint (R303). The tool.definition hook
// annotates the task tool description so the dispatching agent sees the
// KEY: value-in-prompt rule BEFORE composing — closing the audience/timing
// gap where injectToolDocs' hint lands only in the subagent-facing description
// after compose. Mirrors protocol-gate's tool.definition pattern.
// R009 (issue-9 remainder): the hint is mode-agnostic — it is injected before
// the dispatch mode is known — so the swarm MILESTONE ID line carries the
// "(swarm mode only)" qualifier (mirroring injectToolDocs' swarm-only line
// placement right after MODE), and the KD PATHS line documents the
// comma-separated convention the validation split() expects.
function dispatcherFormatHint() {
  return `
Delegation Prompt Format:
Put delegation fields as KEY: value lines INSIDE the prompt parameter, one per line:
DISPATCH TO: <agent>
MODE: <mode>
MILESTONE ID: <milestone-id> — swarm mode only, exactly one, required
SESSION DATE: <YYYY-MM-DD>
SESSION ID: <session-id>
GENERATION: <generation>
BRANCH: <branch> — preflight/cleanup modes only, required
SCOPE: <optional context>
RESULT KD: knowledge/<type>-<name>-<session_id>[-gen<N>].md (when subagent produces a KD)
KD PATHS: <upstream KD paths, comma-separated> (optional)
`;
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
  // M4 (R009/R010): swarm result KDs carry the dispatched milestone as the
  // first token after impl- — knowledge/impl-<milestone-id>-<name>-... Only
  // injected for swarm so other modes don't see the contract they must not use.
  const milestoneToken = displayMode === "swarm" ? "<milestone-id>-" : "";
  const resultKdExamples = modePrefixes
    .map(p => `knowledge/${p}-${milestoneToken}<name>-<session_id>${genSuffix}.md`)
    .join(", ");
  // M3 (R006): swarm dispatches carry exactly one MILESTONE ID — the structural
  // field the protocol-gate registry transition keys on. Only injected for swarm
  // so other modes don't see a field they must not include.
  const milestoneLine = displayMode === "swarm" ? "MILESTONE ID: <milestone-id> (exactly one, required for swarm)\n" : "";
  // R102 (M3): committer-owned modes carry the dispatch BRANCH — the branch the
  // committer creates at preflight and verifies at cleanup. Only injected for
  // preflight/cleanup so other modes don't see a field they must not include.
  const branchLine = displayMode === "preflight" || displayMode === "cleanup" ? "BRANCH: <branch> (required for preflight/cleanup)\n" : "";
  const formatHint = `
Delegation Prompt Format:
DISPATCH TO: ${displayAgent}
MODE: ${displayMode}
${milestoneLine}INTENT KD: knowledge/intent-<name>.md
SESSION DATE: ${today}
SESSION ID: <session-id>
GENERATION: <generation>
${branchLine}SCOPE: <optional context>
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
      // The state dir follows protocol-gate's PROTOCOL_GATE_STATE_DIR seam (P302)
      // so isolated test runs never race on the real .state dir.
      if (!fields["generation"] && sessionID) {
        try {
          const stateDir = process.env.PROTOCOL_GATE_STATE_DIR || join(PLUGIN_DIR, "..", "protocol-gate", ".state");
          const statePath = join(stateDir, `.protocol-state-${sessionID}.json`);
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
      // R009/R014: intent_kd is not required for the committer-owned modes
      // (checkpoint, cleanup) — their templates render no INTENT KD reference
      // (the committer's read:allow denies knowledge/intent-*.md), so requiring
      // the field serves no purpose. Only non-committer modes need intent_kd
      // to identify the upstream KD.
      const requiredFields = ["agent", "mode", "session_date"];
      if (fields.mode?.toLowerCase() !== "checkpoint" && fields.mode?.toLowerCase() !== "cleanup") {
        requiredFields.push("intent_kd");
      }
      // R102 (M3): committer-owned modes carry a branch field — the committer
      // creates/verifies the dispatch BRANCH, so an absent branch is a hard
      // rejection before template rendering (spec matrix: preflight + cleanup
      // require branch; checkpoint and all other modes do not).
      if (fields.mode?.toLowerCase() === "preflight" || fields.mode?.toLowerCase() === "cleanup") {
        requiredFields.push("branch");
      }

      debug(`Extracted fields: ${Object.keys(fields).join(", ")}`);

      // Reject literal placeholder patterns (e.g. {scope}, {result_kd}) — these indicate
      // the Overseer failed to substitute values into the delegation prompt.
      for (const [key, value] of Object.entries(fields)) {
        if (containsPlaceholder(value)) {
          debug(`VALIDATION FAILED: field '${key}' contains unresolved placeholder '${value}'`);
          throw new DelegationGateError(ERRORS.MISSING_STRUCTURED_FIELDS.code, `Field '${key}' contains unresolved placeholder '${value}'`, `Replace placeholder values with actual values — fields are KEY: value lines in the prompt parameter`);
        }
      }

      for (const field of requiredFields) {
        if (fields[field] === undefined || fields[field] === null) {
          debug(`VALIDATION FAILED: missing required field '${field}'`);
          throw new DelegationGateError(ERRORS.MISSING_STRUCTURED_FIELDS.code, ERRORS.MISSING_STRUCTURED_FIELDS.message, ERRORS.MISSING_STRUCTURED_FIELDS.guidance);
        }
      }

      // R102 (M3): validate any branch value present — required for
      // preflight/cleanup, but a stray BRANCH line in other modes is still
      // checked so unsafe values can never reach a git command (EC04).
      if (fields.branch !== undefined && !validateBranch(fields.branch)) {
        debug(`VALIDATION FAILED: invalid branch '${fields.branch}'`);
        throw new DelegationGateError(ERRORS.INVALID_BRANCH.code, ERRORS.INVALID_BRANCH.message, ERRORS.INVALID_BRANCH.guidance);
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

      // R006–R008: swarm dispatches require exactly one valid MILESTONE ID.
      // Runs after the result_kd check so a missing result_kd reports the more
      // specific error first. Multiple milestones in one dispatch are rejected
      // structurally (MULTI_MILESTONE) instead of warned about — the advisory
      // regex only caught prose references (MEM-015), never enforced anything.
      if (fields.mode?.toLowerCase() === "swarm") {
        const milestoneIds = collectMilestoneIds(prompt);
        if (milestoneIds.length === 0) {
          debug(`VALIDATION FAILED: swarm mode requires MILESTONE ID`);
          throw new DelegationGateError(ERRORS.MISSING_STRUCTURED_FIELDS.code, ERRORS.MISSING_STRUCTURED_FIELDS.message, "Include exactly one MILESTONE ID: <milestone-id> field in swarm dispatches");
        }
        if (milestoneIds.length > 1 || /,/.test(milestoneIds[0])) {
          debug(`VALIDATION FAILED: multiple milestones in single swarm dispatch: ${JSON.stringify(milestoneIds)}`);
          throw new DelegationGateError(ERRORS.MULTI_MILESTONE.code, ERRORS.MULTI_MILESTONE.message, ERRORS.MULTI_MILESTONE.guidance);
        }
        const milestoneId = milestoneIds[0];
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(milestoneId)) {
          debug(`VALIDATION FAILED: invalid MILESTONE ID format '${milestoneId}'`);
          throw new DelegationGateError(ERRORS.INVALID_MILESTONE_ID.code, ERRORS.INVALID_MILESTONE_ID.message, ERRORS.INVALID_MILESTONE_ID.guidance);
        }
        fields["milestone_id"] = milestoneId;
        debug(`ALLOW swarm dispatch for milestone: ${milestoneId}`);

        // M4 (R009/R010): the swarm result KD must be milestone-scoped — the
        // first token after impl- is the dispatched milestone ID. This naming
        // is the check-off contract the protocol-gate reads back: the impl KD
        // on disk is the verifiable evidence of the milestone's completion.
        // Matching is case-insensitive so impl-m3-... satisfies MILESTONE ID: M3.
        if (fields.result_kd) {
          const resultToken = extractMilestoneTokenFromResultKd(fields.result_kd);
          if (!resultToken || resultToken.toLowerCase() !== milestoneId.toLowerCase()) {
            debug(`VALIDATION FAILED: swarm result KD '${fields.result_kd}' does not carry milestone '${milestoneId}'`);
            throw new DelegationGateError(ERRORS.RESULT_KD_MILESTONE_MISMATCH.code, ERRORS.RESULT_KD_MILESTONE_MISMATCH.message, ERRORS.RESULT_KD_MILESTONE_MISMATCH.guidance);
          }
        }
      }

      debug(`Rendering template for mode='${fields.mode}', agent='${fields.agent}'`);
      const rendered = renderTemplate(template, fields);
      output.args.prompt = rendered;
      debug(`Prompt rendered successfully (${rendered.length} chars)`);
    }

    // --- Hook: tool.definition ---
    // R303: annotate the task tool definition so the format hint is visible to
    // the dispatcher before composing. Dedupe guard (FM04): never show the hint
    // twice on one surface — injectToolDocs applies the same includes() guard
    // to the subagent-facing description after compose.
    async function toolDefinition(input, output) {
      const { toolID } = input;
      if (toolID !== "task") return;
      if (output.description?.includes("Delegation Prompt Format:")) return;
      output.description = (output.description || "") + dispatcherFormatHint();
      debug(`tool.definition: annotated task tool description with delegation format hint`);
    }

    return {
      "tool.execute.before": toolExecuteBefore,
      "tool.definition": toolDefinition,
      // Test-access properties
      DelegationGateError,
      ERRORS,
      templates
    };
  }
};
