// tests/plugins/delegation-gate/index.test.js
// Tests for delegation-gate plugin — structured dispatch enforcement.
//
// Two hooks under test:
//   1. tool.definition — appends delegation format hint to description and
//      injects structured fields (mode, intent_kd, session_date, scope)
//      into the parameters schema as actual tool call args.
//   2. tool.execute.before — resolves templates for structured dispatches,
//      provides positive guidance for rejections. Four routing paths.
//
// Target: ~23 tests covering routing, rejection, confirmation, circuit breaker,
// description hints, and structural integrity.

import fs from "fs";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import delegationGatePlugin from "../../../plugins/delegation-gate/index.js";

// Reset circuit breaker state before every test
beforeEach(() => {
  delegationGatePlugin.resetRejectionState();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeValidArgs(overrides = {}) {
  return {
    mode: "explore",
    intent_kd: "knowledge/intent-auth-flow-2026-07-07.md",
    session_date: "2026-07-07",
    scope: "auth",
    ...overrides,
  };
}

function callToolDefinition(plugin, toolID = "task") {
  const input = { toolID };
  const output = {
    description: "Task tool",
    parameters: {},
    jsonSchema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        description: { type: "string" },
        subagent_type: { type: "string" },
      },
      required: ["prompt", "description", "subagent_type"],
    },
  };
  plugin["tool.definition"](input, output);
  return output;
}

// ---------------------------------------------------------------------------
// 1. Structured dispatch routing
// ---------------------------------------------------------------------------

describe("Structured dispatch routing", () => {
  it("routes structured dispatch to correct agent", async () => {
    const plugin = await delegationGatePlugin({});
    const output = { args: makeValidArgs() };
    await plugin["tool.execute.before"](
      { tool: "task", sessionID: "t", callID: "c1" },
      output,
    );
    expect(output.args.subagent_type).toBe("explorer");
    expect(output.args.prompt).toContain("DISPATCH TO: explorer");
    expect(output.args.prompt).toContain("SCOPE: auth");
  });

  it("routes to correct agent for each mode", async () => {
    const plugin = await delegationGatePlugin({});
    const routeTests = [
      { mode: "explore", expected: "explorer" },
      { mode: "investigate", expected: "analyzer" },
      { mode: "align", expected: "spec-weaver" },
      { mode: "decompose", expected: "pathfinder" },
      { mode: "swarm", expected: "artisan" },
      { mode: "verify", expected: "inspector" },
      { mode: "extract", expected: "scribe" },
      { mode: "evolve", expected: "habit-builder" },
      { mode: "cleanup", expected: "committer" },
      { mode: "checkpoint", expected: "committer" },
      { mode: "preflight", expected: "committer" },
      { mode: "report", expected: "overseer" },
    ];
    for (const { mode, expected } of routeTests) {
      delegationGatePlugin.resetRejectionState();
      const output = { args: makeValidArgs({ mode }) };
      await plugin["tool.execute.before"](
        { tool: "task", sessionID: "t", callID: "c1" },
        output,
      );
      expect(output.args.subagent_type).toBe(expected);
    }
  });

  it("report mode routes to overseer with empty prompt", async () => {
    const plugin = await delegationGatePlugin({});
    const output = { args: makeValidArgs({ mode: "report" }) };
    await plugin["tool.execute.before"](
      { tool: "task", sessionID: "t", callID: "c1" },
      output,
    );
    expect(output.args.subagent_type).toBe("overseer");
    expect(output.args.prompt).toBe("");
  });
});

// ---------------------------------------------------------------------------
// 2. Free-text dispatch rejection
// ---------------------------------------------------------------------------

