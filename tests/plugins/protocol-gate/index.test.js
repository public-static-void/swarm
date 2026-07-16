import { describe, it, expect, vi, beforeEach } from "vitest";
import protocolGatePlugin from "../../../plugins/protocol-gate/index.js";

describe("Protocol-Gate Plugin", () => {
  let hooks;

  beforeEach(async () => {
    hooks = await protocolGatePlugin({}, {});
  });

  describe("Default Export", () => {
    it("exports an async function", () => {
      expect(typeof protocolGatePlugin).toBe("function");
    });

    it("returns named hook functions", async () => {
      const result = await protocolGatePlugin({}, {});
      expect(typeof result["chat.params"]).toBe("function");
      expect(typeof result["permission.ask"]).toBe("function");
      expect(typeof result["tool.execute.before"]).toBe("function");
    });

    it("has no named exports beyond default", () => {
      const module = require("../../../plugins/protocol-gate/index.js");
      const namedExports = Object.keys(module).filter(k => k !== "default" && k !== "__esModule");
      expect(namedExports).toHaveLength(0);
    });
  });

  describe("chat.params Hook", () => {
    it("initializes overseer session to PROTOCOL_NOT_LOADED", async () => {
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});

      expect(hooks.sessionPhaseMap.get("test-1")).toBe(0);
    });

    it("cleans up non-overseer session state", async () => {
      await hooks["chat.params"]({ sessionID: "test-1", agent: "artisan" }, {});

      expect(hooks.sessionPhaseMap.has("test-1")).toBe(false);
    });

    it("tracks concurrent sessions independently", async () => {
      await hooks["chat.params"]({ sessionID: "session-1", agent: "overseer" }, {});
      await hooks["chat.params"]({ sessionID: "session-2", agent: "overseer" }, {});

      expect(hooks.sessionPhaseMap.get("session-1")).toBe(0);
      expect(hooks.sessionPhaseMap.get("session-2")).toBe(0);
    });
  });

  describe("permission.ask Hook", () => {
    it("sets output.status deny for non-allowed tools (does not throw)", async () => {
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});

      const output = { status: "" };
      await hooks["permission.ask"]({ sessionID: "test-1", type: "read" }, output);
      // Per R026: non-task tool blocks set output.status = "deny" without throwing
      expect(output.status).toBe("deny");
    });

    it("allows todowrite in PROTOCOL_NOT_LOADED phase", async () => {
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});

      const output = { status: "" };
      await hooks["permission.ask"]({ sessionID: "test-1", type: "todowrite" }, output);
      expect(output.status).toBe("");
    });

    it("passes through non-overseer agents", async () => {
      // Non-overseer session: phase is undefined → early return
      await hooks["chat.params"]({ sessionID: "test-1", agent: "artisan" }, {});

      const output = { status: "" };
      await hooks["permission.ask"]({ sessionID: "test-1", type: "read" }, output);
      expect(output.status).toBe("");
    });
  });

  describe("tool.execute.before Hook", () => {
    it("throws BLOCKED_UNINITIALIZED for unknown session", async () => {
      await expect(
        hooks["tool.execute.before"]({ tool: "todowrite", sessionID: "unknown", callID: "c1" }, { args: {} })
      ).rejects.toThrow("Session not initialized");
    });

    it("transitions to INTENT on todowrite with all keywords", async () => {
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});

      const keywords = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "COMMIT", "REPORT"];
      const todos = keywords.map(k => ({ content: k }));

      await hooks["tool.execute.before"](
        { tool: "todowrite", sessionID: "test-1", callID: "c1" },
        { args: { todos } }
      );
      expect(hooks.sessionPhaseMap.get("test-1")).toBe(1);
    });

    it("rejects todowrite missing keywords", async () => {
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});

      await expect(
        hooks["tool.execute.before"](
          { tool: "todowrite", sessionID: "test-1", callID: "c1" },
          { args: { todos: [{ content: "INTENT" }] } }
        )
      ).rejects.toThrow("Missing lifecycle keywords");
    });

    it("does NOT advance phase based on todowrite content after initial load", async () => {
      // Transition to INTENT first
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});

      const keywords = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "COMMIT", "REPORT"];
      await hooks["tool.execute.before"](
        { tool: "todowrite", sessionID: "test-1", callID: "c1" },
        { args: { todos: keywords.map(k => ({ content: k })) } }
      );
      expect(hooks.sessionPhaseMap.get("test-1")).toBe(1); // INTENT

      // Call todowrite again with all keywords — should NOT advance
      await hooks["tool.execute.before"](
        { tool: "todowrite", sessionID: "test-1", callID: "c2" },
        { args: { todos: keywords.map(k => ({ content: k })) } }
      );
      expect(hooks.sessionPhaseMap.get("test-1")).toBe(1); // Still INTENT — no keyword-based advancement
    });

    it("validates write path in INTENT phase", async () => {
      // Set up session and transition to INTENT
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});

      const keywords = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "COMMIT", "REPORT"];
      await hooks["tool.execute.before"](
        { tool: "todowrite", sessionID: "test-1", callID: "c1" },
        { args: { todos: keywords.map(k => ({ content: k })) } }
      );
      expect(hooks.sessionPhaseMap.get("test-1")).toBe(1); // INTENT

      // Now try to write a non-intent KD
      await expect(
        hooks["tool.execute.before"](
          { tool: "write", sessionID: "test-1", callID: "c2" },
          { args: { filePath: "knowledge/spec-foo.md" } }
        )
      ).rejects.toThrow("Writes restricted to intent KDs");
    });

    it("validates read path in INTENT phase", async () => {
      // Set up session and transition to INTENT
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});

      const keywords = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "COMMIT", "REPORT"];
      await hooks["tool.execute.before"](
        { tool: "todowrite", sessionID: "test-1", callID: "c1" },
        { args: { todos: keywords.map(k => ({ content: k })) } }
      );

      // Now try to read a non-template file
      await expect(
        hooks["tool.execute.before"](
          { tool: "read", sessionID: "test-1", callID: "c2" },
          { args: { filePath: "knowledge/foo.md" } }
        )
      ).rejects.toThrow("Reads restricted to templates");
    });
  });

  describe("State Transitions", () => {
    it("has 13 states (PROTOCOL_NOT_LOADED through REPORT)", () => {
      expect(hooks.STATES).toBeDefined();
      expect(Object.keys(hooks.STATES)).toHaveLength(13);
    });

    it("allows write to intent KD in INTENT phase", async () => {
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});

      const keywords = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "COMMIT", "REPORT"];
      await hooks["tool.execute.before"](
        { tool: "todowrite", sessionID: "test-1", callID: "c1" },
        { args: { todos: keywords.map(k => ({ content: k })) } }
      );

      await hooks["tool.execute.before"](
        { tool: "write", sessionID: "test-1", callID: "c2" },
        { args: { filePath: "knowledge/intent-foo.md" } }
      );

      expect(hooks.sessionPhaseMap.get("test-1")).toBe(1);
    });
  });

  describe("Retry Tracking", () => {
    it("increments retry counter on re-delegation in same phase", async () => {
      // Transition to PREFLIGHT
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});

      const keywords = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "COMMIT", "REPORT"];
      await hooks["tool.execute.before"](
        { tool: "todowrite", sessionID: "test-1", callID: "c1" },
        { args: { todos: keywords.map(k => ({ content: k })) } }
      );
      expect(hooks.sessionPhaseMap.get("test-1")).toBe(1); // INTENT

      // Simulate disk advancement to PREFLIGHT by setting phase directly
      hooks.sessionPhaseMap.set("test-1", hooks.STATES.PREFLIGHT);

      // First delegation — should not increment retry
      await hooks["tool.execute.before"](
        { tool: "task", sessionID: "test-1", callID: "c2" },
        { args: { prompt: "AGENT: committer\nMODE: preflight\nINTENT KD: knowledge/intent-foo.md\nSESSION DATE: 2026-07-16\nSCOPE: Setup workspace\nRESULT KD: knowledge/plan-preflight.md" } }
      );
      expect(hooks.retryMap.get("test-1")).toBe(0);

      // Second delegation (retry) — should increment
      await hooks["tool.execute.before"](
        { tool: "task", sessionID: "test-1", callID: "c3" },
        { args: { prompt: "AGENT: committer\nMODE: preflight\nINTENT KD: knowledge/intent-foo.md\nSESSION DATE: 2026-07-16\nSCOPE: Setup workspace\nRESULT KD: knowledge/plan-preflight.md" } }
      );
      expect(hooks.retryMap.get("test-1")).toBe(1);
    });

    it("blocks delegation when retry limit exceeded", async () => {
      // Set up session in PREFLIGHT with max retries
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});

      hooks.sessionPhaseMap.set("test-1", hooks.STATES.PREFLIGHT);
      hooks.retryMap.set("test-1", 5); // At limit
      hooks.delegationAttempted.set("test-1", true);

      await expect(
        hooks["tool.execute.before"](
          { tool: "task", sessionID: "test-1", callID: "c1" },
          { args: { prompt: "AGENT: committer\nMODE: preflight\nINTENT KD: knowledge/intent-foo.md\nSESSION DATE: 2026-07-16\nSCOPE: Setup workspace\nRESULT KD: knowledge/plan-preflight.md" } }
        )
      ).rejects.toThrow("Retry limit exceeded");
    });
  });

  describe("Backward Transitions", () => {
    it("transitions backward when agent matches a previous phase", async () => {
      // Set up session in VERIFY phase
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});

      hooks.sessionPhaseMap.set("test-1", hooks.STATES.VERIFY);

      // Delegate to artisan (SWARM's agent) — should trigger backward transition
      await hooks["tool.execute.before"](
        { tool: "task", sessionID: "test-1", callID: "c1" },
        { args: { prompt: "AGENT: artisan\nMODE: swarm\nINTENT KD: knowledge/intent-foo.md\nSESSION DATE: 2026-07-16\nSCOPE: Fix issues\nRESULT KD: knowledge/impl-foo.md" } }
      );
      // Should have transitioned to SWARM (7)
      expect(hooks.sessionPhaseMap.get("test-1")).toBe(hooks.STATES.SWARM);
      // Retry counter should be reset
      expect(hooks.retryMap.get("test-1")).toBe(0);
    });

    it("rejects agent not matching current or backward target", async () => {
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});

      hooks.sessionPhaseMap.set("test-1", hooks.STATES.PREFLIGHT);

      // Delegate to explorer (not committer, not a backward target from PREFLIGHT)
      await expect(
        hooks["tool.execute.before"](
          { tool: "task", sessionID: "test-1", callID: "c1" },
          { args: { prompt: "AGENT: explorer\nMODE: explore\nINTENT KD: knowledge/intent-foo.md\nSESSION DATE: 2026-07-16\nSCOPE: Explore codebase\nRESULT KD: knowledge/exploration-foo.md" } }
        )
      ).rejects.toThrow("Incorrect agent dispatched");
    });
  });

  describe("Agent Extraction", () => {
    it("extracts agent from raw prompt (AGENT: format)", async () => {
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});

      hooks.sessionPhaseMap.set("test-1", hooks.STATES.PREFLIGHT);

      const output = { args: { prompt: "AGENT: committer\nMODE: preflight\nINTENT KD: knowledge/intent-foo.md\nSESSION DATE: 2026-07-16\nSCOPE: Setup workspace\nRESULT KD: knowledge/plan-preflight.md" } };
      await hooks["tool.execute.before"](
        { tool: "task", sessionID: "test-1", callID: "c1" },
        output
      );
      // Protocol-gate does NOT modify the prompt — only delegation-gate renders templates
      expect(output.args.prompt).toBe("AGENT: committer\nMODE: preflight\nINTENT KD: knowledge/intent-foo.md\nSESSION DATE: 2026-07-16\nSCOPE: Setup workspace\nRESULT KD: knowledge/plan-preflight.md");
    });

    it("extracts agent from rendered prompt (DISPATCH TO: format)", async () => {
      // Simulates delegation-gate running first and rendering the prompt
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});

      hooks.sessionPhaseMap.set("test-1", hooks.STATES.PREFLIGHT);

      const output = { args: { prompt: "DISPATCH TO: committer\nMODE: preflight\nINTENT KD: knowledge/intent-foo.md\nSESSION DATE: 2026-07-16\nSCOPE: Setup workspace\nRESULT KD: knowledge/plan-preflight.md" } };
      await hooks["tool.execute.before"](
        { tool: "task", sessionID: "test-1", callID: "c1" },
        output
      );
      // Should not throw — agent extraction works on rendered format too
      expect(output.args.prompt).toBe("DISPATCH TO: committer\nMODE: preflight\nINTENT KD: knowledge/intent-foo.md\nSESSION DATE: 2026-07-16\nSCOPE: Setup workspace\nRESULT KD: knowledge/plan-preflight.md");
    });

    it("does not modify prompt — template rendering is delegation-gate's responsibility", async () => {
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});

      hooks.sessionPhaseMap.set("test-1", hooks.STATES.PREFLIGHT);

      const originalPrompt = "AGENT: committer\nMODE: preflight\nINTENT KD: knowledge/intent-foo.md\nSESSION DATE: 2026-07-16\nSCOPE: Setup workspace\nRESULT KD: knowledge/plan-preflight.md";
      const output = { args: { prompt: originalPrompt } };
      await hooks["tool.execute.before"](
        { tool: "task", sessionID: "test-1", callID: "c1" },
        output
      );
      // Prompt should be unchanged — protocol-gate only validates routing
      expect(output.args.prompt).toBe(originalPrompt);
    });
  });
});
