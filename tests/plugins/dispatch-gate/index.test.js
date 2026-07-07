// tests/plugins/dispatch-gate/index.test.js
// Tests for dispatch-gate plugin — uniform template generation.
// ALL callers (Overseer, Artisan, any agent) use the same structured
// dispatch format: { mode, intent_kd, session_date, scope? }
// Plugin resolves templates and routes to the correct target agent.

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

function callHook(plugin, args, tool = "task") {
  const ctx = { tool, sessionID: "test", callID: "test-001" };
  const output = { args };
  return plugin["tool.execute.before"](ctx, output);
}

async function assertRoutesTo(plugin, args, expectedAgent) {
  const ctx = { tool: "task", sessionID: "test", callID: "test-001" };
  const output = { args };
  await plugin["tool.execute.before"](ctx, output);
  expect(output.args.subagent_type).toBe(expectedAgent);
  expect(typeof output.args.prompt).toBe("string");
  expect(output.args.prompt.length).toBeGreaterThan(0);
  expect(output.args.description).toBeDefined();
}

async function assertRejected(plugin, args, expectedText) {
  const ctx = { tool: "task", sessionID: "test", callID: "test-001" };
  const output = { args };
  try {
    await plugin["tool.execute.before"](ctx, output);
    // Should not reach here
    expect(true).toBe(false);
  } catch (err) {
    expect(err.message).toContain(expectedText);
  }
}

// ---------------------------------------------------------------------------
// Template Engine Tests
// ---------------------------------------------------------------------------

describe("template-engine parseIntentPath", () => {
  it("extracts name and date from valid intent KD path", () => {
    const result = parseIntentPath(
      "knowledge/intent-auth-flow-2026-07-07.md"
    );
    expect(result).toEqual({ name: "auth-flow", date: "2026-07-07" });
  });

  it("handles multi-hyphen names", () => {
    const result = parseIntentPath(
      "knowledge/intent-user-auth-flow-test-2026-12-01.md"
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
      "name=auth-flow date=2026-07-07 kd=knowledge/intent-auth-flow-2026-07-07.md sess=2026-07-07 scope=auth"
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
// Plugin: Structured dispatch accepted
// ---------------------------------------------------------------------------

describe("Structured dispatch accepted", () => {
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
    ];
    for (const { mode, expected } of routeTests) {
      const args = makeValidArgs({ mode });
      const ctx = { tool: "task", sessionID: "test", callID: "test-001" };
      const output = { args };
      await plugin["tool.execute.before"](ctx, output);
      expect(output.args.subagent_type).toBe(expected);
    }
  });

  it("skips template generation for report mode", async () => {
    const plugin = await dispatchGatePlugin({});
    const args = makeValidArgs({ mode: "report" });
    const ctx = { tool: "task", sessionID: "test", callID: "test-001" };
    const output = { args };
    await plugin["tool.execute.before"](ctx, output);
    // Should not modify output for report mode
    expect(output.args).toBe(args);
  });
});

// ---------------------------------------------------------------------------
// Plugin: Missing fields rejected
// ---------------------------------------------------------------------------

describe("Missing fields rejected", () => {
  it("rejects missing mode", async () => {
    const plugin = await dispatchGatePlugin({});
    await assertRejected(plugin, { intent_kd: "x", session_date: "y" }, "DISPATCH REJECTED");
  });

  it("rejects missing intent_kd", async () => {
    const plugin = await dispatchGatePlugin({});
    await assertRejected(plugin, { mode: "explore", session_date: "y" }, "DISPATCH REJECTED");
  });

  it("rejects missing session_date", async () => {
    const plugin = await dispatchGatePlugin({});
    await assertRejected(plugin, { mode: "explore", intent_kd: "x" }, "DISPATCH REJECTED");
  });

  it("rejects empty args object", async () => {
    const plugin = await dispatchGatePlugin({});
    await assertRejected(plugin, {}, "DISPATCH REJECTED");
  });

  it("rejects non-object args", async () => {
    const plugin = await dispatchGatePlugin({});
    await assertRejected(plugin, "just a string", "DISPATCH REJECTED");
  });

  it("rejects null args", async () => {
    const plugin = await dispatchGatePlugin({});
    await assertRejected(plugin, null, "DISPATCH REJECTED");
  });

  it("rejects empty prompt string", async () => {
    const plugin = await dispatchGatePlugin({});
    await assertRejected(plugin, { prompt: "" }, "DISPATCH REJECTED");
  });
});

// ---------------------------------------------------------------------------
// Plugin: Error message uses positive framing
// ---------------------------------------------------------------------------

describe("Error message uses positive framing", () => {
  it("tells what fields to provide, not what to avoid", async () => {
    const plugin = await dispatchGatePlugin({});
    try {
      await callHook(plugin, { mode: "explore" });
      expect(true).toBe(false);
    } catch (err) {
      const msg = err.message;
      expect(msg).toContain("Provide the required fields");
      expect(msg).toContain("mode");
      expect(msg).toContain("intent_kd");
      expect(msg).toContain("session_date");
      // No negative framing
      expect(msg).not.toMatch(/don't|do not|never|avoid|not include/i);
    }
  });

  it("does not contain prohibitive language", async () => {
    const plugin = await dispatchGatePlugin({});
    try {
      await callHook(plugin, { mode: "explore" });
      expect(true).toBe(false);
    } catch (err) {
      expect(err.message).not.toMatch(/don't|do not|never|avoid|not include/i);
    }
  });
});

// ---------------------------------------------------------------------------
// Plugin: Uniform validation across callers
// ---------------------------------------------------------------------------

describe("Uniform validation across callers", () => {
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

  it("rejects both caller styles equally when fields missing", async () => {
    const plugin = await dispatchGatePlugin({});
    // Same rejection for any caller missing fields
    const badArgs = { description: "checkpoint", subagent_type: "committer", prompt: "Stage changes" };
    const ctx = { tool: "task", sessionID: "test", callID: "test-001" };
    const output = { args: badArgs };
    try {
      await plugin["tool.execute.before"](ctx, output);
      expect(true).toBe(false);
    } catch (err) {
      expect(err.message).toContain("DISPATCH REJECTED");
    }
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
// Plugin: Non-task tool passes through
// ---------------------------------------------------------------------------

describe("Non-task tool passes through", () => {
  it("ignores non-task tools", async () => {
    const plugin = await dispatchGatePlugin({});
    const ctx = { tool: "read", sessionID: "test", callID: "test-001" };
    const output = { args: { prompt: "anything" } };
    await expect(
      plugin["tool.execute.before"](ctx, output)
    ).resolves.toBeUndefined();
    // output should be unchanged
    expect(output.args.prompt).toBe("anything");
  });
});

// ---------------------------------------------------------------------------
// Plugin: Generated prompt structure
// ---------------------------------------------------------------------------

describe("Generated prompt structure", () => {
  it("explore mode produces dispatch with DISPATCH TO: explorer", async () => {
    const plugin = await dispatchGatePlugin({});
    await assertRoutesTo(plugin, makeValidArgs({ mode: "explore" }), "explorer");
  });

  it("verify mode produces dispatch with DISPATCH TO: inspector", async () => {
    const plugin = await dispatchGatePlugin({});
    await assertRoutesTo(plugin, makeValidArgs({ mode: "verify" }), "inspector");
  });

  it("unknown mode is rejected with guidance", async () => {
    const plugin = await dispatchGatePlugin({});
    await assertRejected(
      plugin,
      makeValidArgs({ mode: "bogus" }),
      "Unknown mode"
    );
  });
});
