// tests/plugins/dispatch-gate/index.test.js
// Tests for dispatch-gate plugin — structured dispatch enforcement.
//
// Two hooks under test:
//   1. tool.definition — modifies jsonSchema (mutable JSON Schema 7) to
//      add structured dispatch fields as REQUIRED properties. Guides the
//      LLM to use structured format.
//   2. tool.execute.before — resolves templates for structured dispatches
//      via property mutation. Throws for free-text and unknown mode.
//      Logs every event via [DISPATCH-GATE] structured format.
//
// ALL callers (Overseer, Artisan, any agent) use the same structured
// dispatch format: { mode, intent_kd, session_date, scope? }
// The plugin resolves templates and routes to the correct target agent.

import fs from "fs";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import dispatchGatePlugin from "../../../plugins/dispatch-gate/index.js";
import {
  resolveTemplate,
  parseIntentPath,
  resolveVariables,
  resolveGlobs,
  buildContext,
} from "../../../plugins/dispatch-gate/template-engine.js";
import templates from "../../../plugins/dispatch-gate/templates.json" with { type: "json" };

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

/** Invoke the tool.execute.before hook. */
function callExecuteBefore(plugin, args, tool = "task") {
  const ctx = { tool, sessionID: "test", callID: "test-001" };
  const output = { args };
  return plugin["tool.execute.before"](ctx, output);
}

/**
 * Invoke the tool.definition hook and return the modified output.
 * Uses jsonSchema (the mutable JSON Schema 7 object used at runtime)
 * rather than parameters (which is an Effect Schema.Struct with no
 * .properties at runtime).
 */
function callToolDefinition(plugin, toolID = "task", existingSchema = null) {
  const input = { toolID };
  const defaultSchema = {
    type: "object",
    properties: {
      prompt: { type: "string" },
      description: { type: "string" },
      subagent_type: { type: "string" },
    },
    required: ["prompt", "description", "subagent_type"],
  };
  const output = {
    description: "Task tool",
    // parameters simulates Effect Schema.Struct — no .properties
    parameters: {},
    jsonSchema: existingSchema || { ...defaultSchema },
  };
  plugin["tool.definition"](input, output);
  return output;
}

// ---------------------------------------------------------------------------
// Tool Definition Hook Tests
// ---------------------------------------------------------------------------

