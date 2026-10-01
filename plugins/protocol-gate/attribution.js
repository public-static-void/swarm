// Shell denial attribution (protocol-gate-local).
//
// Turns a bare shell denial into feedback that names the exact denied
// stage of a compound command plus the allowlisted variants sharing its
// prefix, so the calling agent retries a concrete alternative instead of
// concluding a whole tool family is denied. The calling agent's
// agents/<agent>.md definition file is the single source of truth for
// suggestions, read here inside the plugin; when that file cannot be
// read the feedback says so and guesses nothing.

import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { parseSegments } from "./segments.js";

const GATE_DIR = dirname(fileURLToPath(import.meta.url));

function defaultAgentsDir() {
  return join(GATE_DIR, "..", "..", "agents");
}

export function getAttributionAgentsDir() {
  return defaultAgentsDir();
}

const allowlistCache = new Map();

export function clearAttributionCache() {
  allowlistCache.clear();
}

const SHELL_ALLOW_ENTRY =
  /-\s*action:\s*shell\s*\n\s*resource:\s*"([^"]+)"\s*\n\s*effect:\s*([A-Za-z]+)/g;

export function parseAgentShellAllowlist(fileText) {
  if (typeof fileText !== "string") return [];
  const patterns = [];
  const scanner = new RegExp(SHELL_ALLOW_ENTRY);
  let match;
  while ((match = scanner.exec(fileText)) !== null) {
    if (String(match[2]).toLowerCase() === "allow") patterns.push(match[1]);
  }
  return patterns;
}

export function loadAgentShellAllowlist(agentName, overrides = {}) {
  const agent =
    typeof agentName === "string" ? agentName.toLowerCase() : "";
  if (allowlistCache.has(agent)) {
    return { agent, patterns: allowlistCache.get(agent), cached: true };
  }
  const agentsDir = overrides.agentsDir || defaultAgentsDir();
  const readFile = overrides.readFile || readFileSync;
  const filePath = join(agentsDir, `${agent}.md`);
  let fileText;
  try {
    fileText = readFile(filePath, "utf8");
  } catch {
    return {
      agent,
      patterns: null,
      reason: `agent definition unreadable at ${filePath}`,
    };
  }
  const patterns = parseAgentShellAllowlist(fileText);
  allowlistCache.set(agent, patterns);
  return { agent, patterns, cached: false };
}

