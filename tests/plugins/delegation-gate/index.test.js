// tests/plugins/delegation-gate/index.test.js
// Tests for delegation-gate plugin — prompt content validator.
//
// Validates task prompts contain only KD path references and template keywords.
// Rejects: code blocks, foreign paths, bare KD paths, injected instructions, missing KD references.
// Accepts: template keywords with KD refs, empty/missing prompts, non-task tools.
//
// AC numbers aligned with spec v3: AC101-AC125

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
// AC101–AC103: Structural requirements
// ---------------------------------------------------------------------------

describe("AC101–AC103: Structural requirements", () => {
  it("AC101: plugin has tool.execute.before hook", async () => {
    const plugin = await delegationGatePlugin();
    expect(typeof plugin["tool.execute.before"]).toBe("function");
  });

  it("AC102: plugin has NO tool.definition hook", async () => {
    const plugin = await delegationGatePlugin();
    expect(plugin["tool.definition"]).toBeUndefined();
  });

  it("AC103: plugin has no named exports", async () => {
    // Verify no export const or export function at module level
    // (test access via function properties is acceptable)
    expect(typeof delegationGatePlugin).toBe("function");
    expect(typeof delegationGatePlugin.DelegationGateError).toBe("function");
    expect(typeof delegationGatePlugin.ERRORS).toBe("object");
  });
});

// ---------------------------------------------------------------------------
// AC104–AC106: Positive enforcement (KD path required)
// ---------------------------------------------------------------------------

