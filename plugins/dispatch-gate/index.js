// plugins/dispatch-gate/index.js
// Intercepts `task` tool calls via tool.execute.before hook.
// Validates that every dispatch prompt has the required structured fields.
// Same validation for ALL callers — no Overseer/Artisan distinction.
// If valid: passes through to the original task implementation unchanged.
// If invalid: rejects with a positive-framed message listing required fields.

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate that a dispatch prompt contains all required structured fields.
 * Returns an array of missing field names (empty if all present).
 */
function validateRequiredFields(prompt) {
  if (!prompt || typeof prompt !== "string") {
    return [
      "DISPATCH TO:",
      "ACTION:",
      "ARTIFACT:",
      "one of DOMAIN:, SCOPE:, or MODE:",
      "KDS:",
      "RETURN:",
      "ACCEPTANCE:",
    ];
  }

  const missing = [];

  if (!/^DISPATCH TO:[ \t]+\S+/m.test(prompt)) {
    missing.push("DISPATCH TO:");
  }
  if (!/^ACTION:[ \t]+\S+/m.test(prompt)) {
    missing.push("ACTION:");
  }
  if (!/^ARTIFACT:[ \t]+\S+/m.test(prompt)) {
    missing.push("ARTIFACT:");
  }
  if (!/^(DOMAIN|SCOPE|MODE):[ \t]+\S+/m.test(prompt)) {
    missing.push("one of DOMAIN:, SCOPE:, or MODE:");
  }
  if (!/^KDS:/m.test(prompt)) {
    missing.push("KDS:");
  }
  if (!/^RETURN:[ \t]+\S+/m.test(prompt)) {
    missing.push("RETURN:");
  }
  if (!/^ACCEPTANCE:[ \t]+\S+/m.test(prompt)) {
    missing.push("ACCEPTANCE:");
  }

  return missing;
}

// ---------------------------------------------------------------------------
// Plugin entry point
// ---------------------------------------------------------------------------

/**
 * Plugin entry point — called by opencode on load.
 */
export default async function dispatchGatePlugin(input) {
  return {
    /**
     * Intercepts all tool executions before they run.
     * Only validates `task` tool calls for structured dispatch fields.
     */
    "tool.execute.before": async (ctx, output) => {
      if (ctx.tool !== "task") return;

      const args = output.args;
      const prompt = typeof args === "string" ? args : (args.prompt || "");

      const missingFields = validateRequiredFields(prompt);

      if (missingFields.length > 0) {
        throw new Error(
          "DISPATCH REJECTED: MISSING_FIELDS — Provide the required structured fields: " +
          missingFields.join(", ") + ". " +
          "Every dispatch must include: DISPATCH TO:, ACTION:, ARTIFACT:, " +
          "one of DOMAIN:, SCOPE:, or MODE:, KDS:, RETURN:, and ACCEPTANCE:."
        );
      }

      // All required fields present — pass through to the original task implementation
      return;
    },
  };
}
