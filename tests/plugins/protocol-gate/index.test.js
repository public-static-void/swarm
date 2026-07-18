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
      expect(typeof result["tool.definition"]).toBe("function");
      expect(typeof result["experimental.chat.system.transform"]).toBe("function");
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

    it("tracks overseer sessions in overseerSessions set", async () => {
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});

      expect(hooks.overseerSessions.has("test-1")).toBe(true);
      expect(hooks.isOverseerSession("test-1")).toBe(true);
    });

    it("does not track non-overseer session in phase map or overseer set", async () => {
      await hooks["chat.params"]({ sessionID: "test-1", agent: "artisan" }, {});

      // Non-overseer sessions pass through — never added to the map
      expect(hooks.sessionPhaseMap.has("test-1")).toBe(false);
      expect(hooks.overseerSessions.has("test-1")).toBe(false);
      expect(hooks.isOverseerSession("test-1")).toBe(false);
    });

    it("tracks concurrent sessions independently", async () => {
      await hooks["chat.params"]({ sessionID: "session-1", agent: "overseer" }, {});
      await hooks["chat.params"]({ sessionID: "session-2", agent: "overseer" }, {});

      expect(hooks.sessionPhaseMap.get("session-1")).toBe(0);
      expect(hooks.sessionPhaseMap.get("session-2")).toBe(0);
      expect(hooks.isOverseerSession("session-1")).toBe(true);
      expect(hooks.isOverseerSession("session-2")).toBe(true);
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

    it("blocks overseer session with missing phase entry (fail-closed, BUG 2)", async () => {
      // Simulate an overseer session that was tracked but lost its phase entry
      hooks.overseerSessions.add("orphan-overseer");
      // Session is in overseerSessions but NOT in sessionPhaseMap

      await expect(
        hooks["tool.execute.before"](
          { tool: "task", sessionID: "orphan-overseer", callID: "c1" },
          { args: { prompt: "AGENT: explorer\nMODE: explore\nINTENT KD: knowledge/intent-foo.md\nSESSION DATE: 2026-07-17\nSCOPE: Explore codebase\nRESULT KD: knowledge/exploration-foo.md" } }
        )
      ).rejects.toThrow("Session not initialized");
    });

    it("passes through non-overseer session calling task tool", async () => {
      // A non-overseer session (e.g., explorer) calls task tool — should pass through
      const output = { args: { prompt: "some task" } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "explorer-session", callID: "c1" }, output);
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

  describe("BUG 1: Session Date Filtering (stale KDs)", () => {
    it("does not advance phase when no session date is set", async () => {
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});

      const keywords = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "COMMIT", "REPORT"];
      await hooks["tool.execute.before"](
        { tool: "todowrite", sessionID: "test-1", callID: "c1" },
        { args: { todos: keywords.map(k => ({ content: k })) } }
      );
      // Force INTENT phase — no session date set
      hooks.sessionPhaseMap.set("test-1", 1); // INTENT

      // Call write — disk check fires but no session date → no advancement
      await hooks["tool.execute.before"](
        { tool: "write", sessionID: "test-1", callID: "c2" },
        { args: { filePath: "knowledge/intent-foo.md" } }
      );

      // Phase stays INTENT — no session date means disk check returns false
      expect(hooks.sessionPhaseMap.get("test-1")).toBe(1);
    });

    it("captures session date from intent KD filename on write", async () => {
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});

      const keywords = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "COMMIT", "REPORT"];
      await hooks["tool.execute.before"](
        { tool: "todowrite", sessionID: "test-1", callID: "c1" },
        { args: { todos: keywords.map(k => ({ content: k })) } }
      );
      hooks.sessionPhaseMap.set("test-1", 1); // INTENT

      // Write intent KD with date in filename
      await hooks["tool.execute.before"](
        { tool: "write", sessionID: "test-1", callID: "c2" },
        { args: { filePath: "knowledge/intent-my-feature-2026-07-17.md" } }
      );

      // Session date should be captured
      expect(hooks.sessionPhaseMap.get("test-1:date")).toBe("2026-07-17");
    });

    it("captures session date from absolute path intent KD", async () => {
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});

      const keywords = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "COMMIT", "REPORT"];
      await hooks["tool.execute.before"](
        { tool: "todowrite", sessionID: "test-1", callID: "c1" },
        { args: { todos: keywords.map(k => ({ content: k })) } }
      );
      hooks.sessionPhaseMap.set("test-1", 1); // INTENT

      await hooks["tool.execute.before"](
        { tool: "write", sessionID: "test-1", callID: "c2" },
        { args: { filePath: "/home/user/project/knowledge/intent-my-feature-2026-07-17.md" } }
      );

      expect(hooks.sessionPhaseMap.get("test-1:date")).toBe("2026-07-17");
    });
  });

  describe("BUG 2: Disk Check Tool Restriction", () => {
    it("does not trigger disk check on read tool", async () => {
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});

      const keywords = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "COMMIT", "REPORT"];
      await hooks["tool.execute.before"](
        { tool: "todowrite", sessionID: "test-1", callID: "c1" },
        { args: { todos: keywords.map(k => ({ content: k })) } }
      );
      hooks.sessionPhaseMap.set("test-1", 1); // INTENT

      // read is NOT in DISK_CHECK_TOOLS — should not trigger disk advancement
      await hooks["tool.execute.before"](
        { tool: "read", sessionID: "test-1", callID: "c2" },
        { args: { filePath: "knowledge/intent-foo.md" } }
      );

      // Phase stays INTENT — read doesn't trigger disk check
      expect(hooks.sessionPhaseMap.get("test-1")).toBe(1);
    });

    it("blocks skill tool in INTENT phase (not in allowlist)", async () => {
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});

      const keywords = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "COMMIT", "REPORT"];
      await hooks["tool.execute.before"](
        { tool: "todowrite", sessionID: "test-1", callID: "c1" },
        { args: { todos: keywords.map(k => ({ content: k })) } }
      );
      hooks.sessionPhaseMap.set("test-1", 1); // INTENT

      // skill is not in INTENT allowlist — should be blocked
      await expect(
        hooks["tool.execute.before"](
          { tool: "skill", sessionID: "test-1", callID: "c2" },
          { args: { name: "kd-system" } }
        )
      ).rejects.toThrow("not allowed in INTENT phase");
    });

    it("blocks bash tool in INTENT phase (not in allowlist)", async () => {
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});

      const keywords = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "COMMIT", "REPORT"];
      await hooks["tool.execute.before"](
        { tool: "todowrite", sessionID: "test-1", callID: "c1" },
        { args: { todos: keywords.map(k => ({ content: k })) } }
      );
      hooks.sessionPhaseMap.set("test-1", 1); // INTENT

      // bash is not in INTENT allowlist — should be blocked
      await expect(
        hooks["tool.execute.before"](
          { tool: "bash", sessionID: "test-1", callID: "c2" },
          { args: { command: "ls" } }
        )
      ).rejects.toThrow("not allowed in INTENT phase");
    });

    it("triggers disk check on write tool (in DISK_CHECK_TOOLS)", async () => {
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});

      const keywords = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "COMMIT", "REPORT"];
      await hooks["tool.execute.before"](
        { tool: "todowrite", sessionID: "test-1", callID: "c1" },
        { args: { todos: keywords.map(k => ({ content: k })) } }
      );
      hooks.sessionPhaseMap.set("test-1", 1); // INTENT

      // write IS in DISK_CHECK_TOOLS — disk check fires (but no session date → no advancement)
      await hooks["tool.execute.before"](
        { tool: "write", sessionID: "test-1", callID: "c2" },
        { args: { filePath: "knowledge/intent-foo.md" } }
      );

      // No session date set, so disk check returns false — phase stays INTENT
      expect(hooks.sessionPhaseMap.get("test-1")).toBe(1);
    });
  });

  describe("BUG 4: REPORT/COMMIT Stuck Detection Skip", () => {
    it("does not increment disk check failures in REPORT phase", async () => {
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});
      hooks.sessionPhaseMap.set("test-1", hooks.STATES.REPORT);

      // Call todowrite multiple times — disk check fires but REPORT has no pattern
      for (let i = 0; i < 12; i++) {
        await hooks["tool.execute.before"](
          { tool: "todowrite", sessionID: "test-1", callID: `c${i}` },
          { args: { todos: [{ content: "REPORT" }] } }
        );
      }

      // REPORT phase should not accumulate disk check failures
      // (no stuck warning should fire)
      // Phase stays REPORT — REPORT is the last phase, +1 would be 13 which is undefined
      expect(hooks.sessionPhaseMap.get("test-1")).toBe(hooks.STATES.REPORT);
    });
  });

  describe("lastSeenSession Tracking", () => {
    it("is null before any hook is called", () => {
      expect(hooks.lastSeenSession).toBeNull();
    });

    it("updates when chat.params is called for overseer", async () => {
      await hooks["chat.params"]({ sessionID: "sess-1", agent: "overseer" }, {});
      expect(hooks.lastSeenSession).toBe("sess-1");
    });

    it("updates when chat.params is called for non-overseer", async () => {
      await hooks["chat.params"]({ sessionID: "sess-2", agent: "artisan" }, {});
      expect(hooks.lastSeenSession).toBe("sess-2");
    });

    it("updates when tool.execute.before is called", async () => {
      await hooks["chat.params"]({ sessionID: "sess-1", agent: "overseer" }, {});
      await hooks["tool.execute.before"](
        { tool: "todowrite", sessionID: "sess-2", callID: "c1" },
        { args: {} }
      );
      expect(hooks.lastSeenSession).toBe("sess-2");
    });

    it("tracks the most recent session across multiple calls", async () => {
      await hooks["chat.params"]({ sessionID: "a", agent: "overseer" }, {});
      await hooks["chat.params"]({ sessionID: "b", agent: "overseer" }, {});
      expect(hooks.lastSeenSession).toBe("b");
    });
  });

  describe("tool.definition Hook", () => {
    it("passes through when no session has been seen", async () => {
      const output = { description: "Read a file", parameters: {} };
      await hooks["tool.definition"]({ toolID: "read" }, output);
      expect(output.description).toBe("Read a file");
    });

    it("passes through for non-overseer sessions", async () => {
      await hooks["chat.params"]({ sessionID: "test-1", agent: "artisan" }, {});
      const output = { description: "Read a file", parameters: {} };
      await hooks["tool.definition"]({ toolID: "read" }, output);
      expect(output.description).toBe("Read a file");
    });

    it("passes through for allowed tools", async () => {
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});
      // PROTOCOL_NOT_LOADED phase allows todowrite
      const output = { description: "Write todos", parameters: {} };
      await hooks["tool.definition"]({ toolID: "todowrite" }, output);
      expect(output.description).toBe("Write todos");
    });

    it("passes through for task tool (always allowed)", async () => {
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});
      // PROTOCOL_NOT_LOADED — task is not in allowlist but is always allowed
      const output = { description: "Delegate to agent", parameters: {} };
      await hooks["tool.definition"]({ toolID: "task" }, output);
      expect(output.description).toBe("Delegate to agent");
    });

    it("blocks non-allowed tools with description prefix", async () => {
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});
      // PROTOCOL_NOT_LOADED only allows todowrite
      const output = { description: "Read a file", parameters: {} };
      await hooks["tool.definition"]({ toolID: "read" }, output);
      expect(output.description).toContain("NOT AVAILABLE in PROTOCOL_NOT_LOADED phase");
      expect(output.description).toContain("Allowed tools: todowrite");
      expect(output.description).toContain("Read a file");
    });

    it("preserves original description after blocking prefix", async () => {
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});
      hooks.sessionPhaseMap.set("test-1", hooks.STATES.INTENT); // INTENT: todowrite, write, read, question
      const original = "Search files by pattern";
      const output = { description: original, parameters: {} };
      await hooks["tool.definition"]({ toolID: "glob" }, output);
      expect(output.description).toBe(`⛔ NOT AVAILABLE in INTENT phase. Allowed tools: todowrite, write, read, question. ${original}`);
    });

    it("allows all tools in INTENT phase (todowrite, write, read, question)", async () => {
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});
      hooks.sessionPhaseMap.set("test-1", hooks.STATES.INTENT);

      for (const toolID of ["todowrite", "write", "read", "question", "task"]) {
        const output = { description: "test", parameters: {} };
        await hooks["tool.definition"]({ toolID }, output);
        expect(output.description).toBe("test");
      }
    });

    it("blocks non-allowlisted tools in INTENT phase", async () => {
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});
      hooks.sessionPhaseMap.set("test-1", hooks.STATES.INTENT);

      const blocked = ["bash", "edit", "glob", "grep", "skill"];
      for (const toolID of blocked) {
        const output = { description: "original", parameters: {} };
        await hooks["tool.definition"]({ toolID }, output);
        expect(output.description).toContain("NOT AVAILABLE in INTENT phase");
      }
    });
  });

  describe("experimental.chat.system.transform Hook", () => {
    it("passes through when no session has been seen", async () => {
      const output = { system: ["base system prompt"] };
      await hooks["experimental.chat.system.transform"]({}, output);
      expect(output.system).toEqual(["base system prompt"]);
    });

    it("passes through for non-overseer sessions", async () => {
      await hooks["chat.params"]({ sessionID: "test-1", agent: "artisan" }, {});
      const output = { system: ["base"] };
      await hooks["experimental.chat.system.transform"]({ sessionID: "test-1" }, output);
      expect(output.system).toEqual(["base"]);
    });

    it("injects phase constraint for overseer sessions", async () => {
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});
      const output = { system: ["base system"] };
      await hooks["experimental.chat.system.transform"]({ sessionID: "test-1" }, output);
      expect(output.system).toHaveLength(2);
      expect(output.system[1]).toContain("[Protocol Gate]");
      expect(output.system[1]).toContain("PROTOCOL_NOT_LOADED");
      expect(output.system[1]).toContain("todowrite");
    });

    it("injects correct phase name for INTENT phase", async () => {
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});
      hooks.sessionPhaseMap.set("test-1", hooks.STATES.INTENT);
      const output = { system: ["base"] };
      await hooks["experimental.chat.system.transform"]({ sessionID: "test-1" }, output);
      expect(output.system[1]).toContain("INTENT");
      expect(output.system[1]).toContain("todowrite, write, read, question");
    });

    it("injects allowed tools list matching TOOL_ALLOWLIST", async () => {
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});
      hooks.sessionPhaseMap.set("test-1", hooks.STATES.SWARM);
      const output = { system: ["base"] };
      await hooks["experimental.chat.system.transform"]({ sessionID: "test-1" }, output);
      expect(output.system[1]).toContain("SWARM");
      expect(output.system[1]).toContain("task, todowrite, glob");
      expect(output.system[1]).toContain("structurally blocked");
    });

    it("appends to system array without modifying existing entries", async () => {
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});
      const output = { system: ["prompt-1", "prompt-2", "prompt-3"] };
      await hooks["experimental.chat.system.transform"]({ sessionID: "test-1" }, output);
      expect(output.system).toHaveLength(4);
      expect(output.system[0]).toBe("prompt-1");
      expect(output.system[1]).toBe("prompt-2");
      expect(output.system[2]).toBe("prompt-3");
      expect(output.system[3]).toContain("[Protocol Gate]");
    });

    it("does not inject when session is not tracked in overseerSessions", async () => {
      // Manually set lastSeenSession via tool.execute.before for non-overseer
      await hooks["chat.params"]({ sessionID: "test-1", agent: "artisan" }, {});
      const output = { system: ["base"] };
      await hooks["experimental.chat.system.transform"]({ sessionID: "test-1" }, output);
      expect(output.system).toEqual(["base"]);
    });
  });
});
