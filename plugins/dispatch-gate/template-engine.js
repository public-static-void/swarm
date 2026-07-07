// plugins/dispatch-gate/template-engine.js
// Generates dispatch prompts from structured data inputs using templates.json.
// Operates on path-based data only — does NOT read KD content.
// Slots: {{intent_kd}}, {{name}}, {{date}}, {{glob:pattern}}

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Parse a KD filename following: {type}-{name}-{YYYY-MM-DD}.md
 * Supports both relative (knowledge/...) and absolute paths.
 * Returns { name, date } or null if pattern doesn't match.
 */
function parseKdPath(kdPath) {
  if (!kdPath) return null;
  const basename = path.basename(kdPath);
  const regex = /^[a-z]+-(.+)-(\d{4}-\d{2}-\d{2})\.md$/i;
  const match = basename.match(regex);
  if (!match) return null;
  return {
    name: match[1],
    date: match[2],
  };
}

/**
 * Resolve a potentially relative path against the workspace root.
 * If the path is already absolute, return it as-is.
 */
function resolveWorkspacePath(filePath, workspaceRoot) {
  if (path.isAbsolute(filePath)) return filePath;
  return path.resolve(workspaceRoot, filePath);
}

/**
 * Resolve a {{glob:pattern}} entry to matching file paths in the knowledge/ directory.
 * The pattern is relative to the workspace root (e.g., "knowledge/*-{{date}}-*.md").
 * Uses fs.readdirSync on the knowledge/ directory to match files.
 * Returns an array of matched relative paths, or the pattern string if no matches.
 */
function resolveGlobPattern(pattern, variables, workspaceRoot) {
  // First resolve any {{variables}} within the pattern itself
  let resolvedPattern = pattern;
  for (const [key, value] of Object.entries(variables)) {
    resolvedPattern = resolvedPattern.replace(
      new RegExp(`\\{\\{${key}\\}\\}`, "g"),
      value
    );
  }

  // Extract the glob portion (after "glob:")
  const globPart = resolvedPattern.replace(/^\{\{glob:/, "").replace(/\}\}$/, "");
  
  // Determine the directory to search in
  const knowledgeDir = path.resolve(workspaceRoot, "knowledge");
  
  try {
    if (!fs.existsSync(knowledgeDir)) {
      return [];
    }

    const files = fs.readdirSync(knowledgeDir);
    
    // Build a simple pattern matcher from the glob expression
    // The pattern is like "knowledge/*-2026-07-06-*.md" or "knowledge/exploration-{{name}}-{{date}}.md"
    // Extract just the filename portion of the glob
    const globFilename = path.basename(globPart);
    
    // Convert glob pattern to regex: * → .*, . → \.
    const globRegex = new RegExp(
      "^" + globFilename.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$"
    );

    const matches = files
      .filter((f) => globRegex.test(f))
      .map((f) => path.join("knowledge", f));
    
    return matches;
  } catch (_) {
    return [];
  }
}

/**
 * Load and cache templates.json from the plugin directory.
 */
let _templatesCache = null;

function loadTemplates() {
  if (_templatesCache) return _templatesCache;
  
  const pluginDir = path.dirname(fileURLToPath(import.meta.url));
  const templatesPath = path.join(pluginDir, "templates.json");
  
  try {
    const content = fs.readFileSync(templatesPath, "utf-8");
    _templatesCache = JSON.parse(content);
    return _templatesCache;
  } catch (err) {
    throw new Error(
      `TEMPLATE_LOAD_ERROR: Failed to load templates.json — ${err.message}`
    );
  }
}

// ---------------------------------------------------------------------------
// Exported function
// ---------------------------------------------------------------------------

/**
 * Generate a dispatch prompt from structured data.
 *
 * @param {string} mode — One of the modes defined in templates.json
 * @param {string} intentKd — Path to the intent KD (e.g., "knowledge/intent-foo-2026-07-06.md")
 * @param {object} [options]
 * @param {string} [options.session_date] — Optional YYYY-MM-DD override
 * @param {string} [options.scope] — Optional scope identifier for scope-based modes
 * @param {string} [options.workspaceRoot] — Workspace root directory (defaults to cwd)
 * @returns {{ prompt: string, target_agent: string, dispatch_fields: object, self_execute: boolean }}
 */
