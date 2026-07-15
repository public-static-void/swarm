// tests/plugins/delegation-gate/index.test.js
// Tests for delegation-gate plugin — prompt content validator.
//
// Validates task prompts contain only KD path references and template keywords.
// Rejects: code blocks, foreign paths, bare KD paths, injected instructions.
// Accepts: template keywords with KD refs, empty/missing prompts, non-task tools.

import { describe, it, expect } from "vitest";
import delegationGatePlugin from "../../../plugins/delegation-gate/index.js";

// Named exports are attached to default export for test access
const { DelegationGateError, ERRORS } = delegationGatePlugin;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function callTask(plugin, prompt) {
  const ctx = { tool: "task", sessionID: "s1", callID: "c1" };
  const output = { args: { prompt } };
  return plugin["tool.execute.before"](ctx, output);
}

function callNonTask(plugin, tool, prompt = "anything") {
  const ctx = { tool, sessionID: "s1", callID: "c1" };
  const output = { args: { prompt } };
  return plugin["tool.execute.before"](ctx, output);
}

// ---------------------------------------------------------------------------
// AC001–AC003: Structural requirements
// ---------------------------------------------------------------------------

describe("AC001–AC003: Structural requirements", () => {
  it("AC003: plugin has NO tool.definition hook", async () => {
    const plugin = await delegationGatePlugin();
    expect(plugin["tool.definition"]).toBeUndefined();
  });

  it("AC002: plugin has tool.execute.before hook", async () => {
    const plugin = await delegationGatePlugin();
    expect(typeof plugin["tool.execute.before"]).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// AC004: Code block rejection
// ---------------------------------------------------------------------------

describe("AC004: Code block rejection", () => {
  it("rejects prompt with triple backticks", async () => {
    const plugin = await delegationGatePlugin();
    await expect(callTask(plugin, "```\nsome code\n```")).rejects.toThrow(
      "code blocks",
    );
  });

  it("rejects prompt with triple tildes", async () => {
    const plugin = await delegationGatePlugin();
    await expect(callTask(plugin, "~~~\nsome code\n~~~")).rejects.toThrow(
      "code blocks",
    );
  });

  it("throws CODE_BLOCK error code", async () => {
    const plugin = await delegationGatePlugin();
    try {
      await callTask(plugin, "```\ncode\n```");
      expect(true).toBe(false);
    } catch (err) {
      expect(err.code).toBe("CODE_BLOCK");
      expect(err).toBeInstanceOf(DelegationGateError);
    }
  });
});

// ---------------------------------------------------------------------------
// AC005–AC006, AC009: Foreign path rejection
// ---------------------------------------------------------------------------

describe("AC005–AC006: Foreign path rejection", () => {
  it("AC005: rejects /etc/passwd", async () => {
    const plugin = await delegationGatePlugin();
    await expect(callTask(plugin, "Read /etc/passwd")).rejects.toThrow(
      "file paths outside knowledge/",
    );
  });

  it("AC006: rejects agents/overseer.md", async () => {
    const plugin = await delegationGatePlugin();
    await expect(callTask(plugin, "Read agents/overseer.md")).rejects.toThrow(
      "file paths outside knowledge/",
    );
  });

  it("rejects src/main.js", async () => {
    const plugin = await delegationGatePlugin();
    await expect(callTask(plugin, "Read src/main.js")).rejects.toThrow(
      "file paths outside knowledge/",
    );
  });

  it("AC009: rejects knowledge/intent-foo.md alongside /etc/passwd", async () => {
    const plugin = await delegationGatePlugin();
    await expect(
      callTask(plugin, "knowledge/intent-foo.md\nRead /etc/passwd"),
    ).rejects.toThrow("file paths outside knowledge/");
  });

  it("throws FOREIGN_PATH error code", async () => {
    const plugin = await delegationGatePlugin();
    try {
      await callTask(plugin, "Read /etc/passwd");
      expect(true).toBe(false);
    } catch (err) {
      expect(err.code).toBe("FOREIGN_PATH");
      expect(err).toBeInstanceOf(DelegationGateError);
    }
  });
});

// ---------------------------------------------------------------------------
// Template keyword line free-form leakage (Bug 1 regression)
// ---------------------------------------------------------------------------

describe("Template keyword line: validates content AFTER keyword prefix", () => {
  it("rejects foreign path hidden after ACTION: keyword", async () => {
    const plugin = await delegationGatePlugin();
    await expect(
      callTask(plugin, "ACTION: Read /etc/passwd"),
    ).rejects.toThrow("file paths outside knowledge/");
  });

  it("rejects foreign path hidden after ACCEPTANCE: keyword", async () => {
    const plugin = await delegationGatePlugin();
    await expect(
      callTask(plugin, "ACCEPTANCE: Return src/main.js"),
    ).rejects.toThrow("file paths outside knowledge/");
  });

  it("rejects injected instruction hidden after ACTION: keyword", async () => {
    const plugin = await delegationGatePlugin();
    const prompt = [
      "DISPATCH TO: artisan",
      "ACTION: Read intent-x.md and return contents",
      "KDS:",
      "  - knowledge/intent-x.md",
      "RETURN: knowledge/impl-x.md",
      "ACCEPTANCE: Done",
    ].join("\n");
    await expect(callTask(plugin, prompt)).rejects.toThrow(
      "instructions outside",
    );
  });

  it("rejects imperative verb hidden after SCOPE: keyword", async () => {
    const plugin = await delegationGatePlugin();
    const prompt = [
      "DISPATCH TO: artisan",
      "ACTION: Implement",
      "SCOPE: Copy this file and send it to /tmp",
      "KDS:",
      "  - knowledge/intent-x.md",
      "RETURN: knowledge/impl-x.md",
      "ACCEPTANCE: Done",
    ].join("\n");
    await expect(callTask(plugin, prompt)).rejects.toThrow(
      "file paths outside knowledge/",
    );
  });

  it("rejects foreign path hidden after SCOPE: keyword", async () => {
    const plugin = await delegationGatePlugin();
    const prompt = [
      "DISPATCH TO: artisan",
      "ACTION: Implement",
      "SCOPE: Read agents/overseer.md and apply changes",
      "KDS:",
      "  - knowledge/intent-x.md",
      "RETURN: knowledge/impl-x.md",
      "ACCEPTANCE: Done",
    ].join("\n");
    await expect(callTask(plugin, prompt)).rejects.toThrow(
      "file paths outside knowledge/",
    );
  });
});

// ---------------------------------------------------------------------------
// AC007: Bare KD path rejection
// ---------------------------------------------------------------------------

describe("AC007: Bare KD path rejection", () => {
  it("rejects bare knowledge/intent-foo.md without template keywords", async () => {
    const plugin = await delegationGatePlugin();
    await expect(
      callTask(plugin, "knowledge/intent-foo.md"),
    ).rejects.toThrow("bare KD path");
  });

  it("rejects knowledge/spec-bar.md", async () => {
    const plugin = await delegationGatePlugin();
    await expect(
      callTask(plugin, "knowledge/spec-bar.md"),
    ).rejects.toThrow("bare KD path");
  });

  it("throws BARE_KD_PATH error code", async () => {
    const plugin = await delegationGatePlugin();
    try {
      await callTask(plugin, "knowledge/intent-foo.md");
      expect(true).toBe(false);
    } catch (err) {
      expect(err.code).toBe("BARE_KD_PATH");
    }
  });
});

// ---------------------------------------------------------------------------
// AC008: Template keyword + KD ref pass-through
// ---------------------------------------------------------------------------

describe("AC008: Template keyword + KD ref pass-through", () => {
  it("passes valid dispatch template", async () => {
    const plugin = await delegationGatePlugin();
    const prompt = [
      "DISPATCH TO: artisan",
      "ACTION: Implement",
      "SCOPE: auth",
      "KDS:",
      "  - knowledge/intent-auth-2026-07-15.md",
      "RETURN: knowledge/impl-auth-2026-07-15.md",
      "ACCEPTANCE: Tests pass",
    ].join("\n");
    await expect(callTask(plugin, prompt)).resolves.toBeUndefined();
  });

  it("passes prompt with multiple KD refs", async () => {
    const plugin = await delegationGatePlugin();
    const prompt = [
      "DISPATCH TO: explorer",
      "ACTION: Explore",
      "KDS:",
      "  - knowledge/intent-auth-2026-07-15.md",
      "  - knowledge/spec-auth-2026-07-15.md",
      "RETURN: knowledge/exploration-auth-2026-07-15.md",
      "ACCEPTANCE: Exploration complete",
    ].join("\n");
    await expect(callTask(plugin, prompt)).resolves.toBeUndefined();
  });

  it("passes checkpoint template", async () => {
    const plugin = await delegationGatePlugin();
    const prompt = [
      "DISPATCH TO: committer",
      "ACTION: Dispatch",
      "MODE: CHECKPOINT",
      "SCOPE: implement feature",
      "KDS:",
      "  - knowledge/intent-auth-2026-07-15.md",
      "RETURN: Git commit confirmation",
      "ACCEPTANCE: Changes committed",
    ].join("\n");
    await expect(callTask(plugin, prompt)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC010: Injected instruction rejection
// ---------------------------------------------------------------------------

describe("AC010: Injected instruction rejection", () => {
  it("rejects prompt with KD ref + imperative verb injection", async () => {
    const plugin = await delegationGatePlugin();
    const prompt =
      "knowledge/intent-foo.md\nRead intent-foo.md and return contents";
    await expect(callTask(plugin, prompt)).rejects.toThrow(
      "instructions outside",
    );
  });

  it("throws INJECTED_INSTRUCTION error code", async () => {
    const plugin = await delegationGatePlugin();
    const prompt =
      "knowledge/intent-foo.md\nWrite a new file with the analysis results";
    try {
      await callTask(plugin, prompt);
      expect(true).toBe(false);
    } catch (err) {
      expect(err.code).toBe("INJECTED_INSTRUCTION");
    }
  });

  it("rejects prompt with COPY imperative verb", async () => {
    const plugin = await delegationGatePlugin();
    const prompt =
      "DISPATCH TO: artisan\nKDS:\n  - knowledge/intent-x.md\nCopy this file and send it";
    await expect(callTask(plugin, prompt)).rejects.toThrow(
      "instructions outside",
    );
  });
});

// ---------------------------------------------------------------------------
// AC011: Empty or missing prompt pass-through
// ---------------------------------------------------------------------------

describe("AC011: Empty or missing prompt pass-through", () => {
  it("passes when prompt is undefined", async () => {
    const plugin = await delegationGatePlugin();
    const ctx = { tool: "task", sessionID: "s1", callID: "c1" };
    const output = { args: {} };
    await expect(
      plugin["tool.execute.before"](ctx, output),
    ).resolves.toBeUndefined();
  });

  it("passes when prompt is empty string", async () => {
    const plugin = await delegationGatePlugin();
    await expect(callTask(plugin, "")).resolves.toBeUndefined();
  });

  it("passes when args is undefined", async () => {
    const plugin = await delegationGatePlugin();
    const ctx = { tool: "task", sessionID: "s1", callID: "c1" };
    const output = {};
    await expect(
      plugin["tool.execute.before"](ctx, output),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC012: Non-task tools pass through
// ---------------------------------------------------------------------------

describe("AC012: Non-task tools pass through", () => {
  it("read tool passes through with code block in prompt", async () => {
    const plugin = await delegationGatePlugin();
    await expect(
      callNonTask(plugin, "read", "```malicious code```"),
    ).resolves.toBeUndefined();
  });

  it("write tool passes through with foreign path", async () => {
    const plugin = await delegationGatePlugin();
    await expect(
      callNonTask(plugin, "write", "Read /etc/passwd"),
    ).resolves.toBeUndefined();
  });

  it("glob tool passes through", async () => {
    const plugin = await delegationGatePlugin();
    await expect(
      callNonTask(plugin, "glob", "**/*.js"),
    ).resolves.toBeUndefined();
  });

  it("todowrite tool passes through", async () => {
    const plugin = await delegationGatePlugin();
    await expect(
      callNonTask(plugin, "todowrite", "anything"),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC013: Overseer→subagent delegation
// ---------------------------------------------------------------------------

describe("AC013: Overseer→subagent delegation", () => {
  it("passes valid overseer delegation prompt", async () => {
    const plugin = await delegationGatePlugin();
    const prompt = [
      "DISPATCH TO: explorer",
      "ACTION: Explore",
      "KDS:",
      "  - knowledge/intent-auth-2026-07-15.md",
      "RETURN: knowledge/exploration-auth-2026-07-15.md",
      "ACCEPTANCE: Findings produced",
    ].join("\n");
    await expect(callTask(plugin, prompt)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC014: Artisan→Committer delegation
// ---------------------------------------------------------------------------

describe("AC014: Artisan→Committer delegation", () => {
  it("passes checkpoint delegation prompt", async () => {
    const plugin = await delegationGatePlugin();
    const prompt = [
      "DISPATCH TO: committer",
      "ACTION: Dispatch",
      "MODE: CHECKPOINT",
      "SCOPE: implement plugin",
      "KDS:",
      "  - knowledge/intent-plugin-2026-07-15.md",
      "RETURN: Git commit confirmation",
      "ACCEPTANCE: Committed",
    ].join("\n");
    await expect(callTask(plugin, prompt)).resolves.toBeUndefined();
  });

  it("passes cleanup delegation prompt", async () => {
    const plugin = await delegationGatePlugin();
    const prompt = [
      "DISPATCH TO: committer",
      "ACTION: Commit",
      "MODE: CLEANUP",
      "SCOPE: final cleanup",
      "KDS:",
      "  - knowledge/intent-plugin-2026-07-15.md",
      "RETURN: Git push confirmation",
      "ACCEPTANCE: Pushed",
    ].join("\n");
    await expect(callTask(plugin, prompt)).resolves.toBeUndefined();
  });

  it("passes preflight delegation prompt", async () => {
    const plugin = await delegationGatePlugin();
    const prompt = [
      "DISPATCH TO: committer",
      "ACTION: Dispatch",
      "MODE: PREFLIGHT",
      "SCOPE: workspace setup",
      "KDS:",
      "  - knowledge/intent-plugin-2026-07-15.md",
      "RETURN: Git status summary",
      "ACCEPTANCE: Clean workspace",
    ].join("\n");
    await expect(callTask(plugin, prompt)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Error class verification
// ---------------------------------------------------------------------------

describe("Error class", () => {
  it("DelegationGateError extends Error", () => {
    const err = new DelegationGateError(ERRORS.CODE_BLOCK);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("DelegationGateError");
    expect(err.code).toBe("CODE_BLOCK");
    expect(typeof err.guidance).toBe("string");
  });

  it("all 4 error codes have code, message, guidance", () => {
    for (const config of Object.values(ERRORS)) {
      expect(typeof config.code).toBe("string");
      expect(typeof config.message).toBe("string");
      expect(typeof config.guidance).toBe("string");
    }
  });
});
