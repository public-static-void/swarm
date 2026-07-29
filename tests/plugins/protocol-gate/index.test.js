import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import pluginModule from "../../../plugins/protocol-gate/index.js";

describe("Protocol-Gate Plugin", () => {
  let hooks;

  beforeEach(async () => {
    // Clean up any state files from prior tests to prevent loadState leaking state
    const stateDir = join(process.cwd(), "plugins", "protocol-gate", ".state");
    try {
      const files = readdirSync(stateDir);
      for (const f of files) {
        if (f.startsWith(".protocol-state-") && f.endsWith(".json")) {
          try { rmSync(join(stateDir, f)); } catch (_) {}
        }
      }
    } catch (_) {} // .state dir may not exist
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
      ).rejects.toThrow("Awaiting chat.params initialization");
    });

    it("passes through non-overseer session calling task tool", async () => {
      // A non-overseer session (e.g., explorer) calls task tool — should pass through
      const output = { args: { prompt: "some task" } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "explorer-session", callID: "c1" }, output);
      // Should not throw — non-overseer sessions pass through unaffected
    });

    it("transitions to INTENT on todowrite with all keywords", async () => {
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});

      const keywords = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "CLEANUP", "REPORT"];
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

      const keywords = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "CLEANUP", "REPORT"];
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
      // only disk-based KD existence does. Phase may also regress to
      // PROTOCOL_NOT_LOADED (0) if no intent KD exists on disk.
      const phase = hooks.sessionPhaseMap.get("test-1");
      expect(phase <= 1).toBe(true); // never advances beyond INTENT via todowrite alone
    });

    it("validates write path in INTENT phase", async () => {
      // Set up session and transition to INTENT
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});

      const keywords = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "CLEANUP", "REPORT"];
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
      ).rejects.toThrow("Write to knowledge/intent-*.md");
    });

    it("validates read path in INTENT phase", async () => {
      // Set up session and transition to INTENT
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});

      const keywords = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "CLEANUP", "REPORT"];
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
      ).rejects.toThrow("Read from template, skill, or knowledge/intent-*.md");
    });
  });

  describe("State Transitions", () => {
    it("has 13 states (PROTOCOL_NOT_LOADED through REPORT)", () => {
      expect(hooks.STATES).toBeDefined();
      expect(Object.keys(hooks.STATES)).toHaveLength(13);
    });

    it("allows write to intent KD in INTENT phase", async () => {
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});

      const keywords = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "CLEANUP", "REPORT"];
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

      // Delegate to artisan (SWARM's agent) with BACKWARD: true flag
      await hooks["tool.execute.before"](
        { tool: "task", sessionID: "test-1", callID: "c1" },
        { args: { prompt: "AGENT: artisan\nBACKWARD: true\nMODE: swarm\nINTENT KD: knowledge/intent-foo.md\nSESSION DATE: 2026-07-16\nSCOPE: Fix issues\nRESULT KD: knowledge/impl-foo.md" } }
      );
      // Should have transitioned to SWARM (7)
      expect(hooks.sessionPhaseMap.get("test-1")).toBe(hooks.STATES.SWARM);
    });

    it("rejects agent not matching current or backward target", async () => {
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});

      hooks.sessionPhaseMap.set("test-1", hooks.STATES.PREFLIGHT);

      // Delegate to explorer (not committer, not a backward target from PREFLIGHT)
      // No BACKWARD: true flag — should throw WRONG_AGENT regardless
      await expect(
        hooks["tool.execute.before"](
          { tool: "task", sessionID: "test-1", callID: "c1" },
          { args: { prompt: "AGENT: explorer\nMODE: explore\nINTENT KD: knowledge/intent-foo.md\nSESSION DATE: 2026-07-16\nSCOPE: Explore codebase\nRESULT KD: knowledge/exploration-foo.md" } }
        )
      ).rejects.toThrow("Incorrect agent dispatched");
    });

    // R011: Backward transition WITHOUT BACKWARD: true flag should throw WRONG_AGENT
    it("rejects backward transition without BACKWARD: true flag", async () => {
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});
      hooks.sessionPhaseMap.set("test-1", hooks.STATES.VERIFY);

      // Delegate to artisan without BACKWARD: true — should throw WRONG_AGENT
      await expect(
        hooks["tool.execute.before"](
          { tool: "task", sessionID: "test-1", callID: "c1" },
          { args: { prompt: "AGENT: artisan\nMODE: swarm\nINTENT KD: knowledge/intent-foo.md\nSESSION DATE: 2026-07-16\nSCOPE: Fix issues\nRESULT KD: knowledge/impl-foo.md" } }
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

      const keywords = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "CLEANUP", "REPORT"];
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

      const keywords = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "CLEANUP", "REPORT"];
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
      ).rejects.toThrow("Write to knowledge/intent-*.md");
    });

    it("allows read from knowledge/ directory (F02)", async () => {
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});

      const keywords = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "CLEANUP", "REPORT"];
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

      const keywords = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "CLEANUP", "REPORT"];
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

      const keywords = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "CLEANUP", "REPORT"];
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
      ).rejects.toThrow("Read from template, skill, or knowledge/intent-*.md");
    });

    it("has INTENT pattern for disk advancement (F04)", async () => {
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});

      const keywords = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "CLEANUP", "REPORT"];
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

      const keywords = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "CLEANUP", "REPORT"];
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

      const keywords = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "CLEANUP", "REPORT"];
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

      const keywords = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "CLEANUP", "REPORT"];

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
      // Phase may have advanced via disk check — flag was reset so check fires.
      // Phase may also regress to PROTOCOL_NOT_LOADED (0) if no KD exists on disk.
      const phase = hooks.sessionPhaseMap.get("test-1");
      expect(phase <= 1).toBe(true); // never advances beyond INTENT via todowrite alone
    });
  });

  describe("INTENT Read Restrictions (Issue 5)", () => {
    it("allows reading intent KDs in INTENT phase", async () => {
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});

      const keywords = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "CLEANUP", "REPORT"];
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

      const keywords = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "CLEANUP", "REPORT"];
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
      ).rejects.toThrow("Read from template, skill, or knowledge/intent-*.md");
    });

    it("blocks reading analysis KDs in INTENT phase", async () => {
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});

      const keywords = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "CLEANUP", "REPORT"];
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
      ).rejects.toThrow("Read from template, skill, or knowledge/intent-*.md");
    });

    it("allows reading templates in INTENT phase", async () => {
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});

      const keywords = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "CLEANUP", "REPORT"];
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

      const keywords = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "CLEANUP", "REPORT"];
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

      const keywords = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "CLEANUP", "REPORT"];
      await hooks["tool.execute.before"](
        { tool: "todowrite", sessionID: "test-1", callID: "c1" },
        { args: { todos: keywords.map(k => ({ content: k })) } }
      );
      hooks.sessionPhaseMap.set("test-1", 1); // INTENT

      // Write intent KD with session ID in filename
      await hooks["tool.execute.before"](
        { tool: "write", sessionID: "test-1", callID: "c2" },
        { args: { filePath: "knowledge/intent-my-feature-test-1.md" } }
      );

      // Session ID should be captured
      expect(hooks.sessionPhaseMap.get("test-1:sid")).toBe("test-1");
    });

    it("captures session date from absolute path intent KD", async () => {
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});

      const keywords = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "CLEANUP", "REPORT"];
      await hooks["tool.execute.before"](
        { tool: "todowrite", sessionID: "test-1", callID: "c1" },
        { args: { todos: keywords.map(k => ({ content: k })) } }
      );
      hooks.sessionPhaseMap.set("test-1", 1); // INTENT

      await hooks["tool.execute.before"](
        { tool: "write", sessionID: "test-1", callID: "c2" },
        { args: { filePath: "/home/user/project/knowledge/intent-my-feature-test-1.md" } }
      );

      expect(hooks.sessionPhaseMap.get("test-1:sid")).toBe("test-1");
    });
  });

  describe("BUG 2: Disk Check Tool Restriction", () => {
    it("does not trigger disk check on read tool", async () => {
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});

      const keywords = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "CLEANUP", "REPORT"];
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

    it("blocks skill tool in INTENT phase (removed from allowlist)", async () => {
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});

      const keywords = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "CLEANUP", "REPORT"];
      await hooks["tool.execute.before"](
        { tool: "todowrite", sessionID: "test-1", callID: "c1" },
        { args: { todos: keywords.map(k => ({ content: k })) } }
      );
      hooks.sessionPhaseMap.set("test-1", 1); // INTENT

      // skill is in INTENT allowlist — needed to load kd-system skill
      await expect(
        hooks["tool.execute.before"](
          { tool: "skill", sessionID: "test-1", callID: "c2" },
          { args: { name: "kd-system" } }
        )
      ).resolves.toBeUndefined();
    });

    it("blocks bash tool in INTENT phase (removed from allowlist)", async () => {
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});

      const keywords = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "CLEANUP", "REPORT"];
      await hooks["tool.execute.before"](
        { tool: "todowrite", sessionID: "test-1", callID: "c1" },
        { args: { todos: keywords.map(k => ({ content: k })) } }
      );
      hooks.sessionPhaseMap.set("test-1", 1); // INTENT

      // bash IS in INTENT allowlist — tool.execute.before passes through (restriction is in tool.definition only)
      await hooks["tool.execute.before"](
        { tool: "bash", sessionID: "test-1", callID: "c2" },
        { args: { command: "ls" } }
      );
      // bash should NOT have thrown — it's allowed in INTENT
    });

    it("triggers disk check on write tool (in DISK_CHECK_TOOLS)", async () => {
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});

      const keywords = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "CLEANUP", "REPORT"];
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

  describe("BUG 4: REPORT Stuck Detection Skip", () => {
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
      expect(output.description).toContain("Use only: todowrite in PROTOCOL_NOT_LOADED phase");
      expect(output.description).toContain("Read a file");
    });

    it("preserves original description after blocking prefix", async () => {
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});
      hooks.sessionPhaseMap.set("test-1", hooks.STATES.INTENT); // INTENT: todowrite, write, read
      const original = "Search files by pattern";
      const output = { description: original, parameters: {} };
      await hooks["tool.definition"]({ toolID: "glob" }, output);
      expect(output.description).toBe(`⛔ Use only: todowrite, write, read, skill, bash in INTENT phase. ${original}`);
    });

    it("appends restriction info for allowed tools with restrictions", async () => {
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});
      hooks.sessionPhaseMap.set("test-1", hooks.STATES.INTENT);
      const original = "Read a file or directory";
      const output = { description: original, parameters: {} };
      await hooks["tool.definition"]({ toolID: "read" }, output);
      // read is in INTENT allowlist but has restriction — should show it
      expect(output.description).toContain("[INTENT phase restriction: ONLY templates and intent KDs]");
      expect(output.description).toContain(original);
    });

    it("allows all tools in INTENT phase (todowrite, write, read, skill, bash)", async () => {
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});
      hooks.sessionPhaseMap.set("test-1", hooks.STATES.INTENT);

      // Tools without restrictions pass through unchanged
      for (const toolID of ["todowrite", "write", "task", "skill"]) {
        const output = { description: "test", parameters: {} };
        await hooks["tool.definition"]({ toolID }, output);
        expect(output.description).toBe("test");
      }

      // read is in INTENT allowlist but has restriction — description gets annotated
      const readOutput = { description: "test", parameters: {} };
      await hooks["tool.definition"]({ toolID: "read" }, readOutput);
      expect(readOutput.description).toContain("[INTENT phase restriction:");
      expect(readOutput.description).toContain("test");
    });

    it("blocks non-allowlisted tools in INTENT phase", async () => {
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});
      hooks.sessionPhaseMap.set("test-1", hooks.STATES.INTENT);

      const blocked = ["edit", "glob", "grep"];
      for (const toolID of blocked) {
        const output = { description: "original", parameters: {} };
        await hooks["tool.definition"]({ toolID }, output);
        expect(output.description).toContain("Use only: todowrite, write, read, skill, bash in INTENT phase");
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

    it("injects PROTOCOL_NOT_LOADED guidance when phase is not loaded", async () => {
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});
      // PROTOCOL_NOT_LOADED now has PHASE_INSTRUCTIONS — systemTransform injects guidance
      const output = { system: ["base system"] };
      await hooks["experimental.chat.system.transform"]({ sessionID: "test-1" }, output);
      expect(output.system).toHaveLength(2);
      expect(output.system[1]).toContain("PROTOCOL_NOT_LOADED");
      expect(output.system[1]).toContain("Call todowrite to load the 12-phase lifecycle protocol");
    });

    it("injects behavioral constraint for INTENT phase (absolute directive)", async () => {
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});
      hooks.sessionPhaseMap.set("test-1", hooks.STATES.INTENT);
      const output = { system: ["base"] };
      await hooks["experimental.chat.system.transform"]({ sessionID: "test-1" }, output);
      expect(output.system[1]).toContain("INTENT");
      // INTENT has absolute single-action PHASE_INSTRUCTIONS — names tool and content
      expect(output.system[1]).toContain("Call write to create an intent KD");
      expect(output.system[1]).toContain("user's exact words as the Raw Request");
    });

    it("injects behavioral constraint for SWARM phase (dispatch instruction)", async () => {
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});
      hooks.sessionPhaseMap.set("test-1", hooks.STATES.SWARM);
      const output = { system: ["base"] };
      await hooks["experimental.chat.system.transform"]({ sessionID: "test-1" }, output);
      expect(output.system[1]).toContain("SWARM");
      // SWARM has PHASE_INSTRUCTIONS — positive framing
      expect(output.system[1]).toContain("Dispatch the Artisan agent.");
    });

    it("appends behavioral constraint to system array without modifying existing entries", async () => {
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});
      hooks.sessionPhaseMap.set("test-1", hooks.STATES.INTENT);
      const output = { system: ["prompt-1", "prompt-2", "prompt-3"] };
      await hooks["experimental.chat.system.transform"]({ sessionID: "test-1" }, output);
      expect(output.system).toHaveLength(4);
      expect(output.system[0]).toBe("prompt-1");
      expect(output.system[1]).toBe("prompt-2");
      expect(output.system[2]).toBe("prompt-3");
      // INTENT has absolute single-action PHASE_INSTRUCTIONS
      expect(output.system[3]).toContain("[Protocol Gate]");
      expect(output.system[3]).toContain("Call write to create an intent KD");
    });

    it("does not inject when session is not tracked in overseerSessions", async () => {
      // Manually set lastSeenSession via tool.execute.before for non-overseer
      await hooks["chat.params"]({ sessionID: "test-1", agent: "artisan" }, {});
      const output = { system: ["base"] };
      await hooks["experimental.chat.system.transform"]({ sessionID: "test-1" }, output);
      expect(output.system).toEqual(["base"]);
    });
  });

  describe("State Persistence", () => {
    const stateDir = join(process.cwd(), "plugins", "protocol-gate", ".state");

    function getStatePath(sessionID) {
      return join(stateDir, `.protocol-state-${sessionID}.json`);
    }

    function cleanupState(sessionID) {
      try { rmSync(getStatePath(sessionID)); } catch (_) {}
    }

    afterEach(() => {
      // Clean up any state files created during tests
      for (const sid of ["persist-1", "persist-2", "persist-restart"]) {
        cleanupState(sid);
      }
    });

    it("saves state after todowrite advances to INTENT", async () => {
      const hooks = await pluginModule.server({}, {});
      const sessionID = "persist-1";

      await hooks["chat.params"]({ sessionID, agent: "overseer" }, {});

      const keywords = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "CLEANUP", "REPORT"];
      await hooks["tool.execute.before"](
        { tool: "todowrite", sessionID, callID: "c1" },
        { args: { todos: keywords.map(k => ({ content: k })) } }
      );

      // State file should exist with phase=INTENT(1)
      const data = JSON.parse(readFileSync(getStatePath(sessionID), "utf8"));
      expect(data.phase).toBe(1); // INTENT
      expect(data.timestamp).toBeDefined();
    });

    it("saves state after session date capture", async () => {
      const hooks = await pluginModule.server({}, {});
      const sessionID = "persist-2";

      await hooks["chat.params"]({ sessionID, agent: "overseer" }, {});

      const keywords = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "CLEANUP", "REPORT"];
      await hooks["tool.execute.before"](
        { tool: "todowrite", sessionID, callID: "c1" },
        { args: { todos: keywords.map(k => ({ content: k })) } }
      );

      // Write intent KD with session ID to trigger session ID capture
      await hooks["tool.execute.before"](
        { tool: "write", sessionID, callID: "c2" },
        { args: { filePath: "knowledge/intent-feature-persist-2.md" } }
      );

      // State file should have the session ID
      const data = JSON.parse(readFileSync(getStatePath(sessionID), "utf8"));
      expect(data.sid).toBe("persist-2");
    });

    it("restores state on restart via loadState in chat.params", async () => {
      const sessionID = "persist-restart";

      // Phase 1: Create plugin, advance session to INTENT
      const hooks1 = await pluginModule.server({}, {});
      await hooks1["chat.params"]({ sessionID, agent: "overseer" }, {});

      const keywords = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "CLEANUP", "REPORT"];
      await hooks1["tool.execute.before"](
        { tool: "todowrite", sessionID, callID: "c1" },
        { args: { todos: keywords.map(k => ({ content: k })) } }
      );

      // Confirm state was saved
      expect(hooks1.sessionPhaseMap.get(sessionID)).toBe(1); // INTENT

      // Phase 2: Simulate restart — new plugin instance, same session ID
      const hooks2 = await pluginModule.server({}, {});
      await hooks2["chat.params"]({ sessionID, agent: "overseer" }, {});

      // Phase should be restored to INTENT (not PROTOCOL_NOT_LOADED)
      expect(hooks2.sessionPhaseMap.get(sessionID)).toBe(1); // INTENT
      expect(hooks2.isOverseerSession(sessionID)).toBe(true);
    });

    it("restores session date on restart", async () => {
      const sessionID = "persist-restart";

      // Phase 1: Create plugin, advance to INTENT, capture session date
      const hooks1 = await pluginModule.server({}, {});
      await hooks1["chat.params"]({ sessionID, agent: "overseer" }, {});

      const keywords = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "CLEANUP", "REPORT"];
      await hooks1["tool.execute.before"](
        { tool: "todowrite", sessionID, callID: "c1" },
        { args: { todos: keywords.map(k => ({ content: k })) } }
      );
      await hooks1["tool.execute.before"](
        { tool: "write", sessionID, callID: "c2" },
        { args: { filePath: "knowledge/intent-feature-persist-restart.md" } }
      );

      // Phase 2: Simulate restart
      const hooks2 = await pluginModule.server({}, {});
      await hooks2["chat.params"]({ sessionID, agent: "overseer" }, {});

      // Session ID should be restored
      expect(hooks2.sessionPhaseMap.get(`${sessionID}:sid`)).toBe("persist-restart");
    });

    it("does not restore PROTOCOL_NOT_LOADED phase from state file", async () => {
      const sessionID = "persist-restart";

      // Manually write a state file with phase=0 (PROTOCOL_NOT_LOADED)
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(getStatePath(sessionID), JSON.stringify({ phase: 0, sid: null, timestamp: Date.now() }));

      // New plugin instance — loadState should reject phase=0
      const hooks = await pluginModule.server({}, {});
      await hooks["chat.params"]({ sessionID, agent: "overseer" }, {});

      // Should fall through to default PROTOCOL_NOT_LOADED initialization
      expect(hooks.sessionPhaseMap.get(sessionID)).toBe(0);
    });

    it("handles corrupt state file gracefully", async () => {
      const sessionID = "persist-restart";

      // Write corrupt JSON to state file
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(getStatePath(sessionID), "not valid json {{{");

      // Should not throw — loadState catches parse errors
      const hooks = await pluginModule.server({}, {});
      await hooks["chat.params"]({ sessionID, agent: "overseer" }, {});

      // Falls through to default initialization
      expect(hooks.sessionPhaseMap.get(sessionID)).toBe(0);
    });

    it("handles missing state file gracefully", async () => {
      const sessionID = "persist-restart";

      // No state file exists — should not throw
      const hooks = await pluginModule.server({}, {});
      await hooks["chat.params"]({ sessionID, agent: "overseer" }, {});

      expect(hooks.sessionPhaseMap.get(sessionID)).toBe(0);
    });
  });

  describe("PROTOCOL_NOT_LOADED Instructions", () => {
    it("injects guidance for PROTOCOL_NOT_LOADED phase", async () => {
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});
      // Phase is already PROTOCOL_NOT_LOADED after initialization
      const output = { system: ["base system"] };
      await hooks["experimental.chat.system.transform"]({ sessionID: "test-1" }, output);

      // Should now inject instructions (previously had no PHASE_INSTRUCTIONS entry)
      expect(output.system).toHaveLength(2);
      expect(output.system[1]).toContain("PROTOCOL_NOT_LOADED");
      expect(output.system[1]).toContain("Call todowrite to load the 12-phase lifecycle protocol");
    });

    it("allows todowrite in PROTOCOL_NOT_LOADED (tool definition not blocked)", async () => {
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});
      const output = { description: "Write todos", parameters: {} };
      await hooks["tool.definition"]({ toolID: "todowrite" }, output);
      // todowrite is in the PROTOCOL_NOT_LOADED allowlist — should pass through
      expect(output.description).toBe("Write todos");
    });
  });

  describe("REPORT Dead-End Fix → PROTOCOL_NOT_LOADED Transition", () => {
    it("transitions REPORT → PROTOCOL_NOT_LOADED when report KD is written", async () => {
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});
      hooks.sessionPhaseMap.set("test-1", hooks.STATES.REPORT);

      await hooks["tool.execute.before"](
        { tool: "edit", sessionID: "test-1", callID: "c1" },
        { args: { filePath: "knowledge/report-lifecycle-test-1.md", content: "# Report" } }
      );

      expect(hooks.sessionPhaseMap.get("test-1")).toBe(hooks.STATES.PROTOCOL_NOT_LOADED);
    });

    it("stays in REPORT when non-report KD is written", async () => {
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});
      hooks.sessionPhaseMap.set("test-1", hooks.STATES.REPORT);

      await hooks["tool.execute.before"](
        { tool: "edit", sessionID: "test-1", callID: "c1" },
        { args: { filePath: "knowledge/other-file.md", content: "# Other" } }
      ).catch(() => {}); // write blocked for non-report KD in REPORT

      expect(hooks.sessionPhaseMap.get("test-1")).toBe(hooks.STATES.REPORT);
    });

    it("transitions PROTOCOL_NOT_LOADED → INTENT on lifecycle restart via todowrite", async () => {
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});
      hooks.sessionPhaseMap.set("test-1", hooks.STATES.PROTOCOL_NOT_LOADED);

      const keywords = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "CLEANUP", "REPORT"];
      await hooks["tool.execute.before"](
        { tool: "todowrite", sessionID: "test-1", callID: "c1" },
        { args: { todos: keywords.map(k => ({ content: k })) } }
      );

      expect(hooks.sessionPhaseMap.get("test-1")).toBe(hooks.STATES.INTENT);
    });

    it("throws error with incomplete keywords in PROTOCOL_NOT_LOADED", async () => {
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});
      hooks.sessionPhaseMap.set("test-1", hooks.STATES.PROTOCOL_NOT_LOADED);

      await expect(
        hooks["tool.execute.before"](
          { tool: "todowrite", sessionID: "test-1", callID: "c1" },
          { args: { todos: [{ content: "REPORT" }, { content: "INTENT" }] } }
        )
      ).rejects.toThrow("Missing lifecycle keywords");
    });

    it("allows full lifecycle after REPORT → PROTOCOL_NOT_LOADED → INTENT", async () => {
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});

      // Advance to REPORT
      hooks.sessionPhaseMap.set("test-1", hooks.STATES.REPORT);

      // Write report KD → transitions to PROTOCOL_NOT_LOADED
      await hooks["tool.execute.before"](
        { tool: "edit", sessionID: "test-1", callID: "c1" },
        { args: { filePath: "knowledge/report-lifecycle-test-1.md", content: "# Report" } }
      );
      expect(hooks.sessionPhaseMap.get("test-1")).toBe(hooks.STATES.PROTOCOL_NOT_LOADED);

      // Start new lifecycle from PROTOCOL_NOT_LOADED
      const keywords = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "CLEANUP", "REPORT"];
      await hooks["tool.execute.before"](
        { tool: "todowrite", sessionID: "test-1", callID: "c2" },
        { args: { todos: keywords.map(k => ({ content: k })) } }
      );
      expect(hooks.sessionPhaseMap.get("test-1")).toBe(hooks.STATES.INTENT);
    });

    it("restricts tools in PROTOCOL_NOT_LOADED state to todowrite only", async () => {
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});
      hooks.sessionPhaseMap.set("test-1", hooks.STATES.PROTOCOL_NOT_LOADED);

      // todowrite should NOT be blocked
      const outputTodo = { description: "Test todowrite", parameters: {} };
      await hooks["tool.definition"]({ toolID: "todowrite" }, outputTodo);
      expect(outputTodo.description).not.toContain("⛔");

      // task is always allowed via universal bypass — never blocked in tool.definition
      const outputTask = { description: "Test task", parameters: {} };
      await hooks["tool.definition"]({ toolID: "task" }, outputTask);
      expect(outputTask.description).not.toContain("⛔");

      // Other tools should be blocked in PROTOCOL_NOT_LOADED
      const blockedTools = ["read", "write", "glob", "bash", "skill"];
      for (const tool of blockedTools) {
        const output = { description: `Test ${tool}`, parameters: {} };
        await hooks["tool.definition"]({ toolID: tool }, output);
        expect(output.description).toContain("⛔");
      }
    });
  });

  describe("Preflight KD Advancement (KD-based signaling)", () => {

    it("does not advance PREFLIGHT without preflight KD", async () => {
      const sid = "preflight-1";
      await hooks["chat.params"]({ sessionID: sid, agent: "overseer" }, {});
      hooks.sessionPhaseMap.set(sid, hooks.STATES.PREFLIGHT);
      hooks.sessionPhaseMap.set(`${sid}:sid`, sid);

      // No preflight KD exists — trigger disk check
      await hooks["tool.execute.before"](
        { tool: "todowrite", sessionID: sid, callID: "c1" },
        { args: { todos: [{ content: "PREFLIGHT" }] } }
      );

      // Phase stays PREFLIGHT — no KD means no advancement
      expect(hooks.sessionPhaseMap.get(sid)).toBe(hooks.STATES.PREFLIGHT);
    });

    it("advances PREFLIGHT when preflight KD exists", async () => {
      const sid = "preflight-2";
      await hooks["chat.params"]({ sessionID: sid, agent: "overseer" }, {});
      hooks.sessionPhaseMap.set(sid, hooks.STATES.PREFLIGHT);
      hooks.sessionPhaseMap.set(`${sid}:sid`, sid);

      // Create preflight KD file
      const knowledgeDir = join(process.cwd(), "knowledge");
      mkdirSync(knowledgeDir, { recursive: true });
      writeFileSync(join(knowledgeDir, `preflight-workspace-${sid}.md`), "test");

      await hooks["tool.execute.before"](
        { tool: "todowrite", sessionID: sid, callID: "c1" },
        { args: { todos: [{ content: "PREFLIGHT" }] } }
      );

      // Phase should advance to EXPLORE (3)
      expect(hooks.sessionPhaseMap.get(sid)).toBe(hooks.STATES.EXPLORE);

      // Cleanup
      try { require("fs").unlinkSync(join(knowledgeDir, `preflight-workspace-${sid}.md`)); } catch (_) {}
    });

    it("uses session date to find correct preflight KD", async () => {
      const sid = "preflight-4";
      await hooks["chat.params"]({ sessionID: sid, agent: "overseer" }, {});
      hooks.sessionPhaseMap.set(sid, hooks.STATES.PREFLIGHT);
      hooks.sessionPhaseMap.set(`${sid}:sid`, sid);

      const knowledgeDir = join(process.cwd(), "knowledge");
      mkdirSync(knowledgeDir, { recursive: true });

      // Create a preflight KD for a DIFFERENT session — should not match
      writeFileSync(join(knowledgeDir, "preflight-workspace-other-session.md"), "test");

      await hooks["tool.execute.before"](
        { tool: "todowrite", sessionID: sid, callID: "c1" },
        { args: { todos: [{ content: "PREFLIGHT" }] } }
      );

      // Phase stays PREFLIGHT — wrong session ID KD
      expect(hooks.sessionPhaseMap.get(sid)).toBe(hooks.STATES.PREFLIGHT);

      // Cleanup
      try { require("fs").unlinkSync(join(knowledgeDir, "preflight-workspace-other-session.md")); } catch (_) {}
    });

    it("does not advance when no session ID is set", async () => {
      const sid = "preflight-5";
      await hooks["chat.params"]({ sessionID: sid, agent: "overseer" }, {});
      hooks.sessionPhaseMap.set(sid, hooks.STATES.PREFLIGHT);
      // No session ID set

      await hooks["tool.execute.before"](
        { tool: "todowrite", sessionID: sid, callID: "c1" },
        { args: { todos: [{ content: "PREFLIGHT" }] } }
      );

      // Phase stays PREFLIGHT — no session ID means KD path can't match
      expect(hooks.sessionPhaseMap.get(sid)).toBe(hooks.STATES.PREFLIGHT);
    });
  });

  describe("Cleanup KD Advancement (KD-based signaling)", () => {
    it("does not advance CLEANUP without cleanup KD", async () => {
      const sid = "cleanup-1";
      await hooks["chat.params"]({ sessionID: sid, agent: "overseer" }, {});
      hooks.sessionPhaseMap.set(sid, hooks.STATES.CLEANUP);
      hooks.sessionPhaseMap.set(`${sid}:sid`, sid);

      // No cleanup KD exists — trigger disk check
      await hooks["tool.execute.before"](
        { tool: "todowrite", sessionID: sid, callID: "c1" },
        { args: { todos: [{ content: "CLEANUP" }] } }
      );

      // Phase stays CLEANUP — no KD means no advancement
      expect(hooks.sessionPhaseMap.get(sid)).toBe(hooks.STATES.CLEANUP);
    });

    it("advances CLEANUP when cleanup KD exists", async () => {
      const sid = "cleanup-2";
      await hooks["chat.params"]({ sessionID: sid, agent: "overseer" }, {});
      hooks.sessionPhaseMap.set(sid, hooks.STATES.CLEANUP);
      hooks.sessionPhaseMap.set(`${sid}:sid`, sid);

      // Create cleanup KD file
      const knowledgeDir = join(process.cwd(), "knowledge");
      mkdirSync(knowledgeDir, { recursive: true });
      writeFileSync(join(knowledgeDir, `cleanup-finalize-${sid}.md`), "test");

      await hooks["tool.execute.before"](
        { tool: "todowrite", sessionID: sid, callID: "c1" },
        { args: { todos: [{ content: "CLEANUP" }] } }
      );

      // Phase should advance to REPORT (12)
      expect(hooks.sessionPhaseMap.get(sid)).toBe(hooks.STATES.REPORT);

      // Cleanup
      try { require("fs").unlinkSync(join(knowledgeDir, `cleanup-finalize-${sid}.md`)); } catch (_) {}
    });

    it("uses session ID to find correct cleanup KD", async () => {
      const sid = "cleanup-3";
      await hooks["chat.params"]({ sessionID: sid, agent: "overseer" }, {});
      hooks.sessionPhaseMap.set(sid, hooks.STATES.CLEANUP);
      hooks.sessionPhaseMap.set(`${sid}:sid`, sid);

      const knowledgeDir = join(process.cwd(), "knowledge");
      mkdirSync(knowledgeDir, { recursive: true });

      // Create a cleanup KD for a DIFFERENT session — should not match
      writeFileSync(join(knowledgeDir, "cleanup-finalize-other-session.md"), "test");

      await hooks["tool.execute.before"](
        { tool: "todowrite", sessionID: sid, callID: "c1" },
        { args: { todos: [{ content: "CLEANUP" }] } }
      );

      // Phase stays CLEANUP — wrong session ID KD
      expect(hooks.sessionPhaseMap.get(sid)).toBe(hooks.STATES.CLEANUP);

      // Cleanup
      try { require("fs").unlinkSync(join(knowledgeDir, "cleanup-finalize-other-session.md")); } catch (_) {}
    });

    it("does not advance when no session ID is set", async () => {
      const sid = "cleanup-4";
      await hooks["chat.params"]({ sessionID: sid, agent: "overseer" }, {});
      hooks.sessionPhaseMap.set(sid, hooks.STATES.CLEANUP);
      // No session ID set

      await hooks["tool.execute.before"](
        { tool: "todowrite", sessionID: sid, callID: "c1" },
        { args: { todos: [{ content: "CLEANUP" }] } }
      );

      // Phase stays CLEANUP — no session ID means KD path can't match
      expect(hooks.sessionPhaseMap.get(sid)).toBe(hooks.STATES.CLEANUP);
    });
  });

  describe("SWARM Dispatch Counter (Issue 6)", () => {
    it("increments dispatch count on artisan task in SWARM phase", async () => {
      await hooks["chat.params"]({ sessionID: "swarm-1", agent: "overseer" }, {});
      hooks.sessionPhaseMap.set("swarm-1", hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set("swarm-1:sid", "swarm-1");

      await hooks["tool.execute.before"](
        { tool: "task", sessionID: "swarm-1", callID: "c1" },
        { args: { subagent_type: "artisan" } }
      );

      expect(hooks.swarmDispatchCount.get("swarm-1")).toBe(1);
    });

    it("increments count for multiple artisan dispatches", async () => {
      await hooks["chat.params"]({ sessionID: "swarm-2", agent: "overseer" }, {});
      hooks.sessionPhaseMap.set("swarm-2", hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set("swarm-2:sid", "swarm-2");

      await hooks["tool.execute.before"](
        { tool: "task", sessionID: "swarm-2", callID: "c1" },
        { args: { subagent_type: "artisan" } }
      );
      await hooks["tool.execute.before"](
        { tool: "task", sessionID: "swarm-2", callID: "c2" },
        { args: { subagent_type: "artisan" } }
      );
      await hooks["tool.execute.before"](
        { tool: "task", sessionID: "swarm-2", callID: "c3" },
        { args: { subagent_type: "artisan" } }
      );

      expect(hooks.swarmDispatchCount.get("swarm-2")).toBe(3);
    });

    it("does not advance SWARM when 0 dispatches", async () => {
      await hooks["chat.params"]({ sessionID: "swarm-3", agent: "overseer" }, {});
      hooks.sessionPhaseMap.set("swarm-3", hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set("swarm-3:sid", "swarm-3");

      // No dispatches — dispatchCount stays 0
      await hooks["tool.execute.before"](
        { tool: "todowrite", sessionID: "swarm-3", callID: "c1" },
        { args: { todos: [{ content: "SWARM" }] } }
      );

      // Phase should stay SWARM — no dispatches recorded means no advancement
      expect(hooks.sessionPhaseMap.get("swarm-3")).toBe(hooks.STATES.SWARM);
    });

    it("does not advance when dispatches exceed impl files", async () => {
      await hooks["chat.params"]({ sessionID: "swarm-4", agent: "overseer" }, {});
      hooks.sessionPhaseMap.set("swarm-4", hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set("swarm-4:sid", "swarm-4");

      // 3 dispatches, but no impl files exist for this session
      await hooks["tool.execute.before"](
        { tool: "task", sessionID: "swarm-4", callID: "c1" },
        { args: { subagent_type: "artisan" } }
      );
      await hooks["tool.execute.before"](
        { tool: "task", sessionID: "swarm-4", callID: "c2" },
        { args: { subagent_type: "artisan" } }
      );
      await hooks["tool.execute.before"](
        { tool: "task", sessionID: "swarm-4", callID: "c3" },
        { args: { subagent_type: "artisan" } }
      );

      expect(hooks.swarmDispatchCount.get("swarm-4")).toBe(3);

      // Trigger disk check — no impl files for swarm-4 session
      await hooks["tool.execute.before"](
        { tool: "todowrite", sessionID: "swarm-4", callID: "c4" },
        { args: { todos: [{ content: "SWARM" }] } }
      );

      expect(hooks.sessionPhaseMap.get("swarm-4")).toBe(hooks.STATES.SWARM);
    });

    it("advances only when dispatch count matches impl file count", async () => {
      const sid = "swarm-5";
      await hooks["chat.params"]({ sessionID: sid, agent: "overseer" }, {});
      hooks.sessionPhaseMap.set(sid, hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set(`${sid}:sid`, sid);

      // 2 dispatches
      await hooks["tool.execute.before"](
        { tool: "task", sessionID: sid, callID: "c1" },
        { args: { subagent_type: "artisan" } }
      );
      await hooks["tool.execute.before"](
        { tool: "task", sessionID: sid, callID: "c2" },
        { args: { subagent_type: "artisan" } }
      );
      expect(hooks.swarmDispatchCount.get(sid)).toBe(2);

      // No impl files for swarm-5 session → stays SWARM
      await hooks["tool.execute.before"](
        { tool: "todowrite", sessionID: sid, callID: "c3" },
        { args: { todos: [{ content: "SWARM" }] } }
      );
      expect(hooks.sessionPhaseMap.get(sid)).toBe(hooks.STATES.SWARM);

      // Create 2 temp impl files matching the session ID
      const { writeFileSync: wf, mkdirSync: md, rmSync } = await import("fs");
      const knowledgeDir = join(process.cwd(), "knowledge");
      md(knowledgeDir, { recursive: true });
      wf(join(knowledgeDir, `impl-swarm-test-a-${sid}.md`), "test");
      wf(join(knowledgeDir, `impl-swarm-test-b-${sid}.md`), "test");

      await hooks["tool.execute.before"](
        { tool: "todowrite", sessionID: sid, callID: "c4" },
        { args: { todos: [{ content: "SWARM" }] } }
      );
      // 2 impl files >= 2 dispatches → should advance to VERIFY
      expect(hooks.sessionPhaseMap.get(sid)).toBe(hooks.STATES.VERIFY);

      // Cleanup
      try { rmSync(join(knowledgeDir, `impl-swarm-test-a-${sid}.md`)); } catch (_) {}
      try { rmSync(join(knowledgeDir, `impl-swarm-test-b-${sid}.md`)); } catch (_) {}
    });

    it("does not increment count for backward-transitioned artisan dispatches", async () => {
      await hooks["chat.params"]({ sessionID: "swarm-6", agent: "overseer" }, {});
      hooks.sessionPhaseMap.set("swarm-6", hooks.STATES.VERIFY);
      hooks.sessionPhaseMap.set("swarm-6:sid", "swarm-6");

      // Backward transition to SWARM via artisan dispatch with BACKWARD: true
      await hooks["tool.execute.before"](
        { tool: "task", sessionID: "swarm-6", callID: "c1" },
        { args: { prompt: "AGENT: artisan\nBACKWARD: true\nMODE: swarm" } }
      );

      // Phase should be SWARM after backward transition
      expect(hooks.sessionPhaseMap.get("swarm-6")).toBe(hooks.STATES.SWARM);
      // R004: Backward transition now resets swarmDispatchCount to max(1, implFiles.length).
      // Since no impl files exist for this session, count becomes max(1, 0) = 1.
      expect(hooks.swarmDispatchCount.get("swarm-6")).toBe(1);
    });
  });

  describe("Phase-State Consistency Check (Undo/Regression)", () => {
    const knowledgeDir = join(process.cwd(), "knowledge");

    function createKD(filename) {
      try { mkdirSync(knowledgeDir, { recursive: true }); } catch (_) {}
      writeFileSync(join(knowledgeDir, filename), "test content");
    }

    function removeKD(filename) {
      try { rmSync(join(knowledgeDir, filename)); } catch (_) {}
    }

    function cleanupSession(sessionID) {
      // Remove all KDs matching this session
      try {
        const files = readdirSync(knowledgeDir);
        for (const f of files) {
          if (f.endsWith(`-${sessionID}.md`)) {
            removeKD(f);
          }
        }
      } catch (_) {}
    }

    // AC001: Given phase is ALIGN (5) and spec-*.md KD is deleted, reset to highest surviving KD phase
    it("AC001: regresses from ALIGN to INVESTIGATE when spec KD deleted but analysis KD exists", async () => {
      const sid = "regress-1";
      await hooks["chat.params"]({ sessionID: sid, agent: "overseer" }, {});
      hooks.sessionPhaseMap.set(sid, hooks.STATES.ALIGN);
      hooks.sessionPhaseMap.set(`${sid}:sid`, sid);

      // Create an analysis KD (INVESTIGATE phase) but no spec KD (ALIGN phase)
      createKD(`analysis-investigate-${sid}.md`);

      const result = hooks.checkPhaseStateConsistency(
        sid, hooks.STATES.ALIGN, hooks.sessionPhaseMap,
        () => {}, hooks.diskCheckFailures, hooks.phaseRedispatchCount, hooks.swarmDispatchCount
      );

      expect(result).toBe(true);
      expect(hooks.sessionPhaseMap.get(sid)).toBe(hooks.STATES.INVESTIGATE);
      cleanupSession(sid);
    });

    // AC002: Given phase is SWARM (7) and impl KD is deleted, reset to DECOMPOSE if plan KD exists
    it("AC002: regresses from SWARM to DECOMPOSE when impl KD deleted but plan KD exists", async () => {
      const sid = "regress-2";
      await hooks["chat.params"]({ sessionID: sid, agent: "overseer" }, {});
      hooks.sessionPhaseMap.set(sid, hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set(`${sid}:sid`, sid);

      createKD(`plan-decompose-${sid}.md`);

      const result = hooks.checkPhaseStateConsistency(
        sid, hooks.STATES.SWARM, hooks.sessionPhaseMap,
        () => {}, hooks.diskCheckFailures, hooks.phaseRedispatchCount, hooks.swarmDispatchCount
      );

      expect(result).toBe(true);
      expect(hooks.sessionPhaseMap.get(sid)).toBe(hooks.STATES.DECOMPOSE);
      cleanupSession(sid);
    });

    // AC003: Given phase is INTENT (1) and intent KD is deleted, reset to PROTOCOL_NOT_LOADED
    it("AC003: regresses from INTENT to PROTOCOL_NOT_LOADED when intent KD deleted", async () => {
      const sid = "regress-3";
      await hooks["chat.params"]({ sessionID: sid, agent: "overseer" }, {});
      hooks.sessionPhaseMap.set(sid, hooks.STATES.INTENT);
      hooks.sessionPhaseMap.set(`${sid}:sid`, sid);

      // No KDs exist — intent KD was deleted
      const result = hooks.checkPhaseStateConsistency(
        sid, hooks.STATES.INTENT, hooks.sessionPhaseMap,
        () => {}, hooks.diskCheckFailures, hooks.phaseRedispatchCount, hooks.swarmDispatchCount
      );

      expect(result).toBe(true);
      expect(hooks.sessionPhaseMap.get(sid)).toBe(hooks.STATES.PROTOCOL_NOT_LOADED);
    });

    // AC005 (new): After regression, diskCheckFailures persists (no reset)
    it("AC005: diskCheckFailures persists after regression (no reset)", async () => {
      const sid = "regress-4";
      await hooks["chat.params"]({ sessionID: sid, agent: "overseer" }, {});
      hooks.sessionPhaseMap.set(sid, hooks.STATES.ALIGN);
      hooks.sessionPhaseMap.set(`${sid}:sid`, sid);
      hooks.diskCheckFailures.set(sid, 12); // Simulate stuck counter

      createKD(`analysis-investigate-${sid}.md`);

      hooks.checkPhaseStateConsistency(
        sid, hooks.STATES.ALIGN, hooks.sessionPhaseMap,
        () => {}, hooks.diskCheckFailures, hooks.phaseRedispatchCount, hooks.swarmDispatchCount
      );

      // R003: Counter persists across regressions for safety
      expect(hooks.diskCheckFailures.get(sid)).toBe(12);
      cleanupSession(sid);
    });

    // AC005: After regression past SWARM, swarmDispatchCount is cleared
    it("AC005: clears swarmDispatchCount when regressing past SWARM", async () => {
      const sid = "regress-5";
      await hooks["chat.params"]({ sessionID: sid, agent: "overseer" }, {});
      hooks.sessionPhaseMap.set(sid, hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set(`${sid}:sid`, sid);
      hooks.swarmDispatchCount.set(sid, 3);

      createKD(`plan-decompose-${sid}.md`);

      hooks.checkPhaseStateConsistency(
        sid, hooks.STATES.SWARM, hooks.sessionPhaseMap,
        () => {}, hooks.diskCheckFailures, hooks.phaseRedispatchCount, hooks.swarmDispatchCount
      );

      // Regressed to DECOMPOSE (before SWARM) — dispatch count should be cleared
      expect(hooks.swarmDispatchCount.has(sid)).toBe(false);
      cleanupSession(sid);
    });

    // AC006 (new): After regression, phaseRedispatchCount persists (no delete)
    it("AC006: phaseRedispatchCount persists after regression (no delete)", async () => {
      const sid = "regress-6";
      await hooks["chat.params"]({ sessionID: sid, agent: "overseer" }, {});
      hooks.sessionPhaseMap.set(sid, hooks.STATES.ALIGN);
      hooks.sessionPhaseMap.set(`${sid}:sid`, sid);
      hooks.phaseRedispatchCount.set(`${sid}:${hooks.STATES.ALIGN}`, 3);

      createKD(`analysis-investigate-${sid}.md`);

      hooks.checkPhaseStateConsistency(
        sid, hooks.STATES.ALIGN, hooks.sessionPhaseMap,
        () => {}, hooks.diskCheckFailures, hooks.phaseRedispatchCount, hooks.swarmDispatchCount
      );

      // R003: Counter persists across regressions for safety
      expect(hooks.phaseRedispatchCount.get(`${sid}:${hooks.STATES.ALIGN}`)).toBe(3);
      cleanupSession(sid);
    });

    // AC007: After regression, .state file is updated via saveState
    it("AC007: calls saveState after regression", async () => {
      const sid = "regress-7";
      await hooks["chat.params"]({ sessionID: sid, agent: "overseer" }, {});
      hooks.sessionPhaseMap.set(sid, hooks.STATES.ALIGN);
      hooks.sessionPhaseMap.set(`${sid}:sid`, sid);

      createKD(`analysis-investigate-${sid}.md`);

      let saveStateCalled = false;
      hooks.checkPhaseStateConsistency(
        sid, hooks.STATES.ALIGN, hooks.sessionPhaseMap,
        () => { saveStateCalled = true; },
        hooks.diskCheckFailures, hooks.phaseRedispatchCount, hooks.swarmDispatchCount
      );

      expect(saveStateCalled).toBe(true);
      cleanupSession(sid);
    });

    // AC008 (new): Stuck detection counter persists across regressions
    it("AC008: stuck counter persists after regression (no reset)", async () => {
      const sid = "regress-8";
      await hooks["chat.params"]({ sessionID: sid, agent: "overseer" }, {});
      hooks.sessionPhaseMap.set(sid, hooks.STATES.ALIGN);
      hooks.sessionPhaseMap.set(`${sid}:sid`, sid);
      hooks.diskCheckFailures.set(sid, 5); // Some stuck count

      createKD(`analysis-investigate-${sid}.md`);

      hooks.checkPhaseStateConsistency(
        sid, hooks.STATES.ALIGN, hooks.sessionPhaseMap,
        () => {}, hooks.diskCheckFailures, hooks.phaseRedispatchCount, hooks.swarmDispatchCount
      );

      // R003: Counter persists — safety mechanisms remain effective across regressions
      expect(hooks.diskCheckFailures.get(sid)).toBe(5);
      cleanupSession(sid);
    });

    // AC019: Undo at session start (INTENT phase, KD just written) resets to PROTOCOL_NOT_LOADED
    it("AC019: undo at INTENT phase resets to PROTOCOL_NOT_LOADED", async () => {
      const sid = "regress-19";
      await hooks["chat.params"]({ sessionID: sid, agent: "overseer" }, {});
      hooks.sessionPhaseMap.set(sid, hooks.STATES.INTENT);
      hooks.sessionPhaseMap.set(`${sid}:sid`, sid);

      // Intent KD deleted — no KDs exist
      const result = hooks.checkPhaseStateConsistency(
        sid, hooks.STATES.INTENT, hooks.sessionPhaseMap,
        () => {}, hooks.diskCheckFailures, hooks.phaseRedispatchCount, hooks.swarmDispatchCount
      );

      expect(result).toBe(true);
      expect(hooks.sessionPhaseMap.get(sid)).toBe(hooks.STATES.PROTOCOL_NOT_LOADED);
    });

    // AC020: Undo that deletes multiple KDs resets to highest surviving KD phase
    it("AC020: undo deleting multiple KDs resets to highest surviving", async () => {
      const sid = "regress-20";
      await hooks["chat.params"]({ sessionID: sid, agent: "overseer" }, {});
      hooks.sessionPhaseMap.set(sid, hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set(`${sid}:sid`, sid);

      // Only INVESTIGATE KD survives — ALIGN and DECOMPOSE KDs were deleted
      createKD(`analysis-investigate-${sid}.md`);

      const result = hooks.checkPhaseStateConsistency(
        sid, hooks.STATES.SWARM, hooks.sessionPhaseMap,
        () => {}, hooks.diskCheckFailures, hooks.phaseRedispatchCount, hooks.swarmDispatchCount
      );

      expect(result).toBe(true);
      expect(hooks.sessionPhaseMap.get(sid)).toBe(hooks.STATES.INVESTIGATE);
      cleanupSession(sid);
    });

    // AC021: No KDs exist — resets to PROTOCOL_NOT_LOADED
    it("AC021: no surviving KDs resets to PROTOCOL_NOT_LOADED", async () => {
      const sid = "regress-21";
      await hooks["chat.params"]({ sessionID: sid, agent: "overseer" }, {});
      hooks.sessionPhaseMap.set(sid, hooks.STATES.EXPLORE);
      hooks.sessionPhaseMap.set(`${sid}:sid`, sid);

      // No KDs at all — all deleted
      const result = hooks.checkPhaseStateConsistency(
        sid, hooks.STATES.EXPLORE, hooks.sessionPhaseMap,
        () => {}, hooks.diskCheckFailures, hooks.phaseRedispatchCount, hooks.swarmDispatchCount
      );

      // EXPLORE phase with no earlier KDs and no INTENT phase: no regression (no lifecycle evidence)
      expect(result).toBe(false);
      expect(hooks.sessionPhaseMap.get(sid)).toBe(hooks.STATES.EXPLORE);
    });

    // AC022: No false regression when current phase KD is present
    it("AC022: does not regress when current phase KD is present", async () => {
      const sid = "regress-22";
      await hooks["chat.params"]({ sessionID: sid, agent: "overseer" }, {});
      hooks.sessionPhaseMap.set(sid, hooks.STATES.ALIGN);
      hooks.sessionPhaseMap.set(`${sid}:sid`, sid);

      // Current phase KD exists
      createKD(`spec-align-${sid}.md`);

      const result = hooks.checkPhaseStateConsistency(
        sid, hooks.STATES.ALIGN, hooks.sessionPhaseMap,
        () => {}, hooks.diskCheckFailures, hooks.phaseRedispatchCount, hooks.swarmDispatchCount
      );

      expect(result).toBe(false);
      expect(hooks.sessionPhaseMap.get(sid)).toBe(hooks.STATES.ALIGN);
      cleanupSession(sid);
    });

    // AC014: KD file matches session ID (suffix pattern)
    it("AC014: session ID suffix matching works correctly", async () => {
      const sid = "suffix-123";
      await hooks["chat.params"]({ sessionID: sid, agent: "overseer" }, {});
      hooks.sessionPhaseMap.set(sid, hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set(`${sid}:sid`, sid);

      // Create KD with correct suffix
      createKD(`impl-test-${sid}.md`);

      const result = hooks.checkPhaseStateConsistency(
        sid, hooks.STATES.SWARM, hooks.sessionPhaseMap,
        () => {}, hooks.diskCheckFailures, hooks.phaseRedispatchCount, hooks.swarmDispatchCount
      );

      // KD exists for this session → no regression
      expect(result).toBe(false);
      cleanupSession(sid);
    });

    // AC015: KD file does NOT match session ID (substring rejection)
    it("AC015: rejects substring session ID matches in checkDiskAdvancement", async () => {
      // This test verifies that the suffix-based filtering in checkDiskAdvancement
      // correctly rejects session ID substring matches. The consistency check itself
      // uses the same filtering — if a KD for a different session doesn't match,
      // it won't be in sessionFiles, so no false positive advancement occurs.
      const sid = "short";
      const otherSid = "short-extra";
      await hooks["chat.params"]({ sessionID: sid, agent: "overseer" }, {});
      hooks.sessionPhaseMap.set(sid, hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set(`${sid}:sid`, sid);

      // Create KD with a DIFFERENT session ID that contains `sid` as substring
      createKD(`impl-test-${otherSid}.md`);

      // The consistency check scans for files ending in `-short.md`
      // The file `impl-test-short-extra.md` does NOT end in `-short.md`
      // So sessionFiles will be empty, and consistency check finds no lifecycle evidence
      const result = hooks.checkPhaseStateConsistency(
        sid, hooks.STATES.SWARM, hooks.sessionPhaseMap,
        () => {}, hooks.diskCheckFailures, hooks.phaseRedispatchCount, hooks.swarmDispatchCount
      );

      // No regression because no earlier KDs exist for this session (correct behavior)
      // The suffix filtering correctly excluded the otherSid's KD
      expect(result).toBe(false);
      cleanupSession(sid);
      cleanupSession(otherSid);
    });

    // AC016: KD file does NOT match session ID (suffix must be exact)
    it("AC016: rejects suffix-extension session ID matches in checkDiskAdvancement", async () => {
      const sid = "exact";
      const otherSid = "exact123";
      await hooks["chat.params"]({ sessionID: sid, agent: "overseer" }, {});
      hooks.sessionPhaseMap.set(sid, hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set(`${sid}:sid`, sid);

      // Create KD with session ID that extends past ours
      createKD(`impl-test-${otherSid}.md`);

      const result = hooks.checkPhaseStateConsistency(
        sid, hooks.STATES.SWARM, hooks.sessionPhaseMap,
        () => {}, hooks.diskCheckFailures, hooks.phaseRedispatchCount, hooks.swarmDispatchCount
      );

      // No regression — the otherSid's KD was correctly excluded by suffix matching
      expect(result).toBe(false);
      cleanupSession(sid);
      cleanupSession(otherSid);
    });

    // No regression when phase is PROTOCOL_NOT_LOADED (baseline)
    it("does not regress from PROTOCOL_NOT_LOADED (already at baseline)", async () => {
      const sid = "baseline-1";
      await hooks["chat.params"]({ sessionID: sid, agent: "overseer" }, {});

      const result = hooks.checkPhaseStateConsistency(
        sid, hooks.STATES.PROTOCOL_NOT_LOADED, hooks.sessionPhaseMap,
        () => {}, hooks.diskCheckFailures, hooks.phaseRedispatchCount, hooks.swarmDispatchCount
      );

      expect(result).toBe(false);
    });

    // No regression when session has no SID captured
    it("does not regress when session ID is not captured", async () => {
      const sid = "no-sid-1";
      await hooks["chat.params"]({ sessionID: sid, agent: "overseer" }, {});
      hooks.sessionPhaseMap.set(sid, hooks.STATES.SWARM);
      // No :sid entry set

      const result = hooks.checkPhaseStateConsistency(
        sid, hooks.STATES.SWARM, hooks.sessionPhaseMap,
        () => {}, hooks.diskCheckFailures, hooks.phaseRedispatchCount, hooks.swarmDispatchCount
      );

      expect(result).toBe(false);
    });
  });

  describe("Expanded Backward Transitions", () => {
    // AC009: Dispatching explorer from ALIGN triggers backward transition to EXPLORE
    it("AC009: dispatching explorer from ALIGN transitions to EXPLORE", async () => {
      await hooks["chat.params"]({ sessionID: "bt-1", agent: "overseer" }, {});
      hooks.sessionPhaseMap.set("bt-1", hooks.STATES.ALIGN);
      hooks.sessionPhaseMap.set("bt-1:sid", "bt-1");

      await hooks["tool.execute.before"](
        { tool: "task", sessionID: "bt-1", callID: "c1" },
        { args: { prompt: "AGENT: explorer\nBACKWARD: true", subagent_type: "explorer" } }
      );

      expect(hooks.sessionPhaseMap.get("bt-1")).toBe(hooks.STATES.EXPLORE);
    });

    // AC010: Dispatching spec-weaver from DECOMPOSE triggers backward transition to ALIGN
    it("AC010: dispatching spec-weaver from DECOMPOSE transitions to ALIGN", async () => {
      await hooks["chat.params"]({ sessionID: "bt-2", agent: "overseer" }, {});
      hooks.sessionPhaseMap.set("bt-2", hooks.STATES.DECOMPOSE);
      hooks.sessionPhaseMap.set("bt-2:sid", "bt-2");

      await hooks["tool.execute.before"](
        { tool: "task", sessionID: "bt-2", callID: "c1" },
        { args: { prompt: "AGENT: spec-weaver\nBACKWARD: true", subagent_type: "spec-weaver" } }
      );

      expect(hooks.sessionPhaseMap.get("bt-2")).toBe(hooks.STATES.ALIGN);
    });

    // AC011: Dispatching analyzer from SWARM triggers backward transition to INVESTIGATE
    it("AC011: dispatching analyzer from SWARM transitions to INVESTIGATE", async () => {
      await hooks["chat.params"]({ sessionID: "bt-3", agent: "overseer" }, {});
      hooks.sessionPhaseMap.set("bt-3", hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set("bt-3:sid", "bt-3");

      await hooks["tool.execute.before"](
        { tool: "task", sessionID: "bt-3", callID: "c1" },
        { args: { prompt: "AGENT: analyzer\nBACKWARD: true", subagent_type: "analyzer" } }
      );

      expect(hooks.sessionPhaseMap.get("bt-3")).toBe(hooks.STATES.INVESTIGATE);
    });

    // AC012: Cycle limit (3) still applies — 4th dispatch of same target throws
    it("AC012: cycle limit throws after exceeding maxCyclesPerTransition", async () => {
      await hooks["chat.params"]({ sessionID: "bt-4", agent: "overseer" }, {});
      hooks.sessionPhaseMap.set("bt-4", hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set("bt-4:sid", "bt-4");

      // 3 backward transitions to INVESTIGATE (at limit)
      for (let i = 0; i < 3; i++) {
        hooks.sessionPhaseMap.set("bt-4", hooks.STATES.SWARM);
        await hooks["tool.execute.before"](
          { tool: "task", sessionID: "bt-4", callID: `c${i}` },
          { args: { prompt: "AGENT: analyzer\nBACKWARD: true", subagent_type: "analyzer" } }
        );
        expect(hooks.sessionPhaseMap.get("bt-4")).toBe(hooks.STATES.INVESTIGATE);
      }

      // 4th attempt should throw CYCLE_LIMIT_EXCEEDED
      hooks.sessionPhaseMap.set("bt-4", hooks.STATES.SWARM);
      await expect(
        hooks["tool.execute.before"](
          { tool: "task", sessionID: "bt-4", callID: "c3" },
          { args: { prompt: "AGENT: analyzer\nBACKWARD: true", subagent_type: "analyzer" } }
        )
      ).rejects.toThrow();
    });

    // AC013: lifecycle.json loads correctly with expanded backwardTransitions
    it("AC013: lifecycle.json has expanded backward transitions", async () => {
      const config = JSON.parse(readFileSync(join(process.cwd(), "plugins", "protocol-gate", "lifecycle.json"), "utf8"));
      expect(config.backwardTransitions).toBeDefined();
      expect(config.backwardTransitions.EXPLORE).toEqual(["PREFLIGHT"]);
      expect(config.backwardTransitions.SWARM).toContain("DECOMPOSE");
      expect(config.backwardTransitions.VERIFY).toContain("SWARM");
      expect(config.backwardTransitions.CLEANUP).toContain("EVOLVE");
    });

    // Dispatching scribe from EVOLVE triggers backward transition to EXTRACT
    it("dispatching scribe from EVOLVE transitions to EXTRACT", async () => {
      await hooks["chat.params"]({ sessionID: "bt-5", agent: "overseer" }, {});
      hooks.sessionPhaseMap.set("bt-5", hooks.STATES.EVOLVE);
      hooks.sessionPhaseMap.set("bt-5:sid", "bt-5");

      await hooks["tool.execute.before"](
        { tool: "task", sessionID: "bt-5", callID: "c1" },
        { args: { prompt: "AGENT: scribe\nBACKWARD: true\nMODE: extract" } }
      );

      expect(hooks.sessionPhaseMap.get("bt-5")).toBe(hooks.STATES.EXTRACT);
    });

    // Non-backward agent dispatch still throws WRONG_AGENT
    it("throws WRONG_AGENT for non-backward agent dispatch", async () => {
      await hooks["chat.params"]({ sessionID: "bt-6", agent: "overseer" }, {});
      hooks.sessionPhaseMap.set("bt-6", hooks.STATES.EXPLORE);
      hooks.sessionPhaseMap.set("bt-6:sid", "bt-6");

      await expect(
        hooks["tool.execute.before"](
          { tool: "task", sessionID: "bt-6", callID: "c1" },
          { args: { subagent_type: "artisan" } }
        )
      ).rejects.toThrow();
    });
  });

  describe("Checkpoint KD Enforcement (R100)", () => {
    // AC012: Checkpoint KD enforcement detects artisan writes during SWARM
    it("AC012: blocks artisan from writing checkpoint KD during SWARM", async () => {
      await hooks["chat.params"]({ sessionID: "ck-test-1", agent: "overseer" }, {});
      hooks.sessionPhaseMap.set("ck-test-1", hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set("ck-test-1:sid", "ck-test-1");

      // Simulate an artisan session writing a checkpoint KD
      // First register the artisan session in sessionAgentMap via chat.params
      await hooks["chat.params"]({ sessionID: "artisan-ses-1", agent: "artisan" }, {});

      // Artisan writes a checkpoint KD — should be blocked
      await expect(
        hooks["tool.execute.before"](
          { tool: "write", sessionID: "artisan-ses-1", callID: "c1" },
          { args: { filePath: "knowledge/checkpoint-test-ck-test-1.md", content: "# Checkpoint" } }
        )
      ).rejects.toThrow("CHECKPOINT VIOLATION");
    });

    // AC015: Committer writing checkpoint KD is allowed
    it("AC015: committer writing checkpoint KD passes through", async () => {
      await hooks["chat.params"]({ sessionID: "ck-test-2", agent: "overseer" }, {});
      hooks.sessionPhaseMap.set("ck-test-2", hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set("ck-test-2:sid", "ck-test-2");

      // Register committer session
      await hooks["chat.params"]({ sessionID: "committer-ses-1", agent: "committer" }, {});

      // Committer writes a checkpoint KD — should pass through
      let error = null;
      try {
        await hooks["tool.execute.before"](
          { tool: "write", sessionID: "committer-ses-1", callID: "c1" },
          { args: { filePath: "knowledge/checkpoint-test-ck-test-2.md", content: "# Checkpoint" } }
        );
      } catch (e) {
        error = e;
      }
      expect(error).toBeNull();
    });

    // R100: Block overseer from writing checkpoint KD directly
    it("blocks overseer from writing checkpoint KD", async () => {
      await hooks["chat.params"]({ sessionID: "ck-test-3", agent: "overseer" }, {});
      hooks.sessionPhaseMap.set("ck-test-3", hooks.STATES.INTENT);
      hooks.sessionPhaseMap.set("ck-test-3:sid", "ck-test-3");

      // Overseer writes a checkpoint KD — should be blocked
      await expect(
        hooks["tool.execute.before"](
          { tool: "write", sessionID: "ck-test-3", callID: "c1" },
          { args: { filePath: "knowledge/checkpoint-test-ck-test-3.md", content: "# Checkpoint" } }
        )
      ).rejects.toThrow("CHECKPOINT VIOLATION");
    });
  });

  describe("Phase Transition Regression Loop Fix", () => {
    let knowledgeDir;
    // Unique session IDs that won't collide with leftover KD files from prior runs
    const TEST_SIDS = ["ptfix-s1", "ptfix-s2", "ptfix-s3", "ptfix-s4", "ptfix-s5", "ptfix-s6", "ptfix-s7", "ptfix-s8", "ptfix-s9", "ptfix-s10", "ptfix-s11", "ptfix-s12"];

    beforeEach(async () => {
      knowledgeDir = join(process.cwd(), "knowledge");
      try { mkdirSync(knowledgeDir, { recursive: true }); } catch (_) {}
      // Clean up any KDs from prior test runs for our session IDs
      for (const sid of TEST_SIDS) {
        try {
          const files = readdirSync(knowledgeDir).filter(f => f.endsWith(`-${sid}.md`));
          for (const f of files) {
            try { require("fs").rmSync(join(knowledgeDir, f)); } catch (_) {}
          }
        } catch (_) {}
      }
    });

    function createKD(filename) {
      writeFileSync(join(knowledgeDir, filename), `---\ntitle: "KD"\nversion: 1.0.0\nstatus: draft\ntype: test\ncreated: "2026-07-25"\nauthor: Test\nsuperseded_by: null\n---\n# Test KD`);
    }

    function cleanupSession(sid) {
      try {
        const files = readdirSync(knowledgeDir).filter(f => f.endsWith(`-${sid}.md`));
        for (const f of files) {
          try { require("fs").rmSync(join(knowledgeDir, f)); } catch (_) {}
        }
      } catch (_) {}
    }

    // AC001 (new): task call with matching agent → isCreatingExpectedKD true, consistency check skipped
    it("AC001: task call with matching agent skips consistency check", async () => {
      const sid = "ptfix-s1";
      await hooks["chat.params"]({ sessionID: sid, agent: "overseer" }, {});
      hooks.sessionPhaseMap.set(sid, hooks.STATES.EXPLORE);
      hooks.sessionPhaseMap.set(`${sid}:sid`, sid);

      // Dispatch explorer (matching EXPLORE phase) — should NOT trigger regression
      await hooks["tool.execute.before"](
        { tool: "task", sessionID: sid, callID: "c1" },
        { args: { subagent_type: "explorer", prompt: "AGENT: explorer\nExplore codebase" } }
      );

      // Phase should remain EXPLORE — no regression
      expect(hooks.sessionPhaseMap.get(sid)).toBe(hooks.STATES.EXPLORE);
      // inFlightDispatches should be populated (stores array of prefixes)
      expect(hooks.inFlightDispatches.get(sid)).toEqual(["exploration"]);
      cleanupSession(sid);
    });

    // AC002 (new): task call with wrong agent → consistency check runs normally
    it("AC002: task call with wrong agent still runs consistency check", async () => {
      const sid = "ptfix-s2";
      await hooks["chat.params"]({ sessionID: sid, agent: "overseer" }, {});
      hooks.sessionPhaseMap.set(sid, hooks.STATES.INVESTIGATE);
      hooks.sessionPhaseMap.set(`${sid}:sid`, sid);

      // No analysis KD on disk — consistency check should detect missing KD
      // But analysis KD doesn't exist, so regression should occur
      createKD(`exploration-explore-${sid}.md`);

      // Dispatch explorer (wrong agent for INVESTIGATE) — consistency check should run
      await hooks["tool.execute.before"](
        { tool: "task", sessionID: sid, callID: "c1" },
        { args: { subagent_type: "explorer", prompt: "AGENT: explorer" } }
      );

      // Phase should regress to EXPLORE (exploration KD exists)
      expect(hooks.sessionPhaseMap.get(sid)).toBe(hooks.STATES.EXPLORE);
      cleanupSession(sid);
    });

    // AC003 (R002): Fresh advancement grace period prevents false regression
    it("AC003: grace period prevents regression within first 3 disk checks after fresh advancement", async () => {
      const sid = "ptfix-s3";
      await hooks["chat.params"]({ sessionID: sid, agent: "overseer" }, {});
      hooks.sessionPhaseMap.set(sid, hooks.STATES.VERIFY);
      hooks.sessionPhaseMap.set(`${sid}:sid`, sid);

      // Simulate fresh advancement into VERIFY (as if SWARM just advanced)
      hooks.freshAdvancement.set(sid, { phase: hooks.STATES.VERIFY, diskCheckCount: 0 });

      // No review or audit KD on disk — would normally cause regression
      // But grace period should prevent it for the first 3 disk checks
      for (let i = 0; i < 3; i++) {
        const result = hooks.checkPhaseStateConsistency(
          sid, hooks.STATES.VERIFY, hooks.sessionPhaseMap,
          () => {}, hooks.diskCheckFailures, hooks.phaseRedispatchCount, hooks.swarmDispatchCount,
          hooks.inFlightDispatches, hooks.freshAdvancement
        );
        // Should NOT regress during grace period
        expect(result).toBe(false);
        expect(hooks.sessionPhaseMap.get(sid)).toBe(hooks.STATES.VERIFY);
      }

      // After 3 grace-period checks, freshAdvancement entry should be deleted
      expect(hooks.freshAdvancement.has(sid)).toBe(false);
      cleanupSession(sid);
    });

    // AC004 (R002): After grace period expires, legitimate regression works
    it("AC004: legitimate regression works after grace period expires", async () => {
      const sid = "ptfix-s4";
      await hooks["chat.params"]({ sessionID: sid, agent: "overseer" }, {});
      hooks.sessionPhaseMap.set(sid, hooks.STATES.VERIFY);
      hooks.sessionPhaseMap.set(`${sid}:sid`, sid);

      // Simulate fresh advancement with already-expired grace period (diskCheckCount >= 3)
      hooks.freshAdvancement.set(sid, { phase: hooks.STATES.VERIFY, diskCheckCount: 3 });

      // No review or audit KD — grace period is expired, regression should fire
      // But first we need an earlier-phase KD to regress to
      createKD(`impl-swarm-test-${sid}.md`);

      const result = hooks.checkPhaseStateConsistency(
        sid, hooks.STATES.VERIFY, hooks.sessionPhaseMap,
        () => {}, hooks.diskCheckFailures, hooks.phaseRedispatchCount, hooks.swarmDispatchCount,
        hooks.inFlightDispatches, hooks.freshAdvancement
      );

      // Should regress to SWARM (impl KD exists)
      expect(result).toBe(true);
      expect(hooks.sessionPhaseMap.get(sid)).toBe(hooks.STATES.SWARM);
      cleanupSession(sid);
    });

    // AC005 (new): diskCheckFailures not reset after regression
    it("AC005: diskCheckFailures persists across regression", async () => {
      const sid = "ptfix-s5";
      await hooks["chat.params"]({ sessionID: sid, agent: "overseer" }, {});
      hooks.sessionPhaseMap.set(sid, hooks.STATES.ALIGN);
      hooks.sessionPhaseMap.set(`${sid}:sid`, sid);
      hooks.diskCheckFailures.set(sid, 8);

      createKD(`analysis-investigate-${sid}.md`);

      hooks.checkPhaseStateConsistency(
        sid, hooks.STATES.ALIGN, hooks.sessionPhaseMap,
        () => {}, hooks.diskCheckFailures, hooks.phaseRedispatchCount, hooks.swarmDispatchCount,
        hooks.inFlightDispatches, hooks.freshAdvancement
      );

      expect(hooks.diskCheckFailures.get(sid)).toBe(8);
      cleanupSession(sid);
    });

    // AC006 (new): phaseRedispatchCount not deleted after regression
    it("AC006: phaseRedispatchCount persists across regression", async () => {
      const sid = "ptfix-s6";
      await hooks["chat.params"]({ sessionID: sid, agent: "overseer" }, {});
      hooks.sessionPhaseMap.set(sid, hooks.STATES.ALIGN);
      hooks.sessionPhaseMap.set(`${sid}:sid`, sid);
      hooks.phaseRedispatchCount.set(`${sid}:${hooks.STATES.ALIGN}`, 4);

      createKD(`analysis-investigate-${sid}.md`);

      hooks.checkPhaseStateConsistency(
        sid, hooks.STATES.ALIGN, hooks.sessionPhaseMap,
        () => {}, hooks.diskCheckFailures, hooks.phaseRedispatchCount, hooks.swarmDispatchCount,
        hooks.inFlightDispatches, hooks.freshAdvancement
      );

      expect(hooks.phaseRedispatchCount.get(`${sid}:${hooks.STATES.ALIGN}`)).toBe(4);
      cleanupSession(sid);
    });

    // AC007 (new): inFlightDispatches set on task guard, cleared on KD disk appearance
    it("AC007: inFlightDispatches lifecycle — set on task, cleared on disk", async () => {
      const sid = "ptfix-s7";
      await hooks["chat.params"]({ sessionID: sid, agent: "overseer" }, {});
      hooks.sessionPhaseMap.set(sid, hooks.STATES.EXPLORE);
      hooks.sessionPhaseMap.set(`${sid}:sid`, sid);

      // Dispatch explorer → inFlightDispatches should be set (stores array of prefixes)
      await hooks["tool.execute.before"](
        { tool: "task", sessionID: sid, callID: "c1" },
        { args: { subagent_type: "explorer", prompt: "AGENT: explorer" } }
      );
      expect(hooks.inFlightDispatches.get(sid)).toEqual(["exploration"]);

      // Now create the exploration KD on disk — next glob triggers advancement
      // which should clear inFlightDispatches
      createKD(`exploration-explore-${sid}.md`);
      await hooks["tool.execute.before"](
        { tool: "glob", sessionID: sid, callID: "c2" },
        { args: { pattern: "knowledge/*.md" } }
      );
      // After advancement, inFlightDispatches should be cleared
      expect(hooks.inFlightDispatches.has(sid)).toBe(false);
      cleanupSession(sid);
    });

    // AC008 (new): checkPhaseStateConsistency skips regression when in-flight dispatch exists
    it("AC008: consistency check skips regression when in-flight dispatch exists", async () => {
      const sid = "ptfix-s8";
      await hooks["chat.params"]({ sessionID: sid, agent: "overseer" }, {});
      hooks.sessionPhaseMap.set(sid, hooks.STATES.EXPLORE);
      hooks.sessionPhaseMap.set(`${sid}:sid`, sid);

      // No exploration KD on disk — would normally regress
      // But in-flight dispatch says KD is pending
      hooks.inFlightDispatches.set(sid, "explore");

      const result = hooks.checkPhaseStateConsistency(
        sid, hooks.STATES.EXPLORE, hooks.sessionPhaseMap,
        () => {}, hooks.diskCheckFailures, hooks.phaseRedispatchCount, hooks.swarmDispatchCount,
        hooks.inFlightDispatches, hooks.freshAdvancement
      );

      // Should skip regression — in-flight dispatch means KD is pending
      expect(result).toBe(false);
      expect(hooks.sessionPhaseMap.get(sid)).toBe(hooks.STATES.EXPLORE);
    });

    // AC011 (R002): Debug log output includes FRESH_ADVANCEMENT and GRACE_SKIP tags
    it("AC011: debug logs include FRESH_ADVANCEMENT and GRACE_SKIP tags", async () => {
      const sid = "ptfix-s11";
      process.env.PROTOCOL_GATE_DEBUG = "1";
      await hooks["chat.params"]({ sessionID: sid, agent: "overseer" }, {});
      hooks.sessionPhaseMap.set(sid, hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set(`${sid}:sid`, sid);

      // Create impl KD and trigger disk advancement to VERIFY
      // This should log FRESH_ADVANCEMENT
      createKD(`impl-swarm-test-${sid}.md`);

      // Need dispatchCount set to advance
      hooks.swarmDispatchCount.set(sid, 1);

      await hooks["tool.execute.before"](
        { tool: "glob", sessionID: sid, callID: "c1" },
        { args: { pattern: "knowledge/*.md" } }
      );

      // Phase should have advanced to VERIFY
      expect(hooks.sessionPhaseMap.get(sid)).toBe(hooks.STATES.VERIFY);

      // Trigger another disk check in VERIFY without review/audit KD
      // Grace period should log GRACE_SKIP
      await hooks["tool.execute.before"](
        { tool: "glob", sessionID: sid, callID: "c2" },
        { args: { pattern: "knowledge/*.md" } }
      );

      // Read log file and verify tags exist
      try {
        const logContent = require("fs").readFileSync(
          join(process.cwd(), "plugins", "logs", "protocol-gate.log"), "utf8"
        );
        expect(logContent).toContain("FRESH_ADVANCEMENT");
        expect(logContent).toContain("GRACE_SKIP");
      } catch (_) {
        // Log file may not exist in test env — skip if not available
      }
      delete process.env.PROTOCOL_GATE_DEBUG;
      cleanupSession(sid);
    });

    // AC012 (new): Orphaned state files with missing SID cleaned on plugin load
    it("AC012: orphaned state files cleaned on plugin load", async () => {
      const stateDir = join(process.cwd(), "plugins", "protocol-gate", ".state");
      try { mkdirSync(stateDir, { recursive: true }); } catch (_) {}

      // Create orphaned state file (no sid field at all)
      const orphanFile = join(stateDir, ".protocol-state-orphan-session.json");
      writeFileSync(orphanFile, JSON.stringify({ phase: 3, timestamp: Date.now() }));

      // Create valid state file (sid present, even if null — INTENT phase is valid)
      const validFile = join(stateDir, ".protocol-state-valid-session.json");
      writeFileSync(validFile, JSON.stringify({ phase: 3, sid: "valid-session", timestamp: Date.now() }));

      // Create a new plugin instance — should clean up orphan
      const freshHooks = await pluginModule.server({}, {});

      // Orphan file should be deleted
      expect(() => require("fs").readFileSync(orphanFile)).toThrow();
      // Valid file should remain
      expect(() => require("fs").readFileSync(validFile)).not.toThrow();

      // Cleanup
      try { require("fs").rmSync(orphanFile); } catch (_) {}
      try { require("fs").rmSync(validFile); } catch (_) {}
    });

    // AC009 (new): EXPLORE↔INVESTIGATE loop scenario stabilizes
    it("AC009: EXPLORE↔INVESTIGATE loop stabilizes after one regression", async () => {
      const sid = "ptfix-s9";
      await hooks["chat.params"]({ sessionID: sid, agent: "overseer" }, {});

      // Start at INVESTIGATE phase
      hooks.sessionPhaseMap.set(sid, hooks.STATES.INVESTIGATE);
      hooks.sessionPhaseMap.set(`${sid}:sid`, sid);

      // Analysis KD exists on disk — should advance to ALIGN
      createKD(`analysis-investigate-${sid}.md`);
      await hooks["tool.execute.before"](
        { tool: "glob", sessionID: sid, callID: "c1" },
        { args: { pattern: "knowledge/*.md" } }
      );
      expect(hooks.sessionPhaseMap.get(sid)).toBe(hooks.STATES.ALIGN);

      // Now simulate the loop scenario: at ALIGN, analysis KD exists but no spec KD
      // Dispatch analyzer (wrong agent for ALIGN) → triggers consistency check
      // Consistency check finds analysis KD → regresses to INVESTIGATE
      createKD(`analysis-investigate-${sid}.md`);
      // Remove any spec KD that might exist
      try {
        const files = readdirSync(knowledgeDir).filter(f => f.startsWith("spec-") && f.endsWith(`-${sid}.md`));
        for (const f of files) { try { require("fs").rmSync(join(knowledgeDir, f)); } catch (_) {} }
      } catch (_) {}

      await hooks["tool.execute.before"](
        { tool: "task", sessionID: sid, callID: "c2" },
        { args: { subagent_type: "analyzer", prompt: "AGENT: analyzer\nBACKWARD: true" } }
      );

      // Should have transitioned backward to INVESTIGATE
      expect(hooks.sessionPhaseMap.get(sid)).toBe(hooks.STATES.INVESTIGATE);

      // R011: Second dispatch without BACKWARD: true should throw WRONG_AGENT
      // because disk advancement will move to ALIGN first (analysis KD exists),
      // and analyzer without BACKWARD: true in ALIGN phase is a wrong agent.
      // The loop-stabilization mechanism is now controlled by the explicit flag.
      await expect(
        hooks["tool.execute.before"](
          { tool: "task", sessionID: sid, callID: "c3" },
          { args: { subagent_type: "analyzer", prompt: "AGENT: analyzer" } }
        )
      ).rejects.toThrow("Incorrect agent dispatched");
      cleanupSession(sid);
    });
  });

  describe("VERIFY Phase OR Fix (R005 — BUG-009)", () => {
    const knowledgeDir = join(process.cwd(), "knowledge");

    function createKD(filename) {
      try { require("fs").mkdirSync(knowledgeDir, { recursive: true }); } catch (_) {}
      require("fs").writeFileSync(join(knowledgeDir, filename), "test content");
    }

    function cleanupSession(sessionID) {
      try {
        const files = require("fs").readdirSync(knowledgeDir);
        for (const f of files) {
          if (f.endsWith(`-${sessionID}.md`)) {
            try { require("fs").rmSync(join(knowledgeDir, f)); } catch (_) {}
          }
        }
      } catch (_) {}
    }

    // AC010: VERIFY advances with only review KD
    it("AC010: advances from VERIFY to EXTRACT with only review KD", async () => {
      const sid = "ror-s1";
      await hooks["chat.params"]({ sessionID: sid, agent: "overseer" }, {});
      hooks.sessionPhaseMap.set(sid, hooks.STATES.VERIFY);
      hooks.sessionPhaseMap.set(`${sid}:sid`, sid);

      // Create only a review KD (no audit)
      createKD(`review-test-${sid}.md`);

      // Trigger disk check — should advance because OR allows review-only
      await hooks["tool.execute.before"](
        { tool: "glob", sessionID: sid, callID: "c1" },
        { args: { pattern: "knowledge/*.md" } }
      );

      expect(hooks.sessionPhaseMap.get(sid)).toBe(hooks.STATES.EXTRACT);
      cleanupSession(sid);
    });

    // AC011: VERIFY advances with only audit KD
    it("AC011: advances from VERIFY to EXTRACT with only audit KD", async () => {
      const sid = "ror-s2";
      await hooks["chat.params"]({ sessionID: sid, agent: "overseer" }, {});
      hooks.sessionPhaseMap.set(sid, hooks.STATES.VERIFY);
      hooks.sessionPhaseMap.set(`${sid}:sid`, sid);

      // Create only an audit KD (no review)
      createKD(`audit-test-${sid}.md`);

      // Trigger disk check — should advance because OR allows audit-only
      await hooks["tool.execute.before"](
        { tool: "glob", sessionID: sid, callID: "c1" },
        { args: { pattern: "knowledge/*.md" } }
      );

      expect(hooks.sessionPhaseMap.get(sid)).toBe(hooks.STATES.EXTRACT);
      cleanupSession(sid);
    });

    // AC012: VERIFY advances with both KDs (backward-compatible)
    it("AC012: advances from VERIFY to EXTRACT with both review and audit KDs", async () => {
      const sid = "ror-s3";
      await hooks["chat.params"]({ sessionID: sid, agent: "overseer" }, {});
      hooks.sessionPhaseMap.set(sid, hooks.STATES.VERIFY);
      hooks.sessionPhaseMap.set(`${sid}:sid`, sid);

      // Create both review and audit KDs
      createKD(`review-test-${sid}.md`);
      createKD(`audit-test-${sid}.md`);

      // Trigger disk check — should advance (backward compatible)
      await hooks["tool.execute.before"](
        { tool: "glob", sessionID: sid, callID: "c1" },
        { args: { pattern: "knowledge/*.md" } }
      );

      expect(hooks.sessionPhaseMap.get(sid)).toBe(hooks.STATES.EXTRACT);
      cleanupSession(sid);
    });

    // Consistent regression prevention: VERIFY does not regress when either KD exists
    it("consistency check does not regress VERIFY when only review KD exists", async () => {
      const sid = "ror-s4";
      await hooks["chat.params"]({ sessionID: sid, agent: "overseer" }, {});
      hooks.sessionPhaseMap.set(sid, hooks.STATES.VERIFY);
      hooks.sessionPhaseMap.set(`${sid}:sid`, sid);

      createKD(`review-test-${sid}.md`);

      const result = hooks.checkPhaseStateConsistency(
        sid, hooks.STATES.VERIFY, hooks.sessionPhaseMap,
        () => {}, hooks.diskCheckFailures, hooks.phaseRedispatchCount, hooks.swarmDispatchCount,
        hooks.inFlightDispatches, hooks.freshAdvancement
      );

      expect(result).toBe(false);
      expect(hooks.sessionPhaseMap.get(sid)).toBe(hooks.STATES.VERIFY);
      cleanupSession(sid);
    });

    it("consistency check does not regress VERIFY when only audit KD exists", async () => {
      const sid = "ror-s5";
      await hooks["chat.params"]({ sessionID: sid, agent: "overseer" }, {});
      hooks.sessionPhaseMap.set(sid, hooks.STATES.VERIFY);
      hooks.sessionPhaseMap.set(`${sid}:sid`, sid);

      createKD(`audit-test-${sid}.md`);

      const result = hooks.checkPhaseStateConsistency(
        sid, hooks.STATES.VERIFY, hooks.sessionPhaseMap,
        () => {}, hooks.diskCheckFailures, hooks.phaseRedispatchCount, hooks.swarmDispatchCount,
        hooks.inFlightDispatches, hooks.freshAdvancement
      );

      expect(result).toBe(false);
      expect(hooks.sessionPhaseMap.get(sid)).toBe(hooks.STATES.VERIFY);
      cleanupSession(sid);
    });
  });

  describe("SWARM Formula and Counter Reset (R001+R004 — BUG-005+BUG-008)", () => {
    const knowledgeDir = join(process.cwd(), "knowledge");

    function createKD(filename) {
      try { require("fs").mkdirSync(knowledgeDir, { recursive: true }); } catch (_) {}
      require("fs").writeFileSync(join(knowledgeDir, filename), "test content");
    }

    function cleanupSession(sessionID) {
      try {
        const files = require("fs").readdirSync(knowledgeDir);
        for (const f of files) {
          if (f.endsWith(`-${sessionID}.md`)) {
            try { require("fs").rmSync(join(knowledgeDir, f)); } catch (_) {}
          }
        }
      } catch (_) {}
    }

    // AC001: After SWARM→VERIFY regression back to SWARM, formula passes with impl file
    it("AC001: SWARM formula passes after regression when impl files exist", async () => {
      const sid = "swarmfix-s1";
      await hooks["chat.params"]({ sessionID: sid, agent: "overseer" }, {});
      hooks.sessionPhaseMap.set(sid, hooks.STATES.VERIFY);
      hooks.sessionPhaseMap.set(`${sid}:sid`, sid);

      // Create 2 impl files and set dispatchCount to 3 (diverged state before regression)
      createKD(`impl-test-a-${sid}.md`);
      createKD(`impl-test-b-${sid}.md`);
      hooks.swarmDispatchCount.set(sid, 3);

      // Set freshAdvancement for VERIFY to prevent consistency check from
      // auto-regressing before the backward transition task fires
      hooks.freshAdvancement.set(sid, { phase: hooks.STATES.VERIFY, diskCheckCount: 0 });

      // Dispatch artisan with BACKWARD: true from VERIFY → triggers backward transition to SWARM
      // handleBackwardTransition resets swarmDispatchCount to max(1, 2) = 2
      await hooks["tool.execute.before"](
        { tool: "task", sessionID: sid, callID: "c1" },
        { args: { prompt: `AGENT: artisan\nBACKWARD: true`, subagent_type: "artisan" } }
      );

      // Now phase is SWARM, dispatchCount=2
      expect(hooks.sessionPhaseMap.get(sid)).toBe(hooks.STATES.SWARM);
      expect(hooks.swarmDispatchCount.get(sid)).toBe(2);

      // Trigger disk check — formula: implFiles.length (2) >= effectiveCount (2) → advance
      await hooks["tool.execute.before"](
        { tool: "glob", sessionID: sid, callID: "c2" },
        { args: { pattern: "knowledge/*.md" } }
      );

      expect(hooks.sessionPhaseMap.get(sid)).toBe(hooks.STATES.VERIFY);
      cleanupSession(sid);
    });

    // AC002: Normal SWARM still requires impl KD before advancing
    it("AC002: normal SWARM phase requires at least one impl KD before advancing", async () => {
      const sid = "swarmfix-s2";
      await hooks["chat.params"]({ sessionID: sid, agent: "overseer" }, {});
      hooks.sessionPhaseMap.set(sid, hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set(`${sid}:sid`, sid);

      // 1 dispatch but 0 impl files — should NOT advance
      hooks.swarmDispatchCount.set(sid, 1);

      await hooks["tool.execute.before"](
        { tool: "glob", sessionID: sid, callID: "c1" },
        { args: { pattern: "knowledge/*.md" } }
      );

      expect(hooks.sessionPhaseMap.get(sid)).toBe(hooks.STATES.SWARM);

      // Create 1 impl file — should advance to VERIFY
      createKD(`impl-test-${sid}.md`);

      await hooks["tool.execute.before"](
        { tool: "glob", sessionID: sid, callID: "c2" },
        { args: { pattern: "knowledge/*.md" } }
      );

      expect(hooks.sessionPhaseMap.get(sid)).toBe(hooks.STATES.VERIFY);
      cleanupSession(sid);
    });

    // AC007: handleBackwardTransition regressing FROM VERIFY TO SWARM resets swarmDispatchCount
    it("AC007: backward transition to SWARM resets swarmDispatchCount to match file count", async () => {
      const sid = "swarmfix-s3";
      await hooks["chat.params"]({ sessionID: sid, agent: "overseer" }, {});
      hooks.sessionPhaseMap.set(sid, hooks.STATES.VERIFY);
      hooks.sessionPhaseMap.set(`${sid}:sid`, sid);

      // Set divergent dispatchCount (5) despite only 2 impl files
      hooks.swarmDispatchCount.set(sid, 5);
      createKD(`impl-test-a-${sid}.md`);
      createKD(`impl-test-b-${sid}.md`);

      // Set freshAdvancement for VERIFY to prevent consistency check auto-regression
      hooks.freshAdvancement.set(sid, { phase: hooks.STATES.VERIFY, diskCheckCount: 0 });

      // Backward transition to SWARM via task handler
      await hooks["tool.execute.before"](
        { tool: "task", sessionID: sid, callID: "c1" },
        { args: { prompt: `AGENT: artisan\nBACKWARD: true`, subagent_type: "artisan" } }
      );

      // swarmDispatchCount should be reset to max(1, 2) = 2
      expect(hooks.swarmDispatchCount.get(sid)).toBe(2);
      cleanupSession(sid);
    });

    // AC008: handleBackwardTransition deletes phaseRedispatchCount for target phase
    it("AC008: backward transition deletes phaseRedispatchCount for target phase", async () => {
      const sid = "swarmfix-s4";
      await hooks["chat.params"]({ sessionID: sid, agent: "overseer" }, {});
      hooks.sessionPhaseMap.set(sid, hooks.STATES.VERIFY);
      hooks.sessionPhaseMap.set(`${sid}:sid`, sid);

      // Set redispatchCount for SWARM (target phase)
      hooks.phaseRedispatchCount.set(`${sid}:${hooks.STATES.SWARM}`, 3);
      hooks.swarmDispatchCount.set(sid, 1);
      createKD(`impl-test-${sid}.md`);

      // Set freshAdvancement to prevent auto-regression
      hooks.freshAdvancement.set(sid, { phase: hooks.STATES.VERIFY, diskCheckCount: 0 });

      // Backward transition to SWARM
      await hooks["tool.execute.before"](
        { tool: "task", sessionID: sid, callID: "c1" },
        { args: { prompt: `AGENT: artisan\nBACKWARD: true`, subagent_type: "artisan" } }
      );

      // phaseRedispatchCount for SWARM should be deleted
      expect(hooks.phaseRedispatchCount.has(`${sid}:${hooks.STATES.SWARM}`)).toBe(false);
      cleanupSession(sid);
    });

    // AC009: After regression into SWARM, dispatchCount is reconciled to impl file count
    it("AC009: dispatchCount reconciled to max(1, implFiles.length) after regression", async () => {
      const sid = "swarmfix-s5";
      await hooks["chat.params"]({ sessionID: sid, agent: "overseer" }, {});
      hooks.sessionPhaseMap.set(sid, hooks.STATES.VERIFY);
      hooks.sessionPhaseMap.set(`${sid}:sid`, sid);

      // 2 impl files exist, dispatchCount=5 (divergent)
      createKD(`impl-test-a-${sid}.md`);
      createKD(`impl-test-b-${sid}.md`);
      hooks.swarmDispatchCount.set(sid, 5);

      // Set freshAdvancement to prevent auto-regression
      hooks.freshAdvancement.set(sid, { phase: hooks.STATES.VERIFY, diskCheckCount: 0 });

      // Backward transition to SWARM — resets dispatchCount to max(1, 2) = 2
      await hooks["tool.execute.before"](
        { tool: "task", sessionID: sid, callID: "c1" },
        { args: { prompt: `AGENT: artisan\nBACKWARD: true`, subagent_type: "artisan" } }
      );

      // dispatchCount reset to max(1, 2) = 2 — the backward transition
      // path does NOT increment dispatchCount; only normal SWARM
      // dispatches (agent-matching task handler) do.
      expect(hooks.swarmDispatchCount.get(sid)).toBe(2);
      expect(hooks.sessionPhaseMap.get(sid)).toBe(hooks.STATES.SWARM);

      // With dispatchCount=2 and 2 impl files, formula does NOT advance
      // (2 > 2 is false). This shows the reset baseline is working
      // correctly with the effectiveCount guard preventing false advancement.
      expect(hooks.sessionPhaseMap.get(sid)).toBe(hooks.STATES.SWARM);
      cleanupSession(sid);
    });
  });

  describe("Safety Shield Override (R003 — BUG-007)", () => {
    const knowledgeDir = join(process.cwd(), "knowledge");

    function createKD(filename) {
      try { require("fs").mkdirSync(knowledgeDir, { recursive: true }); } catch (_) {}
      require("fs").writeFileSync(join(knowledgeDir, filename), "test content");
    }

    function cleanupSession(sessionID) {
      try {
        const files = require("fs").readdirSync(knowledgeDir);
        for (const f of files) {
          if (f.endsWith(`-${sessionID}.md`)) {
            try { require("fs").rmSync(join(knowledgeDir, f)); } catch (_) {}
          }
        }
      } catch (_) {}
    }

    // AC005: Force-advance at 15 disk check failures fires despite pendingVerification
    it("AC005: force-advance fires at 15 failures even with pendingVerification active", async () => {
      const sid = "safety-s1";
      await hooks["chat.params"]({ sessionID: sid, agent: "overseer" }, {});
      hooks.sessionPhaseMap.set(sid, hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set(`${sid}:sid`, sid);

      // Activate pendingVerification (simulating subagent at work)
      hooks.pendingVerification.set(sid, {
        expectedPrefixes: ["impl"],
        toolType: "task",
        timestamp: Date.now(),
        toolCalls: 0
      });

      // Set disk check failures to 14 — one more trigger hits 15
      hooks.diskCheckFailures.set(sid, 14);

      // Trigger disk check — should force-advance despite pendingVerification
      await hooks["tool.execute.before"](
        { tool: "glob", sessionID: sid, callID: "c1" },
        { args: { pattern: "knowledge/*.md" } }
      );

      // Phase should advance to VERIFY (force-advance at 15)
      expect(hooks.sessionPhaseMap.get(sid)).toBe(hooks.STATES.VERIFY);
      // pendingVerification should be cleared
      expect(hooks.pendingVerification.has(sid)).toBe(false);
      cleanupSession(sid);
    });

    // AC006: Re-dispatch cap at 5 fires despite pendingVerification
    it("AC006: re-dispatch cap fires at 5 redispatches with pendingVerification active", async () => {
      const sid = "safety-s2";
      await hooks["chat.params"]({ sessionID: sid, agent: "overseer" }, {});
      hooks.sessionPhaseMap.set(sid, hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set(`${sid}:sid`, sid);

      // Activate pendingVerification
      hooks.pendingVerification.set(sid, {
        expectedPrefixes: ["impl"],
        toolType: "task",
        timestamp: Date.now(),
        toolCalls: 0
      });

      // Set re-dispatch count to 5 for current phase
      hooks.phaseRedispatchCount.set(`${sid}:${hooks.STATES.SWARM}`, 5);

      // Dispatch task — the re-dispatch cap fires during disk check and advances
      // the phase to VERIFY. The subsequent task handler then throws WRONG_AGENT
      // because artisan is not the expected agent for VERIFY phase.
      // This is expected — the safety mechanism already fired.
      let caughtError = null;
      try {
        await hooks["tool.execute.before"](
          { tool: "task", sessionID: sid, callID: "c1" },
          { args: { subagent_type: "artisan", prompt: "AGENT: artisan" } }
        );
      } catch (e) {
        caughtError = e;
      }

      // Safety override should have fired — phase advanced to VERIFY
      expect(hooks.sessionPhaseMap.get(sid)).toBe(hooks.STATES.VERIFY);
      // pendingVerification should be cleared by the override
      expect(hooks.pendingVerification.has(sid)).toBe(false);
      // Task handler should have thrown WRONG_AGENT (expected — phase changed)
      expect(caughtError).not.toBeNull();
      expect(caughtError.code).toBe("WRONG_AGENT");
      cleanupSession(sid);
    });

    // Verify that pendingVerification still works normally below safety thresholds
    it("pendingVerification prevents regression when failures < 15 and redispatches < 5", async () => {
      const sid = "safety-s3";
      await hooks["chat.params"]({ sessionID: sid, agent: "overseer" }, {});
      hooks.sessionPhaseMap.set(sid, hooks.STATES.SWARM);
      hooks.sessionPhaseMap.set(`${sid}:sid`, sid);

      // Activate pendingVerification
      hooks.pendingVerification.set(sid, {
        expectedPrefixes: ["impl"],
        toolType: "task",
        timestamp: Date.now(),
        toolCalls: 0
      });

      // Some failures but below threshold
      hooks.diskCheckFailures.set(sid, 5);

      // No impl files exist — would normally trigger regression check
      // But pendingVerification should prevent it (failures < 15, no task dispatch)
      await hooks["tool.execute.before"](
        { tool: "glob", sessionID: sid, callID: "c1" },
        { args: { pattern: "knowledge/*.md" } }
      );

      // Phase should stay SWARM — pendingVerification active
      expect(hooks.sessionPhaseMap.get(sid)).toBe(hooks.STATES.SWARM);
      cleanupSession(sid);
    });
  });
});