function firstToken(text) {
  const token = String(text).trim().split(/\s+/)[0] || "";
  return token.replace(/^["'`]+|["'`]+$/g, "");
}

export function segmentPrefix(segment) {
  return firstToken(segment);
}

function withoutTrailingStar(pattern) {
  return pattern.endsWith("*") ? pattern.slice(0, -1) : pattern;
}

export function segmentAllowed(segment, patterns) {
  const candidate = String(segment).trim();
  if (!candidate || !Array.isArray(patterns)) return false;
  return patterns.some((pattern) => {
    if (pattern.endsWith("*")) {
      return candidate.startsWith(pattern.slice(0, -1));
    }
    return candidate === pattern;
  });
}

export function allowedVariantsForPrefix(prefix, patterns) {
  return (patterns || []).filter(
    (pattern) => firstToken(withoutTrailingStar(pattern)) === prefix
  );
}

export function suggestedRetryFor(variants) {
  if (!variants || variants.length === 0) return undefined;
  const retry = withoutTrailingStar(variants[0]).trim();
  return retry.length > 0 ? retry : undefined;
}

// Output-stitching builtins with no dedicated-tool counterpart: echo (and
// printf) only shape text between real stages, so sending the whole task to
// another role turns a subagent into a text tool. Restructure instead.
const RESTRUCTURE_BUILTINS = new Set(["echo", "printf"]);

function routingFor(prefix) {
  if (prefix === "make") return "route make work to artisan or analyzer";
  if (["cat", "head", "tail", "wc"].includes(prefix)) {
    return "read files through the Read tool";
  }
  if (prefix === "grep") {
    return "use the Grep tool (add include `*.log` for log files)";
  }
  if (prefix === "find") {
    return "use the Glob tool or route file discovery to explorer";
  }
  if (RESTRUCTURE_BUILTINS.has(prefix)) {
    return "drop the segment or run the parts through their routed tools (Read/Grep/Glob); no dedicated tool covers it";
  }
  return "route the task to a role granting it";
}

function summarizeDeniedVariants(agent, detail) {
  if (detail.variants.length > 0) {
    return `\`${detail.prefix}*\`: ${detail.variants.join(", ")}`;
  }
  return `\`${detail.prefix}*\`: none — ${routingFor(detail.prefix)}`;
}

export function buildAttributionMessage({ agent, denied, fallbackUsed }) {
  let deniedLine;
  if (denied.length === 1) {
    const only = denied[0];
    deniedLine =
      only.variants.length > 0
        ? `DENIED segment: \`${only.segment}\` ` +
          `(prefix \`${only.prefix}\` is unlisted for ${agent} — ` +
          `this target only, \`${only.prefix}\` itself stays available)`
        : `DENIED segment: \`${only.segment}\` ` +
          `(prefix \`${only.prefix}\` is unlisted for ${agent} — ` +
          `no \`${only.prefix}*\` target is granted to this role, ` +
          `drop the segment or run the parts through their routed tools)`;
  } else {
    const parts = denied
      .map((detail) => `\`${detail.segment}\` (prefix \`${detail.prefix}\`)`)
      .join(", ");
    deniedLine = `DENIED segments for ${agent}: ${parts} — these targets only`;
  }
  const allowedLines = denied.map(
    (detail) =>
      `Allowed \`${detail.prefix}*\` variants for ${agent}: ` +
      (detail.variants.length > 0
        ? detail.variants.join(", ")
        : `none — ${routingFor(detail.prefix)}`)
  );
  const retries = denied
    .map((detail) => detail.retry)
    .filter(Boolean)
    .map((retry) => `\`${retry}\``);
  const restructured = denied.filter((detail) =>
    RESTRUCTURE_BUILTINS.has(detail.prefix)
  );
  const tryLine =
    retries.length > 0
      ? `Try next: ${retries.join(", ")}, then log each segment result.`
      : restructured.length > 0
        ? `Try next: drop ${restructured.map((detail) => `\`${detail.segment}\``).join(", ")} or run the parts through their routed tools, then log each segment result.`
        : `Try next: retry each segment alone through its routed tool, then log each segment result.`;
  const lines = [deniedLine, ...allowedLines, tryLine];
  if (fallbackUsed) {
    lines.push(
      `Bisect note: retry every stage alone and record each allow/deny outcome before retrying the compound.`
    );
  }
  if (lines.length > 5) {
    const merged = denied
      .map((detail) => summarizeDeniedVariants(agent, detail))
      .join(" | ");
    const compacted = [
      deniedLine,
      `Allowed variants for ${agent}: ${merged}`,
      tryLine,
    ];
    if (fallbackUsed) {
      compacted.push(
        `Bisect note: retry every stage alone and record each allow/deny outcome before retrying the compound.`
      );
    }
    return compacted.slice(0, 5).join("\n");
  }
  return lines.join("\n");
}

export function buildUnresolvableMessage({ agent, rawCommand, reason }) {
  return [
    `Attribution unavailable for ${agent}: allowlist unreadable (${reason}) — no entries assumed.`,
    `Bisect manually: retry each stage of \`${rawCommand}\` alone, then log each allow/deny outcome.`,
    `No allowlist entries were guessed — every future suggestion traces to the agent definition file.`,
  ].join("\n");
}

function detailFor(segment, patterns) {
  const prefix = segmentPrefix(segment);
  const variants = allowedVariantsForPrefix(prefix, patterns);
  return { segment, prefix, variants, retry: suggestedRetryFor(variants) };
}

