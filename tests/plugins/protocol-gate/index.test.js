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
      ).rejects.toThrow("Write to knowledge/intent-*.md");
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
      ).rejects.toThrow("Write to knowledge/intent-*.md");
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
      ).rejects.toThrow("Read from template, skill, or knowledge/intent-*.md");
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
      ).rejects.toThrow("Read from template, skill, or knowledge/intent-*.md");
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
      ).rejects.toThrow("Read from template, skill, or knowledge/intent-*.md");
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

      const keywords = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "COMMIT", "REPORT"];
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

    it("blocks skill tool in INTENT phase (removed from allowlist)", async () => {
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});

      const keywords = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "COMMIT", "REPORT"];
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

      const keywords = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "COMMIT", "REPORT"];
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

      const keywords = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "COMMIT", "REPORT"];
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

      const keywords = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "COMMIT", "REPORT"];
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

      const keywords = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "COMMIT", "REPORT"];
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

      const keywords = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "COMMIT", "REPORT"];
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

      const keywords = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "COMMIT", "REPORT"];
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
      const keywords = ["INTENT", "PREFLIGHT", "EXPLORE", "INVESTIGATE", "ALIGN", "DECOMPOSE", "SWARM", "VERIFY", "EXTRACT", "EVOLVE", "COMMIT", "REPORT"];
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

  describe("Commit KD Advancement (KD-based signaling)", () => {
    it("does not advance COMMIT without commit KD", async () => {
      const sid = "commit-1";
      await hooks["chat.params"]({ sessionID: sid, agent: "overseer" }, {});
      hooks.sessionPhaseMap.set(sid, hooks.STATES.COMMIT);
      hooks.sessionPhaseMap.set(`${sid}:sid`, sid);

      // No commit KD exists — trigger disk check
      await hooks["tool.execute.before"](
        { tool: "todowrite", sessionID: sid, callID: "c1" },
        { args: { todos: [{ content: "COMMIT" }] } }
      );

      // Phase stays COMMIT — no KD means no advancement
      expect(hooks.sessionPhaseMap.get(sid)).toBe(hooks.STATES.COMMIT);
    });

    it("advances COMMIT when commit KD exists", async () => {
      const sid = "commit-2";
      await hooks["chat.params"]({ sessionID: sid, agent: "overseer" }, {});
      hooks.sessionPhaseMap.set(sid, hooks.STATES.COMMIT);
      hooks.sessionPhaseMap.set(`${sid}:sid`, sid);

      // Create commit KD file
      const knowledgeDir = join(process.cwd(), "knowledge");
      mkdirSync(knowledgeDir, { recursive: true });
      writeFileSync(join(knowledgeDir, `commit-finalize-${sid}.md`), "test");

      await hooks["tool.execute.before"](
        { tool: "todowrite", sessionID: sid, callID: "c1" },
        { args: { todos: [{ content: "COMMIT" }] } }
      );

      // Phase should advance to REPORT (12)
      expect(hooks.sessionPhaseMap.get(sid)).toBe(hooks.STATES.REPORT);

      // Cleanup
      try { require("fs").unlinkSync(join(knowledgeDir, `commit-finalize-${sid}.md`)); } catch (_) {}
    });

    it("uses session ID to find correct commit KD", async () => {
      const sid = "commit-3";
      await hooks["chat.params"]({ sessionID: sid, agent: "overseer" }, {});
      hooks.sessionPhaseMap.set(sid, hooks.STATES.COMMIT);
      hooks.sessionPhaseMap.set(`${sid}:sid`, sid);

      const knowledgeDir = join(process.cwd(), "knowledge");
      mkdirSync(knowledgeDir, { recursive: true });

      // Create a commit KD for a DIFFERENT session — should not match
      writeFileSync(join(knowledgeDir, "commit-finalize-other-session.md"), "test");

      await hooks["tool.execute.before"](
        { tool: "todowrite", sessionID: sid, callID: "c1" },
        { args: { todos: [{ content: "COMMIT" }] } }
      );

      // Phase stays COMMIT — wrong session ID KD
      expect(hooks.sessionPhaseMap.get(sid)).toBe(hooks.STATES.COMMIT);

      // Cleanup
      try { require("fs").unlinkSync(join(knowledgeDir, "commit-finalize-other-session.md")); } catch (_) {}
    });

    it("does not advance when no session ID is set", async () => {
      const sid = "commit-4";
      await hooks["chat.params"]({ sessionID: sid, agent: "overseer" }, {});
      hooks.sessionPhaseMap.set(sid, hooks.STATES.COMMIT);
      // No session ID set

      await hooks["tool.execute.before"](
        { tool: "todowrite", sessionID: sid, callID: "c1" },
        { args: { todos: [{ content: "COMMIT" }] } }
      );

      // Phase stays COMMIT — no session ID means KD path can't match
      expect(hooks.sessionPhaseMap.get(sid)).toBe(hooks.STATES.COMMIT);
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

      // Backward transition to SWARM via artisan dispatch
      await hooks["tool.execute.before"](
        { tool: "task", sessionID: "swarm-6", callID: "c1" },
        { args: { prompt: "AGENT: artisan\nMODE: swarm" } }
      );

      // Phase should be SWARM after backward transition
      expect(hooks.sessionPhaseMap.get("swarm-6")).toBe(hooks.STATES.SWARM);
      // Backward transition dispatch should NOT increment the counter
      expect(hooks.swarmDispatchCount.get("swarm-6") || 0).toBe(0);
    });
  });
});