describe("Free-text dispatch rejection", () => {
  it("throws when free-text dispatch with only prompt", async () => {
    const plugin = await delegationGatePlugin({});
    const output = { args: { prompt: "do something" } };
    await expect(
      plugin["tool.execute.before"](
        { tool: "task", sessionID: "t", callID: "c1" },
        output,
      ),
    ).rejects.toThrow("Use structured dispatch fields");
  });

  it("throws for invalid mode with INVALID_MODE_VALUE error code", async () => {
    const plugin = await delegationGatePlugin({});
    try {
      await plugin["tool.execute.before"](
        { tool: "task", sessionID: "t", callID: "c1" },
        { args: makeValidArgs({ mode: "bogus" }) },
      );
      expect(true).toBe(false);
    } catch (err) {
      expect(err.code).toBe("INVALID_MODE_VALUE");
      expect(err.guidance).toBeTruthy();
      expect(err.example).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Partial fields rejection (FR-04, R001)
// ---------------------------------------------------------------------------

describe("Partial fields rejection", () => {
  it("mode without intent_kd/session_date → MISSING_REQUIRED_FIELDS", async () => {
    const plugin = await delegationGatePlugin({});
    try {
      await plugin["tool.execute.before"](
        { tool: "task", sessionID: "t", callID: "c1" },
        { args: { mode: "explore" } },
      );
      expect(true).toBe(false);
    } catch (err) {
      expect(err.code).toBe("MISSING_REQUIRED_FIELDS");
      expect(err.fieldsReceived.mode).toBe("explore");
    }
  });

  it("MISSING_MODE when intent_kd+session_date present without mode", async () => {
    const plugin = await delegationGatePlugin({});
    try {
      await plugin["tool.execute.before"](
        { tool: "task", sessionID: "t", callID: "c1" },
        {
          args: {
            intent_kd: "knowledge/intent-test-2026-07-07.md",
            session_date: "2026-07-07",
          },
        },
      );
      expect(true).toBe(false);
    } catch (err) {
      expect(err.code).toBe("MISSING_MODE");
      expect(err.fieldsReceived.intent_kd).toBe("knowledge/intent-test-2026-07-07.md");
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Absorbed validation — intent_kd path, session_date format
// ---------------------------------------------------------------------------

describe("Absorbed validation (from protocol-gate)", () => {
  it("rejects invalid intent_kd path with INVALID_INTENT_KD_PATH", async () => {
    const plugin = await delegationGatePlugin({});
    try {
      await plugin["tool.execute.before"](
        { tool: "task", sessionID: "t", callID: "c1" },
        {
          args: {
            mode: "explore",
            intent_kd: "knowledge/spec-bad-2026-07-07.md",
            session_date: "2026-07-07",
          },
        },
      );
      expect(true).toBe(false);
    } catch (err) {
      expect(err.code).toBe("INVALID_INTENT_KD_PATH");
      expect(err.guidance).toContain("intent-<descriptive-name>");
    }
  });

  it("rejects invalid session_date with INVALID_SESSION_DATE", async () => {
    const plugin = await delegationGatePlugin({});
    try {
      await plugin["tool.execute.before"](
        { tool: "task", sessionID: "t", callID: "c1" },
        {
          args: {
            mode: "explore",
            intent_kd: "knowledge/intent-test-2026-07-07.md",
            session_date: "bad-date",
          },
        },
      );
      expect(true).toBe(false);
    } catch (err) {
      expect(err.code).toBe("INVALID_SESSION_DATE");
      expect(err.guidance).toContain("YYYY-MM-DD");
    }
  });

  it("rejects missing scope in PATH 1 with MISSING_SCOPE", async () => {
    const plugin = await delegationGatePlugin({});
    try {
      await plugin["tool.execute.before"](
        { tool: "task", sessionID: "t", callID: "c1" },
        {
          args: {
            mode: "explore",
            intent_kd: "knowledge/intent-test-2026-07-07.md",
            session_date: "2026-07-07",
          },
        },
      );
      expect(true).toBe(false);
    } catch (err) {
      expect(err.code).toBe("MISSING_SCOPE");
      expect(err.fieldsReceived.mode).toBe("explore");
      expect(err.fieldsReceived.intent_kd).toBe("knowledge/intent-test-2026-07-07.md");
      expect(err.fieldsReceived.session_date).toBe("2026-07-07");
    }
  });

  it("rejects empty scope string in PATH 1 with MISSING_SCOPE", async () => {
    const plugin = await delegationGatePlugin({});
    try {
      await plugin["tool.execute.before"](
        { tool: "task", sessionID: "t", callID: "c1" },
        {
          args: {
            mode: "explore",
            intent_kd: "knowledge/intent-test-2026-07-07.md",
            session_date: "2026-07-07",
            scope: "",
          },
        },
      );
      expect(true).toBe(false);
    } catch (err) {
      expect(err.code).toBe("MISSING_SCOPE");
    }
  });

  it("rejects whitespace-only scope in PATH 1 with MISSING_SCOPE", async () => {
    const plugin = await delegationGatePlugin({});
    try {
      await plugin["tool.execute.before"](
        { tool: "task", sessionID: "t", callID: "c1" },
        {
          args: {
            mode: "explore",
            intent_kd: "knowledge/intent-test-2026-07-07.md",
            session_date: "2026-07-07",
            scope: "   ",
          },
        },
      );
      expect(true).toBe(false);
    } catch (err) {
      expect(err.code).toBe("MISSING_SCOPE");
    }
  });
});

// ---------------------------------------------------------------------------
// 5. _dispatch_confirmation (FR-03)
// ---------------------------------------------------------------------------

describe("_dispatch_confirmation", () => {
  it("confirmation fills missing fields and routes to PATH 1", async () => {
    const plugin = await delegationGatePlugin({});
    const output = {
      args: {
        intent_kd: "knowledge/intent-test-2026-07-07.md",
        session_date: "2026-07-07",
        scope: "test scope",
        _dispatch_confirmation: {
          status: "dispatched",
          mode: "explore",
          targetAgent: "explorer",
          kds: ["knowledge/intent-test-2026-07-07.md"],
          returnPath: "",
        },
      },
    };
    await plugin["tool.execute.before"](
      { tool: "task", sessionID: "t", callID: "c1" },
      output,
    );
    expect(output.args.subagent_type).toBe("explorer");
    expect(output.args.prompt).toContain("DISPATCH TO: explorer");
  });

  it("confirmation deleted from args after extraction (old one consumed)", async () => {
    const plugin = await delegationGatePlugin({});
    const output = {
      args: {
        scope: "test scope",
        _dispatch_confirmation: {
          status: "dispatched",
          mode: "explore",
          intent_kd: "knowledge/intent-test-2026-07-07.md",
          session_date: "2026-07-07",
          targetAgent: "explorer",
          kds: [],
          returnPath: "",
        },
      },
    };
    await plugin["tool.execute.before"](
      { tool: "task", sessionID: "t", callID: "c1" },
      output,
    );
    // Old confirmation consumed; new one injected by PATH 1
    expect(output.args._dispatch_confirmation).toBeDefined();
    expect(output.args._dispatch_confirmation.mode).toBe("explore");
  });

  it("confirmation with no usable fields → normal routing (free-text rejection)", async () => {
    const plugin = await delegationGatePlugin({});
    await expect(
      plugin["tool.execute.before"](
        { tool: "task", sessionID: "t", callID: "c1" },
        {
          args: {
            prompt: "do something",
            _dispatch_confirmation: { status: "dispatched" },
          },
        },
      ),
    ).rejects.toThrow("Use structured dispatch fields");
  });

  it("confirmation survives cleanup — not deleted with structured fields", async () => {
    const plugin = await delegationGatePlugin({});
    const output = { args: makeValidArgs() };
    await plugin["tool.execute.before"](
      { tool: "task", sessionID: "t", callID: "c1" },
      output,
    );
    // Structured fields deleted
    expect(output.args.mode).toBeUndefined();
    expect(output.args.intent_kd).toBeUndefined();
    // Confirmation preserved
    expect(output.args._dispatch_confirmation).toBeDefined();
    expect(output.args._dispatch_confirmation.status).toBe("dispatched");
  });
});

// ---------------------------------------------------------------------------
// 6. Circuit breaker (FR-05)
// ---------------------------------------------------------------------------

describe("Circuit breaker", () => {
  it("activates after 3 consecutive failures", async () => {
    const plugin = await delegationGatePlugin({});
    const ctx = { tool: "task", sessionID: "t", callID: "c1" };
    // 2 failures — below threshold
    for (let i = 0; i < 2; i++) {
      try { await plugin["tool.execute.before"](ctx, { args: { prompt: `f${i}` } }); } catch (_) {}
    }
    // 3rd failure — triggers progressive guidance
    try {
      await plugin["tool.execute.before"](ctx, { args: { prompt: "f2" } });
    } catch (err) {
      expect(err.message).toContain("Example — use this format");
    }
  });

  it("successful dispatch resets counter", async () => {
    const plugin = await delegationGatePlugin({});
    const ctx = { tool: "task", sessionID: "t", callID: "c1" };
    // 2 failures
    for (let i = 0; i < 2; i++) {
      try { await plugin["tool.execute.before"](ctx, { args: { prompt: `f${i}` } }); } catch (_) {}
    }
    // Successful dispatch resets counter
    await plugin["tool.execute.before"](ctx, { args: makeValidArgs() });
    // Next failure is treated as 1st — no progressive guidance
    try {
      await plugin["tool.execute.before"](ctx, { args: { prompt: "after" } });
    } catch (err) {
      expect(err.message).not.toContain("Example — use this format");
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Extra fields passthrough
// ---------------------------------------------------------------------------

describe("Extra fields passthrough", () => {
  it("preserves task_id and command in structured dispatch", async () => {
    const plugin = await delegationGatePlugin({});
    const output = {
      args: makeValidArgs({
        mode: "checkpoint",
        task_id: "prev-123",
        command: "git status",
      }),
    };
    await plugin["tool.execute.before"](
      { tool: "task", sessionID: "t", callID: "c1" },
      output,
    );
    expect(output.args.task_id).toBe("prev-123");
    expect(output.args.command).toBe("git status");
    // Structured fields cleaned
    expect(output.args.mode).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 8. Guard clauses — non-task tools, empty args
// ---------------------------------------------------------------------------

describe("Guard clauses", () => {
  it("non-task tool passes through untouched", async () => {
    const plugin = await delegationGatePlugin({});
    const output = { args: { prompt: "anything" } };
    await plugin["tool.execute.before"](
      { tool: "read", sessionID: "t", callID: "c1" },
      output,
    );
    expect(output.args.prompt).toBe("anything");
  });

  it("empty/unrelated args pass through", async () => {
    const plugin = await delegationGatePlugin({});
    const output = { args: { unrelated: true } };
    await plugin["tool.execute.before"](
      { tool: "task", sessionID: "t", callID: "c1" },
      output,
    );
    expect(output.args).toEqual({ unrelated: true });
  });
});

// ---------------------------------------------------------------------------
// 9. tool.definition — description hint (P002)
// ---------------------------------------------------------------------------

describe("tool.definition description hint", () => {
  it("appends format hint to description", async () => {
    const plugin = await delegationGatePlugin({});
    const output = callToolDefinition(plugin, "task");
    expect(output.description).toContain("Delegation:");
    expect(output.description).toContain("pass mode, intent_kd, session_date, scope as tool parameters");
    expect(output.description).toContain("Modes:");
  });

  it("injects structured fields into parameters.properties", async () => {
    const plugin = await delegationGatePlugin({});
    const output = callToolDefinition(plugin, "task");
    expect(output.parameters.properties.mode).toBeDefined();
    expect(output.parameters.properties.mode.type).toBe("string");
    expect(output.parameters.properties.mode.enum).toContain("explore");
    expect(output.parameters.properties.intent_kd).toBeDefined();
    expect(output.parameters.properties.intent_kd.type).toBe("string");
    expect(output.parameters.properties.session_date).toBeDefined();
    expect(output.parameters.properties.session_date.type).toBe("string");
    expect(output.parameters.properties.scope).toBeDefined();
    expect(output.parameters.properties.scope.type).toBe("string");
  });

  it("does NOT touch jsonSchema.properties", async () => {
    const plugin = await delegationGatePlugin({});
    const output = callToolDefinition(plugin, "task");
    // jsonSchema.properties remains untouched — only parameters.properties is modified
    expect(output.jsonSchema.properties.mode).toBeUndefined();
    expect(output.jsonSchema.properties.intent_kd).toBeUndefined();
    expect(output.jsonSchema.properties.session_date).toBeUndefined();
    expect(output.jsonSchema.properties._dispatch_confirmation).toBeUndefined();
    // Original properties preserved
    expect(output.jsonSchema.properties.prompt).toBeDefined();
    expect(output.jsonSchema.properties.description).toBeDefined();
    expect(output.jsonSchema.properties.subagent_type).toBeDefined();
    expect(output.jsonSchema.required).toContain("prompt");
  });

  it("non-task tool does not inject parameters", async () => {
    const plugin = await delegationGatePlugin({});
    const output = callToolDefinition(plugin, "read");
    // parameters.properties is not created for non-task tools
    expect(output.parameters.properties).toBeUndefined();
    expect(output.description).not.toContain("Delegation:");
  });
});

// ---------------------------------------------------------------------------
// 10. Structured fields cleaned from output
// ---------------------------------------------------------------------------

describe("Structured fields removed from output", () => {
  it("mode, intent_kd, session_date, scope are removed after dispatch", async () => {
    const plugin = await delegationGatePlugin({});
    const output = { args: makeValidArgs({ mode: "swarm" }) };
    await plugin["tool.execute.before"](
      { tool: "task", sessionID: "t", callID: "c1" },
      output,
    );
    expect(output.args.mode).toBeUndefined();
    expect(output.args.intent_kd).toBeUndefined();
    expect(output.args.session_date).toBeUndefined();
    expect(output.args.scope).toBeUndefined();
    expect(output.args.subagent_type).toBe("artisan");
    expect(output.args.prompt).toBeDefined();
    expect(output.args.description).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 11. PATH 2 extraction — fields in prompt text
// ---------------------------------------------------------------------------

describe("PATH 2 extraction from prompt text", () => {
  it("extracts all 4 fields from prompt and routes through PATH 1", async () => {
    const plugin = await delegationGatePlugin({});
    const output = {
      args: {
        prompt:
          'mode: cleanup\nintent_kd: knowledge/intent-test-2026-07-10.md\nsession_date: 2026-07-10\nscope: commit changes',
      },
    };
    await plugin["tool.execute.before"](
      { tool: "task", sessionID: "t", callID: "c1" },
      output,
    );
    expect(output.args.subagent_type).toBe("committer");
    expect(output.args.prompt).toContain("DISPATCH TO: committer");
    expect(output.args.mode).toBeUndefined();
  });

  it("extracts mode/intent_kd/session_date but missing scope → MISSING_SCOPE", async () => {
    const plugin = await delegationGatePlugin({});
    const output = {
      args: {
        prompt:
          'mode: cleanup\nintent_kd: knowledge/intent-test-2026-07-10.md\nsession_date: 2026-07-10',
      },
    };
    try {
      await plugin["tool.execute.before"](
        { tool: "task", sessionID: "t", callID: "c1" },
        output,
      );
      expect(true).toBe(false);
    } catch (err) {
      expect(err.code).toBe("MISSING_SCOPE");
      expect(err.fieldsReceived.mode).toBe("cleanup");
      expect(err.fieldsReceived.intent_kd).toBe("knowledge/intent-test-2026-07-10.md");
      expect(err.fieldsReceived.session_date).toBe("2026-07-10");
    }
  });
});

// ---------------------------------------------------------------------------
// 12. Error infrastructure
// ---------------------------------------------------------------------------

describe("Error infrastructure", () => {
  it("all error codes have required fields (code, message, guidance, example)", async () => {
    const plugin = await delegationGatePlugin({});
    const testCases = [
      { args: { intent_kd: "x", session_date: "2026-07-07" }, code: "MISSING_MODE" },
      { args: { prompt: "work" }, code: "MISSING_ALL_FIELDS" },
      { args: { prompt: "mode: explore" }, code: "FIELDS_IN_PROMPT" },
      { args: makeValidArgs({ mode: "bogus" }), code: "INVALID_MODE_VALUE" },
      { args: { mode: "explore" }, code: "MISSING_REQUIRED_FIELDS" },
      {
        args: {
          mode: "explore",
          intent_kd: "knowledge/intent-test-2026-07-07.md",
          session_date: "2026-07-07",
        },
        code: "MISSING_SCOPE",
      },
    ];

    for (const { args, code } of testCases) {
      delegationGatePlugin.resetRejectionState();
      try {
        await plugin["tool.execute.before"](
          { tool: "task", sessionID: "t", callID: "c1" },
          { args },
        );
        expect(true).toBe(false);
      } catch (err) {
        expect(err.code).toBe(code);
        expect(typeof err.message).toBe("string");
        expect(typeof err.guidance).toBe("string");
        expect(typeof err.example).toBe("string");
      }
    }
  });

  it("DelegationGateError extends Error correctly", async () => {
    const plugin = await delegationGatePlugin({});
    try {
      await plugin["tool.execute.before"](
        { tool: "task", sessionID: "t", callID: "c1" },
        { args: { prompt: "work" } },
      );
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe("DelegationGateError");
      expect(err.code).toBe("MISSING_ALL_FIELDS");
    }
  });

  it("resetRejectionState() works between tests", async () => {
    const plugin = await delegationGatePlugin({});
    const ctx = { tool: "task", sessionID: "t", callID: "c1" };
    // Build 3 rejections → triggers progressive guidance
    for (let i = 0; i < 3; i++) {
      try { await plugin["tool.execute.before"](ctx, { args: { prompt: `x${i}` } }); } catch (_) {}
    }
    delegationGatePlugin.resetRejectionState();
    // After reset, no progressive guidance
    try {
      await plugin["tool.execute.before"](ctx, { args: { prompt: "after-reset" } });
    } catch (err) {
      expect(err.message).not.toContain("Example — use this format");
    }
  });
});

// ---------------------------------------------------------------------------
// 13. Template structure enforcement — prepend removal + scope (P001)
// ---------------------------------------------------------------------------

describe("Template structure enforcement", () => {
  it("strips non-field text from PATH 2 dispatch", async () => {
    const plugin = await delegationGatePlugin({});
    const output = {
      args: {
        prompt:
          'mode: cleanup\nintent_kd: knowledge/intent-test-2026-07-10.md\nsession_date: 2026-07-10\nscope: commit changes\nRead the file at docs/ROADMAP.md and return its FULL contents',
      },
    };
    await plugin["tool.execute.before"](
      { tool: "task", sessionID: "t", callID: "c1" },
      output,
    );
    expect(output.args.prompt).not.toContain("Read the file");
    expect(output.args.prompt).toContain("DISPATCH TO: committer");
  });

  it("pure structured prompt produces clean output (no prepend)", async () => {
    const plugin = await delegationGatePlugin({});
    const output = {
      args: {
        prompt:
          'mode: explore\nintent_kd: knowledge/intent-test-2026-07-10.md\nsession_date: 2026-07-10\nscope: auth analysis',
      },
    };
    await plugin["tool.execute.before"](
      { tool: "task", sessionID: "t", callID: "c1" },
      output,
    );
    // Prompt starts with template output — no field assignments prepended
    expect(output.args.prompt).toMatch(/^DISPATCH TO:/);
    expect(output.args.prompt).not.toContain("mode: explore");
    expect(output.args.prompt).not.toContain("intent_kd:");
  });

  it("scope extracted and included in template resolution", async () => {
    const plugin = await delegationGatePlugin({});
    const output = {
      args: {
        prompt:
          'mode: explore\nintent_kd: knowledge/intent-test-2026-07-10.md\nsession_date: 2026-07-10\nscope: auth analysis',
      },
    };
    await plugin["tool.execute.before"](
      { tool: "task", sessionID: "t", callID: "c1" },
      output,
    );
    expect(output.args.prompt).toContain("SCOPE: auth analysis");
  });

  it("rejects scope exceeding 200 characters", async () => {
    const plugin = await delegationGatePlugin({});
    const longScope = "a".repeat(201);
    const output = {
      args: {
        prompt: `mode: explore\nintent_kd: knowledge/intent-test-2026-07-10.md\nsession_date: 2026-07-10\nscope: ${longScope}`,
      },
    };
    await expect(
      plugin["tool.execute.before"](
        { tool: "task", sessionID: "t", callID: "c1" },
        output,
      ),
    ).rejects.toThrow("scope exceeds 200 character limit");
  });

  it("accepts scope at exactly 200 characters", async () => {
    const plugin = await delegationGatePlugin({});
    const exactScope = "b".repeat(200);
    const output = {
      args: {
        prompt: `mode: explore\nintent_kd: knowledge/intent-test-2026-07-10.md\nsession_date: 2026-07-10\nscope: ${exactScope}`,
      },
    };
    await plugin["tool.execute.before"](
      { tool: "task", sessionID: "t", callID: "c1" },
      output,
    );
    expect(output.args.prompt).toContain("DISPATCH TO: explorer");
  });

  it("scope omitted throws MISSING_SCOPE in PATH 2", async () => {
    const plugin = await delegationGatePlugin({});
    const output = {
      args: {
        prompt:
          'mode: explore\nintent_kd: knowledge/intent-test-2026-07-10.md\nsession_date: 2026-07-10',
      },
    };
    try {
      await plugin["tool.execute.before"](
        { tool: "task", sessionID: "t", callID: "c1" },
        output,
      );
      expect(true).toBe(false);
    } catch (err) {
      expect(err.code).toBe("MISSING_SCOPE");
      expect(err.fieldsReceived.mode).toBe("explore");
      expect(err.fieldsReceived.intent_kd).toBe("knowledge/intent-test-2026-07-10.md");
      expect(err.fieldsReceived.session_date).toBe("2026-07-10");
    }
  });

  it("SCOPE_TOO_LONG error has all required fields", async () => {
    const plugin = await delegationGatePlugin({});
    const longScope = "c".repeat(201);
    try {
      await plugin["tool.execute.before"](
        { tool: "task", sessionID: "t", callID: "c1" },
        {
          args: {
            prompt: `mode: explore\nintent_kd: knowledge/intent-test-2026-07-10.md\nsession_date: 2026-07-10\nscope: ${longScope}`,
          },
        },
      );
      expect(true).toBe(false);
    } catch (err) {
      expect(err.code).toBe("SCOPE_TOO_LONG");
      expect(typeof err.message).toBe("string");
      expect(typeof err.guidance).toBe("string");
      expect(typeof err.example).toBe("string");
      expect(err).toBeInstanceOf(Error);
    }
  });

  it("description hint includes scope limit", async () => {
    const plugin = await delegationGatePlugin({});
    const output = callToolDefinition(plugin, "task");
    expect(output.description).toContain("max 200 chars");
  });

  it("parameters.scope description includes max 200 chars", async () => {
    const plugin = await delegationGatePlugin({});
    const output = callToolDefinition(plugin, "task");
    expect(output.parameters.properties.scope.description).toContain("max 200 chars");
  });
});
