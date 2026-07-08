// tests/plugins/dispatch-gate/index.test.js
// Tests for dispatch-gate plugin — schema-level enforcement.
//
// Two hooks under test:
//   1. tool.definition — extends the task tool schema so structured
//      fields (mode, intent_kd, session_date) are REQUIRED and
//      prompt/description/subagent_type are optional. Schema validation
//      rejects calls missing mode/intent_kd/session_date BEFORE the
//      execute hook runs.
//   2. tool.execute.before — resolves the template for the given mode
//      and injects standard task tool fields. Never throws — schema
//      handles all rejection.
//
// ALL callers (Overseer, Artisan, any agent) use the same structured
// dispatch format: { mode, intent_kd, session_date, scope? }
// The plugin resolves templates and routes to the correct target agent.

import { describe, it, expect } from "vitest";
import dispatchGatePlugin from "../../../plugins/dispatch-gate/index.js";
import {
  resolveTemplate,
  parseIntentPath,
  resolveVariables,
  resolveGlobs,
  buildContext,
} from "../../../plugins/dispatch-gate/template-engine.js";

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

/** Invoke the tool.definition hook and return the modified output. */
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
    parameters: existingSchema || { ...defaultSchema },
  };
  plugin["tool.definition"](input, output);
  return output;
}

// ---------------------------------------------------------------------------
// Tool Definition Hook Tests
// ---------------------------------------------------------------------------

describe("tool.definition hook", () => {
  it("adds mode, intent_kd, session_date, scope to task schema", async () => {
    const plugin = await dispatchGatePlugin({});
    const output = callToolDefinition(plugin, "task");
    expect(output.parameters.properties.mode).toBeDefined();
    expect(output.parameters.properties.mode.type).toBe("string");
    expect(output.parameters.properties.intent_kd).toBeDefined();
    expect(output.parameters.properties.intent_kd.type).toBe("string");
    expect(output.parameters.properties.session_date).toBeDefined();
    expect(output.parameters.properties.session_date.type).toBe("string");
    expect(output.parameters.properties.scope).toBeDefined();
    expect(output.parameters.properties.scope.type).toBe("string");
  });

  it("makes mode, intent_kd, session_date required", async () => {
    const plugin = await dispatchGatePlugin({});
    const output = callToolDefinition(plugin, "task");
    expect(output.parameters.required).toContain("mode");
    expect(output.parameters.required).toContain("intent_kd");
    expect(output.parameters.required).toContain("session_date");
  });

  it("removes prompt, description, subagent_type from required", async () => {
    const plugin = await dispatchGatePlugin({});
    const output = callToolDefinition(plugin, "task");
    expect(output.parameters.required).not.toContain("prompt");
    expect(output.parameters.required).not.toContain("description");
    expect(output.parameters.required).not.toContain("subagent_type");
  });

  it("does not modify non-task tools", async () => {
    const plugin = await dispatchGatePlugin({});
    const output = callToolDefinition(plugin, "read");
    // Should be identical to the default schema
    expect(output.parameters.properties.prompt).toBeDefined();
    expect(output.parameters.required).toContain("prompt");
    expect(output.parameters.required).toContain("description");
    expect(output.parameters.required).toContain("subagent_type");
    // Should NOT have added structured fields
    expect(output.parameters.properties.mode).toBeUndefined();
    // Should NOT have pushed structured fields to required
    expect(output.parameters.required).not.toContain("mode");
  });

  it("handles schema with no properties gracefully", async () => {
    const plugin = await dispatchGatePlugin({});
    const input = { toolID: "task" };
    const output = { description: "bare", parameters: null };
    // Should not throw when parameters is null
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
    // Should have added structured fields
    expect(output.parameters.properties.mode).toBeDefined();
    // Should not have thrown about missing required array
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
// Plugin: Unknown mode does not throw
// ---------------------------------------------------------------------------

describe("Unknown mode handling", () => {
  it("returns without modification for unknown mode", async () => {
    const plugin = await dispatchGatePlugin({});
    const args = makeValidArgs({ mode: "bogus" });
    const ctx = { tool: "task", sessionID: "test", callID: "test-001" };
    const output = { args };
    // Should NOT throw — schema guarantees mode exists, but mode values
    // are unvalidated. The hook just returns without modification.
    await expect(
      plugin["tool.execute.before"](ctx, output),
    ).resolves.toBeUndefined();
    // output.args should remain unchanged (no template was found)
    expect(output.args).toEqual(args);
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
// Plugin: Generated prompt overrides caller-provided prompt
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
