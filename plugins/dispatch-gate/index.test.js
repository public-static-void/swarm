// plugins/dispatch-gate/index.test.js
// Tests for structural format validation (no pattern-based rejection).

import { describe, it, expect } from "vitest";

// Import the module — plumbs the internal functions via the plugin export
import dispatchGatePlugin from "./index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createOverseerDispatch(overrides = {}) {
  const lines = [
    `DISPATCH TO: ${overrides.targetAgent || "explorer"}`,
    `ACTION: ${overrides.action || "Explore"}`,
    `ARTIFACT: ${overrides.artifact || "exploration KD"}`,
    overrides.domainOrScope || "DOMAIN: authentication",
    "",
    ...(overrides.kds || []).map((k) => `  - ${k}`),
    `RETURN: ${overrides.returnPath || "knowledge/exploration-test-2026-07-07.md"}`,
    `ACCEPTANCE: ${overrides.acceptance || "exploration KD exists with findings"}`,
  ];
  return lines.join("\n");
}

function makeArgs(prompt, extra = {}) {
  return { prompt, ...extra };
}

function callValidate(plugin, args) {
  // Simulates the tool.execute.before handler
  const ctx = { tool: "task", sessionID: "test", callID: "test-001" };
  const output = { args };
  return plugin["tool.execute.before"](ctx, output);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Overseer format detection (isOverseerFormat)", () => {
  it("detects dispatch starting with DISPATCH TO:", async () => {
    const prompt = createOverseerDispatch();
    // Validation should pass — no error thrown
    const plugin = await dispatchGatePlugin({});
    await expect(
      callValidate(plugin, makeArgs(prompt))
    ).resolves.toBeUndefined();
  });

  it("rejects when DISPATCH TO: is missing", async () => {
    const prompt = "ACTION: Explore\nARTIFACT: exploration KD\nDOMAIN: auth\n";
    const plugin = await dispatchGatePlugin({});
    await expect(
      callValidate(plugin, makeArgs(prompt))
    ).resolves.toBeUndefined(); // Non-Overseer format → passes through
  });

  it("detects dispatch with leading whitespace before DISPATCH TO:", async () => {
    const prompt = "  \n  \n" + createOverseerDispatch();
    const plugin = await dispatchGatePlugin({});
    await expect(
      callValidate(plugin, makeArgs(prompt))
    ).resolves.toBeUndefined();
  });
});

