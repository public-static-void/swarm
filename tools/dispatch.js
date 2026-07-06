import { tool } from "@opencode-ai/plugin";
import { readFileSync, readdirSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import crypto from "crypto";

// ─── Constants ───────────────────────────────────────────────────────────────

const KNOWN_AGENTS = [
  "explorer", "spec-weaver", "pathfinder", "analyzer",
  "artisan", "committer", "inspector", "scribe", "habit-builder"
];

const KD_PATH_PATTERN = /^knowledge\/[a-z]+-[a-z0-9-]+-\d{4}-\d{2}-\d{2}\.md$/;

const FILE_PATH_PATTERNS = [
  /\/home\//, /\.\//, /\bsrc\//, /^refs\//, /^\/[a-zA-Z]/
];

const FILE_EXTENSIONS = /\.(py|ts|rs|md|json|yaml|yml|toml|cfg|ini|sh|js|jsx|tsx|css|scss|html|sql|go|rb|java|kt|swift|c|cpp|h|hpp)$/;

const READ_VERBS = /\b(read|return contents|list files|get the file|cat |view file)\b/i;

const REJECTION_CODES = {
  UNKNOWN_AGENT: "target_agent is not a registered agent or is the Overseer (self-dispatch not allowed)",
  INVALID_KD_PATH: "a referenced_kds entry does not match the KD path pattern",
  INLINE_CODE_DETECTED: "field contains code blocks or inline code",
  FILE_PATH_DETECTED: "field contains source file paths",
  IMPLEMENTATION_INSTRUCTION: "field contains HOW-level implementation details",
  FILE_EXTENSION_IN_DOMAIN: "domain_or_scope_or_mode contains file extensions",
  READ_VERB_IN_DOMAIN: "domain_or_scope_or_mode contains read verbs or return contents language",
  MISSING_INTENT_KD: "no current-session INTENT KD exists for Phase >2 dispatch",
  PHASE_ORDER_VIOLATION: "prerequisite artifact for this phase does not exist",
  SESSION_MISMATCH: "referenced KDs have different session date prefixes",
  OVERSIZED_INPUT: "field exceeds max length constraint",
  EXTRA_FIELD_REJECTED: "input contains properties not in the schema",
  INTERNAL_ERROR: "tool-level failure occurred during validation"
};

// ─── Phase Readiness Table ──────────────────────────────────────────────────
// Maps lifecycle phases to target agents, artifact patterns, and prerequisites.
// Used by determinePhase() and validateDispatch() for phase ordering checks.

const PHASE_TABLE = [
  { phase: 1, agents: ["overseer-self"], artifactPattern: "INTENT KD", prereq: null },
  { phase: 2, agents: ["committer"], artifactPattern: "MODE: PREFLIGHT", prereq: null },
  { phase: 3, agents: ["explorer"], artifactPattern: "exploration", prereq: null },
  { phase: 4, agents: ["analyzer"], artifactPattern: "ANALYSIS", prereq: "exploration" },
  { phase: 5, agents: ["spec-weaver"], artifactPattern: "SPEC", prereq: "analysis" },
  { phase: 6, agents: ["pathfinder"], artifactPattern: "PLAN", prereq: "spec" },
  { phase: 7, agents: ["artisan"], artifactPattern: "implementation", prereq: "plan" },
  { phase: 8, agents: ["inspector"], artifactPattern: "REVIEW", prereq: "impl" },
  { phase: 9, agents: ["scribe"], artifactPattern: "COMPOSED", prereq: "review" },
  { phase: 10, agents: ["habit-builder"], artifactPattern: "PROCESS", prereq: "composed" },
  { phase: 11, agents: ["committer"], artifactPattern: "MODE: CLEANUP", prereq: "process" }
];

/**
 * Determine the implied phase from target_agent and artifact.
 * Returns phase number or null if undetermined.
 */
function determinePhase(targetAgent, artifact) {
  for (const entry of PHASE_TABLE) {
    if (entry.agents.includes(targetAgent)) {
      const artifactLower = (artifact || "").toLowerCase();
      const patternLower = entry.artifactPattern.toLowerCase();
      if (artifactLower.includes(patternLower)) {
        return entry.phase;
      }
    }
  }
  return null;
}

/**
 * Session date is extracted from the KDS paths if provided.
 */
function extractSessionDate(kds) {
  if (!kds || kds.length === 0) return null;
  for (const kd of kds) {
    const match = kd.match(/(\d{4}-\d{2}-\d{2})/);
    if (match) return match[1];
  }
  return null;
}

/**
 * Check if a particular prerequisite file exists.
 * The prereq pattern maps: exploration -> knowledge/exploration-*.md
 * Returns true if prereqType is null (Phase 1/2 have no prereq).
 */
function prereqExists(worktree, prereqType) {
  if (!prereqType) return true;
  const knowledgeDir = join(worktree, "knowledge");
  try {
    if (!existsSync(knowledgeDir)) return false;
    const entries = readdirSync(knowledgeDir);
    return entries.some(e => e.startsWith(prereqType));
  } catch {
    return false;
  }
}

// ─── Validation Functions ───────────────────────────────────────────────────

class ValidationError extends Error {
  constructor(code, field, violation, detail) {
    super(detail);
    this.code = code;
    this.field = field;
    this.violation = violation;
    this.detail = detail;
  }
}

function scanForInlineCode(value) {
  if (!value) return null;
  const str = String(value);
  if (/```/.test(str)) return "triple-backtick code block detected";
  if (/`[^`\n]+`/.test(str)) return "inline backtick code detected";
  return null;
}

function scanForFilePaths(value) {
  if (!value) return null;
  const str = String(value);
  for (const pattern of FILE_PATH_PATTERNS) {
    if (pattern.test(str)) {
      return `source file path pattern '${pattern.source}' detected`;
    }
  }
  return null;
}

function scanForImplementationInstructions(value) {
  if (!value) return null;
  const str = String(value);
  const howPatterns = [
    /\b(use|using|implement|implemented with)\s+(FastAPI|Express|Django|Flask|Spring|React|Vue|Angular|Laravel|Rails|Next\.?js|Nuxt|Svelte)\b/i,
    /\b(use|using|implement)\s+(Pydantic|Zod|Joi|class-validator|TypeORM|Prisma|Mongoose|SQLAlchemy)\b/i,
    /\bfunction\s+signature\b/i,
    /\b(algorithm|procedure)\s+step[s]?\b/i,
    /\bN\+1\s+query\b/i,
    /\b(follow|implement|apply)\s+(TDD|BDD|DDD|MVC|MVVM|Clean Architecture|Hexagonal)\b/i
  ];
  for (const pattern of howPatterns) {
    if (pattern.test(str)) return `implementation instruction pattern '${pattern.source}' detected`;
  }
  return null;
}

function scanForFileExtension(value) {
  if (!value) return null;
  const str = String(value);
  const match = FILE_EXTENSIONS.exec(str);
  if (match) return `file extension '${match[0]}' detected`;
  return null;
}

function scanForReadVerbs(value) {
  if (!value) return null;
  const str = String(value);
  const match = READ_VERBS.exec(str);
  if (match) return `read verb '${match[0]}' detected`;
  return null;
}

function validateKDKds(kds) {
  if (!kds || kds.length === 0) return [];
  const violations = [];
  for (const kd of kds) {
    if (!KD_PATH_PATTERN.test(kd)) {
      violations.push(`'${kd}' does not match knowledge/{type}-{name}-{date}.md pattern`);
    }
  }
  return violations;
}

function checkSessionMismatch(kds) {
  if (!kds || kds.length < 2) return null;
  const dates = kds.map(kd => {
    const match = kd.match(/(\d{4}-\d{2}-\d{2})/);
    return match ? match[1] : null;
  }).filter(Boolean);
  if (dates.length < 2) return null;
  const uniqueDates = new Set(dates);
  if (uniqueDates.size > 1) {
    return `KDs reference multiple session dates: ${[...uniqueDates].join(", ")}`;
  }
  return null;
}

function generateDispatchId(date) {
  const hash = crypto.randomBytes(4).toString("hex");
  const seq = Math.floor(Math.random() * 1000).toString().padStart(3, "0");
  return `dsp-${hash}-${date || "unknown"}-${seq}`;
}

function truncateHash(content) {
  if (!content) return "empty";
  return crypto.createHash("sha256").update(content).digest("hex").substring(0, 8);
}

// ─── Audit Logging ──────────────────────────────────────────────────────────

function ensureKnowledgeDir(worktree) {
  const dir = join(worktree, "knowledge");
  try {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    return dir;
  } catch {
    return null;
  }
}

function writeAuditEntry(worktree, entry) {
  const sessionDate = entry.timestamp.substring(0, 10);
  const auditPath = join(worktree, "knowledge", `audit-dispatch-log-${sessionDate}.md`);
  try {
    ensureKnowledgeDir(worktree);
    if (!existsSync(auditPath)) {
      const header = `---\ntitle: "AUDIT: Dispatch Log - ${sessionDate}"\nversion: 1.0.0\nstatus: draft\ntype: audit\ncreated: "${sessionDate}"\nauthor: dispatch-tool\n---\n\n# AUDIT: Dispatch Log\n\n## Entries\n\n`;
      writeFileSync(auditPath, header, "utf8");
    }
    const content = readFileSync(auditPath, "utf8");
    const entryCount = (content.match(/### Entry \d+/g) || []).length;
    const entryNum = entryCount + 1;
    const entryText = [
      `\n### Entry ${String(entryNum).padStart(3, "0")}`,
      `- **Timestamp**: ${entry.timestamp}`,
      `- **target_agent**: ${entry.target_agent}`,
      `- **artifact**: ${entry.artifact}`,
      `- **referenced_kds**: ${JSON.stringify(entry.referenced_kds || [])}`,
      `- **acceptance_hash**: ${entry.acceptance_hash}`,
      `- **result**: ${entry.result}`,
      `- **reason**: ${entry.reason || "null"}`,
      ""
    ].join("\n");
    appendFileSync(auditPath, entryText, "utf8");
  } catch {
    // Audit log failure should not block dispatch — best-effort only
  }
}

/**
 * Build a structured dispatch message from validated args.
 * Used as the prompt sent to the target agent via HTTP dispatch.
 */
function buildDispatchMessage(args, sessionDate) {
  const { target_agent, artifact, referenced_kds, domain_or_scope_or_mode, acceptance_criteria } = args;
  const dateStr = sessionDate || "unknown";
  const lines = [
    `DISPATCH TO: ${target_agent}`,
    `ACTION: Create`,
    `ARTIFACT: ${artifact}`,
  ];
  if (domain_or_scope_or_mode) {
    lines.push(domain_or_scope_or_mode);
  }
  if (referenced_kds && referenced_kds.length > 0) {
    lines.push("KDS:");
    referenced_kds.forEach(kd => lines.push(`  - ${kd}`));
  } else {
    lines.push("KDS: None");
  }
  lines.push(`RETURN: knowledge/${artifact}-${dateStr}.md`);
  lines.push(`ACCEPTANCE: ${acceptance_criteria}`);
  return lines.join("\n");
}

// ─── Main Validation ────────────────────────────────────────────────────────

function validateDispatch(args, worktree) {
  const { target_agent, artifact, referenced_kds, domain_or_scope_or_mode, acceptance_criteria } = args;

  // ── R004: Target Agent Validation ──
  if (!target_agent) {
    throw new ValidationError("UNKNOWN_AGENT", "target_agent", "missing", "target_agent is required");
  }
  if (!KNOWN_AGENTS.includes(target_agent)) {
    throw new ValidationError("UNKNOWN_AGENT", "target_agent", target_agent, `"${target_agent}" is not a registered agent`);
  }

  // ── Field Size Constraints ──
  if (artifact && artifact.length > 200) {
    throw new ValidationError("OVERSIZED_INPUT", "artifact", `length ${artifact.length}`, "artifact exceeds maxLength of 200");
  }
  if (acceptance_criteria && acceptance_criteria.length > 1000) {
    throw new ValidationError("OVERSIZED_INPUT", "acceptance_criteria", `length ${acceptance_criteria.length}`, "acceptance_criteria exceeds maxLength of 1000");
  }
  if (referenced_kds && referenced_kds.length > 20) {
    throw new ValidationError("OVERSIZED_INPUT", "referenced_kds", `${referenced_kds.length} items`, "referenced_kds exceeds maxItems of 20");
  }

  // ── R003: Non-KD Content Rejection ──
  const fieldsToScan = { target_agent, artifact, domain_or_scope_or_mode, acceptance_criteria };

  for (const [field, value] of Object.entries(fieldsToScan)) {
    const codeViolation = scanForInlineCode(value);
    if (codeViolation) {
      throw new ValidationError("INLINE_CODE_DETECTED", field, codeViolation, `Field '${field}' contains inline code`);
    }

    const pathViolation = scanForFilePaths(value);
    if (pathViolation) {
      throw new ValidationError("FILE_PATH_DETECTED", field, pathViolation, `Field '${field}' contains source file path`);
    }

    const implViolation = scanForImplementationInstructions(value);
    if (implViolation) {
      throw new ValidationError("IMPLEMENTATION_INSTRUCTION", field, implViolation, `Field '${field}' contains implementation instructions`);
    }
  }

  // ── File extension in domain_or_scope_or_mode ──
  if (domain_or_scope_or_mode) {
    const extViolation = scanForFileExtension(domain_or_scope_or_mode);
    if (extViolation) {
      throw new ValidationError("FILE_EXTENSION_IN_DOMAIN", "domain_or_scope_or_mode", extViolation, "domain_or_scope_or_mode contains file extension");
    }

    const readViolation = scanForReadVerbs(domain_or_scope_or_mode);
    if (readViolation) {
      throw new ValidationError("READ_VERB_IN_DOMAIN", "domain_or_scope_or_mode", readViolation, "domain_or_scope_or_mode contains read verb or return contents language");
    }

    if (!/^(DOMAIN|SCOPE|MODE):\s/.test(domain_or_scope_or_mode)) {
      throw new ValidationError("EXTRA_FIELD_REJECTED", "domain_or_scope_or_mode", domain_or_scope_or_mode,
        'domain_or_scope_or_mode must start with "DOMAIN:", "SCOPE:", or "MODE:"');
    }
  }

  // ── KDS Validation ──
  if (referenced_kds && referenced_kds.length > 0) {
    const kdViolations = validateKDKds(referenced_kds);
    if (kdViolations.length > 0) {
      throw new ValidationError("INVALID_KD_PATH", "referenced_kds", kdViolations.join("; "), "referenced_kds entries do not match KD path pattern");
    }

    const sessionViolation = checkSessionMismatch(referenced_kds);
    if (sessionViolation) {
      throw new ValidationError("SESSION_MISMATCH", "referenced_kds", sessionViolation, "referenced KDs have different session dates");
    }
  }

  // ── Acceptance criteria check — must be WHAT-level ──
  if (acceptance_criteria) {
    if (acceptance_criteria.trim().length === 0) {
      throw new ValidationError("EXTRA_FIELD_REJECTED", "acceptance_criteria", "empty", "acceptance_criteria must not be empty");
    }
  }

  // ── R005: Phase Readiness Check ──
  const phase = determinePhase(target_agent, artifact);
  if (phase !== null && phase > 2) {
    const sessionDate = extractSessionDate(referenced_kds);
    if (!sessionDate || sessionDate === "unknown") {
      throw new ValidationError("MISSING_INTENT_KD", "referenced_kds", "no session date found",
        "Cannot determine session date from KDS. A current-session INTENT KD is required for Phase >2 dispatches.");
    }

    const intentExists = prereqExists(worktree, "intent-");
    if (!intentExists) {
      throw new ValidationError("MISSING_INTENT_KD", "referenced_kds", "INTENT KD not found",
        `No current-session INTENT KD found in knowledge/ directory. Phase ${phase} dispatch requires an INTENT KD.`);
    }

    const phaseEntry = PHASE_TABLE.find(p => p.phase === phase);
    if (phaseEntry && phaseEntry.prereq) {
      const found = prereqExists(worktree, phaseEntry.prereq);
      if (!found) {
        throw new ValidationError("PHASE_ORDER_VIOLATION", "artifact",
          `Phase ${phase} prerequisite '${phaseEntry.prereq}' not found in knowledge/`,
          `Phase ${phase} (${phaseEntry.artifactPattern}) requires the ` +
          `Phase ${phase - 1} ${phaseEntry.prereq} artifact. ` +
          `Complete Phase ${phase - 1} before advancing to Phase ${phase}.`);
      }
    }
  }
}

// ─── Custom Tool Export ──────────────────────────────────────────────────────
// Auto-discovered by opencode from ~/.config/opencode/tools/dispatch.js
// The filename 'dispatch.js' becomes the tool name 'dispatch'.
// This is a standalone tool, NOT wrapped in a plugin() — the framework
// discovers it automatically from the tools/ directory.

export default tool({
  description: "Validate and route a structured dispatch to a sub-agent. "
    + "Rejects non-compliant dispatches before they reach the target agent. "
    + "Performs structural field validation, KD path verification, content safety checks, "
    + "agent validation, phase readiness checks, and audit logging.",
  args: {
    target_agent: tool.schema.string().describe(
      "Registered sub-agent to receive the dispatch. "
      + "Must be one of: explorer, spec-weaver, pathfinder, analyzer, artisan, committer, inspector, scribe, habit-builder."
    ),
    artifact: tool.schema.string().max(200).describe(
      "Concise artifact description (e.g., 'SPEC KD', 'exploration KD', 'implementation')"
    ),
    referenced_kds: tool.schema.array(tool.schema.string()).max(20).optional().default([]).describe(
      "KD path references only — must match knowledge/{type}-{name}-{date}.md pattern"
    ),
    domain_or_scope_or_mode: tool.schema.string().optional().describe(
      "Context field: DOMAIN: {noun phrase} | SCOPE: {identifier} | MODE: {PREFLIGHT|CHECKPOINT|CLEANUP}"
    ),
    acceptance_criteria: tool.schema.string().max(1000).describe(
      "WHAT-level acceptance criteria (no code, no file paths, no implementation instructions)"
    )
  },
  async execute(args, context) {
    try {
      validateDispatch(args, context.worktree);
      const { target_agent, artifact, referenced_kds, domain_or_scope_or_mode, acceptance_criteria } = args;
      const sessionDate = extractSessionDate(referenced_kds) || new Date().toISOString().substring(0, 10);
      const dispatchId = generateDispatchId(sessionDate);

      // Build the structured dispatch message for the target agent
      const dispatchMessage = buildDispatchMessage(args, sessionDate);

      // Log acceptance to audit
      writeAuditEntry(context.worktree, {
        timestamp: new Date().toISOString(),
        target_agent,
        artifact,
        referenced_kds: referenced_kds || [],
        acceptance_hash: truncateHash(acceptance_criteria || ""),
        result: "accepted",
        reason: null
      });

      // ── HTTP Dispatch ────────────────────────────────────────────────────
      // Send the validated dispatch to the target agent via the opencode server API.
      // The server URL is hardcoded to the default localhost:4096.
      // No auth needed — server listens on 127.0.0.1 only.
      const SERVER_URL = "http://127.0.0.1:4096";
      const sessionId = context.sessionID;

      if (!sessionId) {
        throw new Error("Session ID not available in tool context — cannot dispatch via HTTP");
      }

      let httpStatus = null;
      let httpBody = null;
      let httpError = null;

      try {
        const response = await fetch(`${SERVER_URL}/session/${sessionId}/message`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agent: target_agent,
            parts: [{
              type: "subtask",
              agent: target_agent,
              prompt: dispatchMessage,
              description: artifact
            }],
            noReply: true
          })
        });

        httpStatus = response.status;
        httpBody = await response.text().catch(() => "{}");

        if (!response.ok) {
          httpError = `HTTP ${response.status}: ${httpBody}`;
        }
      } catch (fetchErr) {
        httpError = `Fetch failed: ${fetchErr.message}`;
      }

      if (httpError) {
        // Log the HTTP failure to audit
        writeAuditEntry(context.worktree, {
          timestamp: new Date().toISOString(),
          target_agent,
          artifact,
          referenced_kds: referenced_kds || [],
          acceptance_hash: truncateHash(acceptance_criteria || ""),
          result: "rejected",
          reason: "HTTP_DISPATCH_FAILED"
        });

        const output = {
          status: "dispatch_failed",
          dispatch_id: dispatchId,
          target_agent,
          session_id: sessionId,
          error: httpError,
          audit_entry: `knowledge/audit-dispatch-log-${sessionDate}.md`
        };

        return {
          title: "Dispatch Accepted but HTTP Routing Failed",
          output: JSON.stringify(output, null, 2),
          metadata: {
            dispatch_id: dispatchId,
            target_agent,
            status: "dispatch_failed",
            error: httpError,
            audit_entry: `knowledge/audit-dispatch-log-${sessionDate}.md`
          }
        };
      }

      const output = {
        status: "accepted",
        dispatch_id: dispatchId,
        target_agent,
        session_id: sessionId,
        http_status: httpStatus,
        audit_entry: `knowledge/audit-dispatch-log-${sessionDate}.md`
      };

      return {
        title: `Dispatch Accepted — Routed to ${target_agent}`,
        output: JSON.stringify(output, null, 2),
        metadata: {
          dispatch_id: dispatchId,
          target_agent,
          status: "accepted",
          session_id: sessionId,
          http_status: httpStatus,
          audit_entry: `knowledge/audit-dispatch-log-${sessionDate}.md`
        }
      };
    } catch (err) {
      if (err instanceof ValidationError) {
        const sessionDate = new Date().toISOString().substring(0, 10);
        const { target_agent, artifact, referenced_kds, acceptance_criteria } = args;

        writeAuditEntry(context.worktree, {
          timestamp: new Date().toISOString(),
          target_agent: target_agent || "unknown",
          artifact: artifact || "unknown",
          referenced_kds: referenced_kds || [],
          acceptance_hash: truncateHash(acceptance_criteria || ""),
          result: "rejected",
          reason: err.code
        });

        return {
          title: `Dispatch Rejected — ${err.code}`,
          output: JSON.stringify({
            status: "rejected",
            error_code: err.code,
            field: err.field,
            violation: err.violation,
            detail: err.detail,
            audit_entry: `knowledge/audit-dispatch-log-${sessionDate}.md`
          }, null, 2),
          metadata: {
            status: "rejected",
            error_code: err.code,
            field: err.field
          }
        };
      }

      // Unknown error — INTERNAL_ERROR
      const sessionDate = new Date().toISOString().substring(0, 10);
      writeAuditEntry(context.worktree, {
        timestamp: new Date().toISOString(),
        target_agent: args?.target_agent || "unknown",
        artifact: args?.artifact || "unknown",
        referenced_kds: args?.referenced_kds || [],
        acceptance_hash: truncateHash(args?.acceptance_criteria || ""),
        result: "rejected",
        reason: "INTERNAL_ERROR"
      });

      return {
        title: "Dispatch Rejected — INTERNAL_ERROR",
        output: JSON.stringify({
          status: "rejected",
          error_code: "INTERNAL_ERROR",
          field: null,
          violation: err.message,
          detail: "Tool-level failure occurred during validation. Verify tool configuration.",
          audit_entry: `knowledge/audit-dispatch-log-${sessionDate}.md`
        }, null, 2),
        metadata: {
          status: "rejected",
          error_code: "INTERNAL_ERROR",
          field: null
        }
      };
    }
  }
});
