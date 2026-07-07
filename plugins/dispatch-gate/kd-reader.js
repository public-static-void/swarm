// plugins/dispatch-gate/kd-reader.js
// Reads and extracts data from Knowledge Documents (KDs).
// Provides structured data for the template engine and dispatch flow.
// All functions are synchronous by design — file system calls use readFileSync.

import fs from "fs";
import path from "path";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Split raw KD content into frontmatter (YAML) and body (markdown).
 * Frontmatter is bounded by --- markers at the start of the file.
 * Returns { frontmatter: object|null, body: string }.
 */
function splitFrontmatter(content) {
  if (typeof content !== "string") return { frontmatter: null, body: "" };
  const trimmed = content.trimStart();

  // Must start with --- on its own line
  if (!trimmed.startsWith("---")) {
    return { frontmatter: null, body: trimmed };
  }

  // Find the closing ---
  const endIdx = trimmed.indexOf("\n---", 3);
  if (endIdx === -1) {
    return { frontmatter: null, body: trimmed };
  }

  const yamlBlock = trimmed.slice(3, endIdx).trim();
  const body = trimmed.slice(endIdx + 4).trim();
  return { frontmatter: parseSimpleYaml(yamlBlock), body };
}

/**
 * Parse simple YAML frontmatter (key-value pairs only).
 * Supports: string, quoted string, number, and array-of-strings values.
 * Returns a plain object or null if parsing fails.
 */
function parseSimpleYaml(yamlBlock) {
  if (!yamlBlock) return null;
  const result = {};
  try {
    const lines = yamlBlock.split("\n");
    let currentKey = null;
    let currentArray = null;

    for (const raw of lines) {
      const line = raw.trimEnd();

      // Skip empty lines and comments
      if (line === "" || line.startsWith("#")) continue;

      // Array item continuation (starts with dash)
      if (line.startsWith("- ") && currentKey !== null) {
        const val = line.slice(2).trim();
        result[currentKey] = result[currentKey] || [];
        result[currentKey].push(trimYamlValue(val));
        continue;
      }

      // Key-value pair (key: value)
      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) continue;

      const key = line.slice(0, colonIdx).trim();
      let val = line.slice(colonIdx + 1).trim();

      if (val === "" || val === "null") {
        result[key] = null;
      } else if (val === "true") {
        result[key] = true;
      } else if (val === "false") {
        result[key] = false;
      } else {
        result[key] = trimYamlValue(val);
      }
      currentKey = key;
    }

    const valid = Object.keys(result).length > 0 && validateYamlValues(result);
    return valid ? result : null;
  } catch (_) {
    return null;
  }
}

/**
 * Validate YAML string values for common malformations.
 * Returns true if all values appear well-formed.
 */
