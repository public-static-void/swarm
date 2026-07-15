// tests/plugins/protocol-gate/index.test.js
// Tests for protocol-gate plugin — two-step structural guard rail.
//
// Phase 0 (Pre-todowrite): Block ALL tools except todowrite with lifecycle keywords.
// Phase 1 (Pre-intent):    Block all except todowrite + read/write for intent KDs.
// Phase 2 (Post-intent):   Allow all tools.
// Non-Overseer:            Fail-open (no blocking).

import { describe, it, expect, beforeEach } from "vitest";
import protocolGatePlugin, {
  PHASE_0_PRE_TODOWRITE,
  PHASE_1_PRE_INTENT,
  PHASE_2_POST_INTENT,
  LIFECYCLE_KEYWORDS,
  containsLifecycleKeywords,
  isIntentKD,
  sessionAgentMap,
  sessionPhaseMap,
  ProtocolGateError,
  PROTOCOL_ERRORS,
} from "../../../plugins/protocol-gate/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function callChatParams(plugin, sessionID, agent) {
  return plugin["chat.params"]({ sessionID, agent }, {});
}

async function callExecuteBefore(plugin, ctx, output) {
  return plugin["tool.execute.before"](ctx, output);
}

function makeCtx(tool, sessionID, callID = "c1") {
  return { tool, sessionID, callID };
}

function makeOutput(args = {}) {
  return { args };
}

function makeWriteOutput(filePath, content = "...") {
  return { args: { filePath, content } };
}

function makeTodoOutput(items) {
  return { args: { items } };
}

// ---------------------------------------------------------------------------
// Helper function tests
// ---------------------------------------------------------------------------

describe("containsLifecycleKeywords", () => {
  it("returns true when items contain INTENT keyword", () => {
    expect(containsLifecycleKeywords([{ content: "Create INTENT KD" }])).toBe(
      true,
    );
  });

  it("returns true when items contain multiple keywords", () => {
    expect(
      containsLifecycleKeywords([
        { content: "PREFLIGHT check" },
        { content: "EXPLORE codebase" },
      ]),
    ).toBe(true);
  });

  it("returns true case-insensitively", () => {
    expect(containsLifecycleKeywords([{ content: "intent" }])).toBe(true);
    expect(containsLifecycleKeywords([{ content: "Swarm" }])).toBe(true);
  });

  it("returns true for string items", () => {
    expect(containsLifecycleKeywords(["INTENT", "PREFLIGHT"])).toBe(true);
  });

  it("returns false for empty array", () => {
    expect(containsLifecycleKeywords([])).toBe(false);
  });

  it("returns false for non-array", () => {
    expect(containsLifecycleKeywords(null)).toBe(false);
    expect(containsLifecycleKeywords(undefined)).toBe(false);
  });

  it("returns false when no lifecycle keywords present", () => {
    expect(
      containsLifecycleKeywords([{ content: "Buy groceries" }]),
    ).toBe(false);
  });
});