describe("tool.definition hook", () => {
  it("adds mode, intent_kd, session_date, scope to task jsonSchema", async () => {
    const plugin = await dispatchGatePlugin({});
    const output = callToolDefinition(plugin, "task");
    expect(output.jsonSchema.properties.mode).toBeDefined();
    expect(output.jsonSchema.properties.mode.type).toBe("string");
    expect(output.jsonSchema.properties.intent_kd).toBeDefined();
    expect(output.jsonSchema.properties.intent_kd.type).toBe("string");
    expect(output.jsonSchema.properties.session_date).toBeDefined();
    expect(output.jsonSchema.properties.session_date.type).toBe("string");
    expect(output.jsonSchema.properties.scope).toBeDefined();
    expect(output.jsonSchema.properties.scope.type).toBe("string");
  });

  it("makes mode, intent_kd, session_date required", async () => {
    const plugin = await dispatchGatePlugin({});
    const output = callToolDefinition(plugin, "task");
    expect(output.jsonSchema.required).toContain("mode");
    expect(output.jsonSchema.required).toContain("intent_kd");
    expect(output.jsonSchema.required).toContain("session_date");
  });

  it("removes prompt, description, subagent_type from required", async () => {
    const plugin = await dispatchGatePlugin({});
    const output = callToolDefinition(plugin, "task");
    expect(output.jsonSchema.required).not.toContain("prompt");
    expect(output.jsonSchema.required).not.toContain("description");
    expect(output.jsonSchema.required).not.toContain("subagent_type");
  });

  it("does not modify non-task tools", async () => {
    const plugin = await dispatchGatePlugin({});
    const output = callToolDefinition(plugin, "read");
    // Should be identical to the default schema
    expect(output.jsonSchema.properties.prompt).toBeDefined();
    expect(output.jsonSchema.required).toContain("prompt");
    expect(output.jsonSchema.required).toContain("description");
    expect(output.jsonSchema.required).toContain("subagent_type");
    // Should NOT have added structured fields
    expect(output.jsonSchema.properties.mode).toBeUndefined();
    // Should NOT have pushed structured fields to required
    expect(output.jsonSchema.required).not.toContain("mode");
  });

  it("does NOT modify output.parameters (Effect Schema has no .properties)", async () => {
    const plugin = await dispatchGatePlugin({});
    const output = callToolDefinition(plugin, "task");
    // output.parameters is a mock Effect Schema — no .properties
    expect(output.parameters.properties).toBeUndefined();
  });

  it("handles schema with no jsonSchema gracefully", async () => {
    const plugin = await dispatchGatePlugin({});
    const input = { toolID: "task" };
    // No jsonSchema, no parameters.properties — should not throw
    const output = { description: "bare", parameters: null };
    await expect(
      plugin["tool.definition"](input, output),
    ).resolves.toBeUndefined();
  });

  it("handles schema with no required array gracefully", async () => {
    const plugin = await dispatchGatePlugin({});
    const schema = {
      type: "object",
      properties: { prompt: { type: "string" } },
      // no "required" key
    };
    const output = callToolDefinition(plugin, "task", schema);
    // Should have added structured fields to jsonSchema
    expect(output.jsonSchema.properties.mode).toBeDefined();
    // Should not have thrown about missing required array
  });

  it("mode property includes enum values for all dispatch modes", async () => {
    const plugin = await dispatchGatePlugin({});
    const output = callToolDefinition(plugin, "task");
    const expectedModes = [
      "explore", "investigate", "align", "decompose", "swarm",
      "verify", "extract", "evolve", "commit", "report",
      "checkpoint", "preflight",
    ];
    for (const mode of expectedModes) {
      expect(output.jsonSchema.properties.mode.enum).toContain(mode);
    }
  });

  it("session_date property includes pattern validation", async () => {
    const plugin = await dispatchGatePlugin({});
    const output = callToolDefinition(plugin, "task");
    expect(output.jsonSchema.properties.session_date.pattern).toBeDefined();
    expect(output.jsonSchema.properties.session_date.pattern).toMatch(
      /^\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$$/,
    );
  });
});

// ---------------------------------------------------------------------------
// Swarm Template KDS Tests (R002 — review-* glob)
// ---------------------------------------------------------------------------

describe("Swarm template KDS completeness (R002)", () => {
  it("AC003: swarm template includes review-* glob in KDS section", () => {
    // Verify the template source (not resolved prompt) has the review-* glob entry
    const swarmTemplate = templates.swarm.template;
    const kdsSectionStart = swarmTemplate.indexOf("KDS:");
    const returnSectionStart = swarmTemplate.indexOf("RETURN:");
    const kdsSection = swarmTemplate.slice(kdsSectionStart, returnSectionStart);
    expect(kdsSection).toContain("knowledge/review-*{{date}}.md");
  });

  it("AC004: empty review glob resolves silently (unmatched glob returns empty string)", async () => {
    // This test verifies that resolveGlobs handles unmatched glob patterns without error.
    // Using a glob pattern guaranteed to have no matches for the test session date.
    const result = await resolveGlobs("{{glob:knowledge/review-*2026-99-99.md}}");
    // Unmatched glob returns empty string, not an error
    expect(result).toBe("");
  });

  it("AC003b: swarm template maintains chronological order of KDS entries", () => {
    // spec-* comes before plan-* comes before review-*
    const swarmTemplate = templates.swarm.template;
    const specIdx = swarmTemplate.indexOf("{{glob:knowledge/spec-*{{date}}.md}}");
    const planIdx = swarmTemplate.indexOf("{{glob:knowledge/plan-*{{date}}.md}}");
    const reviewIdx = swarmTemplate.indexOf("{{glob:knowledge/review-*{{date}}.md}}");
    expect(specIdx).toBeGreaterThan(-1);
    expect(planIdx).toBeGreaterThan(specIdx);
    expect(reviewIdx).toBeGreaterThan(planIdx);
  });
});