describe("Structural field validation for Overseer dispatches", () => {
  it("accepts a valid complete dispatch", async () => {
    const prompt = createOverseerDispatch();
    const plugin = await dispatchGatePlugin({});
    await expect(
      callValidate(plugin, makeArgs(prompt))
    ).resolves.toBeUndefined();
  });

  it("rejects when DISPATCH TO: has no value", async () => {
    const prompt = "DISPATCH TO: \nACTION: Explore\nARTIFACT: exploration KD\nDOMAIN: auth\n";
    const plugin = await dispatchGatePlugin({});
    await expect(
      callValidate(plugin, makeArgs(prompt))
    ).rejects.toThrow("MISSING_DISPATCH_TO");
  });

  it("rejects when ACTION is missing", async () => {
    const prompt = "DISPATCH TO: explorer\nARTIFACT: exploration KD\nDOMAIN: auth\n";
    const plugin = await dispatchGatePlugin({});
    await expect(
      callValidate(plugin, makeArgs(prompt))
    ).rejects.toThrow("MISSING_ACTION");
  });

  it("rejects when ACTION has no value", async () => {
    const prompt = "DISPATCH TO: explorer\nACTION: \nARTIFACT: exploration KD\nDOMAIN: auth\n";
    const plugin = await dispatchGatePlugin({});
    await expect(
      callValidate(plugin, makeArgs(prompt))
    ).rejects.toThrow("MISSING_ACTION");
  });

  it("rejects when ARTIFACT is missing", async () => {
    const prompt = "DISPATCH TO: explorer\nACTION: Explore\nDOMAIN: auth\n";
    const plugin = await dispatchGatePlugin({});
    await expect(
      callValidate(plugin, makeArgs(prompt))
    ).rejects.toThrow("MISSING_ARTIFACT");
  });

  it("rejects when ARTIFACT has no value", async () => {
    const prompt = "DISPATCH TO: explorer\nACTION: Explore\nARTIFACT: \nDOMAIN: auth\n";
    const plugin = await dispatchGatePlugin({});
    await expect(
      callValidate(plugin, makeArgs(prompt))
    ).rejects.toThrow("MISSING_ARTIFACT");
  });

  it("rejects when DOMAIN, SCOPE, and MODE are all missing", async () => {
    const prompt = "DISPATCH TO: explorer\nACTION: Explore\nARTIFACT: exploration KD\n";
    const plugin = await dispatchGatePlugin({});
    await expect(
      callValidate(plugin, makeArgs(prompt))
    ).rejects.toThrow("MISSING_DOMAIN_OR_SCOPE_OR_MODE");
  });

  it("accepts DISPATCH TO with SCOPE instead of DOMAIN", async () => {
    const prompt = "DISPATCH TO: artisan\nACTION: Implement\nARTIFACT: plugin code\nSCOPE: dispatch-gate\n";
    const plugin = await dispatchGatePlugin({});
    await expect(
      callValidate(plugin, makeArgs(prompt))
    ).resolves.toBeUndefined();
  });

  it("accepts DISPATCH TO with MODE instead of DOMAIN", async () => {
    const prompt = "DISPATCH TO: committer\nACTION: Commit\nARTIFACT: checkpoint\nMODE: CHECKPOINT\n";
    const plugin = await dispatchGatePlugin({});
    await expect(
      callValidate(plugin, makeArgs(prompt))
    ).resolves.toBeUndefined();
  });

  it("rejects when SCOPE has no value", async () => {
    const prompt = "DISPATCH TO: artisan\nACTION: Implement\nARTIFACT: plugin code\nSCOPE: \n";
    const plugin = await dispatchGatePlugin({});
    await expect(
      callValidate(plugin, makeArgs(prompt))
    ).rejects.toThrow("MISSING_DOMAIN_OR_SCOPE_OR_MODE");
  });

  it("rejects when MODE has no value", async () => {
    const prompt = "DISPATCH TO: committer\nACTION: Commit\nARTIFACT: checkpoint\nMODE: \n";
    const plugin = await dispatchGatePlugin({});
    await expect(
      callValidate(plugin, makeArgs(prompt))
    ).rejects.toThrow("MISSING_DOMAIN_OR_SCOPE_OR_MODE");
  });
});

describe("Non-Overseer dispatches pass through unconditionally", () => {
  it("passes through a plain text prompt", async () => {
    const prompt = "Read the file at /home/user/project/src/main.py and return its contents";
    const plugin = await dispatchGatePlugin({});
    // This would have been rejected by pattern-based validation before.
    // Now it passes through because it does not start with DISPATCH TO:.
    await expect(
      callValidate(plugin, makeArgs(prompt))
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
      callValidate(plugin, args)
    ).resolves.toBeUndefined();
  });

  it("passes through a raw string argument", async () => {
    const rawPrompt = "explore the authentication module code in src/auth/";
    const plugin = await dispatchGatePlugin({});
    await expect(
      callValidate(plugin, rawPrompt)
    ).resolves.toBeUndefined();
  });

  it("passes through calls with code blocks (previously rejected)", async () => {
    const prompt = "```\nconst x = 1;\n```";
    const plugin = await dispatchGatePlugin({});
    await expect(
      callValidate(plugin, makeArgs(prompt))
    ).resolves.toBeUndefined();
  });

  it("passes through calls with file paths (previously rejected)", async () => {
    const prompt = "Check the config at /home/user/.config/app.json";
    const plugin = await dispatchGatePlugin({});
    await expect(
      callValidate(plugin, makeArgs(prompt))
    ).resolves.toBeUndefined();
  });
});

describe("KD path validation", () => {
  it("accepts valid KD paths", async () => {
    const prompt = createOverseerDispatch({
      kds: ["knowledge/spec-dispatch-gate-2026-07-06.md"]
    });
    const plugin = await dispatchGatePlugin({});
    await expect(
      callValidate(plugin, makeArgs(prompt))
    ).resolves.toBeUndefined();
  });

  it("rejects invalid KD paths", async () => {
    const prompt = createOverseerDispatch({
      kds: ["knowledge/foo.md"]
    });
    const plugin = await dispatchGatePlugin({});
    await expect(
      callValidate(plugin, makeArgs(prompt))
    ).rejects.toThrow("INVALID_KD_PATH");
  });

  it("ignores non-KD entries in KDS section (passes through)", async () => {
    // Only lines matching - knowledge/{pattern}.md are validated.
    // Non-KD entries like src/main.py are not matched and pass through.
    const prompt = createOverseerDispatch({
      kds: ["src/main.py"]
    });
    const plugin = await dispatchGatePlugin({});
    await expect(
      callValidate(plugin, makeArgs(prompt))
    ).resolves.toBeUndefined();
  });
});

