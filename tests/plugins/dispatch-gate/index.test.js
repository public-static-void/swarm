// tests/plugins/dispatch-gate/index.test.js
// Tests for dispatch-gate plugin — uniform structural validation.
// Same validation for ALL callers: no Overseer/Artisan distinction.
// Valid dispatches pass through. Invalid dispatches reject with positive framing.

import { describe, it, expect } from "vitest";
import dispatchGatePlugin from "../../../plugins/dispatch-gate/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a valid dispatch prompt with all required structured fields.
 */
function makeValidDispatch(overrides = {}) {
  const lines = [
    "DISPATCH TO: explorer",
    "ACTION: Explore",
    "ARTIFACT: exploration KD",
    "DOMAIN: auth",
    "KDS:",
    "  - knowledge/intent-test-2026-07-07.md",
    "RETURN: knowledge/exploration-auth-2026-07-07.md",
    "ACCEPTANCE: Exploration KD exists at knowledge/exploration-auth-2026-07-07.md",
  ];
  // Apply overrides: replace the matching line if key exists
  const result = lines.map((line) => {
    for (const [key, value] of Object.entries(overrides)) {
      if (line.startsWith(key)) {
        return value;
      }
    }
    return line;
  });
  return result.join("\n");
}

function callHook(plugin, args, tool = "task") {
  const ctx = { tool, sessionID: "test", callID: "test-001" };
  const output = { args };
  return plugin["tool.execute.before"](ctx, output);
}

// ---------------------------------------------------------------------------
// Tests: Valid dispatches pass through
// ---------------------------------------------------------------------------

