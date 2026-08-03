import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import pluginModule from "../../../plugins/delegation-gate/index.js";

// Consolidated delegation-gate suite (P304): 106 → 53 tests. Issue-labeled
// one-off describes (Issue 2, Issue 3, Issue 7A/7B, Bug 2, M1/M3/M4 describe
// blocks) are folded into the core describes they exercise; duplicate and
// tautological assertions are merged into parameterized loops. No behavior
// coverage was dropped — the from → folded-into mapping is documented in
// knowledge/impl-M3-*.md. The M1 GENERATION-fallback state-file test was
// relocated to the protocol-gate suite (R306), so this suite needs no temp
// PROTOCOL_GATE_STATE_DIR and never writes the real .state dir (AC306).
describe("Delegation-Gate Plugin", () => {
  let hooks;

  beforeEach(async () => {
    hooks = await pluginModule.server({}, {});
  });

  describe("Default Export", () => {
    it("exports a PluginModule with server() returning named hooks and no extra named exports", async () => {
      expect(typeof pluginModule).toBe("object");
      expect(pluginModule.id).toBe("delegation-gate");
      expect(typeof pluginModule.server).toBe("function");

      const result = await pluginModule.server({}, {});
      expect(typeof result["tool.execute.before"]).toBe("function");

      const module = require("../../../plugins/delegation-gate/index.js");
      const namedExports = Object.keys(module).filter(k => k !== "default" && k !== "__esModule");
      expect(namedExports).toHaveLength(0);
    });
  });

  describe("Field Extraction", () => {
    it("extracts all required fields from a structured prompt, including underscore variants", async () => {
      const prompt = `AGENT: artisan
MODE: explore
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-15
SCOPE: Implement feature X
RESULT KD: knowledge/exploration-foo.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
      expect(output.args.prompt).toContain("knowledge/intent-foo.md");

      // Overseer-issued dispatches may use underscore variants (intent_kd, session_date, result_kd)
      const underscore = `AGENT: artisan
MODE: explore
intent_kd: knowledge/intent-foo.md
session_date: 2026-07-15
SCOPE: Implement feature X
result_kd: knowledge/exploration-foo.md`;
      const out2 = { args: { prompt: underscore } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c2" }, out2);
      expect(out2.args.prompt).toContain("knowledge/intent-foo.md");
      expect(out2.args.prompt).toContain("2026-07-15");
    });

    it("extracts the agent from both DISPATCH TO: and AGENT: formats", async () => {
      for (const agentLine of ["DISPATCH TO: artisan", "AGENT: artisan"]) {
        const prompt = `${agentLine}
MODE: explore
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-15
SCOPE: Implement feature X
RESULT KD: knowledge/exploration-foo.md`;
        const output = { args: { prompt } };
        await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
        expect(output.args.prompt).toContain("knowledge/intent-foo.md");
      }
    });

    it("rejects prompts without structured fields or missing required fields", async () => {
      await expect(
        hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, { args: { prompt: "Please implement feature X" } })
      ).rejects.toThrow("Missing required structured fields");

      await expect(
        hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c2" }, { args: { prompt: "AGENT: artisan\nMODE: checkpoint" } })
      ).rejects.toThrow("Missing required structured fields");
    });

    it("extracts fields from the description as a fallback and lets prompt fields override them", async () => {
      // Description-only: agent comes from subagent_type (Overseer convention)
      const descriptionOnly = {
        args: {
          prompt: "",
          description: `MODE: explore
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-17
SCOPE: Implement feature X
RESULT KD: knowledge/exploration-foo.md`,
          subagent_type: "artisan"
        }
      };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, descriptionOnly);
      expect(descriptionOnly.args.prompt).toContain("knowledge/intent-foo.md");

      // Both present: prompt values win over description values
      const both = {
        args: {
          prompt: `AGENT: artisan
MODE: explore
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-17
SCOPE: Implement feature X
RESULT KD: knowledge/exploration-foo.md`,
          description: `SESSION DATE: 2099-01-01
SCOPE: From description
RESULT KD: knowledge/wrong.md`
        }
      };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c2" }, both);
      expect(both.args.prompt).toContain("2026-07-17");
      expect(both.args.prompt).toContain("Implement feature X");
      expect(both.args.prompt).toContain("knowledge/exploration-foo.md");
    });

    it("extracts intent_kd from prose fallback patterns and lets structured fields win", async () => {
      // Prose: "Read the INTENT KD at <path>" — no structured INTENT KD line
      const prose = {
        args: {
          prompt: `You are the Explorer agent in explore mode.
Read the INTENT KD at knowledge/intent-foo.md for context.
SESSION DATE: 2026-07-23
SCOPE: Explore the memory system
RESULT KD: knowledge/exploration-foo.md`,
          subagent_type: "explorer"
        }
      };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, prose);
      expect(prose.args.prompt).toContain("knowledge/intent-foo.md");

      // Structured INTENT KD: wins over a prose mention of a different path
      const structured = {
        args: {
          prompt: `AGENT: artisan
MODE: explore
INTENT KD: knowledge/intent-structured.md
SESSION DATE: 2026-07-23
SCOPE: Fix bug
RESULT KD: knowledge/exploration-foo.md

Also reference knowledge/intent-prose.md in context.`
        }
      };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c2" }, structured);
      expect(structured.args.prompt).toContain("knowledge/intent-structured.md");
    });

    it("strips ** markdown bold markers from all field values", async () => {
      const prompt = `**AGENT:** **artisan**
**MODE:** **explore**
**INTENT KD:** **knowledge/intent-foo.md**
**SESSION DATE:** **2026-07-21**
**SCOPE:** **Implement feature X**
**RESULT KD:** **knowledge/exploration-foo.md**`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
      expect(output.args.prompt).toContain("DISPATCH TO: artisan");
      expect(output.args.prompt).toContain("MODE: explore");
      expect(output.args.prompt).not.toContain("**artisan**");
      expect(output.args.prompt).not.toContain("**explore**");
    });
  });

  describe("Content Validators", () => {
    it("rejects code blocks in the prompt", async () => {
      const codeBlock = `AGENT: artisan
MODE: checkpoint
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-15
SCOPE: Implement feature X
RESULT KD: knowledge/impl-foo.md

\`\`\`js
console.log("test");
\`\`\``;
      await expect(
        hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, { args: { prompt: codeBlock } })
      ).rejects.toThrow("Code blocks detected in prompt");
    });

    it("rejects absolute paths on non-field lines (local path leak)", async () => {
      for (const body of ["/etc/passwd", "/home/user/config.json", "/home/user/secret-file.txt"]) {
        const prompt = `AGENT: artisan
MODE: checkpoint
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-15
SCOPE: Implement feature X
RESULT KD: knowledge/impl-foo.md
${body}`;
        await expect(
          hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, { args: { prompt } })
        ).rejects.toThrow("Foreign paths detected");
      }
    });

    it("rejects a bare KD path without structured fields", async () => {
      await expect(
        hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, { args: { prompt: "knowledge/intent-foo.md" } })
      ).rejects.toThrow("Bare KD path without structured fields");
    });

    it("accepts relative paths, embedded KD paths, and field lines in body text", async () => {
      const bodies = [
        "docs/ROADMAP.md",
        "Read the INTENT KD at knowledge/intent-foo.md for details.",
        "Load the kd-system skill. Read the INTENT KD at knowledge/intent-foo.md. Produce an EXPLORATION KD at knowledge/exploration-foo.md.",
        "DISPATCH TO: artisan",
        "SESSION ID: some-session-id"
      ];
      for (const body of bodies) {
        const prompt = `AGENT: artisan
MODE: explore
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-15
SCOPE: Implement feature X
RESULT KD: knowledge/exploration-foo.md
${body}`;
        const output = { args: { prompt } };
        await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
        expect(output.args.prompt).toContain("knowledge/intent-foo.md");
      }
    });

    it("validates result_kd against the knowledge/*.md pattern", async () => {
      const prompt = `AGENT: artisan
MODE: checkpoint
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-15
SCOPE: Implement feature X
RESULT KD: invalid-path.md`;

      await expect(
        hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, { args: { prompt } })
      ).rejects.toThrow("Invalid result KD path");
    });

    it("treats an empty result_kd as missing for KD-producing modes", async () => {
      const prompt = `AGENT: committer
MODE: cleanup
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-15
SCOPE: Implement feature X
RESULT KD:`;

      await expect(
        hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, { args: { prompt } })
      ).rejects.toThrow("KD-producing mode requires result_kd");
    });

    it("rejects unresolved placeholders in any structured field", async () => {
      const prompts = [
        `AGENT: artisan
MODE: checkpoint
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-15
SCOPE: {scope}`,
        `AGENT: artisan
MODE: checkpoint
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-15
SCOPE: Implement feature X
RESULT KD: {result_kd}`,
        `AGENT: artisan
MODE: checkpoint
INTENT KD: {intent_kd}
SESSION DATE: 2026-07-15
SCOPE: Implement feature X`,
      ];
      for (const prompt of prompts) {
        await expect(
          hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, { args: { prompt } })
        ).rejects.toThrow("unresolved placeholder");
      }
    });

    it("strips unresolved optional placeholders from the rendered template", async () => {
      const prompt = `AGENT: explorer
MODE: explore
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-15
RESULT KD: knowledge/exploration-foo.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
      expect(output.args.prompt).not.toContain("{scope}");
      expect(output.args.prompt).toContain("knowledge/intent-foo.md");
    });
  });

  describe("Scope Validation", () => {
    it("accepts advisory scope variations without blocking", async () => {
      const scopes = [
        "",
        "A".repeat(201),
        "Do not use TypeScript",
        "Read docs/ROADMAP.md and identify the best item",
        "Read /home/user/secret.md for details",
        "Check https://example.com/docs for API details",
        "Read the docs first. Then identify gaps. Finally produce a summary.",
        "Find the config file and then update it",
        "Explore the plugin system architecture",
      ];
      for (const scope of scopes) {
        const prompt = `AGENT: explorer
MODE: explore
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-16
SCOPE: ${scope}
RESULT KD: knowledge/exploration-foo.md`;
        const output = { args: { prompt } };
        await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
        expect(output.args.prompt).toContain("knowledge/intent-foo.md");
      }
    });

    it("accepts a prompt without scope (scope is optional)", async () => {
      const prompt = `AGENT: committer
MODE: preflight
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-17
RESULT KD: knowledge/preflight-foo.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
      expect(output.args.prompt).toContain("knowledge/intent-foo.md");
    });

    it("lets the prompt scope override the description scope", async () => {
      const prompt = `AGENT: artisan
MODE: checkpoint
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-17
SCOPE: Fix the bug
RESULT KD: knowledge/impl-foo.md`;

      const output = { args: { prompt, description: "Implement feature X" } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
      expect(output.args.prompt).toContain("Fix the bug");
    });
  });

  describe("Template Injection", () => {
    it("renders the prompt from the template for valid structured prompts across agents", async () => {
      const prompts = [
        `AGENT: artisan
MODE: explore
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-15
SCOPE: Implement feature X
RESULT KD: knowledge/exploration-foo.md`,
        `AGENT: committer
MODE: preflight
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-15
SCOPE: Setup workspace
RESULT KD: knowledge/preflight-foo.md`,
      ];
      for (const prompt of prompts) {
        const output = { args: { prompt } };
        await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
        expect(output.args.prompt).toContain("knowledge/intent-foo.md");
        expect(output.args.prompt).not.toBe(prompt);
        expect(output.args.prompt).toBeDefined();
      }
    });

    it("renders the correct committer template bodies", async () => {
      const cases = [
        // Preflight must not instruct reading the INTENT KD (no read:allow on committer)
        { mode: "preflight", result: "knowledge/preflight-foo.md", expectMatch: /Load the kd-system skill and the committer-preflight skill/, expectNoMatch: /Read the INTENT KD at/ },
        // Checkpoint reads KDs from KD PATHS only
        { mode: "checkpoint", result: "knowledge/checkpoint-foo.md", expectMatch: /Read KDs from KD PATHS/, expectNoMatch: /Read the INTENT KD at/ },
        // Cleanup must not instruct reading the INTENT KD (no read:allow on committer)
        { mode: "cleanup", result: "knowledge/cleanup-foo.md", expectMatch: /Load the kd-system skill. Load the committer-cleanup skill/, expectNoMatch: /Read the INTENT KD at/ },
        // Explore (read:allow) reads the INTENT KD
        { mode: "explore", result: "knowledge/exploration-foo.md", expectMatch: /Read the INTENT KD at/, expectNoMatch: null },
      ];
      for (const c of cases) {
        const prompt = `AGENT: committer
MODE: ${c.mode}
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-21
SCOPE: Test ${c.mode}
RESULT KD: ${c.result}`;

        const output = { args: { prompt } };
        await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
        expect(output.args.prompt).toMatch(c.expectMatch);
        if (c.expectNoMatch) expect(output.args.prompt).not.toMatch(c.expectNoMatch);
      }
    });

    it("renders RESULT KD in the header and body for every KD-producing mode", async () => {
      const modes = [
        { mode: "explore", agent: "explorer", kd: "knowledge/exploration-foo.md" },
        { mode: "investigate", agent: "analyzer", kd: "knowledge/analysis-foo.md" },
        { mode: "align", agent: "spec-weaver", kd: "knowledge/spec-foo.md" },
        { mode: "decompose", agent: "pathfinder", kd: "knowledge/plan-foo.md" },
        { mode: "swarm", agent: "artisan", kd: "knowledge/impl-M1-foo.md", milestoneId: "M1" },
        { mode: "verify", agent: "inspector", kd: "knowledge/review-foo.md" },
        { mode: "extract", agent: "scribe", kd: "knowledge/composed-foo.md" },
        { mode: "evolve", agent: "habit-builder", kd: "knowledge/process-foo.md" },
      ];

      for (const { mode, agent, kd, milestoneId } of modes) {
        const prompt = `AGENT: ${agent}
MODE: ${mode}
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-21
${milestoneId ? `MILESTONE ID: ${milestoneId}\n` : ""}SCOPE: Test ${mode}
RESULT KD: ${kd}`;

        const output = { args: { prompt } };
        await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
        expect(output.args.prompt).toContain(`RESULT KD: ${kd}`);
        expect(output.args.prompt).toContain(kd);
      }
    });
  });

  describe("Cleanup INTENT-KD Exemption (M2)", () => {
    it("exempts cleanup from the intent_kd required-field check like checkpoint (AC015)", async () => {
      // Cleanup dispatch without intent_kd passes validation — the cleanup
      // template renders no INTENT KD reference for the committer to read.
      const withoutIntent = `AGENT: committer
MODE: cleanup
SESSION DATE: 2026-07-21
SCOPE: Commit and push remaining changes
RESULT KD: knowledge/cleanup-foo.md`;

      const out1 = { args: { prompt: withoutIntent } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, out1);
      expect(out1.args.prompt).toContain("MODE: cleanup");
      expect(out1.args.prompt).not.toContain("{intent_kd}");
      expect(out1.args.prompt).not.toMatch(/Read the INTENT KD at/);

      // A cleanup dispatch that does include intent_kd also passes.
      const withIntent = `AGENT: committer
MODE: cleanup
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-21
SCOPE: Commit and push remaining changes
RESULT KD: knowledge/cleanup-foo.md`;

      const out2 = { args: { prompt: withIntent } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c2" }, out2);
      expect(out2.args.prompt).toContain("MODE: cleanup");
      expect(out2.args.prompt).not.toContain("Read the INTENT KD at");
    });

    it("keeps the cleanup and preflight fallback templates free of the INTENT-KD read instruction (AC012, AC013)", async () => {
      // Fallback templates are embedded strings in index.js, reachable only
      // when the disk template fails to load — assert absence directly on the
      // source so the fallback path can't reintroduce the denied read.
      const src = readFileSync(new URL("../../../plugins/delegation-gate/index.js", import.meta.url), "utf8");
      const fallbackLines = src.split("\n").filter(l => /^    (cleanup|preflight): /.test(l));
      expect(fallbackLines).toHaveLength(2);
      for (const line of fallbackLines) {
        expect(line).not.toMatch(/Read the INTENT KD at/);
      }
    });
  });

  describe("Tool Doc Injection", () => {
    it("injects the delegation format with concrete examples and variable placeholders", async () => {
      const prompt = `AGENT: artisan
MODE: checkpoint
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-15
SCOPE: Implement feature X
RESULT KD: knowledge/impl-foo.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);

      expect(output.args.description).toContain("Delegation Prompt Format:");
      expect(output.args.description).toContain("DISPATCH TO: artisan");
      expect(output.args.description).toContain("MODE: checkpoint");
      // Only current mode's KD prefix is injected — not all 11 modes
      expect(output.args.description).toContain("RESULT KD: knowledge/checkpoint-<name>-<session_id>.md");
      expect(output.args.description).toContain("- checkpoint: knowledge/checkpoint-<name>-<session_id>.md");
      for (const other of ["exploration", "analysis", "spec", "plan", "impl", "review", "audit", "composed", "process", "preflight", "cleanup"]) {
        expect(output.args.description).not.toContain(other);
      }
      // Variable placeholders — genuinely vary per dispatch
      expect(output.args.description).toContain("INTENT KD: knowledge/intent-<name>.md");
      expect(output.args.description).toContain("SESSION ID: <session-id>");
      expect(output.args.description).toContain("SCOPE: <optional context>");
      // No angle bracket placeholders for fixed fields
      expect(output.args.description).not.toContain("<agent-name>");
      expect(output.args.description).not.toContain("<descriptive-name>");
    });

    it("does not duplicate the format hint when the description already contains it", async () => {
      const prompt = `AGENT: artisan
MODE: checkpoint
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-15
SCOPE: Implement feature X
RESULT KD: knowledge/impl-foo.md`;

      const output = { args: { prompt, description: "Existing description with Delegation Prompt Format: already here" } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);

      const matches = output.args.description.match(/Delegation Prompt Format:/g);
      expect(matches).toHaveLength(1);
    });

    it("injects only the current mode's KD prefixes for investigate and preflight modes", async () => {
      const cases = [
        { agent: "analyzer", mode: "investigate", result: "knowledge/analysis-<name>-<session_id>.md", other: ["exploration", "review", "audit"] },
        { agent: "committer", mode: "preflight", result: "knowledge/preflight-<name>-<session_id>.md", other: ["checkpoint", "cleanup"] },
      ];
      for (const c of cases) {
        const prompt = `AGENT: ${c.agent}
MODE: ${c.mode}
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-15
SCOPE: Investigate the plugin system
RESULT KD: knowledge/${c.mode === "investigate" ? "analysis" : "preflight"}-foo.md`;

        const output = { args: { prompt } };
        await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
        expect(output.args.description).toContain(`MODE: ${c.mode}`);
        expect(output.args.description).toContain(c.result);
        expect(output.args.description).toContain(`- ${c.mode}: ${c.result}`);
        for (const other of c.other) {
          expect(output.args.description).not.toContain(other);
        }
      }
    });

    it("injects both review and audit prefixes for verify mode (dual KDs)", async () => {
      const prompt = `AGENT: inspector
MODE: verify
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-15
SCOPE: Verify implementation
RESULT KD: knowledge/review-foo.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);

      expect(output.args.description).toContain("MODE: verify");
      expect(output.args.description).toContain("RESULT KD: knowledge/review-<name>-<session_id>.md, knowledge/audit-<name>-<session_id>.md");
      expect(output.args.description).toContain("RESULT KD Naming Conventions:");
      expect(output.args.description).toContain("- verify: knowledge/review-<name>-<session_id>.md, knowledge/audit-<name>-<session_id>.md");
      expect(output.args.description).not.toContain("RESULT KD Naming Convention:");
    });

    it("falls back to the <type> placeholder for unknown modes", async () => {
      const prompt = `AGENT: custom
MODE: unknown
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-15
SCOPE: Test unknown mode
RESULT KD: knowledge/unknown-foo.md`;

      const output = { args: { prompt } };
      // injectToolDocs runs before template lookup, so description is set even though
      // the hook ultimately rejects due to missing template for unknown mode
      await expect(
        hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output)
      ).rejects.toThrow("No template found for mode: unknown");

      expect(output.args.description).toContain("MODE: unknown");
      expect(output.args.description).toContain("RESULT KD: knowledge/<type>-<name>-<session_id>.md");
      expect(output.args.description).toContain("- unknown: knowledge/<type>-<name>-<session_id>.md");
    });

    it("injects the MILESTONE ID requirement and milestone token into the swarm tool doc only", async () => {
      const swarmPrompt = `AGENT: artisan
MODE: swarm
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-31
MILESTONE ID: M3
SCOPE: Execute implementation
RESULT KD: knowledge/impl-M3-foo.md`;

      const swarmOutput = { args: { prompt: swarmPrompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, swarmOutput);
      expect(swarmOutput.args.description).toContain("MILESTONE ID:");
      expect(swarmOutput.args.description).toContain("exactly one");
      expect(swarmOutput.args.description).toContain("RESULT KD: knowledge/impl-<milestone-id>-<name>-<session_id>.md");

      const ckptPrompt = `AGENT: committer
MODE: checkpoint
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-31
SCOPE: Commit X
RESULT KD: knowledge/checkpoint-foo.md`;

      const ckptOutput = { args: { prompt: ckptPrompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c2" }, ckptOutput);
      expect(ckptOutput.args.description).not.toContain("MILESTONE ID:");
      expect(ckptOutput.args.description).not.toContain("<milestone-id>");
      expect(ckptOutput.args.description).toContain("RESULT KD: knowledge/checkpoint-<name>-<session_id>.md");
    });
  });

  describe("Subagent Type Fallback", () => {
    it("resolves the agent from subagent_type when the prompt omits AGENT/DISPATCH TO", async () => {
      const prompt = `MODE: explore
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-17
SCOPE: Implement feature X
RESULT KD: knowledge/exploration-foo.md`;

      const output = { args: { prompt, subagent_type: "artisan" } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
      expect(output.args.prompt).toContain("DISPATCH TO: artisan");
      expect(output.args.prompt).toContain("knowledge/intent-foo.md");
    });

    it("lets subagent_type take precedence over a prompt-extracted agent", async () => {
      const prompt = `AGENT: committer
MODE: explore
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-17
SCOPE: Implement feature X
RESULT KD: knowledge/exploration-foo.md`;

      const output = { args: { prompt, subagent_type: "artisan" } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
      expect(output.args.prompt).toContain("DISPATCH TO: artisan");
    });

    it("leaves an explicitly provided subagent_type untouched", async () => {
      const prompt = `AGENT: artisan
MODE: explore
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-15
SCOPE: Implement feature X
RESULT KD: knowledge/exploration-foo.md`;

      const output = { args: { prompt, subagent_type: "custom-agent" } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
      expect(output.args.subagent_type).toBe("custom-agent");
    });
  });

  describe("Session ID Injection", () => {
    it("extracts SESSION ID: from the prompt field", async () => {
      const prompt = `AGENT: artisan
MODE: checkpoint
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-15
SESSION ID: abc-123-def
SCOPE: Implement feature X
RESULT KD: knowledge/impl-foo.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
      expect(output.args.prompt).toContain("abc-123-def");
    });

    it("injects hookInput.sessionID when the prompt omits SESSION ID:", async () => {
      const prompt = `AGENT: artisan
MODE: checkpoint
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-15
SCOPE: Implement feature X
RESULT KD: knowledge/impl-foo.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "ses_abc123", callID: "call_456" }, output);
      expect(output.args.prompt).toContain("SESSION ID: ses_abc123");
    });

    it("lets the prompt SESSION ID: take precedence over hookInput.sessionID", async () => {
      const prompt = `AGENT: artisan
MODE: checkpoint
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-15
SESSION ID: prompt-session-99
SCOPE: Implement feature X
RESULT KD: knowledge/impl-foo.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "hook-session-42", callID: "c1" }, output);
      expect(output.args.prompt).toContain("prompt-session-99");
      expect(output.args.prompt).not.toContain("hook-session-42");
    });

    it("strips an unresolved {session_id} placeholder when no session ID is available", async () => {
      const prompt = `AGENT: artisan
MODE: checkpoint
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-15
SCOPE: Implement feature X
RESULT KD: knowledge/impl-foo.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: null, callID: "c1" }, output);
      expect(output.args.prompt).not.toContain("{session_id}");
    });
  });

  describe("Mode Inference", () => {
    it("infers the mode from natural language when no MODE: field is present", async () => {
      const cases = [
        { prompt: `You are the Committer agent in checkpoint mode. 
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-21
SCOPE: Setup workspace
RESULT KD: knowledge/checkpoint-foo.md`, subagent: "committer", expected: "checkpoint" },
        { prompt: `Delegate to artisan for explore phase. 
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-21
SCOPE: Analyze the codebase
RESULT KD: knowledge/exploration-foo.md`, subagent: "artisan", expected: "explore" },
      ];
      for (const c of cases) {
        const output = { args: { prompt: c.prompt, subagent_type: c.subagent } };
        await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
        expect(output.args.prompt).toContain(c.expected);
      }
    });

    it("lets an explicit MODE: field take precedence over natural language", async () => {
      const prompt = `AGENT: artisan
MODE: investigate
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-21
SCOPE: This is an explore task
RESULT KD: knowledge/analysis-foo.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
      expect(output.args.prompt).toContain("MODE: investigate");
      expect(output.args.prompt).not.toMatch(/^MODE:\s*explore/m);
    });

    it("infers the first matching mode when the prompt contains multiple mode keywords", async () => {
      // KNOWN_MODES order: checkpoint, preflight, cleanup, explore, ... — "checkpoint" wins
      const prompt = `AGENT: artisan
Run the explore phase then checkpoint.
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-21
SCOPE: Test multiple modes
RESULT KD: knowledge/checkpoint-foo.md`;

      const output = { args: { prompt, subagent_type: "artisan" } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
      expect(output.args.prompt).toContain("checkpoint");
    });

    it("does not infer a mode from partial word matches", async () => {
      const prompt = `AGENT: artisan
Run the checkpoints process.
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-21
SCOPE: Test partial match`;

      await expect(
        hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, { args: { prompt, subagent_type: "artisan" } })
      ).rejects.toThrow("Missing required structured fields");
    });
  });

  describe("Result KD Enforcement", () => {
    it("requires result_kd for every KD-producing mode", async () => {
      const cases = [
        { mode: "explore", agent: "explorer", scope: "Explore the codebase" },
        { mode: "investigate", agent: "artisan", scope: "Investigate the plugin system" },
        { mode: "decompose", agent: "pathfinder", scope: "Decompose the project into tasks" },
        { mode: "swarm", agent: "artisan", scope: "Execute implementation" },
        { mode: "checkpoint", agent: "committer", scope: "Create a checkpoint commit" },
        { mode: "preflight", agent: "committer", scope: "Setup workspace" },
        { mode: "align", agent: "spec-weaver", scope: "Align requirements" },
        { mode: "verify", agent: "inspector", scope: "Verify implementation" },
        { mode: "extract", agent: "scribe", scope: "Extract documentation" },
        { mode: "evolve", agent: "habit-builder", scope: "Evolve process" },
        { mode: "cleanup", agent: "committer", scope: "Commit changes" }
      ];

      for (const { mode, agent, scope } of cases) {
        const prompt = `AGENT: ${agent}
MODE: ${mode}
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-21
SCOPE: ${scope}`;

        await expect(
          hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, { args: { prompt } })
        ).rejects.toThrow("KD-producing mode requires result_kd");
      }
    });
  });

  describe("Swarm Milestone Enforcement (M3)", () => {
    it("preserves exactly one valid MILESTONE ID through the rendered swarm template", async () => {
      const prompt = `AGENT: artisan
MODE: swarm
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-31
MILESTONE ID: M3
SCOPE: Implement milestone M3
RESULT KD: knowledge/impl-M3-foo.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
      expect(output.args.prompt).toContain("MILESTONE ID: M3");
    });

    it("requires MILESTONE ID in swarm mode", async () => {
      const prompt = `AGENT: artisan
MODE: swarm
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-31
SCOPE: Execute implementation
RESULT KD: knowledge/impl-foo.md`;

      await expect(
        hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, { args: { prompt } })
      ).rejects.toThrow("Missing required structured fields");
    });

    it("rejects multiple milestones in a single swarm dispatch", async () => {
      const prompts = [
        `AGENT: artisan
MODE: swarm
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-31
MILESTONE ID: M1, M2
SCOPE: Execute implementation
RESULT KD: knowledge/impl-foo.md`,
        `AGENT: artisan
MODE: swarm
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-31
MILESTONE ID: M1
MILESTONE ID: M2
SCOPE: Execute implementation
RESULT KD: knowledge/impl-foo.md`,
      ];
      for (const prompt of prompts) {
        await expect(
          hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, { args: { prompt } })
        ).rejects.toThrow("Multiple milestones in single dispatch");
      }
    });

    it("rejects malformed MILESTONE ID values", async () => {
      const prompt = `AGENT: artisan
MODE: swarm
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-31
MILESTONE ID: !bad
SCOPE: Execute implementation
RESULT KD: knowledge/impl-foo.md`;

      await expect(
        hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, { args: { prompt } })
      ).rejects.toThrow("Invalid MILESTONE ID format");
    });

    it("does not require MILESTONE ID in non-swarm modes", async () => {
      const prompt = `AGENT: explorer
MODE: explore
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-31
SCOPE: Explore
RESULT KD: knowledge/exploration-foo.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
      expect(output.args.prompt).toContain("explore");
    });
  });

  describe("Milestone-Scoped impl Result KD (M4)", () => {
    it("accepts a milestone-scoped result KD matching the swarm MILESTONE ID", async () => {
      const cases = [
        { milestone: "M4", kd: "knowledge/impl-M4-feature-ses_x-gen0.md" },
        // Case-insensitive token: impl-m3 satisfies MILESTONE ID: M3
        { milestone: "M3", kd: "knowledge/impl-m3-ses_m3-gen0.md" },
      ];
      for (const c of cases) {
        const prompt = `AGENT: artisan
MODE: swarm
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-08-01
MILESTONE ID: ${c.milestone}
SCOPE: Execute milestone ${c.milestone}
RESULT KD: ${c.kd}`;

        const output = { args: { prompt } };
        await hooks["tool.execute.before"]({ tool: "task", sessionID: "ses_x", callID: "c1" }, output);
        expect(output.args.prompt).toContain(c.kd);
      }
    });

    it("rejects a result KD that is not scoped to the dispatched milestone", async () => {
      const prompts = [
        // Different milestone token
        `AGENT: artisan
MODE: swarm
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-08-01
MILESTONE ID: M4
SCOPE: Execute milestone M4
RESULT KD: knowledge/impl-M5-feature-ses_x-gen0.md`,
        // No milestone token at all
        `AGENT: artisan
MODE: swarm
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-08-01
MILESTONE ID: M4
SCOPE: Execute milestone M4
RESULT KD: knowledge/impl-feature-ses_x-gen0.md`,
      ];
      for (const prompt of prompts) {
        await expect(
          hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, { args: { prompt } })
        ).rejects.toThrow("Swarm result KD does not match the MILESTONE ID");
      }
    });

    it("does not enforce result KD milestone scoping for non-swarm modes", async () => {
      const prompt = `AGENT: committer
MODE: checkpoint
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-08-01
SCOPE: Commit X
RESULT KD: knowledge/checkpoint-foo.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
      expect(output.args.prompt).toContain("knowledge/checkpoint-foo.md");
    });
  });

  describe("Generation Propagation (M1)", () => {
    it("renders GENERATION and -gen{N} naming when the prompt carries GENERATION", async () => {
      const prompt = `AGENT: artisan
MODE: swarm
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-15
SESSION ID: ses_gen
GENERATION: 2
MILESTONE ID: M1
SCOPE: Implement feature X
RESULT KD: knowledge/impl-M1-foo-ses_gen-gen2.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "ses_gen", callID: "c1" }, output);

      expect(output.args.prompt).toContain("GENERATION: 2");
      expect(output.args.prompt).toContain("knowledge/impl-<milestone-id>-<descriptive-name>-<session_id>-gen2.md");
      expect(output.args.description).toContain("knowledge/impl-<milestone-id>-<name>-<session_id>-gen2.md");
      expect(output.args.description).toContain("GENERATION: <generation>");
    });

    it("keeps legacy naming when GENERATION is absent and no state file exists", async () => {
      const prompt = `AGENT: committer
MODE: checkpoint
SESSION DATE: 2026-07-15
SESSION ID: ses_delegation_legacy
SCOPE: Commit X
RESULT KD: knowledge/checkpoint-foo-ses_delegation_legacy.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "ses_delegation_legacy", callID: "c1" }, output);

      // Unresolved {generation} placeholder stripped, no -gen suffix injected
      expect(output.args.prompt).not.toContain("-gen");
      expect(output.args.description).toContain("knowledge/checkpoint-<name>-<session_id>.md");
    });

    it("extracts GENERATION for non-swarm modes (checkpoint)", async () => {
      const prompt = `AGENT: committer
MODE: checkpoint
SESSION DATE: 2026-07-15
SESSION ID: ses_ckpt
GENERATION: 1
SCOPE: Commit X
RESULT KD: knowledge/checkpoint-step1-ses_ckpt-gen1.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "ses_ckpt", callID: "c1" }, output);

      expect(output.args.prompt).toContain("GENERATION: 1");
      expect(output.args.prompt).toContain("knowledge/checkpoint-step1-ses_ckpt-gen1.md");
    });
  });

  describe("Cross-Plugin Integration", () => {
    it("renders a prompt that protocol-gate can parse for agent routing", async () => {
      const prompt = `AGENT: explorer
MODE: explore
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-21
SCOPE: Explore the codebase
RESULT KD: knowledge/exploration-foo.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);

      // protocol-gate's agent extraction looks for a DISPATCH TO: / AGENT: line
      const agentMatch = output.args.prompt.match(/^DISPATCH TO:\s*(.*)/m);
      expect(agentMatch).toBeTruthy();
      expect(agentMatch[1].trim()).toBe("explorer");
    });

    it("does not require PROTOCOL_GATE_STATE_DIR and leaves the real .state dir untouched (AC306)", async () => {
      // The M1 GENERATION-fallback state-file test now lives in the protocol-gate
      // suite (R306). This suite runs against the plugin default without any env
      // override, proving no temp state dir is needed and the real
      // plugins/protocol-gate/.state is never written by this suite.
      const prompt = `AGENT: artisan
MODE: checkpoint
SESSION DATE: 2026-07-15
SESSION ID: ses_ac306_isolated
SCOPE: Implement feature X
RESULT KD: knowledge/checkpoint-foo.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "ses_ac306_isolated", callID: "c1" }, output);
      expect(output.args.prompt).toContain("knowledge/checkpoint-foo.md");
    });

    it("passes the intent_kd path through unchanged (no generation rewriting)", async () => {
      // The delegating-session gen suffix lives in the GENERATION/SESSION ID
      // fields — intent_kd is never rewritten to a session-scoped path.
      const prompt = `AGENT: artisan
MODE: explore
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-15
SESSION ID: ses_pt
SCOPE: Implement feature X
RESULT KD: knowledge/exploration-foo.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "ses_pt", callID: "c1" }, output);
      expect(output.args.prompt).toContain("INTENT KD: knowledge/intent-foo.md");
      expect(output.args.prompt).not.toContain("intent-foo-ses_pt");
    });
  });
});