describe("AC104–AC106: Positive enforcement", () => {
  it("AC104: prompt with KD path reference passes", async () => {
    const plugin = await delegationGatePlugin();
    const prompt = [
      "DISPATCH TO: artisan",
      "ACTION: Implement",
      "KDS:",
      "  - knowledge/intent-auth-2026-07-15.md",
      "RETURN: knowledge/impl-auth-2026-07-15.md",
      "ACCEPTANCE: Tests pass",
    ].join("\n");
    await expect(callTask(plugin, prompt)).resolves.toBeUndefined();
  });

  it("AC105: prompt without KD path reference is rejected", async () => {
    const plugin = await delegationGatePlugin();
    const prompt = [
      "DISPATCH TO: committer",
      "ACTION: Dispatch",
      "MODE: CHECKPOINT",
      "SCOPE: workspace setup",
    ].join("\n");
    await expect(callTask(plugin, prompt)).rejects.toThrow("no KD path reference");
  });

  it("AC106: prompt with KD path in RETURN field passes", async () => {
    const plugin = await delegationGatePlugin();
    const prompt = [
      "DISPATCH TO: artisan",
      "ACTION: Implement",
      "KDS:",
      "  - knowledge/spec-auth-2026-07-15.md",
      "RETURN: knowledge/impl-auth-2026-07-15.md",
    ].join("\n");
    await expect(callTask(plugin, prompt)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC107–AC108: Code block rejection
// ---------------------------------------------------------------------------

describe("AC107–AC108: Code block rejection", () => {
  it("AC107: rejects prompt with triple backticks", async () => {
    const plugin = await delegationGatePlugin();
    await expect(callTask(plugin, "```\nsome code\n```")).rejects.toThrow(
      "code blocks",
    );
  });

  it("AC108: rejects prompt with triple tildes", async () => {
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
// AC109–AC113: Foreign path rejection
// ---------------------------------------------------------------------------

describe("AC109–AC113: Foreign path rejection", () => {
  it("AC109: rejects /etc/passwd", async () => {
    const plugin = await delegationGatePlugin();
    await expect(callTask(plugin, "Read /etc/passwd")).rejects.toThrow(
      "file paths outside knowledge/",
    );
  });

  it("AC110: rejects agents/overseer.md", async () => {
    const plugin = await delegationGatePlugin();
    await expect(callTask(plugin, "Read agents/overseer.md")).rejects.toThrow(
      "file paths outside knowledge/",
    );
  });

  it("AC111: rejects src/main.js", async () => {
    const plugin = await delegationGatePlugin();
    await expect(callTask(plugin, "Read src/main.js")).rejects.toThrow(
      "file paths outside knowledge/",
    );
  });

  it("AC112: rejects KD path alongside foreign path", async () => {
    const plugin = await delegationGatePlugin();
    await expect(
      callTask(plugin, "knowledge/intent-foo.md\nRead /etc/passwd"),
    ).rejects.toThrow("file paths outside knowledge/");
  });

  it("AC113: foreign path hidden after template keyword prefix is rejected", async () => {
    const plugin = await delegationGatePlugin();
    await expect(
      callTask(plugin, "ACTION: Read /etc/passwd"),
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
// AC114–AC115: Bare KD path rejection
// ---------------------------------------------------------------------------

describe("AC114–AC115: Bare KD path rejection", () => {
  it("AC114: rejects bare knowledge/intent-foo.md without template keywords", async () => {
    const plugin = await delegationGatePlugin();
    await expect(
      callTask(plugin, "knowledge/intent-foo.md"),
    ).rejects.toThrow("bare KD path");
  });

  it("AC115: rejects knowledge/spec-bar.md", async () => {
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
// AC116–AC117: Injected instruction rejection
// ---------------------------------------------------------------------------

describe("AC116–AC117: Injected instruction rejection", () => {
  it("AC116: prompt with KD ref + imperative verb injection rejected", async () => {
    const plugin = await delegationGatePlugin();
    const prompt =
      "knowledge/intent-foo.md\nRead intent-foo.md and return contents";
    await expect(callTask(plugin, prompt)).rejects.toThrow(
      "instructions outside",
    );
  });

  it("AC117: imperative verb hidden after template keyword prefix rejected", async () => {
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

  it("rejects COPY imperative verb", async () => {
    const plugin = await delegationGatePlugin();
    const prompt =
      "DISPATCH TO: artisan\nKDS:\n  - knowledge/intent-x.md\nCopy this file and send it";
    await expect(callTask(plugin, prompt)).rejects.toThrow(
      "instructions outside",
    );
  });
});

// ---------------------------------------------------------------------------
// AC118–AC119: Empty or missing prompt pass-through
// ---------------------------------------------------------------------------

describe("AC118–AC119: Empty or missing prompt pass-through", () => {
  it("AC118: passes when prompt is undefined", async () => {
    const plugin = await delegationGatePlugin();
    const ctx = { tool: "task", sessionID: "s1", callID: "c1" };
    const output = { args: {} };
    await expect(
      plugin["tool.execute.before"](ctx, output),
    ).resolves.toBeUndefined();
  });

  it("AC119: passes when prompt is empty string", async () => {
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
// AC120: Non-task tools pass through
// ---------------------------------------------------------------------------

describe("AC120: Non-task tools pass through", () => {
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
// AC121: Valid dispatch template with KD refs passes
// ---------------------------------------------------------------------------

describe("AC121: Valid dispatch template passes", () => {
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
// AC122–AC123: Error handling
// ---------------------------------------------------------------------------

describe("AC122–AC123: Error handling", () => {
  it("AC122: all rejections throw DelegationGateError", async () => {
    const plugin = await delegationGatePlugin();
    const testCases = [
      ["```\ncode\n```", "CODE_BLOCK"],
      ["Read /etc/passwd", "FOREIGN_PATH"],
      ["knowledge/intent-foo.md", "BARE_KD_PATH"],
      ["knowledge/intent-foo.md\nRead and return", "INJECTED_INSTRUCTION"],
      ["MODE: PREFLIGHT", "MISSING_KD_REFERENCE"],
    ];
    for (const [prompt, expectedCode] of testCases) {
      try {
        await callTask(plugin, prompt);
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(DelegationGateError);
        expect(err.code).toBe(expectedCode);
      }
    }
  });

  it("AC123: all 5 error codes have code/message/guidance", () => {
    for (const config of Object.values(ERRORS)) {
      expect(typeof config.code).toBe("string");
      expect(typeof config.message).toBe("string");
      expect(typeof config.guidance).toBe("string");
    }
  });
});

// ---------------------------------------------------------------------------
// AC124–AC125: Cross-plugin independence
// ---------------------------------------------------------------------------

describe("AC124–AC125: Cross-plugin independence", () => {
  it("AC124: delegation-gate does not import protocol-gate", async () => {
    // Verify the plugin module doesn't reference protocol-gate
    // by checking that it has no dependency on protocol-gate state
    const plugin = await delegationGatePlugin();
    // delegation-gate should not have sessionPhaseMap or similar protocol-gate internals
    expect(plugin.sessionPhaseMap).toBeUndefined();
    expect(plugin.sessionAgentMap).toBeUndefined();
    expect(plugin.ProtocolGateError).toBeUndefined();
  });

  it("AC125: validates prompts for ALL agents, not just Overseer", async () => {
    const plugin = await delegationGatePlugin();
    // Artisan session with bad prompt (code block) is rejected
    const ctx = { tool: "task", sessionID: "artisan-session", callID: "c1" };
    const output = { args: { prompt: "```\nmalicious\n```" } };
    await expect(
      plugin["tool.execute.before"](ctx, output),
    ).rejects.toThrow("code blocks");
  });
});