describe("Valid dispatches pass through", () => {
  it("accepts a dispatch with all required fields", async () => {
    const prompt = makeValidDispatch();
    const plugin = await dispatchGatePlugin({});
    await expect(
      callHook(plugin, { prompt })
    ).resolves.toBeUndefined();
  });

  it("accepts a dispatch with DOMAIN field", async () => {
    const prompt = makeValidDispatch({ "DOMAIN": "DOMAIN: auth" });
    const plugin = await dispatchGatePlugin({});
    await expect(
      callHook(plugin, { prompt })
    ).resolves.toBeUndefined();
  });

  it("accepts a dispatch with SCOPE field", async () => {
    const prompt = makeValidDispatch({ "DOMAIN": "SCOPE: dispatch-gate" });
    const plugin = await dispatchGatePlugin({});
    await expect(
      callHook(plugin, { prompt })
    ).resolves.toBeUndefined();
  });

  it("accepts a dispatch with MODE field", async () => {
    const prompt = makeValidDispatch({ "DOMAIN": "MODE: CHECKPOINT" });
    const plugin = await dispatchGatePlugin({});
    await expect(
      callHook(plugin, { prompt })
    ).resolves.toBeUndefined();
  });

  it("accepts a dispatch passed as raw string args", async () => {
    const prompt = makeValidDispatch();
    const plugin = await dispatchGatePlugin({});
    await expect(
      callHook(plugin, prompt)
    ).resolves.toBeUndefined();
  });

  it("accepts a dispatch with multiline KDS entries", async () => {
    const prompt = makeValidDispatch({
      "KDS:": "KDS:\n  - knowledge/spec-test-2026-07-07.md\n  - knowledge/plan-test-2026-07-07.md",
    });
    const plugin = await dispatchGatePlugin({});
    await expect(
      callHook(plugin, { prompt })
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: Invalid dispatches rejected with MISSING_FIELDS
// ---------------------------------------------------------------------------

describe("Invalid dispatches rejected", () => {
  it("rejects empty prompt", async () => {
    const plugin = await dispatchGatePlugin({});
    await expect(
      callHook(plugin, { prompt: "" })
    ).rejects.toThrow("MISSING_FIELDS");
  });

  it("rejects missing DISPATCH TO:", async () => {
    const prompt = makeValidDispatch({ "DISPATCH TO:": "DISPATCH TO:" });
    const plugin = await dispatchGatePlugin({});
    await expect(
      callHook(plugin, { prompt })
    ).rejects.toThrow("MISSING_FIELDS");
  });

  it("rejects missing ACTION:", async () => {
    const prompt = makeValidDispatch({ "ACTION:": "ACTION:" });
    const plugin = await dispatchGatePlugin({});
    await expect(
      callHook(plugin, { prompt })
    ).rejects.toThrow("MISSING_FIELDS");
  });

  it("rejects missing ARTIFACT:", async () => {
    const prompt = makeValidDispatch({ "ARTIFACT:": "ARTIFACT:" });
    const plugin = await dispatchGatePlugin({});
    await expect(
      callHook(plugin, { prompt })
    ).rejects.toThrow("MISSING_FIELDS");
  });

  it("rejects missing DOMAIN, SCOPE, and MODE", async () => {
    const prompt = makeValidDispatch({ "DOMAIN": "SCOPE:" });
    const plugin = await dispatchGatePlugin({});
    await expect(
      callHook(plugin, { prompt })
    ).rejects.toThrow("MISSING_FIELDS");
  });

  it("rejects missing KDS:", async () => {
    const prompt = makeValidDispatch({ "KDS:": "" });
    const plugin = await dispatchGatePlugin({});
    await expect(
      callHook(plugin, { prompt })
    ).rejects.toThrow("MISSING_FIELDS");
  });

  it("rejects missing RETURN:", async () => {
    const prompt = makeValidDispatch({ "RETURN:": "RETURN:" });
    const plugin = await dispatchGatePlugin({});
    await expect(
      callHook(plugin, { prompt })
    ).rejects.toThrow("MISSING_FIELDS");
  });

  it("rejects missing ACCEPTANCE:", async () => {
    const prompt = makeValidDispatch({ "ACCEPTANCE:": "ACCEPTANCE:" });
    const plugin = await dispatchGatePlugin({});
    await expect(
      callHook(plugin, { prompt })
    ).rejects.toThrow("MISSING_FIELDS");
  });

  it("rejects a plain text prompt with no fields", async () => {
    const prompt = "Read the file at /home/user/project/src/main.py";
    const plugin = await dispatchGatePlugin({});
    await expect(
      callHook(plugin, { prompt })
    ).rejects.toThrow("MISSING_FIELDS");
  });

  it("rejects a prompt with code blocks but no fields", async () => {
    const prompt = "```\nconst x = 1;\n```";
    const plugin = await dispatchGatePlugin({});
    await expect(
      callHook(plugin, prompt)
    ).rejects.toThrow("MISSING_FIELDS");
  });
});

// ---------------------------------------------------------------------------
// Tests: Error message positive framing
// ---------------------------------------------------------------------------

describe("Error message uses positive framing", () => {
  it("mentions what fields to provide, not what to avoid", async () => {
    const prompt = "DISPATCH TO: artisan";
    const plugin = await dispatchGatePlugin({});
    try {
      await callHook(plugin, { prompt });
      // Should not reach here
      expect(true).toBe(false);
    } catch (err) {
      const msg = err.message;
      // Message should tell what TO provide, not what NOT to do
      expect(msg).toContain("Provide the required structured fields");
      expect(msg).toContain("DISPATCH TO:");
      expect(msg).toContain("ACTION:");
      expect(msg).toContain("ARTIFACT:");
      expect(msg).toContain("RETURN:");
      expect(msg).toContain("ACCEPTANCE:");
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: Hook mechanism — same validation for all callers
// ---------------------------------------------------------------------------

describe("Hook mechanism — uniform validation", () => {
  it("ignores non-task tools", async () => {
    const plugin = await dispatchGatePlugin({});
    const ctx = { tool: "read", sessionID: "test", callID: "test-001" };
    const output = { args: { prompt: makeValidDispatch() } };
    await expect(
      plugin["tool.execute.before"](ctx, output)
    ).resolves.toBeUndefined();
  });

  it("rejects Artisan-to-Committer style calls without fields", async () => {
    const args = {
      description: "checkpoint commit",
      subagent_type: "committer",
      prompt: "Stage changes and commit",
    };
    const plugin = await dispatchGatePlugin({});
    await expect(
      callHook(plugin, args)
    ).rejects.toThrow("MISSING_FIELDS");
  });

  it("accepts Artisan-to-Committer style calls WITH structured fields", async () => {
    const prompt = [
      "DISPATCH TO: committer",
      "ACTION: Dispatch",
      "ARTIFACT: Git workspace state",
      "MODE: CHECKPOINT",
      "KDS:",
      "RETURN: Git status summary",
      "ACCEPTANCE: Git workspace is clean and branch is ready",
    ].join("\n");
    const args = {
      description: "checkpoint commit",
      subagent_type: "committer",
      prompt,
    };
    const plugin = await dispatchGatePlugin({});
    await expect(
      callHook(plugin, args)
    ).resolves.toBeUndefined();
  });

  it("applies same validation to raw string args as to object args", async () => {
    // Both raw string and object with prompt should get same validation
    const validPrompt = makeValidDispatch();
    const plugin = await dispatchGatePlugin({});
    await expect(
      callHook(plugin, validPrompt)
    ).resolves.toBeUndefined();
  });
});