describe("Target agent validation", () => {
  it("accepts known agents", async () => {
    const prompt = createOverseerDispatch({ targetAgent: "analyzer" });
    const plugin = await dispatchGatePlugin({});
    await expect(
      callValidate(plugin, makeArgs(prompt))
    ).resolves.toBeUndefined();
  });

  it("rejects unknown agents", async () => {
    const prompt = createOverseerDispatch({ targetAgent: "unknown-agent" });
    const plugin = await dispatchGatePlugin({});
    await expect(
      callValidate(plugin, makeArgs(prompt))
    ).rejects.toThrow("UNKNOWN_AGENT");
  });

  it("validates subagent_type parameter", async () => {
    const prompt = createOverseerDispatch();
    const plugin = await dispatchGatePlugin({});
    await expect(
      callValidate(plugin, makeArgs(prompt, { subagent_type: "unknown" }))
    ).rejects.toThrow("UNKNOWN_AGENT");
  });

  it("accepts valid subagent_type", async () => {
    const prompt = createOverseerDispatch();
    const plugin = await dispatchGatePlugin({});
    await expect(
      callValidate(plugin, makeArgs(prompt, { subagent_type: "explorer" }))
    ).resolves.toBeUndefined();
  });
});

describe("Rejection error codes", () => {
  it("uses MISSING_DISPATCH_TO (not INLINE_CODE_DETECTED)", async () => {
    // Previously a dispatch missing DISPATCH TO would pass through.
    // Now with Overseer prefix detection, it gets validated.
    const prompt = "DISPATCH TO:\nACTION: Explore\nARTIFACT: exploration KD\nDOMAIN: auth\n";
    const plugin = await dispatchGatePlugin({});
    await expect(
      callValidate(plugin, makeArgs(prompt))
    ).rejects.toThrow("MISSING_DISPATCH_TO");
  });

  it("uses MISSING_ACTION (not FILE_PATH_DETECTED)", async () => {
    const prompt = "DISPATCH TO: explorer\nARTIFACT: exploration KD\nDOMAIN: auth\n";
    const plugin = await dispatchGatePlugin({});
    await expect(
      callValidate(plugin, makeArgs(prompt))
    ).rejects.toThrow("MISSING_ACTION");
  });

  it("uses MISSING_ARTIFACT (not FILE_EXTENSION_IN_DOMAIN)", async () => {
    const prompt = "DISPATCH TO: explorer\nACTION: Explore\nDOMAIN: auth\n";
    const plugin = await dispatchGatePlugin({});
    await expect(
      callValidate(plugin, makeArgs(prompt))
    ).rejects.toThrow("MISSING_ARTIFACT");
  });

  it("uses MISSING_DOMAIN_OR_SCOPE_OR_MODE (not READ_VERB_DETECTED)", async () => {
    const prompt = "DISPATCH TO: explorer\nACTION: Explore\nARTIFACT: exploration KD\n";
    const plugin = await dispatchGatePlugin({});
    await expect(
      callValidate(plugin, makeArgs(prompt))
    ).rejects.toThrow("MISSING_DOMAIN_OR_SCOPE_OR_MODE");
  });
});

describe("Hook mechanism", () => {
  it("ignores non-task tools", async () => {
    const plugin = await dispatchGatePlugin({});
    const ctx = { tool: "read", sessionID: "test", callID: "test-001" };
    const output = { args: { prompt: "anything" } };
    await expect(
      plugin["tool.execute.before"](ctx, output)
    ).resolves.toBeUndefined();
  });

  it("intercepts task tool calls", async () => {
    const plugin = await dispatchGatePlugin({});
    const ctx = { tool: "task", sessionID: "test", callID: "test-001" };
    // Missing ARTIFACT in an Overseer dispatch
    const output = { args: { prompt: "DISPATCH TO: explorer\nACTION: Explore\nSCOPE: test\n" } };
    await expect(
      plugin["tool.execute.before"](ctx, output)
    ).rejects.toThrow("MISSING_ARTIFACT");
  });
});
