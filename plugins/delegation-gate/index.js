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
import { appendFileSync, mkdirSync, readFileSync, readdirSync } from "fs";
import { join, dirname, resolve } from "path";
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

  RESULT_KD_MILESTONE_MISMATCH: { code: "RESULT_KD_MILESTONE_MISMATCH", message: "Swarm result KD does not match the MILESTONE ID", guidance: "Name the impl KD knowledge/impl-<milestone-id>-<name>-<session-id>[-gen{N}].md with the dispatched MILESTONE ID as the first token after impl-" }
};

// All recognized delegation modes — used for template lookup and natural-language inference.
// `audit` was merged into `review`: the VERIFY dispatch produces ONE review KD whose
// body carries both the Review Findings and the Audit sections.
const KNOWN_MODES = [
  "checkpoint", "preflight", "cleanup",
  "explore", "investigate", "align", "decompose",
  "swarm", "review", "extract", "evolve"
];

// Modes that produce Knowledge Documents — result_kd is mandatory for these.
const KD_PRODUCING_MODES = [
  "preflight",
  "explore", "investigate", "align", "decompose",
  "swarm", "review", "extract", "evolve",
  "checkpoint", "cleanup"
];

// Maps each delegation mode to the KD type prefix(es) it produces.
const MODE_TO_KD_PREFIXES = {
  explore:     ["exploration"],
  investigate: ["analysis"],
  align:       ["spec"],
  decompose:   ["plan"],
  swarm:       ["impl"],
  review:      ["review"],
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
  // A stale cache would keep appending to the previously resolved path.
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
      // File write failed — silently drop rather than bleed to stderr
    }
  }
}

