import { describe, it, expect, vi, beforeEach } from "vitest";
import protocolGatePlugin from "../../../plugins/protocol-gate/index.js";

describe("Protocol-Gate Plugin", () => {
  let plugin;
  let mockCtx;

  beforeEach(async () => {
    plugin = protocolGatePlugin();
    mockCtx = {
      type: "",
      input: {},
      output: {}
    };
  });

  describe("Default Export", () => {
    it("exports a function", () => {
      expect(typeof protocolGatePlugin).toBe("function");
    });

    it("has no named exports", () => {
      const module = require("../../../plugins/protocol-gate/index.js");
      const namedExports = Object.keys(module).filter(k => k !== "default" && k !== "__esModule");
      expect(namedExports).toHaveLength(0);
    });
  });

  describe("chat.params Hook", () => {
    it("initializes overseer session to PROTOCOL_NOT_LOADED", async () => {
      mockCtx.type = "chat.params";
      mockCtx.input = { sessionID: "test-1", agent: "overseer" };

      await plugin(mockCtx);

      expect(plugin.sessionPhaseMap.get("test-1")).toBe(0);
    });

    it("cleans up non-overseer session state", async () => {
      mockCtx.type = "chat.params";
      mockCtx.input = { sessionID: "test-1", agent: "artisan" };

      await plugin(mockCtx);

      expect(plugin.sessionPhaseMap.has("test-1")).toBe(false);
    });

    it("tracks concurrent sessions independently", async () => {
      mockCtx.type = "chat.params";
      mockCtx.input = { sessionID: "session-1", agent: "overseer" };
      await plugin(mockCtx);

      mockCtx.input = { sessionID: "session-2", agent: "overseer" };
      await plugin(mockCtx);

      expect(plugin.sessionPhaseMap.get("session-1")).toBe(0);
      expect(plugin.sessionPhaseMap.get("session-2")).toBe(0);
    });
  });

  describe("permission.ask Hook", () => {
    it("sets output.status deny for non-allowed tools (does not throw)", async () => {
      mockCtx.type = "chat.params";
      mockCtx.input = { sessionID: "test-1", agent: "overseer" };
      await plugin(mockCtx);

      mockCtx.type = "permission.ask";
      mockCtx.input = { sessionID: "test-1", tool: "read" };
      mockCtx.output = { status: "" };

      await plugin(mockCtx);
      // Per R026: non-task tool blocks set output.status = "deny" without throwing
      expect(mockCtx.output.status).toBe("deny");
    });

    it("allows todowrite in PROTOCOL_NOT_LOADED phase", async () => {
      mockCtx.type = "chat.params";
      mockCtx.input = { sessionID: "test-1", agent: "overseer" };
      await plugin(mockCtx);

      mockCtx.type = "permission.ask";
      mockCtx.input = { sessionID: "test-1", tool: "todowrite" };
      mockCtx.output = { status: "" };

      await plugin(mockCtx);
      expect(mockCtx.output.status).toBe("");
    });

    it("passes through non-overseer agents", async () => {
      // Non-overseer session: phase is undefined → early return
      mockCtx.type = "chat.params";
      mockCtx.input = { sessionID: "test-1", agent: "artisan" };
      await plugin(mockCtx);

      mockCtx.type = "permission.ask";
      mockCtx.input = { sessionID: "test-1", tool: "read" };
      mockCtx.output = { status: "" };

      await plugin(mockCtx);
      expect(mockCtx.output.status).toBe("");
    });
  });

  describe("tool.execute.before Hook", () => {
    it("throws BLOCKED_UNINITIALIZED for unknown session", async () => {
      mockCtx.type = "tool.execute.before";
      mockCtx.input = { tool: "todowrite", sessionID: "unknown", args: {} };

      await expect(plugin(mockCtx)).rejects.toThrow("Session not initialized");
    });

    it("transitions to INTENT on todowrite with all keywords", async () => {
      mockCtx.type = "chat.params";
      mockCtx.input = { sessionID: "test-1", agent: "overseer" };
      await plugin(mockCtx);

      const keywords = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "COMMIT", "REPORT"];
      const todos = keywords.map(k => ({ content: k }));

      mockCtx.type = "tool.execute.before";
      mockCtx.input = { tool: "todowrite", sessionID: "test-1", args: { todos } };
      mockCtx.output = {};

      await plugin(mockCtx);
      expect(plugin.sessionPhaseMap.get("test-1")).toBe(1);
    });

    it("rejects todowrite missing keywords", async () => {
      mockCtx.type = "chat.params";
      mockCtx.input = { sessionID: "test-1", agent: "overseer" };
      await plugin(mockCtx);

      mockCtx.type = "tool.execute.before";
      mockCtx.input = { tool: "todowrite", sessionID: "test-1", args: { todos: [{ content: "INTENT" }] } };

      await expect(plugin(mockCtx)).rejects.toThrow("Missing lifecycle keywords");
    });

    it("does NOT advance phase based on todowrite content after initial load", async () => {
      // Transition to INTENT first
      mockCtx.type = "chat.params";
      mockCtx.input = { sessionID: "test-1", agent: "overseer" };
      await plugin(mockCtx);

      const keywords = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "COMMIT", "REPORT"];
      mockCtx.type = "tool.execute.before";
      mockCtx.input = { tool: "todowrite", sessionID: "test-1", args: { todos: keywords.map(k => ({ content: k })) } };
      mockCtx.output = {};
      await plugin(mockCtx);
      expect(plugin.sessionPhaseMap.get("test-1")).toBe(1); // INTENT

      // Call todowrite again with all keywords — should NOT advance
      mockCtx.input = { tool: "todowrite", sessionID: "test-1", args: { todos: keywords.map(k => ({ content: k })) } };
      await plugin(mockCtx);
      expect(plugin.sessionPhaseMap.get("test-1")).toBe(1); // Still INTENT — no keyword-based advancement
    });

    it("validates write path in INTENT phase", async () => {
      // Set up session and transition to INTENT
      mockCtx.type = "chat.params";
      mockCtx.input = { sessionID: "test-1", agent: "overseer" };
      await plugin(mockCtx);

      const keywords = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "COMMIT", "REPORT"];
      mockCtx.type = "tool.execute.before";
      mockCtx.input = { tool: "todowrite", sessionID: "test-1", args: { todos: keywords.map(k => ({ content: k })) } };
      mockCtx.output = {};
      await plugin(mockCtx);
      expect(plugin.sessionPhaseMap.get("test-1")).toBe(1); // INTENT

      // Now try to write a non-intent KD
      mockCtx.input = { tool: "write", sessionID: "test-1", args: { filePath: "knowledge/spec-foo.md" } };

      await expect(plugin(mockCtx)).rejects.toThrow("Writes restricted to intent KDs");
    });

    it("validates read path in INTENT phase", async () => {
      // Set up session and transition to INTENT
      mockCtx.type = "chat.params";
      mockCtx.input = { sessionID: "test-1", agent: "overseer" };
      await plugin(mockCtx);

      const keywords = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "COMMIT", "REPORT"];
      mockCtx.type = "tool.execute.before";
      mockCtx.input = { tool: "todowrite", sessionID: "test-1", args: { todos: keywords.map(k => ({ content: k })) } };
      mockCtx.output = {};
      await plugin(mockCtx);

      // Now try to read a non-template file
      mockCtx.input = { tool: "read", sessionID: "test-1", args: { filePath: "knowledge/foo.md" } };

      await expect(plugin(mockCtx)).rejects.toThrow("Reads restricted to templates");
    });
  });

  describe("State Transitions", () => {
    it("has 13 states (PROTOCOL_NOT_LOADED through REPORT)", () => {
      expect(plugin.STATES).toBeDefined();
      expect(Object.keys(plugin.STATES)).toHaveLength(13);
    });

    it("allows write to intent KD in INTENT phase", async () => {
      mockCtx.type = "chat.params";
      mockCtx.input = { sessionID: "test-1", agent: "overseer" };
      await plugin(mockCtx);

      const keywords = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "COMMIT", "REPORT"];
      mockCtx.type = "tool.execute.before";
      mockCtx.input = { tool: "todowrite", sessionID: "test-1", args: { todos: keywords.map(k => ({ content: k })) } };
      mockCtx.output = {};
      await plugin(mockCtx);

      mockCtx.input = { tool: "write", sessionID: "test-1", args: { filePath: "knowledge/intent-foo.md" } };
      await plugin(mockCtx);

      expect(plugin.sessionPhaseMap.get("test-1")).toBe(1);
    });
  });

  describe("Retry Tracking", () => {
    it("increments retry counter on re-delegation in same phase", async () => {
      // Transition to PREFLIGHT
      mockCtx.type = "chat.params";
      mockCtx.input = { sessionID: "test-1", agent: "overseer" };
      await plugin(mockCtx);

      const keywords = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "COMMIT", "REPORT"];
      mockCtx.type = "tool.execute.before";
      mockCtx.input = { tool: "todowrite", sessionID: "test-1", args: { todos: keywords.map(k => ({ content: k })) } };
      mockCtx.output = {};
      await plugin(mockCtx);
      expect(plugin.sessionPhaseMap.get("test-1")).toBe(1); // INTENT

      // Simulate disk advancement to PREFLIGHT by setting phase directly
      plugin.sessionPhaseMap.set("test-1", plugin.STATES.PREFLIGHT);

      // First delegation — should not increment retry
      mockCtx.type = "tool.execute.before";
      mockCtx.input = {
        tool: "task",
        sessionID: "test-1",
        args: { prompt: "AGENT: committer\nMODE: preflight\nINTENT KD: knowledge/intent-foo.md\nSESSION DATE: 2026-07-16\nSCOPE: Setup workspace\nRESULT KD: knowledge/plan-preflight.md" }
      };
      mockCtx.output = { args: {} };
      await plugin(mockCtx);
      expect(plugin.retryMap.get("test-1")).toBe(0);

      // Second delegation (retry) — should increment
      mockCtx.input = {
        tool: "task",
        sessionID: "test-1",
        args: { prompt: "AGENT: committer\nMODE: preflight\nINTENT KD: knowledge/intent-foo.md\nSESSION DATE: 2026-07-16\nSCOPE: Setup workspace\nRESULT KD: knowledge/plan-preflight.md" }
      };
      await plugin(mockCtx);
      expect(plugin.retryMap.get("test-1")).toBe(1);
    });

    it("blocks delegation when retry limit exceeded", async () => {
      // Set up session in PREFLIGHT with max retries
      mockCtx.type = "chat.params";
      mockCtx.input = { sessionID: "test-1", agent: "overseer" };
      await plugin(mockCtx);

      plugin.sessionPhaseMap.set("test-1", plugin.STATES.PREFLIGHT);
      plugin.retryMap.set("test-1", 5); // At limit
      plugin.delegationAttempted.set("test-1", true);

      mockCtx.type = "tool.execute.before";
      mockCtx.input = {
        tool: "task",
        sessionID: "test-1",
        args: { prompt: "AGENT: committer\nMODE: preflight\nINTENT KD: knowledge/intent-foo.md\nSESSION DATE: 2026-07-16\nSCOPE: Setup workspace\nRESULT KD: knowledge/plan-preflight.md" }
      };
      mockCtx.output = { args: {} };

      await expect(plugin(mockCtx)).rejects.toThrow("Retry limit exceeded");
    });
  });

  describe("Backward Transitions", () => {
    it("transitions backward when agent matches a previous phase", async () => {
      // Set up session in VERIFY phase
      mockCtx.type = "chat.params";
      mockCtx.input = { sessionID: "test-1", agent: "overseer" };
      await plugin(mockCtx);

      plugin.sessionPhaseMap.set("test-1", plugin.STATES.VERIFY);

      // Delegate to artisan (SWARM's agent) — should trigger backward transition
      mockCtx.type = "tool.execute.before";
      mockCtx.input = {
        tool: "task",
        sessionID: "test-1",
        args: { prompt: "AGENT: artisan\nMODE: swarm\nINTENT KD: knowledge/intent-foo.md\nSESSION DATE: 2026-07-16\nSCOPE: Fix issues\nRESULT KD: knowledge/impl-foo.md" }
      };
      mockCtx.output = { args: {} };

      await plugin(mockCtx);
      // Should have transitioned to SWARM (7)
      expect(plugin.sessionPhaseMap.get("test-1")).toBe(plugin.STATES.SWARM);
      // Retry counter should be reset
      expect(plugin.retryMap.get("test-1")).toBe(0);
    });

    it("rejects agent not matching current or backward target", async () => {
      mockCtx.type = "chat.params";
      mockCtx.input = { sessionID: "test-1", agent: "overseer" };
      await plugin(mockCtx);

      plugin.sessionPhaseMap.set("test-1", plugin.STATES.PREFLIGHT);

      // Delegate to explorer (not committer, not a backward target from PREFLIGHT)
      mockCtx.type = "tool.execute.before";
      mockCtx.input = {
        tool: "task",
        sessionID: "test-1",
        args: { prompt: "AGENT: explorer\nMODE: explore\nINTENT KD: knowledge/intent-foo.md\nSESSION DATE: 2026-07-16\nSCOPE: Explore codebase\nRESULT KD: knowledge/exploration-foo.md" }
      };
      mockCtx.output = { args: {} };

      await expect(plugin(mockCtx)).rejects.toThrow("Incorrect agent dispatched");
    });
  });

  describe("Template Loading", () => {
    it("loads and renders template for task delegation", async () => {
      mockCtx.type = "chat.params";
      mockCtx.input = { sessionID: "test-1", agent: "overseer" };
      await plugin(mockCtx);

      plugin.sessionPhaseMap.set("test-1", plugin.STATES.PREFLIGHT);

      mockCtx.type = "tool.execute.before";
      mockCtx.input = {
        tool: "task",
        sessionID: "test-1",
        args: { prompt: "AGENT: committer\nMODE: preflight\nINTENT KD: knowledge/intent-foo.md\nSESSION DATE: 2026-07-16\nSCOPE: Setup workspace\nRESULT KD: knowledge/plan-preflight.md" }
      };
      mockCtx.output = { args: {} };

      await plugin(mockCtx);
      expect(mockCtx.output.args.prompt).toContain("knowledge/intent-foo.md");
      expect(mockCtx.output.args.prompt).toContain("2026-07-16");
      expect(mockCtx.output.args.prompt).toContain("Setup workspace");
    });

    it("guards against corrupted template files (missing template field)", async () => {
      // loadTemplate returns null for corrupted/missing templates → prompt passes through unchanged
      mockCtx.type = "chat.params";
      mockCtx.input = { sessionID: "test-1", agent: "overseer" };
      await plugin(mockCtx);

      plugin.sessionPhaseMap.set("test-1", plugin.STATES.PREFLIGHT);

      mockCtx.type = "tool.execute.before";
      mockCtx.input = {
        tool: "task",
        sessionID: "test-1",
        args: { prompt: "AGENT: committer\nMODE: nonexistent\nINTENT KD: knowledge/intent-foo.md\nSESSION DATE: 2026-07-16\nSCOPE: Setup workspace\nRESULT KD: knowledge/plan-preflight.md" }
      };
      mockCtx.output = { args: {} };

      await plugin(mockCtx);
      // No template found → output.args.prompt not set, original prompt preserved
      expect(mockCtx.output.args.prompt).toBeUndefined();
      expect(mockCtx.input.args.prompt).toContain("AGENT: committer");
    });
  });
});
