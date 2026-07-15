// tests/plugins/protocol-gate/index.test.js
// Tests for protocol-gate plugin — Overseer protocol enforcement.
//
// Three-phase lifecycle:
//   PROTOCOL_NOT_LOADED → PROTOCOL_LOADED → INTENT_WRITTEN
// Non-Overseer: fail-open. Unknown session: fail-open.
//
// Hooks: chat.params (identity), tool.execute.before (gating).

import { describe, it, expect, beforeEach } from "vitest";
import protocolGatePlugin, {
  PROTOCOL_NOT_LOADED,
  PROTOCOL_LOADED,
  INTENT_WRITTEN,
  LIFECYCLE_KEYWORDS,
  containsLifecycleKeywords,
  isIntentKD,
  sessionAgentMap,
  sessionPhaseMap,
  ProtocolGateError,
  ERRORS,
} from "../../../plugins/protocol-gate/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function init(plugin, sessionID, agent) {
  return plugin["chat.params"]({ sessionID, agent }, {});
}

async function exec(plugin, ctx, output) {
  return plugin["tool.execute.before"](ctx, output);
}

function ctx(tool, sessionID) {
  return { tool, sessionID, callID: "c1" };
}

function out(args = {}) {
  return { args };
}

function writeOut(filePath, content = "...") {
  return { args: { filePath, content } };
}

function todoOut(items) {
  return { args: { items } };
}

// ---------------------------------------------------------------------------
// Helper function tests
// ---------------------------------------------------------------------------

describe("containsLifecycleKeywords", () => {
  it("returns true for items containing INTENT", () => {
    expect(containsLifecycleKeywords([{ content: "Create INTENT KD" }])).toBe(true);
  });

  it("returns true case-insensitively", () => {
    expect(containsLifecycleKeywords([{ content: "swarm" }])).toBe(true);
  });

  it("returns true for string items", () => {
    expect(containsLifecycleKeywords(["EXPLORE", "COMMIT"])).toBe(true);
  });

  it("returns false for empty array", () => {
    expect(containsLifecycleKeywords([])).toBe(false);
  });

  it("returns false for non-array", () => {
    expect(containsLifecycleKeywords(null)).toBe(false);
    expect(containsLifecycleKeywords(undefined)).toBe(false);
  });

  it("returns false for non-lifecycle content", () => {
    expect(containsLifecycleKeywords([{ content: "Buy groceries" }])).toBe(false);
  });
});

