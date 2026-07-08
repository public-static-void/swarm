// plugins/dispatch-gate/template-engine.js
// Resolves template strings with variable and glob pattern placeholders.
// Variables: {{name}}, {{date}}, {{intent_kd}}, {{session_date}}, {{scope}}
// Glob patterns: {{glob:some/path/*.md}}

import { glob } from "glob";

/**
 * Parse intent KD path to extract agent name and date.
 * Expects pattern: knowledge/intent-{name}-{YYYY-MM-DD}.md
 * Returns { name, date } or empty strings if parsing fails.
 */
export function parseIntentPath(intentKd) {
  if (!intentKd || typeof intentKd !== "string") {
    return { name: "", date: "" };
  }

  // Match: knowledge/intent-<name>-<date>.md
  // The name can contain hyphens, so we match the date pattern specifically
  const match = intentKd.match(/intent-(.+)-(\d{4}-\d{2}-\d{2})\.md$/);
  if (!match) {
    return { name: "", date: "" };
  }

  return { name: match[1], date: match[2] };
}

/**
 * Resolve {{glob:pattern}} placeholders by finding matching files.
 * Returns the template with glob patterns replaced by file paths (one per line).
 */
export async function resolveGlobs(template) {
  const globRegex = /\{\{glob:([^}]+)\}\}/g;
  let result = template;
  let match;

  while ((match = globRegex.exec(template)) !== null) {
    const pattern = match[1].trim();
    try {
      const files = await glob(pattern);
      result = result.replace(match[0], files.join("\n"));
    } catch {
      // If glob fails (invalid pattern, no matches), replace with empty string
      result = result.replace(match[0], "");
    }
  }

  return result;
}

/**
 * Build the resolution context from the structured dispatch fields.
 * Extracts name and date from intent_kd path when available.
 */
export function buildContext(fields) {
  const { name, date } = parseIntentPath(fields.intent_kd);
  return {
    name: fields.name || name || "",
    date: fields.date || date || "",
    intent_kd: fields.intent_kd || "",
    session_date: fields.session_date || "",
    scope: fields.scope || "",
  };
}

/**
 * Resolve all {{variable}} placeholders in a template string.
 * Does NOT resolve {{glob:...}} patterns — use resolveGlobs() for those.
 */
export function resolveVariables(template, context) {
  let result = template;

  result = result.replace(/\{\{name\}\}/g, context.name || "");
  result = result.replace(/\{\{date\}\}/g, context.date || "");
  result = result.replace(/\{\{intent_kd\}\}/g, context.intent_kd || "");
  result = result.replace(/\{\{session_date\}\}/g, context.session_date || "");
  result = result.replace(/\{\{scope\}\}/g, context.scope || "");

  return result;
}

/**
 * Full template resolution pipeline:
 * 1. Build context from fields
 * 2. Resolve variables
 * 3. Resolve glob patterns
 */
export async function resolveTemplate(template, fields) {
  const context = buildContext(fields);
  let result = resolveVariables(template, context);
  result = await resolveGlobs(result);
  return result;
}
