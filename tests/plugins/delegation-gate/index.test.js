import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { readFileSync, mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  let logDir;
  let priorLogDir;
  let priorDebug;

  beforeAll(() => {
    // Log isolation (AC018): point DELEGATION_GATE_LOG_DIR at a per-run temp
    // dir BEFORE the first server() call so the module-level _logFile cache
    // binds to the temp path. Test runs then never append to the real
    // plugins/logs/delegation-gate.log — even when DELEGATION_GATE_DEBUG is
    // set in the environment (.env sets it). The flag is also asserted here
    // so every server() call in this suite deterministically exercises the
    // debug path (AC020) and proves the redirect (AC019).
    priorLogDir = process.env.DELEGATION_GATE_LOG_DIR;
    priorDebug = process.env.DELEGATION_GATE_DEBUG;
    logDir = mkdtempSync(join(tmpdir(), "delegation-gate-test-"));
    process.env.DELEGATION_GATE_LOG_DIR = logDir;
    process.env.DELEGATION_GATE_DEBUG = "1";
  });

  beforeEach(async () => {
    // Re-assert the suite seam after any test that temporarily overrides it —
    // getLogFile() re-resolves the cached path when the env dir differs.
    process.env.DELEGATION_GATE_LOG_DIR = logDir;
    hooks = await pluginModule.server({}, {});
  });

  afterAll(() => {
    if (priorLogDir === undefined) delete process.env.DELEGATION_GATE_LOG_DIR;
    else process.env.DELEGATION_GATE_LOG_DIR = priorLogDir;
    if (priorDebug === undefined) delete process.env.DELEGATION_GATE_DEBUG;
    else process.env.DELEGATION_GATE_DEBUG = priorDebug;
    rmSync(logDir, { recursive: true, force: true });
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
BRANCH: chore/version-bump-2
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

    it("rejects whole-value angle-bracket placeholders in any structured field (AC001, AC004, AC005)", async () => {
      // N2 leak: format-hint literals like <mode> or <session-id>, copied
      // verbatim into a dispatch, were captured by extraction and rendered —
      // now each rejects at the placeholder check before template lookup.
      const prompts = [
        // AC004 — MODE placeholder must never reach template lookup
        `AGENT: artisan
MODE: <mode>
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-08-08
SCOPE: Implement feature X
RESULT KD: knowledge/impl-foo.md`,
        // AC005 — each standalone angle-bracket field
        `AGENT: artisan
MODE: checkpoint
INTENT KD: knowledge/intent-foo.md
SESSION DATE: <YYYY-MM-DD>
SCOPE: Implement feature X
RESULT KD: knowledge/impl-foo.md`,
        `AGENT: artisan
MODE: checkpoint
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-08-08
SESSION ID: <session-id>
SCOPE: Implement feature X
RESULT KD: knowledge/impl-foo.md`,
        `AGENT: artisan
MODE: checkpoint
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-08-08
GENERATION: <generation>
SCOPE: Implement feature X
RESULT KD: knowledge/impl-foo.md`,
        `AGENT: artisan
MODE: checkpoint
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-08-08
SCOPE: <optional context>
RESULT KD: knowledge/impl-foo.md`,
        `AGENT: committer
MODE: preflight
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-08-08
BRANCH: <branch>
SCOPE: Implement feature X
RESULT KD: knowledge/preflight-foo.md`,
        `AGENT: artisan
MODE: swarm
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-08-08
MILESTONE ID: <milestone-id>
SCOPE: Implement feature X
RESULT KD: knowledge/impl-M1-foo.md`,
      ];
      for (const prompt of prompts) {
        await expect(
          hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, { args: { prompt } })
        ).rejects.toThrow("unresolved placeholder");
      }
    });

    it("accepts real values that merely look bracketed — no false positives (AC002, AC006)", async () => {
      // Real session id, ISO date, branch, milestone, and KD paths all pass
      // containsPlaceholder — the extension changes no valid dispatch path.
      const prompt = `AGENT: artisan
MODE: swarm
INTENT KD: knowledge/intent-phase-dispatch-fix-ses_023f1f066ffecWQJC5SF8v1B8U-gen1.md
SESSION DATE: 2026-08-08
SESSION ID: ses_023f1f066ffecWQJC5SF8v1B8U
GENERATION: 1
MILESTONE ID: M1
SCOPE: Execute milestone M1 with real values
RESULT KD: knowledge/impl-M1-phase-dispatch-fix-ses_023f1f066ffecWQJC5SF8v1B8U-gen1.md
KD PATHS: knowledge/spec-foo.md, knowledge/plan-foo.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "ses_023f1f066ffecWQJC5SF8v1B8U", callID: "c1" }, output);
      expect(output.args.prompt).toContain("MILESTONE ID: M1");
      expect(output.args.prompt).toContain("ses_023f1f066ffecWQJC5SF8v1B8U");
      expect(output.args.prompt).toContain("GENERATION: 1");

      // A branch value that starts alphanumeric passes (AC002: gate-fix)
      const preflight = `AGENT: committer
MODE: preflight
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-08-08
BRANCH: gate-fix
SCOPE: Preflight with a real branch
RESULT KD: knowledge/preflight-foo.md`;
      const out2 = { args: { prompt: preflight } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c2" }, out2);
      expect(out2.args.prompt).toContain("BRANCH: gate-fix");
    });

    it("rejects a verbatim RESULT KD template form via validateKDPath, not the placeholder check (AC003)", async () => {
      // knowledge/<type>-<name>.md is not a whole-value <...> placeholder, so
      // containsPlaceholder lets it through; validateKDPath rejects loudly.
      const prompt = `AGENT: artisan
MODE: checkpoint
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-08-08
SCOPE: Implement feature X
RESULT KD: knowledge/<type>-<name>.md`;

      await expect(
        hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, { args: { prompt } })
      ).rejects.toThrow("Invalid result KD path");
    });

    it("rejects an empty prompt whose description carries old-style hint placeholders (AC007)", async () => {
      // Description-fallback literals no longer render silently — the
      // placeholder check fires on the extracted description values.
      const description = `MODE: explore
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-08-08
SESSION ID: <session-id>
GENERATION: <generation>
SCOPE: <optional context>
RESULT KD: knowledge/exploration-foo.md`;

      await expect(
        hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, { args: { prompt: "", description, subagent_type: "explorer" } })
      ).rejects.toThrow("unresolved placeholder");
    });

    it("lets real prompt values override stale description literals (EC1)", async () => {
      const prompt = `AGENT: explorer
MODE: explore
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-08-08
SESSION ID: ses_real
GENERATION: 1
SCOPE: real context
RESULT KD: knowledge/exploration-foo.md`;
      const description = `SESSION ID: <session-id>
GENERATION: <generation>
SCOPE: <optional context>`;

      const output = { args: { prompt, description, subagent_type: "explorer" } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
      expect(output.args.prompt).toContain("ses_real");
      expect(output.args.prompt).toContain("real context");
      expect(output.args.prompt).toContain("GENERATION: 1");
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
BRANCH: fix/swarm-gate
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

    it("renders a three-line SCOPE verbatim and keeps whole-prompt code-block rejection", async () => {
      const scopeLines = [
        "Implement multi-line scope extraction in the delegation plugin",
        "Continuation lines after the SCOPE key join the same field value",
        "The rendered prompt and RAW PROMPT audit trail carry all three lines",
      ];
      const prompt = `AGENT: artisan
MODE: explore
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-08-10
SCOPE: ${scopeLines[0]}
${scopeLines[1]}
${scopeLines[2]}
RESULT KD: knowledge/exploration-foo.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
      for (const line of scopeLines) {
        expect(output.args.prompt).toContain(line);
      }

      const log = readFileSync(join(logDir, "delegation-gate.log"), "utf8");
      expect(log).toContain(`RAW PROMPT (${prompt.length} chars): ${prompt}`);

      // A code block on a scope continuation line still trips the guard — the
      // abuse checks scan the whole prompt, not just the extracted field values.
      const scopedCodeBlock = `AGENT: artisan
MODE: explore
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-08-10
SCOPE: Wrap prose across lines
\`\`\`js
console.log("injected");
\`\`\`
RESULT KD: knowledge/exploration-foo.md`;
      await expect(
        hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, { args: { prompt: scopedCodeBlock } })
      ).rejects.toThrow("Code blocks detected in prompt");
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
BRANCH: fix/swarm-gate
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
        { mode: "preflight", result: "knowledge/preflight-foo.md", branch: "fix/swarm-gate", expectMatch: /Load the kd-system skill and the committer-preflight skill/, expectNoMatch: /Read the INTENT KD at/ },
        // Checkpoint reads KDs from KD PATHS only — kd_paths supplied so the
        // sentence renders (F4 strips it when kd_paths is absent)
        { mode: "checkpoint", result: "knowledge/checkpoint-foo.md", kdPaths: "knowledge/intent-foo.md", expectMatch: /Read KDs from KD PATHS/, expectNoMatch: /Read the INTENT KD at/ },
        // Cleanup must not instruct reading the INTENT KD (no read:allow on committer)
        { mode: "cleanup", result: "knowledge/cleanup-foo.md", branch: "chore/version-bump-2", expectMatch: /Load the kd-system skill. Load the committer-cleanup skill/, expectNoMatch: /Read the INTENT KD at/ },
        // Explore (read:allow) reads the INTENT KD
        { mode: "explore", result: "knowledge/exploration-foo.md", expectMatch: /Read the INTENT KD at/, expectNoMatch: null },
      ];
      for (const c of cases) {
        const prompt = `AGENT: committer
MODE: ${c.mode}
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-21
SCOPE: Test ${c.mode}
RESULT KD: ${c.result}
${c.branch ? `BRANCH: ${c.branch}\n` : ""}${c.kdPaths ? `KD PATHS: ${c.kdPaths}` : ""}`;

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
BRANCH: chore/version-bump-2
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
BRANCH: chore/version-bump-2
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

  describe("Memory Division of Labor (M3, FIX1)", () => {
    // Evolve dispatches the Habit Builder — its rendered prompt must stay free
    // of the Scribe-writes-memory rule (FIX1: the rule belongs to scribe.md
    // step 11, not Habit Builder surfaces) and of any memory-write instruction.
    const evolvePrompt = `AGENT: habit-builder
MODE: evolve
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-08-06
SCOPE: Test evolve memory scope
RESULT KD: knowledge/process-foo.md`;

    it("keeps the Scribe-writes-memory rule out of the evolve template (AC007, FIX1)", async () => {
      const output = { args: { prompt: evolvePrompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
      expect(output.args.prompt).not.toContain("written by the Scribe during EXTRACT");
    });

    it("renders the evolve template without a memory-write instruction (AC008)", async () => {
      const output = { args: { prompt: evolvePrompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
      expect(output.args.prompt).not.toContain("memory_write tool");
    });

    it("keeps the Scribe-writes-memory rule out of the evolve fallback template (AC009, FIX1)", async () => {
      // The in-code fallback (disk template missing) must render the same
      // contract — assert it on the source so drift is caught at test time.
      const src = readFileSync(new URL("../../../plugins/delegation-gate/index.js", import.meta.url), "utf8");
      const fallbackLines = src.split("\n").filter(l => /^    evolve: /.test(l));
      expect(fallbackLines).toHaveLength(1);
      expect(fallbackLines[0]).not.toContain("written by the Scribe during EXTRACT");
    });
  });

  describe("Conditional KD PATHS Rendering (F4)", () => {
    it("omits the KD PATHS header line and body sentence when kd_paths is absent (AC021)", async () => {
      const cases = [
        { mode: "preflight", agent: "committer", result: "knowledge/preflight-foo.md", branch: "fix/swarm-gate" },
        { mode: "checkpoint", agent: "committer", result: "knowledge/checkpoint-foo.md" },
        { mode: "cleanup", agent: "committer", result: "knowledge/cleanup-foo.md", branch: "chore/version-bump-2" },
      ];
      for (const { mode, agent, result, branch } of cases) {
        const prompt = `AGENT: ${agent}
MODE: ${mode}
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-08-03
SCOPE: Test conditional KD PATHS
RESULT KD: ${result}
${branch ? `BRANCH: ${branch}` : ""}`;

        const output = { args: { prompt } };
        await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
        expect(output.args.prompt).not.toMatch(/^KD PATHS:.*$/m);
        expect(output.args.prompt).not.toContain("Read KDs from KD PATHS");
      }
    });

    it("renders the KD PATHS header line and body sentence when kd_paths is supplied (AC022)", async () => {
      const cases = [
        { mode: "preflight", agent: "committer", result: "knowledge/preflight-foo.md", branch: "fix/swarm-gate" },
        { mode: "checkpoint", agent: "committer", result: "knowledge/checkpoint-foo.md" },
        { mode: "cleanup", agent: "committer", result: "knowledge/cleanup-foo.md", branch: "chore/version-bump-2" },
      ];
      for (const { mode, agent, result, branch } of cases) {
        const prompt = `AGENT: ${agent}
MODE: ${mode}
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-08-03
SCOPE: Test conditional KD PATHS
RESULT KD: ${result}
${branch ? `BRANCH: ${branch}\n` : ""}KD PATHS: knowledge/upstream-foo.md`;

        const output = { args: { prompt } };
        await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
        expect(output.args.prompt).toContain("KD PATHS: knowledge/upstream-foo.md");
        expect(output.args.prompt).toContain("Read KDs from KD PATHS");
      }
    });

    it("renders KD PATHS unchanged for legitimate modes with kd_paths supplied (AC023)", async () => {
      const swarmPrompt = `AGENT: artisan
MODE: swarm
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-08-03
MILESTONE ID: M1
SCOPE: Execute milestone M1
RESULT KD: knowledge/impl-M1-foo.md
KD PATHS: knowledge/plan-foo.md`;

      const output = { args: { prompt: swarmPrompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
      expect(output.args.prompt).toContain("KD PATHS: knowledge/plan-foo.md");
      expect(output.args.prompt).toContain("Read SPEC KDs and PLAN KDs from KD PATHS.");
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
      // Genuine variables use parenthetical wording — the defused hint keeps no
      // whole-value <...> placeholder line that extraction could capture (R002/R003)
      expect(output.args.description).toContain("INTENT KD: knowledge/intent-(name).md");
      expect(output.args.description).toContain("SESSION ID: (your session id)");
      expect(output.args.description).toContain("SCOPE: (optional context)");
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
RESULT KD: knowledge/${c.mode === "investigate" ? "analysis" : "preflight"}-foo.md
${c.mode === "preflight" ? "BRANCH: fix/swarm-gate" : ""}`;

        const output = { args: { prompt } };
        await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
        expect(output.args.description).toContain(`MODE: ${c.mode}`);
        expect(output.args.description).toContain(c.result);
        expect(output.args.description).toContain(`- ${c.mode}: ${c.result}`);
        for (const other of c.other) {
          // No other mode's KD path prefix may be injected — bare mode words
          // like "cleanup" legitimately appear in the BRANCH qualifier text.
          expect(output.args.description).not.toContain(`knowledge/${other}-`);
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

    // R009 / issue-9 remainder (AC014): dispatcherFormatHint() is mode-agnostic —
    // injected via tool.definition before dispatch, when the mode is not yet known.
    // The swarm MILESTONE ID line therefore carries the "(swarm mode only)"
    // qualifier, and the KD PATHS line documents the comma-separated convention
    // that the validation split() (index.js:516-517) expects.
    it("annotates the task tool definition with the swarm MILESTONE ID and comma-separated KD PATHS conventions (AC014)", async () => {
      const output = { description: "Delegate work to another agent." };
      await hooks["tool.definition"]({ toolID: "task" }, output);

      expect(output.description).toContain("Delegation Prompt Format:");
      expect(output.description).toContain("MILESTONE ID: milestone id — swarm mode only, exactly one, required");
      expect(output.description).toContain("swarm mode only");
      expect(output.description).toContain("KD PATHS: upstream KD paths, comma-separated (optional)");
      expect(output.description).toContain("comma-separated");
    });
  });

  describe("Defused Format Hints (R002/R003)", () => {
    // AC008: neither hint may contain a KEY: line whose value is a whole-value
    // angle-bracket placeholder — such a line, copied verbatim into a dispatch,
    // is exactly the leak source N2 fixed. The RESULT KD example lines keep
    // <name>-<session_id> path components but are never whole-value <...>.
    const wholeValueAngleLine = /^(?:#{1,6}\s*)?(?:\*\*)?(?:AGENT|DISPATCH TO|MODE|MILESTONE[. _]ID|INTENT[. _]KD|SESSION[. _]DATE|SESSION[. _]ID|GENERATION|BRANCH[. _]NAME|BRANCH|SCOPE|RESULT[. _]KD|KD[. _]PATHS)(?:\*\*)?:\s*<[^>]+>$/;

    it("emits no extractable whole-value angle-bracket line from dispatcherFormatHint (AC008, AC009)", async () => {
      const output = { description: "Delegate work to another agent." };
      await hooks["tool.definition"]({ toolID: "task" }, output);

      const badLines = output.description.split("\n").filter(l => wholeValueAngleLine.test(l.trim()));
      expect(badLines).toEqual([]);
      // Instructional wording survives; the retained RESULT KD template form is
      // not a whole-value placeholder (AC003 semantics).
      expect(output.description).toContain("DISPATCH TO: agent name (e.g. explorer)");
      expect(output.description).toContain("MODE: delegation mode (e.g. explore)");
      expect(output.description).toContain("SESSION DATE: today's date (e.g. ");
      expect(output.description).toContain("KD PATHS: upstream KD paths, comma-separated (optional)");
      expect(output.description).toContain("RESULT KD: knowledge/<type>-<name>-<session_id>[-gen<N>].md");
    });

    it("emits no extractable whole-value angle-bracket line from the injected hint and renders concrete values (AC008, AC009, AC010)", async () => {
      const today = new Date().toISOString().slice(0, 10);
      const prompt = `AGENT: artisan
MODE: checkpoint
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-08-08
SCOPE: Implement feature X
RESULT KD: knowledge/impl-foo.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);

      const badLines = output.args.description.split("\n").filter(l => wholeValueAngleLine.test(l.trim()));
      expect(badLines).toEqual([]);
      // Fixed fields render concrete values (AC010); genuine variables use
      // parenthetical wording.
      expect(output.args.description).toContain("DISPATCH TO: artisan");
      expect(output.args.description).toContain("MODE: checkpoint");
      expect(output.args.description).toContain(`SESSION DATE: ${today}`);
      expect(output.args.description).toContain("SESSION ID: (your session id)");
      expect(output.args.description).toContain("SCOPE: (optional context)");
      expect(output.args.description).toContain("GENERATION: (the lifecycle generation number)");
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
        { mode: "preflight", agent: "committer", scope: "Setup workspace", branch: "fix/swarm-gate" },
        { mode: "align", agent: "spec-weaver", scope: "Align requirements" },
        { mode: "verify", agent: "inspector", scope: "Verify implementation" },
        { mode: "extract", agent: "scribe", scope: "Extract documentation" },
        { mode: "evolve", agent: "habit-builder", scope: "Evolve process" },
        { mode: "cleanup", agent: "committer", scope: "Commit changes", branch: "chore/version-bump-2" }
      ];

      for (const { mode, agent, scope, branch } of cases) {
        const prompt = `AGENT: ${agent}
MODE: ${mode}
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-21
SCOPE: ${scope}
${branch ? `BRANCH: ${branch}` : ""}`;

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

  describe("BRANCH Contract (M3)", () => {
    it("renders BRANCH between GENERATION and SCOPE for preflight and cleanup dispatches (AC101)", async () => {
      const cases = [
        { mode: "preflight", agent: "committer", result: "knowledge/preflight-foo.md", branch: "fix/swarm-gate", intent: "INTENT KD: knowledge/intent-foo.md\n" },
        { mode: "cleanup", agent: "committer", result: "knowledge/cleanup-foo.md", branch: "chore/version-bump-2", intent: "" },
      ];
      for (const { mode, agent, result, branch, intent } of cases) {
        const prompt = `AGENT: ${agent}
MODE: ${mode}
${intent}SESSION DATE: 2026-08-03
SESSION ID: ses_branch
GENERATION: 0
BRANCH: ${branch}
SCOPE: Test branch render
RESULT KD: ${result}`;

        const output = { args: { prompt } };
        await hooks["tool.execute.before"]({ tool: "task", sessionID: "ses_branch", callID: "c1" }, output);
        // The BRANCH header line sits between GENERATION and SCOPE
        const generationIdx = output.args.prompt.indexOf("GENERATION: 0");
        const branchIdx = output.args.prompt.indexOf(`BRANCH: ${branch}`);
        const scopeIdx = output.args.prompt.indexOf("SCOPE: Test branch render");
        expect(generationIdx).toBeGreaterThan(-1);
        expect(branchIdx).toBeGreaterThan(generationIdx);
        expect(scopeIdx).toBeGreaterThan(branchIdx);
        expect(output.args.prompt).toContain(`BRANCH: ${branch}`);
      }
    });

    it("extracts branch in BRANCH:/branch:/BRANCH_NAME: forms and requires it for preflight/cleanup (AC102)", async () => {
      // Both case forms and the BRANCH_NAME underscore variant normalize to `branch`
      const forms = ["BRANCH: fix/swarm-gate", "branch: fix/swarm-gate", "BRANCH_NAME: fix/swarm-gate"];
      for (const form of forms) {
        const prompt = `AGENT: committer
MODE: preflight
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-08-03
${form}
SCOPE: Branch extraction
RESULT KD: knowledge/preflight-foo.md`;

        const output = { args: { prompt } };
        await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
        expect(output.args.prompt).toContain("BRANCH: fix/swarm-gate");
      }

      // Preflight and cleanup without a branch are rejected before rendering
      const missing = [
        `AGENT: committer
MODE: preflight
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-08-03
SCOPE: Missing branch
RESULT KD: knowledge/preflight-foo.md`,
        `AGENT: committer
MODE: cleanup
SESSION DATE: 2026-08-03
SCOPE: Missing branch
RESULT KD: knowledge/cleanup-foo.md`,
      ];
      for (const prompt of missing) {
        await expect(
          hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, { args: { prompt } })
        ).rejects.toThrow("Missing required structured fields");
      }

      // Non-committer modes are unaffected — a swarm dispatch without BRANCH passes
      const swarm = `AGENT: artisan
MODE: swarm
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-08-03
MILESTONE ID: M3
SCOPE: Execute milestone M3
RESULT KD: knowledge/impl-M3-foo.md`;
      const swarmOut = { args: { prompt: swarm } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, swarmOut);
      expect(swarmOut.args.prompt).toContain("MILESTONE ID: M3");
    });

    it("rejects unsafe branch values with the dedicated INVALID_BRANCH error and accepts git-ref-safe ones (AC103)", async () => {
      const invalid = ["a..b", "-fix/x", "fix/", "a b", "a;b"];
      for (const branch of invalid) {
        const prompt = `AGENT: committer
MODE: preflight
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-08-03
BRANCH: ${branch}
SCOPE: Branch validation
RESULT KD: knowledge/preflight-foo.md`;

        await expect(
          hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, { args: { prompt } })
        ).rejects.toThrow("Invalid branch name");
      }

      const valid = ["fix/swarm-gate", "chore/version-bump-2", "improve/x"];
      for (const branch of valid) {
        const prompt = `AGENT: committer
MODE: cleanup
SESSION DATE: 2026-08-03
BRANCH: ${branch}
SCOPE: Branch validation
RESULT KD: knowledge/cleanup-foo.md`;

        const output = { args: { prompt } };
        await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
        expect(output.args.prompt).toContain(`BRANCH: ${branch}`);
      }
    });

    it("shows the BRANCH format hint only for preflight/cleanup modes (AC104)", async () => {
      // Mode-agnostic task-tool definition hint carries the qualifier
      const output = { description: "Delegate work to another agent." };
      await hooks["tool.definition"]({ toolID: "task" }, output);
      expect(output.description).toContain("BRANCH: branch name (required for preflight/cleanup)");

      // Per-mode injected hint: BRANCH line present for preflight/cleanup
      const committerModes = [
        { mode: "preflight", agent: "committer", result: "knowledge/preflight-foo.md", branch: "fix/swarm-gate" },
        { mode: "cleanup", agent: "committer", result: "knowledge/cleanup-foo.md", branch: "chore/version-bump-2" },
      ];
      for (const { mode, agent, result, branch } of committerModes) {
        const prompt = `AGENT: ${agent}
MODE: ${mode}
${mode === "cleanup" ? "" : "INTENT KD: knowledge/intent-foo.md\n"}SESSION DATE: 2026-08-03
BRANCH: ${branch}
SCOPE: Format hint test
RESULT KD: ${result}`;

        const out = { args: { prompt } };
        await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, out);
        expect(out.args.description).toContain("BRANCH: (branch name, required for preflight/cleanup)");
      }

      // ...and absent for other modes
      const otherModes = [
        { mode: "checkpoint", agent: "committer", result: "knowledge/checkpoint-foo.md", extra: "" },
        { mode: "explore", agent: "explorer", result: "knowledge/exploration-foo.md", extra: "" },
        { mode: "swarm", agent: "artisan", result: "knowledge/impl-M3-foo.md", extra: "MILESTONE ID: M3\n" },
      ];
      for (const { mode, agent, result, extra } of otherModes) {
        const prompt = `AGENT: ${agent}
MODE: ${mode}
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-08-03
${extra}SCOPE: Format hint test
RESULT KD: ${result}`;

        const out = { args: { prompt } };
        await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, out);
        expect(out.args.description).not.toContain("BRANCH:");
      }
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
      expect(output.args.description).toContain("GENERATION: (the lifecycle generation number)");
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

  describe("Log Isolation (F3)", () => {
    const promptFor = (mode, overrides = {}) => `AGENT: ${overrides.agent || "artisan"}
MODE: ${mode}
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-08-03
SCOPE: Log isolation test
RESULT KD: knowledge/${overrides.kd || "exploration"}-foo.md`;

    it("writes debug output to the env-seam directory when DELEGATION_GATE_LOG_DIR is set (AC016, AC020)", async () => {
      const altDir = mkdtempSync(join(tmpdir(), "delegation-gate-alt-"));
      try {
        process.env.DELEGATION_GATE_LOG_DIR = altDir;
        process.env.DELEGATION_GATE_DEBUG = "1";
        const output = { args: { prompt: promptFor("explore") } };
        await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);

        const logFile = join(altDir, "delegation-gate.log");
        expect(existsSync(logFile)).toBe(true);
        expect(readFileSync(logFile, "utf8")).toContain("[delegation-gate]");
      } finally {
        process.env.DELEGATION_GATE_LOG_DIR = logDir;
        rmSync(altDir, { recursive: true, force: true });
      }
    });

    it("honors a runtime DELEGATION_GATE_LOG_DIR change with no stale-cache writes (AC017)", async () => {
      const dirA = mkdtempSync(join(tmpdir(), "delegation-gate-a-"));
      const dirB = mkdtempSync(join(tmpdir(), "delegation-gate-b-"));
      try {
        process.env.DELEGATION_GATE_DEBUG = "1";
        process.env.DELEGATION_GATE_LOG_DIR = dirA;
        await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, { args: { prompt: promptFor("explore") } });
        const logA = join(dirA, "delegation-gate.log");
        expect(existsSync(logA)).toBe(true);
        const sizeA = statSync(logA).size;

        process.env.DELEGATION_GATE_LOG_DIR = dirB;
        await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c2" }, { args: { prompt: promptFor("explore") } });

        const logB = join(dirB, "delegation-gate.log");
        expect(existsSync(logB)).toBe(true);
        expect(readFileSync(logB, "utf8")).toContain("[delegation-gate]");
        // The module-level _logFile cache must rebind — no write may land in A.
        expect(statSync(logA).size).toBe(sizeA);
      } finally {
        process.env.DELEGATION_GATE_LOG_DIR = logDir;
        rmSync(dirA, { recursive: true, force: true });
        rmSync(dirB, { recursive: true, force: true });
      }
    });

    it("keeps the real plugins/logs log untouched and writes to the suite temp dir (AC018, AC019)", async () => {
      const realLog = new URL("../../../plugins/logs/delegation-gate.log", import.meta.url);
      const realSize = existsSync(realLog) ? statSync(realLog).size : null;

      // beforeAll bound the module cache to the suite temp dir; assert the
      // seam so this test can never silently fall back to the real path.
      expect(process.env.DELEGATION_GATE_LOG_DIR).toBe(logDir);
      process.env.DELEGATION_GATE_DEBUG = "1";
      const output = { args: { prompt: promptFor("explore") } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);

      const suiteLog = join(logDir, "delegation-gate.log");
      expect(existsSync(suiteLog)).toBe(true);
      expect(readFileSync(suiteLog, "utf8")).toContain("[delegation-gate]");
      if (realSize !== null) {
        expect(statSync(realLog).size).toBe(realSize);
      }
    });

    it("does not write debug output when DELEGATION_GATE_DEBUG is unset (R023)", async () => {
      const quietDir = mkdtempSync(join(tmpdir(), "delegation-gate-quiet-"));
      try {
        delete process.env.DELEGATION_GATE_DEBUG;
        process.env.DELEGATION_GATE_LOG_DIR = quietDir;
        await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, { args: { prompt: promptFor("explore") } });
        expect(existsSync(join(quietDir, "delegation-gate.log"))).toBe(false);
      } finally {
        process.env.DELEGATION_GATE_DEBUG = "1";
        process.env.DELEGATION_GATE_LOG_DIR = logDir;
        rmSync(quietDir, { recursive: true, force: true });
      }
    });

    it("logs the FULL prompt text in RAW PROMPT with the (N chars) annotation for a 2000+ char prompt (T44-01)", async () => {
      // Trailing body text extends the prompt past 2000 chars while the
      // structured fields stay valid — the audit trail must carry every character.
      const longPrompt = promptFor("explore") + `\n\n${"x".repeat(2500)}`;
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, { args: { prompt: longPrompt } });

      const log = readFileSync(join(logDir, "delegation-gate.log"), "utf8");
      expect(log).toContain(`RAW PROMPT (${longPrompt.length} chars): ${longPrompt}`);
    });

    it("logs the FULL description text in RAW DESCRIPTION for a 2000+ char description (T44-02)", async () => {
      const longDescription = "d".repeat(2000);
      await hooks["tool.execute.before"](
        { tool: "task", sessionID: "s1", callID: "c1" },
        { args: { prompt: promptFor("explore"), description: longDescription } }
      );

      const log = readFileSync(join(logDir, "delegation-gate.log"), "utf8");
      expect(log).toContain(`RAW DESCRIPTION (${longDescription.length} chars): ${longDescription}`);
    });

    it("logs the FULL scope text in the scope-validation warning with no 50-char cut (T44-03)", async () => {
      // A /home/ absolute path trips validateScope (advisory) but the SCOPE line
      // is skipped by detectForeignPaths, so the call proceeds to the warning.
      const longScope = "Implement full dispatch logging in /home/swarm/plugins/delegation-gate per issue 44 plan steps";
      const prompt = `AGENT: artisan
MODE: explore
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-08-03
SCOPE: ${longScope}
RESULT KD: knowledge/exploration-foo.md`;
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, { args: { prompt } });

      const log = readFileSync(join(logDir, "delegation-gate.log"), "utf8");
      expect(log).toContain(`WARNING: scope validation failed (len=${longScope.length}, content='${longScope}') — proceeding anyway`);
    });
  });
});