export function fillTemplate(mode, intentKd, options = {}) {
  if (!mode) throw new Error("TEMPLATE_ERROR: mode is required");
  if (!intentKd) throw new Error("TEMPLATE_ERROR: intent_kd is required");

  const workspaceRoot = options.workspaceRoot || process.cwd();
  const templates = loadTemplates();
  const template = templates.modes[mode];

  if (!template) {
    throw new Error(
      `TEMPLATE_ERROR: Unknown mode "${mode}". Valid modes: ${Object.keys(templates.modes).join(", ")}`
    );
  }

  // Parse name and date from intent KD path
  const parsed = parseKdPath(intentKd);
  if (!parsed) {
    throw new Error(
      `TEMPLATE_ERROR: Invalid intent_kd path "${intentKd}" — does not match {type}-{name}-{YYYY-MM-DD}.md pattern`
    );
  }

  const name = parsed.name;
  const date = options.session_date || parsed.date;

  // Build variable context (path-based only — no KD content)
  const variables = {
    intent_kd: intentKd,
    name: name,
    date: date,
  };

  // If scope is provided, make it available
  if (options.scope) {
    variables.scope = options.scope;
  }

  // Resolve KDS entries: handle glob patterns and simple variable substitution
  const resolvedKds = [];
  for (const kdEntry of template.kds_pattern) {
    if (kdEntry.startsWith("{{glob:") && kdEntry.endsWith("}}")) {
      // Glob pattern — resolve to matching files
      const globMatches = resolveGlobPattern(kdEntry, variables, workspaceRoot);
      resolvedKds.push(...globMatches);
    } else {
      // Simple variable substitution
      let resolved = kdEntry;
      for (const [key, value] of Object.entries(variables)) {
        resolved = resolved.replace(
          new RegExp(`\\{\\{${key}\\}\\}`, "g"),
          value
        );
      }
      resolvedKds.push(resolved);
    }
  }

  // Resolve other template fields
  function resolveField(template, fieldName) {
    let value = template[fieldName];
    for (const [key, val] of Object.entries(variables)) {
      value = value.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), val);
    }
    return value;
  }

  const targetAgent = resolveField(template, "target_agent");
  const action = resolveField(template, "action");
  const artifact = resolveField(template, "artifact_pattern");
  const domainOrScopeOrMode = resolveField(template, "domain_or_scope_or_mode");
  const returnPath = resolveField(template, "return_pattern");
  const acceptance = resolveField(template, "acceptance_pattern");

  // Build the dispatch prompt string
  const kdsLines = resolvedKds.length > 0
    ? "\n" + resolvedKds.map((kd) => `  - ${kd}`).join("\n")
    : "";

  const prompt = [
    `DISPATCH TO: ${targetAgent}`,
    `ACTION: ${action}`,
    `ARTIFACT: ${artifact}`,
    domainOrScopeOrMode,
    `KDS:${kdsLines}`,
    `RETURN: ${returnPath}`,
    `ACCEPTANCE: ${acceptance}`,
  ].join("\n");

  // Build dispatch fields for structured access
  const dispatchFields = {
    "DISPATCH TO": targetAgent,
    "ACTION": action,
    "ARTIFACT": artifact,
    kds: resolvedKds,
    "RETURN": returnPath,
    "ACCEPTANCE": acceptance,
  };

  // Parse the domain|scope|mode key-value to add to fields
  const dsmMatch = domainOrScopeOrMode.match(/^(DOMAIN|SCOPE|MODE):\s+(.+)$/i);
  if (dsmMatch) {
    dispatchFields[dsmMatch[1].toUpperCase()] = dsmMatch[2].trim();
  }

  return {
    prompt,
    target_agent: targetAgent,
    dispatch_fields: dispatchFields,
    self_execute: template.self_execute === true,
  };
}