describe("isIntentKD", () => {
  it("matches knowledge/intent-*.md", () => {
    expect(isIntentKD("knowledge/intent-auth-2026-07-15.md")).toBe(true);
    expect(isIntentKD("./knowledge/intent-test.md")).toBe(true);
  });

  it("rejects non-intent files", () => {
    expect(isIntentKD("knowledge/spec-foo.md")).toBe(false);
    expect(isIntentKD("plugins/index.js")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// chat.params — AC016: agent identity tracking
// ---------------------------------------------------------------------------

describe("AC016: chat.params hook", () => {
  it("captures sessionID → agent mapping", async () => {
    const plugin = await protocolGatePlugin();
    await init(plugin, "s1", "overseer");
    expect(sessionAgentMap.get("s1")).toBe("overseer");
  });

  it("initializes PROTOCOL_NOT_LOADED for overseer sessions", async () => {
    const plugin = await protocolGatePlugin();
    await init(plugin, "s2", "overseer");
    expect(sessionPhaseMap.get("s2")).toBe(PROTOCOL_NOT_LOADED);
  });

  it("does not initialize phase for non-overseer", async () => {
    const plugin = await protocolGatePlugin();
    await init(plugin, "s3", "artisan");
    expect(sessionPhaseMap.has("s3")).toBe(false);
  });

  it("cleans up stale phase when agent changes to non-overseer", async () => {
    const plugin = await protocolGatePlugin();
    await init(plugin, "s4", "overseer");
    expect(sessionPhaseMap.has("s4")).toBe(true);
    await init(plugin, "s4", "artisan");
    expect(sessionPhaseMap.has("s4")).toBe(false);
  });

  it("does nothing when sessionID is missing", async () => {
    const plugin = await protocolGatePlugin();
    await init(plugin, undefined, "overseer");
    expect(sessionAgentMap.has(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC018: Plugin does NOT hook task
// ---------------------------------------------------------------------------

describe("AC018: Zero tool overlap with delegation-gate", () => {
  it("plugin has no task-specific handling — task passes through in Phase 0", async () => {
    const plugin = await protocolGatePlugin();
    await init(plugin, "task-test", "overseer");
    const output = out({ description: "delegate" });
    await exec(plugin, ctx("task", "task-test"), output);
    // task is blocked in Phase 0 (treated as non-todowrite tool)
    expect(output.error).toBeDefined();
    expect(output.error.code).toBe("BLOCKED_NOT_LOADED");
  });
});

// ---------------------------------------------------------------------------
// AC019–AC021: Phase 0 blocks read/glob/write
// ---------------------------------------------------------------------------

describe("AC019–AC021: Phase 0 blocks read/glob/write", () => {
  it("AC019: blocks read", async () => {
    const plugin = await protocolGatePlugin();
    await init(plugin, "p0r", "overseer");
    const output = out({ filePath: "some-file.js" });
    await exec(plugin, ctx("read", "p0r"), output);
    expect(output.error).toBeDefined();
    expect(output.error.code).toBe("BLOCKED_NOT_LOADED");
  });

  it("AC020: blocks glob", async () => {
    const plugin = await protocolGatePlugin();
    await init(plugin, "p0g", "overseer");
    const output = out({ pattern: "**/*.js" });
    await exec(plugin, ctx("glob", "p0g"), output);
    expect(output.error).toBeDefined();
    expect(output.error.code).toBe("BLOCKED_NOT_LOADED");
  });

  it("AC021: blocks write", async () => {
    const plugin = await protocolGatePlugin();
    await init(plugin, "p0w", "overseer");
    const output = writeOut("some-file.md");
    await exec(plugin, ctx("write", "p0w"), output);
    expect(output.error).toBeDefined();
    expect(output.error.code).toBe("BLOCKED_NOT_LOADED");
  });
});

// ---------------------------------------------------------------------------
// AC022: todowrite with lifecycle keywords → PROTOCOL_LOADED
// ---------------------------------------------------------------------------

describe("AC022: todowrite with lifecycle keywords", () => {
  it("advances to PROTOCOL_LOADED with INTENT keyword", async () => {
    const plugin = await protocolGatePlugin();
    await init(plugin, "p0k1", "overseer");
    const output = todoOut([{ content: "INTENT phase", status: "pending" }]);
    await exec(plugin, ctx("todowrite", "p0k1"), output);
    expect(sessionPhaseMap.get("p0k1")).toBe(PROTOCOL_LOADED);
  });

  it("advances with all 12 keywords", async () => {
    const plugin = await protocolGatePlugin();
    await init(plugin, "p0k2", "overseer");
    const output = todoOut(
      LIFECYCLE_KEYWORDS.map((kw) => ({ content: `${kw} phase` })),
    );
    await exec(plugin, ctx("todowrite", "p0k2"), output);
    expect(sessionPhaseMap.get("p0k2")).toBe(PROTOCOL_LOADED);
  });
});

// ---------------------------------------------------------------------------
// AC023: todowrite without lifecycle keywords → BLOCKED_NO_LIFECYCLE
// ---------------------------------------------------------------------------

describe("AC023: todowrite without lifecycle keywords", () => {
  it("blocks non-lifecycle todowrite", async () => {
    const plugin = await protocolGatePlugin();
    await init(plugin, "p0k3", "overseer");
    const output = todoOut([{ content: "Buy groceries" }]);
    await exec(plugin, ctx("todowrite", "p0k3"), output);
    expect(output.error).toBeDefined();
    expect(output.error.code).toBe("BLOCKED_NO_LIFECYCLE");
  });

  it("blocks empty items", async () => {
    const plugin = await protocolGatePlugin();
    await init(plugin, "p0k4", "overseer");
    const output = todoOut([]);
    await exec(plugin, ctx("todowrite", "p0k4"), output);
    expect(output.error).toBeDefined();
    expect(output.error.code).toBe("BLOCKED_NO_LIFECYCLE");
  });
});

// ---------------------------------------------------------------------------
// AC024–AC025: PROTOCOL_LOADED — intent KD access
// ---------------------------------------------------------------------------

describe("AC024: read intent KD in PROTOCOL_LOADED", () => {
  it("allows read for knowledge/intent-*.md", async () => {
    const plugin = await protocolGatePlugin();
    await init(plugin, "p1r1", "overseer");
    sessionPhaseMap.set("p1r1", PROTOCOL_LOADED);
    const output = out({ filePath: "knowledge/intent-auth-2026-07-15.md" });
    await exec(plugin, ctx("read", "p1r1"), output);
    expect(output.error).toBeUndefined();
  });
});

describe("AC025: write intent KD in PROTOCOL_LOADED advances to INTENT_WRITTEN", () => {
  it("allows write and advances phase", async () => {
    const plugin = await protocolGatePlugin();
    await init(plugin, "p1w1", "overseer");
    sessionPhaseMap.set("p1w1", PROTOCOL_LOADED);
    const output = writeOut("knowledge/intent-auth-2026-07-15.md");
    await exec(plugin, ctx("write", "p1w1"), output);
    expect(output.error).toBeUndefined();
    expect(sessionPhaseMap.get("p1w1")).toBe(INTENT_WRITTEN);
  });
});

// ---------------------------------------------------------------------------
// AC026: PROTOCOL_LOADED — blocks non-intent read/write
// ---------------------------------------------------------------------------

describe("AC026: blocks non-intent file access in PROTOCOL_LOADED", () => {
  it("blocks read for non-intent file", async () => {
    const plugin = await protocolGatePlugin();
    await init(plugin, "p1b1", "overseer");
    sessionPhaseMap.set("p1b1", PROTOCOL_LOADED);
    const output = out({ filePath: "agents/overseer.md" });
    await exec(plugin, ctx("read", "p1b1"), output);
    expect(output.error).toBeDefined();
    expect(output.error.code).toBe("BLOCKED_NO_INTENT");
  });

  it("blocks write for non-intent file", async () => {
    const plugin = await protocolGatePlugin();
    await init(plugin, "p1b2", "overseer");
    sessionPhaseMap.set("p1b2", PROTOCOL_LOADED);
    const output = writeOut("plugins/index.js");
    await exec(plugin, ctx("write", "p1b2"), output);
    expect(output.error).toBeDefined();
    expect(output.error.code).toBe("BLOCKED_NO_INTENT");
  });

  it("blocks glob in PROTOCOL_LOADED", async () => {
    const plugin = await protocolGatePlugin();
    await init(plugin, "p1b3", "overseer");
    sessionPhaseMap.set("p1b3", PROTOCOL_LOADED);
    const output = out({ pattern: "**/*.js" });
    await exec(plugin, ctx("glob", "p1b3"), output);
    expect(output.error).toBeDefined();
    expect(output.error.code).toBe("BLOCKED_NO_INTENT");
  });
});

// ---------------------------------------------------------------------------
// AC027: INTENT_WRITTEN — all tools allowed
// ---------------------------------------------------------------------------

describe("AC027: INTENT_WRITTEN — all tools allowed", () => {
  it("allows read", async () => {
    const plugin = await protocolGatePlugin();
    await init(plugin, "p2a", "overseer");
    sessionPhaseMap.set("p2a", INTENT_WRITTEN);
    const output = out({ filePath: "any-file.js" });
    await exec(plugin, ctx("read", "p2a"), output);
    expect(output.error).toBeUndefined();
  });

  it("allows write", async () => {
    const plugin = await protocolGatePlugin();
    await init(plugin, "p2b", "overseer");
    sessionPhaseMap.set("p2b", INTENT_WRITTEN);
    const output = writeOut("any-file.md");
    await exec(plugin, ctx("write", "p2b"), output);
    expect(output.error).toBeUndefined();
  });

  it("allows glob", async () => {
    const plugin = await protocolGatePlugin();
    await init(plugin, "p2c", "overseer");
    sessionPhaseMap.set("p2c", INTENT_WRITTEN);
    const output = out({ pattern: "**/*.js" });
    await exec(plugin, ctx("glob", "p2c"), output);
    expect(output.error).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC028: Non-Overseer — fail-open
// ---------------------------------------------------------------------------

describe("AC028: Non-Overseer fail-open", () => {
  it("allows read for artisan", async () => {
    const plugin = await protocolGatePlugin();
    await init(plugin, "no1", "artisan");
    const output = out({ filePath: "any.js" });
    await exec(plugin, ctx("read", "no1"), output);
    expect(output.error).toBeUndefined();
  });

  it("allows write for committer", async () => {
    const plugin = await protocolGatePlugin();
    await init(plugin, "no2", "committer");
    const output = writeOut("any.md");
    await exec(plugin, ctx("write", "no2"), output);
    expect(output.error).toBeUndefined();
  });

  it("allows glob for artisan", async () => {
    const plugin = await protocolGatePlugin();
    await init(plugin, "no3", "artisan");
    const output = out({ pattern: "**/*" });
    await exec(plugin, ctx("glob", "no3"), output);
    expect(output.error).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC029: Unknown session — fail-open
// ---------------------------------------------------------------------------

describe("AC029: Unknown session fail-open", () => {
  it("passes through for unknown session", async () => {
    const plugin = await protocolGatePlugin();
    const output = out({ filePath: "any.js" });
    await exec(plugin, ctx("read", "unknown"), output);
    expect(output.error).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC030: todowrite always allowed in any phase
// ---------------------------------------------------------------------------

describe("AC030: todowrite allowed in any phase", () => {
  it("allowed in PROTOCOL_LOADED", async () => {
    const plugin = await protocolGatePlugin();
    await init(plugin, "tw1", "overseer");
    sessionPhaseMap.set("tw1", PROTOCOL_LOADED);
    const output = todoOut([{ content: "Progress update" }]);
    await exec(plugin, ctx("todowrite", "tw1"), output);
    expect(output.error).toBeUndefined();
  });

  it("allowed in INTENT_WRITTEN", async () => {
    const plugin = await protocolGatePlugin();
    await init(plugin, "tw2", "overseer");
    sessionPhaseMap.set("tw2", INTENT_WRITTEN);
    const output = todoOut([{ content: "Progress update" }]);
    await exec(plugin, ctx("todowrite", "tw2"), output);
    expect(output.error).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Full lifecycle flow
// ---------------------------------------------------------------------------

describe("Full lifecycle: PROTOCOL_NOT_LOADED → PROTOCOL_LOADED → INTENT_WRITTEN", () => {
  it("completes full lifecycle", async () => {
    const plugin = await protocolGatePlugin();
    await init(plugin, "flow", "overseer");

    // Phase 0: read blocked
    const out0 = out({ filePath: "any.js" });
    await exec(plugin, ctx("read", "flow"), out0);
    expect(out0.error.code).toBe("BLOCKED_NOT_LOADED");

    // Phase 0: todowrite without keywords blocked
    const outTodo = todoOut([{ content: "Buy milk" }]);
    await exec(plugin, ctx("todowrite", "flow"), outTodo);
    expect(outTodo.error.code).toBe("BLOCKED_NO_LIFECYCLE");

    // Phase 0: todowrite with keywords → PROTOCOL_LOADED
    const outTodoOk = todoOut([{ content: "INTENT complete" }]);
    await exec(plugin, ctx("todowrite", "flow"), outTodoOk);
    expect(sessionPhaseMap.get("flow")).toBe(PROTOCOL_LOADED);

    // Phase 1: read non-intent blocked
    const out1 = out({ filePath: "any.js" });
    await exec(plugin, ctx("read", "flow"), out1);
    expect(out1.error.code).toBe("BLOCKED_NO_INTENT");

    // Phase 1: read intent allowed
    const outReadIntent = out({ filePath: "knowledge/intent-x.md" });
    await exec(plugin, ctx("read", "flow"), outReadIntent);
    expect(outReadIntent.error).toBeUndefined();

    // Phase 1: write intent → INTENT_WRITTEN
    const outWriteIntent = writeOut("knowledge/intent-x.md");
    await exec(plugin, ctx("write", "flow"), outWriteIntent);
    expect(sessionPhaseMap.get("flow")).toBe(INTENT_WRITTEN);

    // Phase 2: all tools allowed
    const out2 = out({ filePath: "any.js" });
    await exec(plugin, ctx("read", "flow"), out2);
    expect(out2.error).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Concurrent sessions
// ---------------------------------------------------------------------------

describe("Concurrent sessions tracked independently", () => {
  it("two overseer sessions advance independently", async () => {
    const plugin = await protocolGatePlugin();
    await init(plugin, "ov-a", "overseer");
    await init(plugin, "ov-b", "overseer");

    // Advance ov-a to INTENT_WRITTEN
    await exec(plugin, ctx("todowrite", "ov-a"), todoOut([{ content: "INTENT done" }]));
    await exec(plugin, ctx("write", "ov-a"), writeOut("knowledge/intent-a.md"));

    // ov-a: INTENT_WRITTEN — read allowed
    const out1 = out({ filePath: "any.js" });
    await exec(plugin, ctx("read", "ov-a"), out1);
    expect(out1.error).toBeUndefined();

    // ov-b: still PROTOCOL_NOT_LOADED — read blocked
    const out2 = out({ filePath: "any.js" });
    await exec(plugin, ctx("read", "ov-b"), out2);
    expect(out2.error).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Exports verification
// ---------------------------------------------------------------------------

describe("Exports", () => {
  it("exports ProtocolGateError class", () => {
    expect(typeof ProtocolGateError).toBe("function");
    const err = new ProtocolGateError({ code: "TEST", message: "msg", guidance: "g" });
    expect(err.name).toBe("ProtocolGateError");
  });

  it("exports ERRORS frozen object", () => {
    expect(typeof ERRORS).toBe("object");
    expect(Object.isFrozen(ERRORS)).toBe(true);
    expect(ERRORS.BLOCKED_NOT_LOADED).toBeDefined();
    expect(ERRORS.BLOCKED_NO_LIFECYCLE).toBeDefined();
    expect(ERRORS.BLOCKED_NO_INTENT).toBeDefined();
  });

  it("exports phase constants", () => {
    expect(PROTOCOL_NOT_LOADED).toBe(0);
    expect(PROTOCOL_LOADED).toBe(1);
    expect(INTENT_WRITTEN).toBe(2);
  });

  it("exports LIFECYCLE_KEYWORDS with 12 entries", () => {
    expect(Array.isArray(LIFECYCLE_KEYWORDS)).toBe(true);
    expect(LIFECYCLE_KEYWORDS).toHaveLength(12);
  });

  it("exports session maps", () => {
    expect(sessionAgentMap).toBeInstanceOf(Map);
    expect(sessionPhaseMap).toBeInstanceOf(Map);
  });
});
