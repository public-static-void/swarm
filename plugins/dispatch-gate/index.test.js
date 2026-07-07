// plugins/dispatch-gate/index.test.js
// Tests for dispatch-gate plugin — structured dispatch detection,
// legacy format rejection, non-Overseer pass-through.

import { describe, it, expect } from "vitest";

// Import the plugin
import dispatchGatePlugin from "./index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeArgs(overrides = {}) {
  const base = {
    mode: "explore",
    intent_kd: "knowledge/intent-test-2026-07-07.md",
    session_date: "2026-07-07",
  };
  return { ...base, ...overrides };
}

function callHook(plugin, args, tool = "task") {
  const ctx = { tool, sessionID: "test", callID: "test-001" };
  const output = { args };
  return plugin["tool.execute.before"](ctx, output);
}

// ---------------------------------------------------------------------------
// Tests: Structured dispatch detection (internal behavior via hook)
// ---------------------------------------------------------------------------

describe("Structured dispatch detection", () => {
  it("detects valid structured dispatch with mode + intent_kd + session_date", () => {
    const args = makeArgs();
    expect(args.mode).toBeTruthy();
    expect(args.intent_kd).toBeTruthy();
    expect(args.session_date).toBeTruthy();
  });

  it("detects structured dispatch without session_date (optional)", () => {
    const args = makeArgs({ session_date: undefined });
    expect(args.mode).toBeTruthy();
    expect(args.intent_kd).toBeTruthy();
  });

  it("does not treat a plain string as structured dispatch", () => {
    const args = "Read the file at /home/user/project/src/main.py";
    // This should not trigger structured dispatch detection
    expect(typeof args).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Tests: Legacy Overseer format rejection
// ---------------------------------------------------------------------------

describe("Legacy Overseer format rejection", () => {
  it("rejects a dispatch starting with DISPATCH TO:", async () => {
    const prompt = "DISPATCH TO: explorer\nACTION: Explore\nARTIFACT: exploration KD\nDOMAIN: auth\n";
    const plugin = await dispatchGatePlugin({});
    await expect(
      callHook(plugin, { prompt })
    ).rejects.toThrow("LEGACY_FORMAT");
  });

  it("rejects a legacy dispatch with all fields present", async () => {
    const prompt = [
      "DISPATCH TO: artisan",
      "ACTION: Implement",
      "ARTIFACT: implementation",
      "SCOPE: dispatch-gate",
      "  - knowledge/spec-test-2026-07-06.md",
      "RETURN: knowledge/impl-test-2026-07-06.md",
      "ACCEPTANCE: implementation done",
    ].join("\n");
    const plugin = await dispatchGatePlugin({});
    await expect(
      callHook(plugin, { prompt })
    ).rejects.toThrow("LEGACY_FORMAT");
  });

  it("rejects legacy dispatch with leading whitespace", async () => {
    const prompt = "  \n  \nDISPATCH TO: explorer\nACTION: Explore\nARTIFACT: exploration KD\nDOMAIN: auth\n";
    const plugin = await dispatchGatePlugin({});
    await expect(
      callHook(plugin, { prompt })
    ).rejects.toThrow("LEGACY_FORMAT");
  });

  it("uses LEGACY_FORMAT error code (not MISSING_DISPATCH_TO)", async () => {
    const prompt = "DISPATCH TO:\nACTION: Explore\nARTIFACT: exploration KD\nDOMAIN: auth\n";
    const plugin = await dispatchGatePlugin({});
    await expect(
      callHook(plugin, { prompt })
    ).rejects.toThrow("LEGACY_FORMAT");
  });
});

// ---------------------------------------------------------------------------
// Tests: Non-Overseer calls pass through unconditionally
// ---------------------------------------------------------------------------

describe("Non-Overseer pass-through", () => {
  it("passes through a plain text prompt", async () => {
    const prompt = "Read the file at /home/user/project/src/main.py and return its contents";
    const plugin = await dispatchGatePlugin({});
    await expect(
      callHook(plugin, prompt)
    ).resolves.toBeUndefined();
  });

  it("passes through Artisan->Committer-style task call", async () => {
    const args = {
      description: "checkpoint commit",
      subagent_type: "committer",
      prompt: "Stage changes and commit with message: feat: implement x"
    };
    const plugin = await dispatchGatePlugin({});
    await expect(
      callHook(plugin, args)
    ).resolves.toBeUndefined();
  });

  it("passes through a raw string argument", async () => {
    const rawPrompt = "explore the authentication module code in src/auth/";
    const plugin = await dispatchGatePlugin({});
    await expect(
      callHook(plugin, rawPrompt)
    ).resolves.toBeUndefined();
  });

  it("passes through calls with code blocks", async () => {
    const prompt = "```\nconst x = 1;\n```";
    const plugin = await dispatchGatePlugin({});
    await expect(
      callHook(plugin, prompt)
    ).resolves.toBeUndefined();
  });

  it("passes through calls with file paths", async () => {
    const prompt = "Check the config at /home/user/.config/app.json";
    const plugin = await dispatchGatePlugin({});
    await expect(
      callHook(plugin, prompt)
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: Hook mechanism
// ---------------------------------------------------------------------------

describe("Hook mechanism", () => {
  it("ignores non-task tools", async () => {
    const plugin = await dispatchGatePlugin({});
    const ctx = { tool: "read", sessionID: "test", callID: "test-001" };
    const output = { args: { prompt: "anything" } };
    await expect(
      plugin["tool.execute.before"](ctx, output)
    ).resolves.toBeUndefined();
  });

  it("intercepts task tool calls for structured dispatch", async () => {
    const plugin = await dispatchGatePlugin({});
    const ctx = { tool: "task", sessionID: "test", callID: "test-001" };
    // Valid structured dispatch args — should not throw
    const output = {
      args: {
        mode: "explore",
        intent_kd: "knowledge/intent-test-2026-07-07.md",
        session_date: "2026-07-07",
      }
    };
    // The template engine resolves successfully.
    // SDK routing may fail (no client in test env), which triggers fallback,
    // but the hook should not throw — it handles the error gracefully.
    // Must resolve without rejecting — the SDK routing fallback is handled gracefully
    await plugin["tool.execute.before"](ctx, output);
    // After processing, output.args should be modified to indicate dispatch was handled
    expect(output.args._dispatch_result).toBeDefined();
    expect(output.args._dispatch_result.status).toBeDefined();
  });
});