// ---------------------------------------------------------------------------
// Template Engine Tests
// ---------------------------------------------------------------------------

describe("template-engine parseIntentPath", () => {
  it("extracts name and date from valid intent KD path", () => {
    const result = parseIntentPath(
      "knowledge/intent-auth-flow-2026-07-07.md",
    );
    expect(result).toEqual({ name: "auth-flow", date: "2026-07-07" });
  });

  it("handles multi-hyphen names", () => {
    const result = parseIntentPath(
      "knowledge/intent-user-auth-flow-test-2026-12-01.md",
    );
    expect(result).toEqual({
      name: "user-auth-flow-test",
      date: "2026-12-01",
    });
  });

  it("returns empty strings for null input", () => {
    const result = parseIntentPath(null);
    expect(result).toEqual({ name: "", date: "" });
  });

  it("returns empty strings for invalid path", () => {
    const result = parseIntentPath("knowledge/spec-foo-2026-07-07.md");
    expect(result).toEqual({ name: "", date: "" });
  });
});

describe("template-engine resolveVariables", () => {
  const context = {
    name: "auth-flow",
    date: "2026-07-07",
    intent_kd: "knowledge/intent-auth-flow-2026-07-07.md",
    session_date: "2026-07-07",
    scope: "auth",
  };

  it("resolves all variable placeholders", () => {
    const template =
      "name={{name}} date={{date}} kd={{intent_kd}} sess={{session_date}} scope={{scope}}";
    const result = resolveVariables(template, context);
    expect(result).toBe(
      "name=auth-flow date=2026-07-07 kd=knowledge/intent-auth-flow-2026-07-07.md sess=2026-07-07 scope=auth",
    );
  });

  it("replaces unused variables with empty string", () => {
    const result = resolveVariables("hello {{name}}", {});
    expect(result).toBe("hello ");
  });

  it("resolves variables without glob interference", () => {
    const result = resolveVariables("{{name}}-{{date}}", context);
    expect(result).toBe("auth-flow-2026-07-07");
  });
});

describe("template-engine resolveGlobs", () => {
  it("returns template unchanged when no glob patterns", async () => {
    const result = await resolveGlobs("hello world");
    expect(result).toBe("hello world");
  });

  it("replaces unmatched glob pattern with empty string", async () => {
    const result = await resolveGlobs("{{glob:nonexistent/*.xyz}}");
    expect(result).toBe("");
  });
});

describe("template-engine buildContext", () => {
  it("extracts name and date from intent_kd", () => {
    const ctx = buildContext({
      intent_kd: "knowledge/intent-auth-flow-2026-07-07.md",
      session_date: "2026-07-07",
      scope: "auth",
    });
    expect(ctx.name).toBe("auth-flow");
    expect(ctx.date).toBe("2026-07-07");
  });

  it("uses provided name/date when intent_kd lacks them", () => {
    const ctx = buildContext({
      intent_kd: "",
      session_date: "2026-07-07",
    });
    expect(ctx.name).toBe("");
    expect(ctx.date).toBe("");
  });
});

describe("template-engine resolveTemplate", () => {
  it("resolves variables in a template", async () => {
    const template =
      "SCOPE: {{scope}}\nINTENT: {{intent_kd}}\nRETURN: knowledge/exploration-{{name}}-{{date}}.md";
    const result = await resolveTemplate(template, {
      intent_kd: "knowledge/intent-auth-flow-2026-07-07.md",
      session_date: "2026-07-07",
      scope: "auth",
    });
    expect(result).toContain("SCOPE: auth");
    expect(result).toContain("INTENT: knowledge/intent-auth-flow-2026-07-07.md");
    expect(result).toContain("RETURN: knowledge/exploration-auth-flow-2026-07-07.md");
  });
});