// File-only logging gated behind DELEGATION_GATE_DEBUG.
// Previously wrote to stderr which bled into user prompts; moved to file.
// Emissions are per-event and rare by nature.
function warn(msg) {
  if (process.env.DELEGATION_GATE_DEBUG) {
    try {
      appendFileSync(getLogFile(), `[${new Date().toISOString()}] [delegation-gate] WARNING: ${msg}\n`);
    } catch (_) {}
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
    review: "Load the kd-system skill. Read the INTENT KD at {intent_kd}. Review the implementation AND run the security audit per the scope above. Produce a REVIEW KD (review findings + audit section) at {result_kd}.",
    extract: "Load the kd-system skill. Read the INTENT KD at {intent_kd}. Extract and compose the documentation per the scope above. Produce a COMPOSED KD at {result_kd}.",
    evolve: "Load the kd-system skill. Read the INTENT KD at {intent_kd}. Evolve the process per the scope above. Write the PROCESS KD and issue files (`knowledge/issues/*.md`). Produce a PROCESS KD at {result_kd}.",
    checkpoint: "Load the kd-system skill. Load the committer-checkpoint skill. Create a checkpoint commit per the scope above. Write a CHECKPOINT KD at the RESULT KD path.",
    cleanup: "Load the kd-system skill. Load the committer-cleanup skill. Commit and push remaining changes per the scope above. Write a CLEANUP KD at {result_kd} using the template-cleanup.md template to signal completion.",
    preflight: "Load the kd-system skill and the committer-preflight skill. Perform preflight checks per the scope above. Write a PREFLIGHT KD at {result_kd} using the template-preflight.md template to signal completion."
  };

  // Preflight/cleanup fallback headers mirror the disk templates. Cleanup keeps
  // its no-INTENT-KD header shape (matches templates/cleanup.json); all other
  // modes keep the shared header with INTENT KD. Both error
  // paths render the same header so the fallback can never drift from the
  // disk shape (the older fallback was also missing GENERATION entirely).
  const fallbackHeader = (mode) => {
    const intentKdLine = mode === "cleanup" ? "" : "INTENT KD: {intent_kd}\n";
    return `DISPATCH TO: {agent}\nMODE: ${mode}\n${intentKdLine}SESSION DATE: {session_date}\nSESSION ID: {session_id}\nGENERATION: {generation}\nSCOPE: {scope}\nRESULT KD: {result_kd}\n\n---\n\n`;
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
// A key-less line is treated as a SCOPE continuation: scopes are free-form
// prose that legitimately wraps across lines, while every other field stays
// single-line key-value. Accumulation stops at the next key-prefixed line.
function extractFromText(text, fields, override = false) {
  if (!text) return;
  let scopeActive = false;
  for (const line of text.split("\n")) {
    // Accept both "AGENT:" and "DISPATCH TO:" with optional Markdown heading prefix (##, ###, etc.)
    const agentMatch = line.match(/^(?:#{1,6}\s*)?(?:\*\*)?(AGENT|DISPATCH TO)(?:\*\*)?:\s*(.*)/i);
    if (agentMatch) {
      // Strip Markdown bold markers — agents sometimes write `**Mode:** **checkpoint**`
      if (override || !fields["agent"]) fields["agent"] = agentMatch[2].trim().replace(/\*\*/g, "").trim();
      continue;
    }
    const match = line.match(/^(?:#{1,6}\s*)?(?:\*\*)?(MODE|MILESTONE[. _]ID|INTENT[. _]KD|SESSION[. _]DATE|SESSION[. _]ID|GENERATION|SCOPE|RESULT[. _]KD|KD[. _]PATHS)(?:\*\*)?:\s*(.*)/i);
    if (match) {
      let key = match[1].toLowerCase().replace(/[\s.]+/g, "_");
      const assigned = override || !fields[key];
      if (assigned) fields[key] = match[2].trim().replace(/\*\*/g, "").trim();
      // Only a SCOPE assignment opens accumulation; the next key-prefixed line closes it.
      scopeActive = assigned && key === "scope";
      continue;
    }
    if (scopeActive) {
      const continuation = line.trim();
      if (continuation) {
        fields.scope = fields.scope ? `${fields.scope}\n${continuation}` : continuation;
      }
    }
  }
}

// The delegation format hint injected into tool descriptions (injectToolDocs /
// dispatcherFormatHint) is instructional — its KEY: value lines (e.g.
// "KD PATHS: upstream KD paths, comma-separated (optional)", "RESULT KD:
// knowledge/<type>-<name>-<session_id>[-gen<N>].md (when subagent produces a
// KD)") must never be re-extracted as bogus field values on a subsequent
// dispatch. The hint is always appended at the end of the description, so
// stripping from the marker to end-of-text removes exactly the hint block.
function stripFormatHint(text) {
  if (!text) return text;
  return text.replace(/\n?Delegation Prompt Format:[\s\S]*$/, "");
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
  if (description) extractFromText(stripFormatHint(description), fields);  // lower priority
  extractFromText(stripFormatHint(prompt), fields, true);                   // higher priority, overrides description

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

// Reserved KD PATHS token (Issue 67): expands at render time to every on-disk
// KD of the dispatching session's CURRENT lifecycle generation, so all-upstream
// dispatches are complete by construction instead of hand-enumerated (11–17 of
// 22 lifecycle KDs were routinely omitted). Exact uppercase match only.
const SESSION_KDS_TOKEN = "SESSION_KDS";

// Template sentence marking an all-upstream dispatch — only templates carrying
// it get the under-enumeration advisory. Subset templates (swarm's SPEC+PLAN,
// review's SPEC+PLAN+IMPL) are legitimate partial lists and stay silent.
const ALL_UPSTREAM_KD_SENTENCE = "Read all upstream KDs";

function getKnowledgeDir() {
  // Same project-root seam precedence as protocol-gate/knowledge-gate so every
  // plugin resolves one lifecycle's KDs to the same directory.
  if (process.env.PROTOCOL_GATE_KNOWLEDGE_DIR) {
    return resolve(process.env.PROTOCOL_GATE_KNOWLEDGE_DIR);
  }
  if (process.env.KNOWLEDGE_GATE_PROJECT_ROOT) {
    return join(resolve(process.env.KNOWLEDGE_GATE_PROJECT_ROOT), "knowledge");
  }
  return join(process.cwd(), "knowledge");
}

// Current lifecycle generation for a session — direct read of protocol-gate
// state (same file and seam the GENERATION fallback uses). Returns null when
// unresolvable; callers then match the legacy bare filename form only.
function resolveLifecycleGeneration(sessionId) {
  if (!sessionId) return null;
  try {
    const stateDir = process.env.PROTOCOL_GATE_STATE_DIR || join(PLUGIN_DIR, "..", "protocol-gate", ".state");
    const stateData = JSON.parse(readFileSync(join(stateDir, `.protocol-state-${sessionId}.json`), "utf8"));
    if (stateData.generation !== undefined) return String(stateData.generation);
  } catch (_) {}
  return null;
}

// All on-disk KDs of a session's lifecycle at the given generation — single
// top-level readdir, no recursive walk. Generation is taken from each FILENAME;
// generation 0 (and unresolvable generation) additionally matches the legacy
// bare form without a -gen suffix, mirroring injectToolDocs' precedent.
function listSessionKdPaths(sessionId, generation) {
  let files;
  try { files = readdirSync(getKnowledgeDir()); } catch (_) { return []; }
  const gen = generation === null || generation === undefined || generation === "" ? "0" : String(generation);
  const escaped = sessionId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const genForm = new RegExp(`^(?:.+)-${escaped}-gen(\\d+)\\.md$`);
  const legacyForm = new RegExp(`^(?:.+)-${escaped}\\.md$`);
  return files
    .filter(f => {
      const m = f.match(genForm);
      if (m) return m[1] === gen;
      return gen === "0" && legacyForm.test(f);
    })
    .sort()
    .map(f => `knowledge/${f}`);
}

// Expands SESSION_KDS within a KD PATHS value. Literal paths keep their listed
// order; expanded entries append in sorted order; duplicates collapse. An empty
// result renders as today's absent-field behavior (renderTemplate drops the
// header line and read sentence when kd_paths is falsy).
function expandKdPaths(kdPathsValue, sessionId, generation) {
  const literals = [];
  let hasToken = false;
  for (const raw of kdPathsValue.split(",")) {
    const p = raw.trim();
    if (!p) continue;
    if (p === SESSION_KDS_TOKEN) { hasToken = true; continue; }
    if (!literals.includes(p)) literals.push(p);
  }
  if (!hasToken) return { value: literals.join(", "), hasToken, listedCount: literals.length };
  const merged = [...literals];
  for (const p of listSessionKdPaths(sessionId, generation)) {
    if (!merged.includes(p)) merged.push(p);
  }
  return { value: merged.join(", "), hasToken, listedCount: merged.length };
}

function validateKDPath(path) {
  // Accept knowledge/<name>.md where name may contain letters, digits, hyphens,
  // underscores, dots, and slashes (subdirectory paths). Reject globs (*),
  // absolute paths, and traversal paths (../).
  // Normalize backslashes to forward slashes for cross-platform compatibility.
  const normalized = path.replace(/\\/g, "/");
  return /^knowledge\/[a-zA-Z0-9][a-zA-Z0-9_./+-]*\.md$/.test(normalized);
}

function detectCodeBlocks(prompt) {
  return /```[\s\S]*?```|~~~[\s\S]*?~~~/.test(prompt);
}

function detectForeignPaths(prompt) {
  const lines = prompt.split("\n");
  for (const line of lines) {
    const trimmed = line.trim().replace(/\\/g, "/");
    if (!trimmed || /^(?:\*\*)?(AGENT|DISPATCH TO|MODE|MILESTONE[. _]ID|INTENT[. _]KD|SESSION[. _]DATE|SESSION[. _]ID|GENERATION|SCOPE|RESULT[. _]KD|KD[. _]PATHS)(?:\*\*)?:/i.test(trimmed)) continue;
    if (/^knowledge\/[a-zA-Z0-9][a-zA-Z0-9_.+-]*\.md$/i.test(trimmed)) continue;
    if (/^\//.test(trimmed)) return true;
    // Drive-letter paths are normalized to forward slashes above (C:\Windows →
    // C:/Windows), so match the normalized form.
    if (/^[A-Z]:\//.test(trimmed)) return true;
    if (/\.\.[\/\\]/.test(trimmed)) return true;
    // Reject glob patterns only on path-bearing lines. A `*` in arbitrary
    // prose (e.g. "update the agents/*.md files") is a mention, not a foreign
    // path — only a line that is itself a path (starts with a path prefix) is
    // a genuine glob path (e.g. knowledge/*.md) and is rejected.
    if (/\*/.test(trimmed) && /^(knowledge\/|\/|[A-Z]:\/)|\.\.[\/\\]/.test(trimmed)) return true;
    // Allow lines containing knowledge/ paths (positive whitelist)
    // This handles KD paths embedded in body text from template rendering or agent text,
    // including subdirectory paths like knowledge/issues/issue-1.md
    if (/^knowledge\//i.test(trimmed)) continue;
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
// field; both cases are rejected as MULTI_MILESTONE.
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

// Detects literal placeholder patterns that pass structural extraction but are
// meaningless: brace placeholders ({scope}, {result_kd}) AND whole-value
// angle-bracket placeholders (<mode>, <session-id>, <optional context>) leaked
// from format hints. Whole-value semantics only — `knowledge/<type>-<name>.md`
// and `Implement <x> in <y>` (not wholly bracketed) render as prose and are
// handled by validateKDPath where they matter.
function containsPlaceholder(value) {
  const v = value.trim();
  return /^\{[a-zA-Z_][a-zA-Z0-9_]*\}$/.test(v) || /^<[^<>]+>$/.test(v);
}

// Extracts the milestone token from a swarm result KD path per the
// milestone-scoped impl naming contract — the first token after `impl-`.
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
  // KD PATHS is optional — when kd_paths is falsy, drop the
  // `KD PATHS:` header line and the "Read ... from KD PATHS." body sentence so
  // preflight/checkpoint/cleanup dispatches without upstream paths render no
  // empty header and no dangling read instruction. When kd_paths is present,
  // no post-processing — legitimate modes (swarm, review, investigate, ...)
  // keep the header and sentence unchanged. One generic path, no per-template
  // text forks.
  if (!fields.kd_paths) {
    result = result.replace(/^KD PATHS:.*$/m, "");
    result = result.replace(/Read [^.]*KD PATHS[^.]*\./g, "");
  }
  return result;
}

// Dispatcher-visible delegation format hint. The tool.definition hook
// annotates the task tool description so the dispatching agent sees the
// KEY: value-in-prompt rule BEFORE composing — closing the audience/timing
// gap where injectToolDocs' hint lands only in the subagent-facing description
// after compose. Mirrors protocol-gate's tool.definition pattern.
// The hint is mode-agnostic — it is injected before the dispatch mode is
// known — so the swarm MILESTONE ID line carries the "(swarm mode only)"
// qualifier (mirroring injectToolDocs' swarm-only line placement right after
// MODE), and the KD PATHS line documents the comma-separated convention the
// validation split() expects.
// The hint values are bracket-free instructional wording — a literal
// angle-bracket placeholder (<session-id>) copied verbatim from the hint used
// to be captured by extraction as a field value and leak into the rendered
// prompt. Instructional wording can be copied safely; the retained RESULT KD
// template form (knowledge/<type>-<name>-<session_id>[-gen<N>].md) is
// deliberately kept because it is not a standalone whole-value <...> line and
// fails validateKDPath loudly if copied verbatim.
function dispatcherFormatHint() {
  return `
Delegation Prompt Format:
Put delegation fields as KEY: value lines INSIDE the prompt parameter, one per line:
DISPATCH TO: agent name (e.g. explorer)
MODE: delegation mode (e.g. explore)
MILESTONE ID: milestone id — swarm mode only, exactly one, required
SESSION DATE: today's date (e.g. 2026-08-08)
SESSION ID: your session id (e.g. ses_abc)
GENERATION: the lifecycle generation number
SCOPE: optional context
RESULT KD: knowledge/<type>-<name>-<session_id>[-gen<N>].md (when subagent produces a KD)
KD PATHS: upstream KD paths, comma-separated (optional)
`;
}

function injectToolDocs(output, agentName, mode, generation) {
  const today = new Date().toISOString().slice(0, 10);
  const displayAgent = agentName || "explorer";
  const displayMode = mode || "explore";
  // Generation suffix: when a lifecycle generation is known, KD names carry
  // `-gen{N}` after the session ID so stale prior-lifecycle KDs never match.
  // Generation 0 / unknown keeps the legacy bare suffix.
  const genSuffix = generation !== undefined && generation !== "" ? `-gen${generation}` : "";
  // MODE_TO_KD_PREFIXES maps current mode to its KD type prefix(es) — only the relevant
  // entry is injected so the LLM sees only the naming convention for this dispatch.
  // Genuine variables use parenthetical wording ((your session id), (optional
  // context)) instead of angle-bracket placeholders — a literal <...> copied
  // from this hint was captured by extraction as a field value. Only the
  // RESULT KD example paths retain <name>-<session_id> components: those lines
  // are not whole-value placeholders.
  const modePrefixes = MODE_TO_KD_PREFIXES[displayMode] || ["<type>"];
  // Swarm result KDs carry the dispatched milestone as the first token after
  // impl- — knowledge/impl-<milestone-id>-<name>-... Only
  // injected for swarm so other modes don't see the contract they must not use.
  const milestoneToken = displayMode === "swarm" ? "<milestone-id>-" : "";
  const resultKdExamples = modePrefixes
    .map(p => `knowledge/${p}-${milestoneToken}<name>-<session_id>${genSuffix}.md`)
    .join(", ");
  // Swarm dispatches carry exactly one MILESTONE ID — the structural field the
  // protocol-gate registry transition keys on. Only injected for swarm
  // so other modes don't see a field they must not include.
  const milestoneLine = displayMode === "swarm" ? "MILESTONE ID: (exactly one, required for swarm)\n" : "";
  const formatHint = `
Delegation Prompt Format:
DISPATCH TO: ${displayAgent}
MODE: ${displayMode}
${milestoneLine}INTENT KD: knowledge/intent-(name).md
SESSION DATE: ${today}
SESSION ID: (your session id)
GENERATION: (the lifecycle generation number)
SCOPE: (optional context)
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

      // Log raw inputs before any mutation — critical for debugging delegation failures.
      // Full text is the dispatch audit trail; log rotation bounds growth (AGENTS.md).
      debug(`RAW PROMPT (${prompt.length} chars): ${prompt}`);
      debug(`RAW DESCRIPTION (${description.length} chars): ${description}`);
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
      // prompt omits GENERATION. Mirrors the SESSION ID fallback above;
      // saveState always writes generation, so an active session has a value.
      // The state dir follows protocol-gate's PROTOCOL_GATE_STATE_DIR seam so
      // isolated test runs never race on the real .state dir.
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
      // intent_kd is not required for the committer-owned modes (checkpoint,
      // cleanup) — their templates render no INTENT KD reference
      // (the committer's read:allow denies knowledge/intent-*.md), so requiring
      // the field serves no purpose. Only non-committer modes need intent_kd
      // to identify the upstream KD.
      const requiredFields = ["agent", "mode", "session_date"];
      if (fields.mode?.toLowerCase() !== "checkpoint" && fields.mode?.toLowerCase() !== "cleanup") {
        requiredFields.push("intent_kd");
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

      // Scope validation — advisory only, never blocks delegation
      if (fields.scope !== undefined && !validateScope(fields.scope)) {
        debug(`WARNING: scope validation failed (len=${fields.scope.length}, content='${fields.scope}') — proceeding anyway`);
      }

      // SWARM mode multi-milestone scope warning — large plans overload
      // artisan context. Advisory only: warns but does not block delegation.
      // The structural fix (one artisan per milestone) requires Pathfinder to
      // produce milestone-scoped plans.
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
        const paths = fields.kd_paths.split(",").map(p => p.trim()).filter(Boolean);
        for (const path of paths) {
          // Reserved expansion token — exact-match validated here, expanded
          // after template lookup; literal entries stay strictly validated.
          if (path === SESSION_KDS_TOKEN) continue;
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

      // Swarm dispatches require exactly one valid MILESTONE ID. Runs after
      // the result_kd check so a missing result_kd reports the more specific
      // error first. Multiple milestones in one dispatch are rejected
      // structurally (MULTI_MILESTONE) instead of warned about — the advisory
      // regex only caught prose references, never enforced anything.
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

        // The swarm result KD must be milestone-scoped — the first token after
        // impl- is the dispatched milestone ID. This naming is the check-off
        // contract the protocol-gate reads back: the impl KD on disk is the
        // verifiable evidence of the milestone's completion. Matching is
        // case-insensitive so a lowercase milestone token satisfies the
        // uppercase milestone ID.
        if (fields.result_kd) {
          const resultToken = extractMilestoneTokenFromResultKd(fields.result_kd);
          if (!resultToken || resultToken.toLowerCase() !== milestoneId.toLowerCase()) {
            debug(`VALIDATION FAILED: swarm result KD '${fields.result_kd}' does not carry milestone '${milestoneId}'`);
            throw new DelegationGateError(ERRORS.RESULT_KD_MILESTONE_MISMATCH.code, ERRORS.RESULT_KD_MILESTONE_MISMATCH.message, ERRORS.RESULT_KD_MILESTONE_MISMATCH.guidance);
          }
        }
      }

      debug(`Rendering template for mode='${fields.mode}', agent='${fields.agent}'`);

      // Issue 67: expand the reserved SESSION_KDS token at render time and
      // advise on under-enumerated all-upstream dispatches. Runs after
      // validation so literal-path strictness is unchanged; the advisory is
      // non-blocking. SESSION_KDS lists are exempt from the advisory —
      // they enumerate every current-generation KD, so a shortfall is
      // impossible by construction.
      if (fields.kd_paths) {
        const generation = fields.generation !== undefined && fields.generation !== ""
          ? fields.generation
          : resolveLifecycleGeneration(fields.session_id);
        const expanded = expandKdPaths(fields.kd_paths, fields.session_id, generation);
        fields.kd_paths = expanded.value;
        if (!expanded.hasToken && fields.session_id && template.includes(ALL_UPSTREAM_KD_SENTENCE)) {
          const onDiskCount = listSessionKdPaths(fields.session_id, generation).length;
          if (expanded.listedCount < onDiskCount) {
            warn(`KD PATHS under-enumeration: ${expanded.listedCount} listed vs ${onDiskCount} on-disk lifecycle KDs for ${fields.session_id} — pass SESSION_KDS to enumerate every current-generation KD`);
          }
        }
      }

      const rendered = renderTemplate(template, fields);
      output.args.prompt = rendered;
      debug(`Prompt rendered successfully (${rendered.length} chars)`);
    }

    // --- Hook: tool.definition ---
    // Annotate the task tool definition so the format hint is visible to the
    // dispatcher before composing. Dedupe guard: never show the hint twice on
    // one surface — injectToolDocs applies the same includes() guard to the
    // subagent-facing description after compose.
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
