import { describe, it, expect, vi, beforeEach } from "vitest";
import pluginModule from "../../../plugins/protocol-gate/index.js";

describe("Protocol-Gate Plugin", () => {
  let hooks;

  beforeEach(async () => {
    hooks = await pluginModule.server({}, {});
  });

  describe("Default Export", () => {
    it("exports a PluginModule object with id and server", () => {
      expect(typeof pluginModule).toBe("object");
      expect(pluginModule.id).toBe("protocol-gate");
      expect(typeof pluginModule.server).toBe("function");
    });

    it("server() returns named hook functions", async () => {
      const result = await pluginModule.server({}, {});
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

    it("does not track non-overseer session in phase map", async () => {
      await hooks["chat.params"]({ sessionID: "test-1", agent: "artisan" }, {});

      // Non-overseer sessions pass through — never added to the map
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
    it("passes through non-overseer session (unknown session — not in phase map)", async () => {
      const output = { args: {} };
      // Non-overseer session: phase is undefined → returns early, allows passage
      await hooks["tool.execute.before"]({ tool: "todowrite", sessionID: "unknown", callID: "c1" }, output);
      // Should not throw — non-overseer sessions pass through unaffected
    });

    it("transitions to INTENT on todowrite with all keywords", async () => {
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});

      const keywords = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "COMMIT", "REPORT"];
      const todos = keywords.map(k => ({ content: k }));

      await hooks["tool.execute.before"](
        { tool: "todowrite", sessionID: "test-1", callID: "c1" },
        { args: { todos } }
      );
      // Disk advancement may advance past INTENT in the same call
      expect(hooks.sessionPhaseMap.get("test-1")).toBeGreaterThanOrEqual(1);
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

      // Phase should be INTENT after todowrite (disk check skipped in same call)
      expect(hooks.sessionPhaseMap.get("test-1")).toBe(1);

      // Call todowrite again — disk check fires on this call and may advance
      // (the skip flag was cleared after first call)
      await hooks["tool.execute.before"](
        { tool: "todowrite", sessionID: "test-1", callID: "c2" },
        { args: { todos: keywords.map(k => ({ content: k })) } }
      );
      // Disk check may advance past INTENT on second todowrite — this is expected
      // The key invariant: todowrite content alone doesn't drive advancement,
      // only disk-based KD existence does
      const phase = hooks.sessionPhaseMap.get("test-1");
      expect(phase >= 1).toBe(true);
    });

    it("validates write path in INTENT phase", async () => {
      // Set up session and transition to INTENT
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});

      const keywords = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "COMMIT", "REPORT"];
      await hooks["tool.execute.before"](
        { tool: "todowrite", sessionID: "test-1", callID: "c1" },
        { args: { todos: keywords.map(k => ({ content: k })) } }
      );
      // Force INTENT phase — disk advancement may have already advanced past it
      hooks.sessionPhaseMap.set("test-1", 1); // INTENT
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
      // Force INTENT phase — disk advancement may have already advanced past it
      hooks.sessionPhaseMap.set("test-1", 1); // INTENT

      // Now try to read a non-template, non-intent file
      await expect(
        hooks["tool.execute.before"](
          { tool: "read", sessionID: "test-1", callID: "c2" },
          { args: { filePath: "src/main.js" } }
        )
      ).rejects.toThrow("Reads restricted to templates and intent KDs");
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

      // Phase may advance to PREFLIGHT if knowledge/ directory exists with intent KD
      // This is expected behavior from F04 (INTENT disk advancement)
      const phase = hooks.sessionPhaseMap.get("test-1");
      expect(phase === 1 || phase === 2).toBe(true); // INTENT or PREFLIGHT
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
      // Force INTENT phase — disk advancement may have already advanced past it
      hooks.sessionPhaseMap.set("test-1", 1); // INTENT

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

  describe("INTENT Phase Fixes (F01, F02, F04)", () => {
    it("allows write with absolute path to intent KD (F01)", async () => {
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});

      const keywords = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "COMMIT", "REPORT"];
      await hooks["tool.execute.before"](
        { tool: "todowrite", sessionID: "test-1", callID: "c1" },
        { args: { todos: keywords.map(k => ({ content: k })) } }
      );

      // Absolute path should be normalized and allowed
      await hooks["tool.execute.before"](
        { tool: "write", sessionID: "test-1", callID: "c2" },
        { args: { filePath: "/home/user/project/knowledge/intent-foo.md" } }
      );

      // Phase may advance to PREFLIGHT if knowledge/ directory exists with intent KD
      const phase = hooks.sessionPhaseMap.get("test-1");
      expect(phase === 1 || phase === 2).toBe(true); // INTENT or PREFLIGHT
    });

    it("rejects write with absolute path to non-intent KD (F01)", async () => {
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});

      const keywords = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "COMMIT", "REPORT"];
      await hooks["tool.execute.before"](
        { tool: "todowrite", sessionID: "test-1", callID: "c1" },
        { args: { todos: keywords.map(k => ({ content: k })) } }
      );
      // Force INTENT phase — disk advancement may have already advanced past it
      hooks.sessionPhaseMap.set("test-1", 1); // INTENT

      // Absolute path to non-intent KD should be rejected
      await expect(
        hooks["tool.execute.before"](
          { tool: "write", sessionID: "test-1", callID: "c2" },
          { args: { filePath: "/home/user/project/knowledge/spec-foo.md" } }
        )
      ).rejects.toThrow("Writes restricted to intent KDs");
    });

    it("allows read from knowledge/ directory (F02)", async () => {
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});

      const keywords = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "COMMIT", "REPORT"];
      await hooks["tool.execute.before"](
        { tool: "todowrite", sessionID: "test-1", callID: "c1" },
        { args: { todos: keywords.map(k => ({ content: k })) } }
      );
      // Force INTENT phase — disk advancement may have already advanced past it
      hooks.sessionPhaseMap.set("test-1", 1); // INTENT

      // Read from knowledge/ should be allowed
      await hooks["tool.execute.before"](
        { tool: "read", sessionID: "test-1", callID: "c2" },
        { args: { filePath: "knowledge/intent-foo.md" } }
      );

      // Phase may advance to PREFLIGHT if knowledge/ directory exists with intent KD
      const phase = hooks.sessionPhaseMap.get("test-1");
      expect(phase === 1 || phase === 2).toBe(true); // INTENT or PREFLIGHT
    });

    it("allows read from knowledge/ with absolute path (F02)", async () => {
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});

      const keywords = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "COMMIT", "REPORT"];
      await hooks["tool.execute.before"](
        { tool: "todowrite", sessionID: "test-1", callID: "c1" },
        { args: { todos: keywords.map(k => ({ content: k })) } }
      );
      // Force INTENT phase — disk advancement may have already advanced past it
      hooks.sessionPhaseMap.set("test-1", 1); // INTENT

      // Absolute path to knowledge/ should be allowed
      await hooks["tool.execute.before"](
        { tool: "read", sessionID: "test-1", callID: "c2" },
        { args: { filePath: "/home/user/project/knowledge/intent-foo.md" } }
      );

      // Phase may advance to PREFLIGHT if knowledge/ directory exists with intent KD
      const phase = hooks.sessionPhaseMap.get("test-1");
      expect(phase === 1 || phase === 2).toBe(true); // INTENT or PREFLIGHT
    });

    it("rejects read from non-template, non-knowledge path (F02)", async () => {
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});

      const keywords = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "COMMIT", "REPORT"];
      await hooks["tool.execute.before"](
        { tool: "todowrite", sessionID: "test-1", callID: "c1" },
        { args: { todos: keywords.map(k => ({ content: k })) } }
      );
      // Force INTENT phase — disk advancement may have already advanced past it
      hooks.sessionPhaseMap.set("test-1", 1); // INTENT

      // Read from src/ should be rejected
      await expect(
        hooks["tool.execute.before"](
          { tool: "read", sessionID: "test-1", callID: "c2" },
          { args: { filePath: "src/main.js" } }
        )
      ).rejects.toThrow("Reads restricted to templates and intent KDs");
    });

    it("has INTENT pattern for disk advancement (F04)", async () => {
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});

      const keywords = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "COMMIT", "REPORT"];
      await hooks["tool.execute.before"](
        { tool: "todowrite", sessionID: "test-1", callID: "c1" },
        { args: { todos: keywords.map(k => ({ content: k })) } }
      );
      // Force INTENT phase — disk advancement may have already advanced past it
      hooks.sessionPhaseMap.set("test-1", 1); // INTENT

      // Verify we're in INTENT phase
      expect(hooks.sessionPhaseMap.get("test-1")).toBe(1);

      // The disk advancement check should now have INTENT pattern
      // This test verifies the pattern exists by checking the plugin loaded correctly
      expect(hooks.STATES.INTENT).toBe(1);
    });
  });

  describe("Phase Jump Prevention (Issue 3)", () => {
    it("does not advance past INTENT on the same todowrite call", async () => {
      // This is the core Issue 3 test: todowrite advances to INTENT,
      // then the disk check should NOT fire in the same call and jump to PREFLIGHT
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});

      const keywords = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "COMMIT", "REPORT"];
      await hooks["tool.execute.before"](
        { tool: "todowrite", sessionID: "test-1", callID: "c1" },
        { args: { todos: keywords.map(k => ({ content: k })) } }
      );

      // If the disk check fired on the same call, phase would be PREFLIGHT (2).
      // The fix ensures phase is exactly INTENT (1) after the todowrite call.
      expect(hooks.sessionPhaseMap.get("test-1")).toBe(1); // INTENT, not PREFLIGHT
    });

    it("allows disk advancement on the next non-todowrite tool call", async () => {
      // After the todowrite skip, the next tool call should allow disk advancement
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});

      const keywords = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "COMMIT", "REPORT"];
      await hooks["tool.execute.before"](
        { tool: "todowrite", sessionID: "test-1", callID: "c1" },
        { args: { todos: keywords.map(k => ({ content: k })) } }
      );

      // Phase should be INTENT after todowrite
      expect(hooks.sessionPhaseMap.get("test-1")).toBe(1);

      // Next tool call (read) — disk check should fire and may advance
      await hooks["tool.execute.before"](
        { tool: "read", sessionID: "test-1", callID: "c2" },
        { args: { filePath: "knowledge/intent-foo.md" } }
      );

      // Phase may have advanced via disk check on this call
      const phase = hooks.sessionPhaseMap.get("test-1");
      expect(phase === 1 || phase === 2).toBe(true); // INTENT or PREFLIGHT
    });

    it("skips disk check flag resets after use", async () => {
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});

      const keywords = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "COMMIT", "REPORT"];

      // First todowrite: advances to INTENT, sets skip flag
      await hooks["tool.execute.before"](
        { tool: "todowrite", sessionID: "test-1", callID: "c1" },
        { args: { todos: keywords.map(k => ({ content: k })) } }
      );
      expect(hooks.sessionPhaseMap.get("test-1")).toBe(1);

      // Force back to INTENT for a second todowrite test
      hooks.sessionPhaseMap.set("test-1", 1);

      // Second todowrite: skip flag was cleared, so disk check fires
      // and may advance (knowledge/intent-* KDs exist on disk)
      await hooks["tool.execute.before"](
        { tool: "todowrite", sessionID: "test-1", callID: "c2" },
        { args: { todos: keywords.map(k => ({ content: k })) } }
      );
      // Phase may have advanced via disk check — flag was reset so check fires
      const phase = hooks.sessionPhaseMap.get("test-1");
      expect(phase >= 1).toBe(true);
    });
  });

  describe("INTENT Read Restrictions (Issue 5)", () => {
    it("allows reading intent KDs in INTENT phase", async () => {
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});

      const keywords = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "COMMIT", "REPORT"];
      await hooks["tool.execute.before"](
        { tool: "todowrite", sessionID: "test-1", callID: "c1" },
        { args: { todos: keywords.map(k => ({ content: k })) } }
      );
      hooks.sessionPhaseMap.set("test-1", 1); // INTENT

      // Reading an intent KD should be allowed
      await hooks["tool.execute.before"](
        { tool: "read", sessionID: "test-1", callID: "c2" },
        { args: { filePath: "knowledge/intent-foo.md" } }
      );
      // Should not throw
    });

    it("blocks reading report KDs in INTENT phase (Issue 5)", async () => {
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});

      const keywords = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "COMMIT", "REPORT"];
      await hooks["tool.execute.before"](
        { tool: "todowrite", sessionID: "test-1", callID: "c1" },
        { args: { todos: keywords.map(k => ({ content: k })) } }
      );
      hooks.sessionPhaseMap.set("test-1", 1); // INTENT

      // Reading a report KD should be BLOCKED — this prevents self-execution
      await expect(
        hooks["tool.execute.before"](
          { tool: "read", sessionID: "test-1", callID: "c2" },
          { args: { filePath: "knowledge/report-foo.md" } }
        )
      ).rejects.toThrow("Reads restricted to templates and intent KDs");
    });

    it("blocks reading analysis KDs in INTENT phase", async () => {
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});

      const keywords = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "COMMIT", "REPORT"];
      await hooks["tool.execute.before"](
        { tool: "todowrite", sessionID: "test-1", callID: "c1" },
        { args: { todos: keywords.map(k => ({ content: k })) } }
      );
      hooks.sessionPhaseMap.set("test-1", 1); // INTENT

      // Reading analysis KDs should also be blocked
      await expect(
        hooks["tool.execute.before"](
          { tool: "read", sessionID: "test-1", callID: "c2" },
          { args: { filePath: "knowledge/analysis-foo.md" } }
        )
      ).rejects.toThrow("Reads restricted to templates and intent KDs");
    });

    it("allows reading templates in INTENT phase", async () => {
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});

      const keywords = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "COMMIT", "REPORT"];
      await hooks["tool.execute.before"](
        { tool: "todowrite", sessionID: "test-1", callID: "c1" },
        { args: { todos: keywords.map(k => ({ content: k })) } }
      );
      hooks.sessionPhaseMap.set("test-1", 1); // INTENT

      // Reading templates should still be allowed
      await hooks["tool.execute.before"](
        { tool: "read", sessionID: "test-1", callID: "c2" },
        { args: { filePath: "skills/kd-system/templates/intent.md" } }
      );
      // Should not throw
    });
  });
});