// ---------------------------------------------------------------------------
// Plugin: Structured dispatch routes correctly
// ---------------------------------------------------------------------------

describe("Structured dispatch routing", () => {
  it("accepts mode + intent_kd + session_date and routes to agent", async () => {
    const plugin = await dispatchGatePlugin({});
    const args = makeValidArgs();
    const ctx = { tool: "task", sessionID: "test", callID: "test-001" };
    const output = { args };
    await plugin["tool.execute.before"](ctx, output);
    // Uses property mutation — same reference as input args
    expect(output.args).toBe(args);
    expect(output.args.subagent_type).toBe("explorer");
    expect(output.args.prompt).toContain("DISPATCH TO: explorer");
    expect(output.args.prompt).toContain("SCOPE: auth");
  });

  it("accepts mode + intent_kd + session_date with scope", async () => {
    const plugin = await dispatchGatePlugin({});
    const args = makeValidArgs({ scope: "user auth" });
    const ctx = { tool: "task", sessionID: "test", callID: "test-001" };
    const output = { args };
    await plugin["tool.execute.before"](ctx, output);
    expect(output.args.prompt).toContain("SCOPE: user auth");
  });

  it("routes to correct agent for each mode", async () => {
    const plugin = await dispatchGatePlugin({});
    const routeTests = [
      { mode: "explore", expected: "explorer" },
      { mode: "investigate", expected: "analyzer" },
      { mode: "align", expected: "spec-weaver" },
      { mode: "decompose", expected: "pathfinder" },
      { mode: "swarm", expected: "artisan" },
      { mode: "verify", expected: "inspector" },
      { mode: "extract", expected: "scribe" },
      { mode: "evolve", expected: "habit-builder" },
      { mode: "commit", expected: "committer" },
      { mode: "checkpoint", expected: "committer" },
      { mode: "preflight", expected: "committer" },
      { mode: "report", expected: "overseer" },
    ];
    for (const { mode, expected } of routeTests) {
      const args = makeValidArgs({ mode });
      const ctx = { tool: "task", sessionID: "test", callID: "test-001" };
      const output = { args };
      await plugin["tool.execute.before"](ctx, output);
      expect(output.args.subagent_type).toBe(expected);
      // Verify reference identity — property mutation, not object replacement
      expect(output.args).toBe(args);
    }
  });

  it("handles report mode by routing to overseer with empty prompt", async () => {
    const plugin = await dispatchGatePlugin({});
    const args = makeValidArgs({ mode: "report" });
    const ctx = { tool: "task", sessionID: "test", callID: "test-001" };
    const output = { args };
    await plugin["tool.execute.before"](ctx, output);
    expect(output.args.subagent_type).toBe("overseer");
    expect(output.args.description).toBe(
      "Return to Overseer for report generation (no dispatch)",
    );
    expect(output.args.prompt).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Plugin: Free-text dispatch rejection via throw
// ---------------------------------------------------------------------------

describe("Free-text dispatch rejection", () => {
  it("throws when free-text dispatch with only prompt", async () => {
    const plugin = await dispatchGatePlugin({});
    const ctx = { tool: "task", sessionID: "test", callID: "test-001" };
    const output = { args: { prompt: "do something" } };
    await expect(
      plugin["tool.execute.before"](ctx, output),
    ).rejects.toThrow("Provide mode, intent_kd, and session_date fields");
  });

  it("throws when free-text dispatch with only description", async () => {
    const plugin = await dispatchGatePlugin({});
    const ctx = { tool: "task", sessionID: "test", callID: "test-001" };
    const output = { args: { description: "do something" } };
    await expect(
      plugin["tool.execute.before"](ctx, output),
    ).rejects.toThrow("Provide mode, intent_kd, and session_date fields");
  });

  it("throws when free-text dispatch with only subagent_type", async () => {
    const plugin = await dispatchGatePlugin({});
    const ctx = { tool: "task", sessionID: "test", callID: "test-001" };
    const output = { args: { subagent_type: "artisan" } };
    await expect(
      plugin["tool.execute.before"](ctx, output),
    ).rejects.toThrow("Provide mode, intent_kd, and session_date fields");
  });

  it("throws when free-text dispatch with prompt + description + subagent_type", async () => {
    const plugin = await dispatchGatePlugin({});
    const args = {
      prompt: "do something",
      description: "a task",
      subagent_type: "artisan",
    };
    const ctx = { tool: "task", sessionID: "test", callID: "test-001" };
    const output = { args };
    await expect(
      plugin["tool.execute.before"](ctx, output),
    ).rejects.toThrow("Provide mode, intent_kd, and session_date fields");
  });
});

// ---------------------------------------------------------------------------
// Plugin: Structured dispatch with prompt override
// ---------------------------------------------------------------------------

describe("Structured dispatch with prompt override", () => {
  it("generated prompt replaces provided prompt when both are given", async () => {
    const plugin = await dispatchGatePlugin({});
    const args = makeValidArgs({
      mode: "explore",
      prompt: "This free-text should be overridden",
      description: "some description",
      subagent_type: "some-agent",
    });
    const ctx = { tool: "task", sessionID: "test", callID: "test-001" };
    const output = { args };
    await plugin["tool.execute.before"](ctx, output);
    // The output should have the template-generated prompt, not the free-text one
    expect(output.args.prompt).toContain("DISPATCH TO: explorer");
    expect(output.args.prompt).not.toContain("free-text");
    expect(output.args.subagent_type).toBe("explorer");
    expect(output.args.description).toBeDefined();
    // Property mutation preserves reference identity
    expect(output.args).toBe(args);
  });
});

// ---------------------------------------------------------------------------
// Plugin: Structured fields cleaned from output
// ---------------------------------------------------------------------------

describe("Structured fields removed from output", () => {
  it("mode, intent_kd, session_date, scope are not in output.args", async () => {
    const plugin = await dispatchGatePlugin({});
    const args = makeValidArgs({ mode: "swarm" });
    const ctx = { tool: "task", sessionID: "test", callID: "test-001" };
    const output = { args };
    await plugin["tool.execute.before"](ctx, output);
    // Structured fields must be deleted after transformation
    expect(output.args.mode).toBeUndefined();
    expect(output.args.intent_kd).toBeUndefined();
    expect(output.args.session_date).toBeUndefined();
    expect(output.args.scope).toBeUndefined();
    // Only standard task tool fields remain
    expect(output.args.subagent_type).toBe("artisan");
    expect(output.args.prompt).toBeDefined();
    expect(output.args.description).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Plugin: Unknown mode throws with mode listing
// ---------------------------------------------------------------------------

describe("Unknown mode handling", () => {
  it("throws when structured fields have unknown mode", async () => {
    const plugin = await dispatchGatePlugin({});
    const args = makeValidArgs({ mode: "bogus" });
    const ctx = { tool: "task", sessionID: "test", callID: "test-001" };
    const output = { args };
    await expect(
      plugin["tool.execute.before"](ctx, output),
    ).rejects.toThrow(
      "Provide one of the following modes: explore, investigate, align, decompose, swarm, verify, extract, evolve, commit, report, checkpoint, preflight",
    );
  });

  it("does not throw for missing args", async () => {
    const plugin = await dispatchGatePlugin({});
    const ctx = { tool: "task", sessionID: "test", callID: "test-001" };
    // Null args — hook should return without modification
    await expect(
      plugin["tool.execute.before"](ctx, { args: null }),
    ).resolves.toBeUndefined();
  });

  it("does not throw for non-object args", async () => {
    const plugin = await dispatchGatePlugin({});
    const ctx = { tool: "task", sessionID: "test", callID: "test-001" };
    // String args — hook should return without modification
    await expect(
      plugin["tool.execute.before"](ctx, { args: "just a string" }),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Plugin: Non-task tool passes through
// ---------------------------------------------------------------------------

describe("Non-task tool passes through", () => {
  it("ignores non-task tools", async () => {
    const plugin = await dispatchGatePlugin({});
    const ctx = { tool: "read", sessionID: "test", callID: "test-001" };
    const output = { args: { prompt: "anything" } };
    await expect(
      plugin["tool.execute.before"](ctx, output),
    ).resolves.toBeUndefined();
    // output should be unchanged
    expect(output.args.prompt).toBe("anything");
  });
});

// ---------------------------------------------------------------------------
// Plugin: Empty args pass through
// ---------------------------------------------------------------------------

describe("Empty args pass through", () => {
  it("passes through when args has no dispatch fields", async () => {
    const plugin = await dispatchGatePlugin({});
    const args = { unrelated: true };
    const ctx = { tool: "task", sessionID: "test", callID: "test-001" };
    const output = { args };
    await plugin["tool.execute.before"](ctx, output);
    // output.args should be unchanged (no mode, no prompt/desc/subagent)
    expect(output.args).toEqual({ unrelated: true });
    // Pass-through logs PASSED, output unchanged
    expect(output.args.unrelated).toBe(true);
  });

  it("passes through when args is empty object", async () => {
    const plugin = await dispatchGatePlugin({});
    const args = {};
    const ctx = { tool: "task", sessionID: "test", callID: "test-001" };
    const output = { args };
    await plugin["tool.execute.before"](ctx, output);
    // output.args should be the same empty object
    expect(output.args).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Plugin: task_id and command passthrough
// ---------------------------------------------------------------------------

describe("Structured dispatch preserves passthrough fields", () => {
  it("preserves task_id in structured dispatch", async () => {
    const plugin = await dispatchGatePlugin({});
    const args = makeValidArgs({
      mode: "checkpoint",
      task_id: "prev-task-123",
    });
    const ctx = { tool: "task", sessionID: "test", callID: "test-001" };
    const output = { args };
    await plugin["tool.execute.before"](ctx, output);
    // task_id is not in the structured fields set, so delete doesn't touch it
    expect(output.args.task_id).toBe("prev-task-123");
    // Property mutation — same reference
    expect(output.args).toBe(args);
  });

  it("preserves command in structured dispatch", async () => {
    const plugin = await dispatchGatePlugin({});
    const args = makeValidArgs({
      mode: "preflight",
      command: "git status",
    });
    const ctx = { tool: "task", sessionID: "test", callID: "test-001" };
    const output = { args };
    await plugin["tool.execute.before"](ctx, output);
    // command is not in the structured fields set, so delete doesn't touch it
    expect(output.args.command).toBe("git status");
    expect(output.args).toBe(args);
  });
});

// ---------------------------------------------------------------------------
// Plugin: Uniform handling across callers
// ---------------------------------------------------------------------------

describe("Uniform handling across callers", () => {
  it("processes Artisan-style call same as Overseer-style call", async () => {
    const plugin = await dispatchGatePlugin({});
    // Artisan delegates to Committer with checkpoint mode
    const args = {
      mode: "checkpoint",
      intent_kd: "knowledge/intent-auth-flow-2026-07-07.md",
      session_date: "2026-07-07",
      scope: "feat: add login validation",
    };
    const ctx = { tool: "task", sessionID: "test", callID: "test-001" };
    const output = { args };
    await plugin["tool.execute.before"](ctx, output);
    expect(output.args.subagent_type).toBe("committer");
    expect(output.args.prompt).toContain("MODE: CHECKPOINT");
    expect(output.args.prompt).toContain("feat: add login validation");
  });

  it("applies same routing logic to all callers", async () => {
    const plugin = await dispatchGatePlugin({});
    // Two callers, same mode — same result
    const overseerCall = makeValidArgs({ mode: "swarm", scope: "auth" });
    const artisanCall = makeValidArgs({ mode: "swarm", scope: "auth" });
    const overseerCtx = { tool: "task", sessionID: "test", callID: "overseer-001" };
    const artisanCtx = { tool: "task", sessionID: "test", callID: "artisan-001" };
    const overseerOutput = { args: overseerCall };
    const artisanOutput = { args: artisanCall };
    await plugin["tool.execute.before"](overseerCtx, overseerOutput);
    await plugin["tool.execute.before"](artisanCtx, artisanOutput);
    expect(overseerOutput.args.subagent_type).toBe("artisan");
    expect(artisanOutput.args.subagent_type).toBe("artisan");
    expect(overseerOutput.args.prompt).toBe(artisanOutput.args.prompt);
  });
});

// ---------------------------------------------------------------------------
// Debug logging tests
// ---------------------------------------------------------------------------

describe("Debug logging", () => {
  beforeEach(() => {
    process.env.DISPATCH_GATE_DEBUG = "true";
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "appendFileSync").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.DISPATCH_GATE_DEBUG;
  });

  it("structured dispatch produces RECEIVED and TRANSFORMED logs", async () => {
    const plugin = await dispatchGatePlugin({});
    const ctx = { tool: "task", sessionID: "test", callID: "test-001" };
    const output = { args: makeValidArgs() };
    await plugin["tool.execute.before"](ctx, output);
    const logs = fs.appendFileSync.mock.calls.map((c) => c[1]);
    expect(logs.some((l) => l.includes("RECEIVED"))).toBe(true);
    expect(logs.some((l) => l.includes("TRANSFORMED"))).toBe(true);
    expect(logs.some((l) => l.includes("REJECTED"))).toBe(false);
    // Format check: [DISPATCH-GATE] ISO_TIMESTAMP | EVENT | details
    expect(logs[0]).toMatch(/^\[DISPATCH-GATE\] \d{4}-\d{2}-\d{2}T/);
    expect(logs[0]).toContain(" | RECEIVED | mode=explore");
    expect(logs[1]).toContain(" | TRANSFORMED | mode=explore target=explorer");
  });

  it("free-text dispatch produces RECEIVED and REJECTED logs", async () => {
    const plugin = await dispatchGatePlugin({});
    const ctx = { tool: "task", sessionID: "test", callID: "test-001" };
    const output = { args: { prompt: "do something" } };
    await expect(
      plugin["tool.execute.before"](ctx, output),
    ).rejects.toThrow();
    const logs = fs.appendFileSync.mock.calls.map((c) => c[1]);
    expect(logs.some((l) => l.includes("RECEIVED"))).toBe(true);
    expect(logs.some((l) => l.includes("REJECTED"))).toBe(true);
    expect(logs.some((l) => l.includes("TRANSFORMED"))).toBe(false);
    // REJECTED log comes before the throw
    expect(logs[logs.length - 1]).toContain(" | REJECTED | free-text dispatch blocked");
  });

  it("non-task tool call produces zero [DISPATCH-GATE] log lines", async () => {
    const plugin = await dispatchGatePlugin({});
    const ctx = { tool: "read", sessionID: "test", callID: "test-001" };
    const output = { args: { prompt: "anything" } };
    await plugin["tool.execute.before"](ctx, output);
    // No log writes for non-task tools
    expect(fs.appendFileSync.mock.calls.length).toBe(0);
  });

  it("unknown mode produces REJECTED log with mode name", async () => {
    const plugin = await dispatchGatePlugin({});
    const ctx = { tool: "task", sessionID: "test", callID: "test-001" };
    const output = { args: makeValidArgs({ mode: "bogus" }) };
    await expect(
      plugin["tool.execute.before"](ctx, output),
    ).rejects.toThrow();
    const logs = fs.appendFileSync.mock.calls.map((c) => c[1]);
    expect(logs.some((l) => l.includes("REJECTED | unknown mode"))).toBe(true);
    expect(logs.some((l) => l.includes('"bogus"'))).toBe(true);
  });

  it("empty args pass-through produces PASSED log", async () => {
    const plugin = await dispatchGatePlugin({});
    const ctx = { tool: "task", sessionID: "test", callID: "test-001" };
    const output = { args: { unrelated: true } };
    await plugin["tool.execute.before"](ctx, output);
    const logs = fs.appendFileSync.mock.calls.map((c) => c[1]);
    expect(logs.some((l) => l.includes("PASSED | no dispatch fields"))).toBe(true);
  });

  it("log format matches [DISPATCH-GATE] ISO_TIMESTAMP | EVENT | details pattern", async () => {
    const plugin = await dispatchGatePlugin({});
    const ctx = { tool: "task", sessionID: "test", callID: "test-001" };
    const output = { args: makeValidArgs() };
    await plugin["tool.execute.before"](ctx, output);
    const logs = fs.appendFileSync.mock.calls.map((c) => c[1]);
    for (const log of logs) {
      expect(log).toMatch(
        /^\[DISPATCH-GATE\] \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \| (RECEIVED|TRANSFORMED|REJECTED|PASSED|ERROR) \| /,
      );
    }
  });

  it("non-task tool pass-through produces zero DISPATCH-GATE logs for any non-task tool", async () => {
    const plugin = await dispatchGatePlugin({});
    // Test multiple non-task tools
    for (const tool of ["read", "bash", "glob", "grep", "write"]) {
      const ctx = { tool, sessionID: "test", callID: "test-001" };
      const output = { args: { prompt: "anything" } };
      fs.appendFileSync.mockClear();
      await plugin["tool.execute.before"](ctx, output);
      expect(fs.appendFileSync.mock.calls.length).toBe(0);
    }
  });

  it("writes to dispatch-gate.log file path", async () => {
    const plugin = await dispatchGatePlugin({});
    const ctx = { tool: "task", sessionID: "test", callID: "test-001" };
    const output = { args: makeValidArgs() };
    await plugin["tool.execute.before"](ctx, output);
    const calls = fs.appendFileSync.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    // All writes go to the same log file
    for (const call of calls) {
      expect(call[0]).toMatch(/dispatch-gate\.log$/);
    }
  });

  it("zero console.log calls remain in the plugin", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const plugin = await dispatchGatePlugin({});
    const ctx = { tool: "task", sessionID: "test", callID: "test-001" };
    const output = { args: makeValidArgs() };
    await plugin["tool.execute.before"](ctx, output);
    expect(spy.mock.calls.length).toBe(0);
  });

  it("does NOT write log file when DISPATCH_GATE_DEBUG is not set", async () => {
    delete process.env.DISPATCH_GATE_DEBUG;
    const plugin = await dispatchGatePlugin({});
    const ctx = { tool: "task", sessionID: "test", callID: "test-001" };
    const output = { args: makeValidArgs() };
    await plugin["tool.execute.before"](ctx, output);
    expect(fs.appendFileSync.mock.calls.length).toBe(0);
    // Clean up — restore so subsequent tests aren't affected
    process.env.DISPATCH_GATE_DEBUG = "true";
  });

  it("writes log file when DISPATCH_GATE_DEBUG=true", async () => {
    process.env.DISPATCH_GATE_DEBUG = "true";
    const plugin = await dispatchGatePlugin({});
    const ctx = { tool: "task", sessionID: "test", callID: "test-001" };
    const output = { args: makeValidArgs() };
    await plugin["tool.execute.before"](ctx, output);
    expect(fs.appendFileSync.mock.calls.length).toBeGreaterThan(0);
  });
});