export function adviseDenial({
  agent,
  rawCommand,
  patterns,
  fallbackUsed = false,
}) {
  const name = typeof agent === "string" ? agent.toLowerCase() : "unknown";
  const segments = parseSegments(rawCommand);
  if (!Array.isArray(patterns)) {
    return {
      allowed: false,
      message: buildUnresolvableMessage({
        agent: name,
        rawCommand,
        reason: "no allowlist supplied",
      }),
      result: {
        raw: rawCommand,
        segments,
        deniedSegments: [],
        agent: name,
        allowedVariants: [],
        suggestedRetry: undefined,
        fallbackUsed,
        unresolvable: true,
      },
    };
  }
  const denied = segments
    .filter((segment) => !segmentAllowed(segment, patterns))
    .map((segment) => detailFor(segment, patterns));
  if (denied.length === 0) {
    return {
      allowed: true,
      message: null,
      result: {
        raw: rawCommand,
        segments,
        deniedSegments: [],
        agent: name,
        allowedVariants: [],
        suggestedRetry: undefined,
        fallbackUsed,
      },
    };
  }
  const firstRetry = denied.map((detail) => detail.retry).find(Boolean);
  return {
    allowed: false,
    message: buildAttributionMessage({ agent: name, denied, fallbackUsed }),
    result: {
      raw: rawCommand,
      segments,
      deniedSegments: denied.map((detail) => detail.segment),
      deniedPrefix: denied[0].prefix,
      agent: name,
      allowedVariants: denied.flatMap((detail) => detail.variants),
      suggestedRetry: firstRetry,
      fallbackUsed,
    },
  };
}

export function adviseDenialFromAttemptLog({
  agent,
  rawCommand,
  segmentResults,
  patterns,
}) {
  const name = typeof agent === "string" ? agent.toLowerCase() : "unknown";
  const segments = parseSegments(rawCommand);
  const verdictBySegment = new Map();
  for (const entry of segmentResults || []) {
    if (entry && typeof entry.segment === "string") {
      verdictBySegment.set(entry.segment.trim(), entry.allowed);
    }
  }
  if (!Array.isArray(patterns)) {
    const deniedNames = segments.filter(
      (segment) => verdictBySegment.get(segment) === false
    );
    if (deniedNames.length === 0) {
      return {
        allowed: true,
        message: null,
        result: {
          raw: rawCommand,
          segments,
          deniedSegments: [],
          agent: name,
          allowedVariants: [],
          suggestedRetry: undefined,
          fallbackUsed: true,
          unresolvable: true,
        },
      };
    }
    return {
      allowed: false,
      message: buildUnresolvableMessage({
        agent: name,
        rawCommand,
        reason: "no allowlist supplied",
      }),
      result: {
        raw: rawCommand,
        segments,
        deniedSegments: deniedNames,
        deniedPrefix: segmentPrefix(deniedNames[0]),
        agent: name,
        allowedVariants: [],
        suggestedRetry: undefined,
        fallbackUsed: true,
        unresolvable: true,
      },
    };
  }
  const denied = segments
    .filter((segment) => {
      if (verdictBySegment.has(segment)) {
        return verdictBySegment.get(segment) === false;
      }
      return !segmentAllowed(segment, patterns);
    })
    .map((segment) => detailFor(segment, patterns));
  if (denied.length === 0) {
    return {
      allowed: true,
      message: null,
      result: {
        raw: rawCommand,
        segments,
        deniedSegments: [],
        agent: name,
        allowedVariants: [],
        suggestedRetry: undefined,
        fallbackUsed: true,
      },
    };
  }
  const firstRetry = denied.map((detail) => detail.retry).find(Boolean);
  return {
    allowed: false,
    message: buildAttributionMessage({
      agent: name,
      denied,
      fallbackUsed: true,
    }),
    result: {
      raw: rawCommand,
      segments,
      deniedSegments: denied.map((detail) => detail.segment),
      deniedPrefix: denied[0].prefix,
      agent: name,
      allowedVariants: denied.flatMap((detail) => detail.variants),
      suggestedRetry: firstRetry,
      fallbackUsed: true,
    },
  };
}