describe("isIntentKD", () => {
  it("matches knowledge/intent-*.md pattern", () => {
    expect(isIntentKD("knowledge/intent-auth-2026-07-14.md")).toBe(true);
    expect(isIntentKD("./knowledge/intent-test.md")).toBe(true);
  });

  it("rejects non-intent files", () => {
    expect(isIntentKD("knowledge/spec-foo.md")).toBe(false);
    expect(isIntentKD("plugins/delegation-gate/index.js")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// chat.params hook — agent identity and phase initialization
// ---------------------------------------------------------------------------

describe("chat.params hook", () => {
  it("captures sessionID → agent mapping", async () => {
    const plugin = await protocolGatePlugin();
    await callChatParams(plugin, "session-1", "overseer");
    expect(sessionAgentMap.get("session-1")).toBe("overseer");
  });

  it("initializes Phase 0 for overseer sessions", async () => {
    const plugin = await protocolGatePlugin();
    await callChatParams(plugin, "s1", "overseer");
    expect(sessionPhaseMap.get("s1")).toBe(PHASE_0_PRE_TODOWRITE);
  });

  it("does not initialize phase for non-overseer sessions", async () => {
    const plugin = await protocolGatePlugin();
    await callChatParams(plugin, "s2", "artisan");
    expect(sessionPhaseMap.has("s2")).toBe(false);
  });

  it("cleans up stale phase entry when agent changes to non-overseer", async () => {
    const plugin = await protocolGatePlugin();
    await callChatParams(plugin, "s3", "overseer");
    expect(sessionPhaseMap.has("s3")).toBe(true);
    await callChatParams(plugin, "s3", "artisan");
    expect(sessionPhaseMap.has("s3")).toBe(false);
  });

  it("does nothing when sessionID is missing", async () => {
    const plugin = await protocolGatePlugin();
    await callChatParams(plugin, undefined, "overseer");
    expect(sessionAgentMap.has(undefined)).toBe(false);
  });

  it("does nothing when agent is missing", async () => {
    const plugin = await protocolGatePlugin();
    await callChatParams(plugin, "s4", undefined);
    expect(sessionAgentMap.has("s4")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Phase 0: Pre-todowrite
// ---------------------------------------------------------------------------

describe("Phase 0 — blocks all tools except todowrite", () => {
  it("blocks read for overseer in Phase 0", async () => {
    const plugin = await protocolGatePlugin();
    await callChatParams(plugin, "p0a", "overseer");
    const output = makeOutput({ filePath: "some-file.js" });
    await callExecuteBefore(plugin, makeCtx("read", "p0a"), output);
    expect(output.error).toBeDefined();
    expect(output.error.code).toBe("BLOCKED_PHASE_0");
  });

  it("blocks write for overseer in Phase 0", async () => {
    const plugin = await protocolGatePlugin();
    await callChatParams(plugin, "p0b", "overseer");
    const output = makeWriteOutput("some-file.md");
    await callExecuteBefore(plugin, makeCtx("write", "p0b"), output);
    expect(output.error).toBeDefined();
    expect(output.error.code).toBe("BLOCKED_PHASE_0");
  });

  it("blocks edit for overseer in Phase 0", async () => {
    const plugin = await protocolGatePlugin();
    await callChatParams(plugin, "p0c", "overseer");
    const output = makeOutput({ filePath: "some-file.js" });
    await callExecuteBefore(plugin, makeCtx("edit", "p0c"), output);
    expect(output.error).toBeDefined();
    expect(output.error.code).toBe("BLOCKED_PHASE_0");
  });

  it("blocks glob for overseer in Phase 0", async () => {
    const plugin = await protocolGatePlugin();
    await callChatParams(plugin, "p0d", "overseer");
    const output = makeOutput({ pattern: "**/*.js" });
    await callExecuteBefore(plugin, makeCtx("glob", "p0d"), output);
    expect(output.error).toBeDefined();
    expect(output.error.code).toBe("BLOCKED_PHASE_0");
  });

  it("blocks task for overseer in Phase 0", async () => {
    const plugin = await protocolGatePlugin();
    await callChatParams(plugin, "p0e", "overseer");
    const output = makeOutput({ description: "delegate work" });
    await callExecuteBefore(plugin, makeCtx("task", "p0e"), output);
    expect(output.error).toBeDefined();
    expect(output.error.code).toBe("BLOCKED_PHASE_0");
  });

  it("allows todowrite in Phase 0", async () => {
    const plugin = await protocolGatePlugin();
    await callChatParams(plugin, "p0f", "overseer");
    const output = makeTodoOutput([
      { content: "INTENT phase", status: "pending" },
    ]);
    await callExecuteBefore(plugin, makeCtx("todowrite", "p0f"), output);
    // No error means allowed
    expect(output.error).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Phase 0: todowrite lifecycle keyword verification
// ---------------------------------------------------------------------------

describe("Phase 0 — todowrite with lifecycle keywords", () => {
  it("advances to Phase 1 when items contain INTENT keyword", async () => {
    const plugin = await protocolGatePlugin();
    await callChatParams(plugin, "p0k1", "overseer");
    const output = makeTodoOutput([
      { content: "INTENT phase complete", status: "completed" },
    ]);
    await callExecuteBefore(plugin, makeCtx("todowrite", "p0k1"), output);
    expect(sessionPhaseMap.get("p0k1")).toBe(PHASE_1_PRE_INTENT);
  });

  it("advances to Phase 1 when items contain multiple keywords", async () => {
    const plugin = await protocolGatePlugin();
    await callChatParams(plugin, "p0k2", "overseer");
    const output = makeTodoOutput([
      { content: "PREFLIGHT checks", status: "completed" },
      { content: "EXPLORE codebase", status: "in_progress" },
      { content: "INVESTIGATE patterns", status: "pending" },
    ]);
    await callExecuteBefore(plugin, makeCtx("todowrite", "p0k2"), output);
    expect(sessionPhaseMap.get("p0k2")).toBe(PHASE_1_PRE_INTENT);
  });

  it("advances to Phase 1 with all 12 keywords", async () => {
    const plugin = await protocolGatePlugin();
    await callChatParams(plugin, "p0k3", "overseer");
    const output = makeTodoOutput(
      LIFECYCLE_KEYWORDS.map((kw) => ({
        content: `${kw} phase`,
        status: "pending",
      })),
    );
    await callExecuteBefore(plugin, makeCtx("todowrite", "p0k3"), output);
    expect(sessionPhaseMap.get("p0k3")).toBe(PHASE_1_PRE_INTENT);
  });

  it("blocks todowrite without lifecycle keywords", async () => {
    const plugin = await protocolGatePlugin();
    await callChatParams(plugin, "p0k4", "overseer");
    const output = makeTodoOutput([
      { content: "Buy groceries", status: "pending" },
    ]);
    await callExecuteBefore(plugin, makeCtx("todowrite", "p0k4"), output);
    expect(output.error).toBeDefined();
    expect(output.error.code).toBe("BLOCKED_NO_LIFECYCLE");
    // Phase should remain 0
    expect(sessionPhaseMap.get("p0k4")).toBe(PHASE_0_PRE_TODOWRITE);
  });

  it("blocks todowrite with empty items", async () => {
    const plugin = await protocolGatePlugin();
    await callChatParams(plugin, "p0k5", "overseer");
    const output = makeTodoOutput([]);
    await callExecuteBefore(plugin, makeCtx("todowrite", "p0k5"), output);
    expect(output.error).toBeDefined();
    expect(output.error.code).toBe("BLOCKED_NO_LIFECYCLE");
  });

  it("blocks todowrite with no items array", async () => {
    const plugin = await protocolGatePlugin();
    await callChatParams(plugin, "p0k6", "overseer");
    const output = makeTodoOutput(undefined);
    await callExecuteBefore(plugin, makeCtx("todowrite", "p0k6"), output);
    expect(output.error).toBeDefined();
    expect(output.error.code).toBe("BLOCKED_NO_LIFECYCLE");
  });
});

// ---------------------------------------------------------------------------
// Phase 1: Pre-intent
// ---------------------------------------------------------------------------

describe("Phase 1 — blocks non-intent tools", () => {
  it("blocks read for non-intent files", async () => {
    const plugin = await protocolGatePlugin();
    await callChatParams(plugin, "p1a", "overseer");
    // Advance to Phase 1
    sessionPhaseMap.set("p1a", PHASE_1_PRE_INTENT);

    const output = makeOutput({ filePath: "plugins/delegation-gate/index.js" });
    await callExecuteBefore(plugin, makeCtx("read", "p1a"), output);
    expect(output.error).toBeDefined();
    expect(output.error.code).toBe("BLOCKED_PHASE_1");
  });

  it("blocks write for non-intent files", async () => {
    const plugin = await protocolGatePlugin();
    await callChatParams(plugin, "p1b", "overseer");
    sessionPhaseMap.set("p1b", PHASE_1_PRE_INTENT);

    const output = makeWriteOutput("some-file.md");
    await callExecuteBefore(plugin, makeCtx("write", "p1b"), output);
    expect(output.error).toBeDefined();
    expect(output.error.code).toBe("BLOCKED_PHASE_1");
  });

  it("blocks edit in Phase 1", async () => {
    const plugin = await protocolGatePlugin();
    await callChatParams(plugin, "p1c", "overseer");
    sessionPhaseMap.set("p1c", PHASE_1_PRE_INTENT);

    const output = makeOutput({ filePath: "some-file.js" });
    await callExecuteBefore(plugin, makeCtx("edit", "p1c"), output);
    expect(output.error).toBeDefined();
    expect(output.error.code).toBe("BLOCKED_PHASE_1");
  });

  it("blocks glob in Phase 1", async () => {
    const plugin = await protocolGatePlugin();
    await callChatParams(plugin, "p1d", "overseer");
    sessionPhaseMap.set("p1d", PHASE_1_PRE_INTENT);

    const output = makeOutput({ pattern: "**/*.js" });
    await callExecuteBefore(plugin, makeCtx("glob", "p1d"), output);
    expect(output.error).toBeDefined();
    expect(output.error.code).toBe("BLOCKED_PHASE_1");
  });

  it("blocks task in Phase 1", async () => {
    const plugin = await protocolGatePlugin();
    await callChatParams(plugin, "p1e", "overseer");
    sessionPhaseMap.set("p1e", PHASE_1_PRE_INTENT);

    const output = makeOutput({ description: "delegate" });
    await callExecuteBefore(plugin, makeCtx("task", "p1e"), output);
    expect(output.error).toBeDefined();
    expect(output.error.code).toBe("BLOCKED_PHASE_1");
  });
});

describe("Phase 1 — allows intent KD and todowrite", () => {
  it("allows read for intent KD pattern", async () => {
    const plugin = await protocolGatePlugin();
    await callChatParams(plugin, "p1r1", "overseer");
    sessionPhaseMap.set("p1r1", PHASE_1_PRE_INTENT);

    const output = makeOutput({
      filePath: "knowledge/intent-auth-2026-07-14.md",
    });
    await callExecuteBefore(plugin, makeCtx("read", "p1r1"), output);
    expect(output.error).toBeUndefined();
  });

  it("allows write for intent KD pattern", async () => {
    const plugin = await protocolGatePlugin();
    await callChatParams(plugin, "p1r2", "overseer");
    sessionPhaseMap.set("p1r2", PHASE_1_PRE_INTENT);

    const output = makeWriteOutput("knowledge/intent-test-2026-07-14.md");
    await callExecuteBefore(plugin, makeCtx("write", "p1r2"), output);
    expect(output.error).toBeUndefined();
  });

  it("allows todowrite for progress updates", async () => {
    const plugin = await protocolGatePlugin();
    await callChatParams(plugin, "p1r3", "overseer");
    sessionPhaseMap.set("p1r3", PHASE_1_PRE_INTENT);

    const output = makeTodoOutput([
      { content: "INTENT created", status: "completed" },
    ]);
    await callExecuteBefore(plugin, makeCtx("todowrite", "p1r3"), output);
    expect(output.error).toBeUndefined();
  });

  it("write to intent KD advances to Phase 2", async () => {
    const plugin = await protocolGatePlugin();
    await callChatParams(plugin, "p1adv", "overseer");
    sessionPhaseMap.set("p1adv", PHASE_1_PRE_INTENT);

    const output = makeWriteOutput("knowledge/intent-auth-2026-07-14.md");
    await callExecuteBefore(plugin, makeCtx("write", "p1adv"), output);
    expect(sessionPhaseMap.get("p1adv")).toBe(PHASE_2_POST_INTENT);
  });

  it("read to intent KD does NOT advance phase", async () => {
    const plugin = await protocolGatePlugin();
    await callChatParams(plugin, "p1noadv", "overseer");
    sessionPhaseMap.set("p1noadv", PHASE_1_PRE_INTENT);

    const output = makeOutput({
      filePath: "knowledge/intent-test-2026-07-14.md",
    });
    await callExecuteBefore(plugin, makeCtx("read", "p1noadv"), output);
    expect(sessionPhaseMap.get("p1noadv")).toBe(PHASE_1_PRE_INTENT);
  });
});

// ---------------------------------------------------------------------------
// Phase 2: Post-intent — all tools allowed
// ---------------------------------------------------------------------------

describe("Phase 2 — allows all tools", () => {
  it("allows read in Phase 2", async () => {
    const plugin = await protocolGatePlugin();
    await callChatParams(plugin, "p2a", "overseer");
    sessionPhaseMap.set("p2a", PHASE_2_POST_INTENT);

    const output = makeOutput({ filePath: "any-file.js" });
    await callExecuteBefore(plugin, makeCtx("read", "p2a"), output);
    expect(output.error).toBeUndefined();
  });

  it("allows write in Phase 2", async () => {
    const plugin = await protocolGatePlugin();
    await callChatParams(plugin, "p2b", "overseer");
    sessionPhaseMap.set("p2b", PHASE_2_POST_INTENT);

    const output = makeWriteOutput("any-file.md");
    await callExecuteBefore(plugin, makeCtx("write", "p2b"), output);
    expect(output.error).toBeUndefined();
  });

  it("allows edit in Phase 2", async () => {
    const plugin = await protocolGatePlugin();
    await callChatParams(plugin, "p2c", "overseer");
    sessionPhaseMap.set("p2c", PHASE_2_POST_INTENT);

    const output = makeOutput({ filePath: "any-file.js" });
    await callExecuteBefore(plugin, makeCtx("edit", "p2c"), output);
    expect(output.error).toBeUndefined();
  });

  it("allows glob in Phase 2", async () => {
    const plugin = await protocolGatePlugin();
    await callChatParams(plugin, "p2d", "overseer");
    sessionPhaseMap.set("p2d", PHASE_2_POST_INTENT);

    const output = makeOutput({ pattern: "**/*.js" });
    await callExecuteBefore(plugin, makeCtx("glob", "p2d"), output);
    expect(output.error).toBeUndefined();
  });

  it("allows task in Phase 2", async () => {
    const plugin = await protocolGatePlugin();
    await callChatParams(plugin, "p2e", "overseer");
    sessionPhaseMap.set("p2e", PHASE_2_POST_INTENT);

    const output = makeOutput({ description: "delegate" });
    await callExecuteBefore(plugin, makeCtx("task", "p2e"), output);
    expect(output.error).toBeUndefined();
  });

  it("allows todowrite in Phase 2", async () => {
    const plugin = await protocolGatePlugin();
    await callChatParams(plugin, "p2f", "overseer");
    sessionPhaseMap.set("p2f", PHASE_2_POST_INTENT);

    const output = makeTodoOutput([{ content: "Progress update" }]);
    await callExecuteBefore(plugin, makeCtx("todowrite", "p2f"), output);
    expect(output.error).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Non-Overseer: fail-open
// ---------------------------------------------------------------------------

describe("Non-Overseer — fail-open, no blocking", () => {
  it("allows read for non-overseer", async () => {
    const plugin = await protocolGatePlugin();
    await callChatParams(plugin, "no1", "artisan");
    const output = makeOutput({ filePath: "any-file.js" });
    await callExecuteBefore(plugin, makeCtx("read", "no1"), output);
    expect(output.error).toBeUndefined();
  });

  it("allows write for non-overseer", async () => {
    const plugin = await protocolGatePlugin();
    await callChatParams(plugin, "no2", "committer");
    const output = makeWriteOutput("any-file.md");
    await callExecuteBefore(plugin, makeCtx("write", "no2"), output);
    expect(output.error).toBeUndefined();
  });

  it("allows edit for non-overseer", async () => {
    const plugin = await protocolGatePlugin();
    await callChatParams(plugin, "no3", "reviewer");
    const output = makeOutput({ filePath: "any-file.js" });
    await callExecuteBefore(plugin, makeCtx("edit", "no3"), output);
    expect(output.error).toBeUndefined();
  });

  it("allows task for non-overseer", async () => {
    const plugin = await protocolGatePlugin();
    await callChatParams(plugin, "no4", "tester");
    const output = makeOutput({ description: "delegate" });
    await callExecuteBefore(plugin, makeCtx("task", "no4"), output);
    expect(output.error).toBeUndefined();
  });

  it("allows all tools for unknown session (fail-open)", async () => {
    const plugin = await protocolGatePlugin();
    // No chat.params call — session is unknown
    const output = makeOutput({ filePath: "any-file.js" });
    await callExecuteBefore(plugin, makeCtx("read", "unknown"), output);
    expect(output.error).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Multiple sessions tracked independently
// ---------------------------------------------------------------------------

describe("Multiple sessions tracked independently", () => {
  it("overseer and artisan sessions tracked separately", async () => {
    const plugin = await protocolGatePlugin();
    await callChatParams(plugin, "ov1", "overseer");
    await callChatParams(plugin, "ar1", "artisan");

    // Overseer: Phase 0 blocks read
    const out1 = makeOutput({ filePath: "any-file.js" });
    await callExecuteBefore(plugin, makeCtx("read", "ov1"), out1);
    expect(out1.error).toBeDefined();

    // Artisan: read passes (fail-open)
    const out2 = makeOutput({ filePath: "any-file.js" });
    await callExecuteBefore(plugin, makeCtx("read", "ar1"), out2);
    expect(out2.error).toBeUndefined();
  });

  it("two overseer sessions tracked independently", async () => {
    const plugin = await protocolGatePlugin();
    await callChatParams(plugin, "ov-a", "overseer");
    await callChatParams(plugin, "ov-b", "overseer");

    // Advance ov-a to Phase 2 via lifecycle todowrite + intent write
    const todoOut = makeTodoOutput([{ content: "INTENT done" }]);
    await callExecuteBefore(plugin, makeCtx("todowrite", "ov-a"), todoOut);
    const intentOut = makeWriteOutput("knowledge/intent-a.md");
    await callExecuteBefore(plugin, makeCtx("write", "ov-a"), intentOut);

    // ov-a: Phase 2 — read allowed
    const out1 = makeOutput({ filePath: "any-file.js" });
    await callExecuteBefore(plugin, makeCtx("read", "ov-a"), out1);
    expect(out1.error).toBeUndefined();

    // ov-b: still Phase 0 — read blocked
    const out2 = makeOutput({ filePath: "any-file.js" });
    await callExecuteBefore(plugin, makeCtx("read", "ov-b"), out2);
    expect(out2.error).toBeDefined();
  });

  it("session phase advances independently", async () => {
    const plugin = await protocolGatePlugin();
    await callChatParams(plugin, "s-a", "overseer");
    await callChatParams(plugin, "s-b", "overseer");

    // s-a: advance to Phase 1
    await callExecuteBefore(
      plugin,
      makeCtx("todowrite", "s-a"),
      makeTodoOutput([{ content: "INTENT phase" }]),
    );
    expect(sessionPhaseMap.get("s-a")).toBe(PHASE_1_PRE_INTENT);
    expect(sessionPhaseMap.get("s-b")).toBe(PHASE_0_PRE_TODOWRITE);

    // s-b: still blocked
    const out = makeOutput({ filePath: "any-file.js" });
    await callExecuteBefore(plugin, makeCtx("read", "s-b"), out);
    expect(out.error).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Full lifecycle flow — Phase 0 → 1 → 2
// ---------------------------------------------------------------------------

describe("Full lifecycle flow", () => {
  it("Phase 0 → todowrite with keywords → Phase 1 → intent write → Phase 2", async () => {
    const plugin = await protocolGatePlugin();
    await callChatParams(plugin, "flow", "overseer");

    // Phase 0: read blocked
    const out0 = makeOutput({ filePath: "any.js" });
    await callExecuteBefore(plugin, makeCtx("read", "flow"), out0);
    expect(out0.error.code).toBe("BLOCKED_PHASE_0");

    // Phase 0: todowrite without keywords blocked
    const outTodo = makeTodoOutput([{ content: "Buy milk" }]);
    await callExecuteBefore(plugin, makeCtx("todowrite", "flow"), outTodo);
    expect(outTodo.error.code).toBe("BLOCKED_NO_LIFECYCLE");

    // Phase 0: todowrite with keywords → Phase 1
    const outTodoOk = makeTodoOutput([
      { content: "INTENT complete" },
      { content: "PREFLIGHT next" },
    ]);
    await callExecuteBefore(plugin, makeCtx("todowrite", "flow"), outTodoOk);
    expect(sessionPhaseMap.get("flow")).toBe(PHASE_1_PRE_INTENT);

    // Phase 1: read non-intent blocked
    const out1 = makeOutput({ filePath: "any.js" });
    await callExecuteBefore(plugin, makeCtx("read", "flow"), out1);
    expect(out1.error.code).toBe("BLOCKED_PHASE_1");

    // Phase 1: read intent allowed
    const outReadIntent = makeOutput({
      filePath: "knowledge/intent-x.md",
    });
    await callExecuteBefore(plugin, makeCtx("read", "flow"), outReadIntent);
    expect(outReadIntent.error).toBeUndefined();

    // Phase 1: write intent → Phase 2
    const outWriteIntent = makeWriteOutput("knowledge/intent-x.md");
    await callExecuteBefore(plugin, makeCtx("write", "flow"), outWriteIntent);
    expect(sessionPhaseMap.get("flow")).toBe(PHASE_2_POST_INTENT);

    // Phase 2: all tools allowed
    const out2 = makeOutput({ filePath: "any.js" });
    await callExecuteBefore(plugin, makeCtx("read", "flow"), out2);
    expect(out2.error).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Exports verification
// ---------------------------------------------------------------------------

describe("Exports", () => {
  it("exports ProtocolGateError class", () => {
    expect(typeof ProtocolGateError).toBe("function");
    const err = new ProtocolGateError({
      code: "TEST",
      message: "test",
      guidance: "test",
    });
    expect(err.name).toBe("ProtocolGateError");
    expect(err.code).toBe("TEST");
  });

  it("exports PROTOCOL_ERRORS frozen object", () => {
    expect(typeof PROTOCOL_ERRORS).toBe("object");
    expect(Object.isFrozen(PROTOCOL_ERRORS)).toBe(true);
    expect(PROTOCOL_ERRORS.BLOCKED_NO_LIFECYCLE).toBeDefined();
    expect(PROTOCOL_ERRORS.BLOCKED_PHASE_0).toBeDefined();
    expect(PROTOCOL_ERRORS.BLOCKED_PHASE_1).toBeDefined();
  });

  it("exports phase constants", () => {
    expect(PHASE_0_PRE_TODOWRITE).toBe(0);
    expect(PHASE_1_PRE_INTENT).toBe(1);
    expect(PHASE_2_POST_INTENT).toBe(2);
  });

  it("exports LIFECYCLE_KEYWORDS array", () => {
    expect(Array.isArray(LIFECYCLE_KEYWORDS)).toBe(true);
    expect(LIFECYCLE_KEYWORDS).toHaveLength(12);
  });

  it("exports session maps", () => {
    expect(sessionAgentMap).toBeInstanceOf(Map);
    expect(sessionPhaseMap).toBeInstanceOf(Map);
  });
});