function validateYamlValues(obj) {
  for (const val of Object.values(obj)) {
    if (typeof val === "string") {
      // Detect unclosed quotes: starts with " or ' but doesn't end with same
      if (
        (val.startsWith('"') && !val.endsWith('"')) ||
        (val.startsWith("'") && !val.endsWith("'"))
      ) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Strip quotes from a YAML scalar value if present.
 */
function trimYamlValue(val) {
  if (typeof val !== "string") return val;
  const trimmed = val.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Extract a markdown section by heading name.
 * Supports both ## Section Name and ### Sub-section Name.
 * Returns the section text as a trimmed string, or empty string if not found.
 */
function extractSection(body, sectionName) {
  if (!body) return "";
  // Match ## or ### headings with the given name (case-insensitive)
  const regex = new RegExp(
    `^#{2,3}\\s+${escapeRegex(sectionName)}\\s*$`,
    "im"
  );
  const match = body.match(regex);
  if (!match) return "";

  const startIdx = match.index + match[0].length;
  // Collect lines until the next heading of same or higher level
  const lines = body.slice(startIdx).split("\n");
  const sectionLines = [];
  for (const line of lines) {
    // Stop at next ## heading (or end of content)
    if (/^##\s/.test(line)) break;
    sectionLines.push(line);
  }
  return sectionLines.join("\n").trim();
}

/**
 * Escape special regex characters in a string for use in RegExp constructor.
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Parse KD filename following the pattern: {type}-{name}-{YYYY-MM-DD}.md
 * Works with both relative (knowledge/...) and absolute paths.
 * Returns { type, name, date } or null if pattern doesn't match.
 */
function parseKdFilename(filePath) {
  if (!filePath) return null;
  const basename = path.basename(filePath);
  const regex = /^([a-z]+)-(.+)-(\d{4}-\d{2}-\d{2})\.md$/i;
  const match = basename.match(regex);
  if (!match) return null;
  return {
    type: match[1].toLowerCase(),
    name: match[2],
    date: match[3],
  };
}

/**
 * Safely read a file, returning null on any error (missing file, permission, etc).
 */
function readFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch (_) {
    return null;
  }
}

/**
 * Resolve a relative KD path against the workspace root.
 * If the path is already absolute, return it as-is.
 */
function resolvePath(kdPath) {
  if (path.isAbsolute(kdPath)) return kdPath;
  return path.resolve(process.cwd(), kdPath);
}

// ---------------------------------------------------------------------------
// Exported functions
// ---------------------------------------------------------------------------

/**
 * Read an INTENT KD and extract structured data.
 *
 * @param {string} kdPath — Path to the INTENT KD file (relative or absolute).
 * @returns {{ title: string|null, objective: string, successCriteria: string[] }}
 *   Returns null/empty values gracefully on errors.
 */
export function readIntentKd(kdPath) {
  try {
    const content = readFileSafe(resolvePath(kdPath));
    if (!content) return { title: null, objective: "", successCriteria: [] };

    const { frontmatter, body } = splitFrontmatter(content);
    const title = frontmatter && frontmatter.title ? frontmatter.title : null;

    // Extract objective from ## Objective section
    const objective = extractSection(body, "Objective");

    // Extract success criteria from ## Success Criteria or ## Fixes sections
    const successCriteriaSection =
      extractSection(body, "Success Criteria");

    const fixesSection = extractSection(body, "Fixes");

    const successCriteria = successCriteriaSection
      ? parseChecklist(successCriteriaSection)
      : fixesSection
        ? parseFixesSection(fixesSection)
        : [];

    return { title, objective, successCriteria };
  } catch (_) {
    return { title: null, objective: "", successCriteria: [] };
  }
}

/**
 * Read a SPEC KD and extract structured data.
 *
 * @param {string} kdPath — Path to the SPEC KD file (relative or absolute).
 * @returns {{ title: string|null, requirements: Array<{id: string, text: string}>, acceptanceCriteria: string[] }}
 */
export function readSpecKd(kdPath) {
  try {
    const content = readFileSafe(resolvePath(kdPath));
    if (!content) return { title: null, requirements: [], acceptanceCriteria: [] };

    const { frontmatter, body } = splitFrontmatter(content);
    const title = frontmatter && frontmatter.title ? frontmatter.title : null;

    // Extract numbered requirements (R001, R002, etc.)
    const requirements = extractRequirements(body);

    // Extract acceptance criteria from ## Acceptance Criteria section
    const acceptanceSection = extractSection(body, "Acceptance Criteria");
    const acceptanceCriteria = parseChecklist(acceptanceSection);

    return { title, requirements, acceptanceCriteria };
  } catch (_) {
    return { title: null, requirements: [], acceptanceCriteria: [] };
  }
}

/**
 * Read any KD and extract generic metadata.
 *
 * @param {string} kdPath — Path to the KD file (relative or absolute).
 * @returns {{ title: string|null, type: string|null, created: string|null, summary: string }}
 */
export function readKd(kdPath) {
  try {
    const content = readFileSafe(resolvePath(kdPath));
    if (!content) return { title: null, type: null, created: null, summary: "" };

    const { frontmatter, body } = splitFrontmatter(content);
    const title = frontmatter && frontmatter.title ? frontmatter.title : null;
    const type = frontmatter && frontmatter.type ? frontmatter.type : null;
    const created = frontmatter && frontmatter.created ? String(frontmatter.created) : null;

    // Summary is the first paragraph after frontmatter (before any ## heading)
    const summary = extractFirstParagraph(body);

    return { title, type, created, summary };
  } catch (_) {
    return { title: null, type: null, created: null, summary: "" };
  }
}

/**
 * Extract the session date (YYYY-MM-DD) from a KD filename.
 *
 * @param {string} kdPath — Path to a KD file.
 * @returns {string|null} — Date string in YYYY-MM-DD format or null.
 */
export function extractSessionDate(kdPath) {
  if (!kdPath) return null;
  const parsed = parseKdFilename(kdPath);
  return parsed ? parsed.date : null;
}

/**
 * Given an intent KD path and a mode, determine the relevant KDs to reference.
 * The session date is extracted from the intent KD filename.
 *
 * Mode-to-KD mapping:
 *   explore:     [intent_kd]
 *   investigate: [intent_kd, exploration_kd for same session]
 *   align:       [intent_kd, exploration_kd, analysis_kd]
 *   decompose:   [spec_kd]
 *   swarm:       [spec_kd, plan_kd]
 *   verify:      [spec_kd, plan_kd, impl_kd]
 *   extract:     [all session KDs]
 *   evolve:      [all session KDs]
 *   commit:      [] (no KDs)
 *   report:      [all session KDs]
 *   preflight:   [intent_kd]
 *   checkpoint:  [] (no KDs)
 *
 * @param {string} intentPath — Path to the intent KD for the current session.
 * @param {string} mode — One of the modes listed above.
 * @returns {string[]} — Array of KD paths relevant to the given mode.
 */
export function getPhaseKds(intentPath, mode) {
  if (!intentPath || !mode) return [];

  const parsed = parseKdFilename(intentPath);
  if (!parsed) return [];

  const { name, date } = parsed;
  const kdDir = path.dirname(resolvePath(intentPath));

  // Build canonical KD path for a given type
  const kdPath = (type) => path.join(kdDir, `${type}-${name}-${date}.md`);

  // Globs for all KDs matching this session date
  const findSessionKds = () => {
    try {
      const files = fs.readdirSync(kdDir);
      const datePrefix = `${date}`;
      return files
        .filter((f) => {
          const p = parseKdFilename(f);
          return p && p.date === datePrefix;
        })
        .map((f) => path.join(kdDir, f));
    } catch (_) {
      return [];
    }
  };

  switch (mode) {
    case "explore":
      return [kdPath("intent")];

    case "investigate":
      return [kdPath("intent"), kdPath("exploration")];

    case "align":
      return [kdPath("intent"), kdPath("exploration"), kdPath("analysis")];

    case "decompose":
      return [kdPath("spec")];

    case "swarm":
      return [kdPath("spec"), kdPath("plan")];

    case "verify":
      return [kdPath("spec"), kdPath("plan"), kdPath("impl")];

    case "extract":
      return findSessionKds();

    case "evolve":
      return findSessionKds();

    case "commit":
      return [];

    case "report":
      return findSessionKds();

    case "preflight":
      return [kdPath("intent")];

    case "checkpoint":
      return [];

    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Internal section parsers
// ---------------------------------------------------------------------------

/**
 * Extract numbered requirements (R001, R002, etc.) from a SPEC KD body.
 * Returns an array of { id, text } objects.
 */
function extractRequirements(body) {
  if (!body) return [];
  const results = [];
  const regex = /###?\s*(R\d{3}):\s*(.+?)(?=\n###?\s*R\d{3}:|\n##\s|$)/gis;
  let match;
  while ((match = regex.exec(body)) !== null) {
    results.push({
      id: match[1].trim(),
      text: match[2].trim(),
    });
  }

  // Fallback: match inline **R001:** bold patterns
  if (results.length === 0) {
    const inlineRegex = /\*\*(R\d{3}):\*\*\s*(.+?)(?=\n\*\*R\d{3}:|\n##\s|$)/gis;
    while ((match = inlineRegex.exec(body)) !== null) {
      results.push({
        id: match[1].trim(),
        text: match[2].trim(),
      });
    }
  }

  return results;
}

/**
 * Parse checklist items from a section body.
 * Supports both `- [ ] item` (checklist) and `- **ID**: item` formats.
 */
function parseChecklist(sectionText) {
  if (!sectionText) return [];
  const items = [];
  const lines = sectionText.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    // Match - [ ] checklist items
    const checklistMatch = trimmed.match(/^-\s+\[[ x]?\]\s+(.+)/i);
    if (checklistMatch) {
      items.push(checklistMatch[1].trim());
      continue;
    }
    // Match - **label**: description items
    const labelMatch = trimmed.match(/^-\s+\*\*([^*]+)\*\*:\s*(.+)/);
    if (labelMatch) {
      items.push(labelMatch[2].trim());
      continue;
    }
    // Match plain bullet items (- text)
    const bulletMatch = trimmed.match(/^-\s+(.+)/);
    if (bulletMatch) {
      items.push(bulletMatch[1].trim());
    }
  }
  return items;
}

/**
 * Parse a Fixes section with sub-headings like:
 *   ### Fix 1 — Description text
 *   Paragraph describing the fix in detail.
 *
 * Returns an array of description strings from the heading text only.
 */
function parseFixesSection(sectionText) {
  if (!sectionText) return [];
  const items = [];
  const lines = sectionText.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    // Match ### Fix N — description or ### Fix N: description
    const headingMatch = trimmed.match(/^###\s+Fix\s+\d+[\s:—-]+\s*(.+)/i);
    if (headingMatch) {
      items.push(headingMatch[1].trim());
    }
  }
  return items;
}

/**
 * Extract the first paragraph of a body (text before the first ## heading).
 * Strips any HTML comments.
 */
function extractFirstParagraph(body) {
  if (!body) return "";
  // Remove HTML comments
  const noComments = body.replace(/<!--[\s\S]*?-->/g, "").trim();
  if (!noComments) return "";

  // Find first heading
  const headingIdx = noComments.search(/^##\s/m);
  const preHeading = headingIdx === -1 ? noComments : noComments.slice(0, headingIdx);

  // Extract first non-empty paragraph
  const paragraphs = preHeading.split("\n\n").filter((p) => p.trim() !== "");
  return paragraphs.length > 0 ? paragraphs[0].trim() : "";
}
