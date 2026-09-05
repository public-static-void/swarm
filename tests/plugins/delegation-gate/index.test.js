import { describe, it, expect, beforeEach, beforeAll, afterAll, afterEach } from "vitest";
import { readFileSync, mkdtempSync, rmSync, existsSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pluginModule from "../../../plugins/delegation-gate/index.js";

// Absolute path to the plugin's disk templates — used to assert the deleted
// audit template stays gone (audit merged into review).
const PLUGIN_TEMPLATES_DIR = fileURLToPath(new URL("../../../plugins/delegation-gate/templates", import.meta.url));

// Consolidated delegation-gate suite: 106 → 53 tests. Issue-labeled
// one-off describes are folded into the core describes they exercise;
// duplicate and tautological assertions are merged into parameterized loops.
// No behavior coverage was dropped — the from → folded-into mapping is
// documented in the consolidation impl KD. The GENERATION-fallback
// state-file test was relocated to the protocol-gate suite, so this suite
// needs no temp PROTOCOL_GATE_STATE_DIR and never writes the real .state dir.
describe("Delegation-Gate Plugin", () => {
  let hooks;
  let logDir;
  let priorLogDir;
  let priorDebug;

  beforeAll(() => {
    // Log isolation: point DELEGATION_GATE_LOG_DIR at a per-run temp
    // dir BEFORE the first server() call so the module-level _logFile cache
    // binds to the temp path. Test runs then never append to the real
    // plugins/logs/delegation-gate.log — even when DELEGATION_GATE_DEBUG is
    // set in the environment (.env sets it). The flag is also asserted here
    // so every server() call in this suite deterministically exercises the
    // debug path and proves the redirect.
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

    it("does not capture the injected delegation format hint as bogus field values", async () => {
      // The Delegation Prompt Format: hint injected into the description is
      // instructional — its KEY: value lines must never be re-extracted as
      // kd_paths/result_kd/scope field values on a later dispatch.
      const description = `MODE: explore
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-08-27
SCOPE: Implement feature X
RESULT KD: knowledge/exploration-foo.md
Delegation Prompt Format:
DISPATCH TO: explorer
MODE: explore
INTENT KD: knowledge/intent-(name).md
SESSION DATE: today's date (e.g. 2026-08-08)
SESSION ID: (your session id)
GENERATION: (the lifecycle generation number)
SCOPE: (optional context)
RESULT KD: knowledge/exploration-<name>-<session_id>.md (when subagent produces a KD)
KD PATHS: upstream KD paths, comma-separated (optional)`;
      const output = { args: { prompt: "", description, subagent_type: "explorer" } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
      // The hint's instructional lines must not leak into the rendered prompt.
      expect(output.args.prompt).not.toContain("upstream KD paths");
      expect(output.args.prompt).not.toContain("(optional context)");
      expect(output.args.prompt).not.toContain("(when subagent produces a KD)");
      // The legitimate description fields are still extracted.
      expect(output.args.prompt).toContain("knowledge/intent-foo.md");
      expect(output.args.prompt).toContain("2026-08-27");
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

    it("allows glob patterns mentioned in prose (non-path context)", async () => {
      // A `*` in arbitrary prose is a mention, not a foreign path — the glob
      // check must be scoped to path-bearing lines.
      const prompt = `AGENT: artisan
MODE: explore
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-08-27
SCOPE: Implement feature X
RESULT KD: knowledge/exploration-foo.md

Update the agents/*.md and knowledge/issues/*.md files per the plan.`;
      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
      expect(output.args.prompt).toContain("knowledge/intent-foo.md");
    });

    it("still rejects genuine foreign paths — absolute, drive-letter, and traversal", async () => {
      // The glob-scoping fix must not weaken foreign-path protection.
      for (const body of ["/etc/passwd", "C:\\Windows\\System32", "../secret"]) {
        const prompt = `AGENT: artisan
MODE: explore
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-08-27
SCOPE: Implement feature X
RESULT KD: knowledge/exploration-foo.md
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

    it("rejects whole-value angle-bracket placeholders in any structured field", async () => {
      // Format-hint literals like <mode> or <session-id>, copied
      // verbatim into a dispatch, were captured by extraction and rendered —
      // now each rejects at the placeholder check before template lookup.
      const prompts = [
        // MODE placeholder must never reach template lookup
        `AGENT: artisan
MODE: <mode>
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-08-08
SCOPE: Implement feature X
RESULT KD: knowledge/impl-foo.md`,
        // Each standalone angle-bracket field
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

    it("accepts real values that merely look bracketed — no false positives", async () => {
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

      // A preflight dispatch without BRANCH is accepted (no BRANCH required)
      const preflight = `AGENT: committer
MODE: preflight
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-08-08
SCOPE: Preflight with real values
RESULT KD: knowledge/preflight-foo.md`;
      const out2 = { args: { prompt: preflight } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c2" }, out2);
      expect(out2.args.prompt).toContain("SCOPE: Preflight with real values");
    });

    it("rejects a verbatim RESULT KD template form via validateKDPath, not the placeholder check", async () => {
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

    it("rejects an empty prompt whose description carries old-style hint placeholders", async () => {
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

    it("lets real prompt values override stale description literals", async () => {
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
        // Checkpoint reads KDs from KD PATHS only — kd_paths supplied so the
        // sentence renders (stripped when kd_paths is absent)
        { mode: "checkpoint", result: "knowledge/checkpoint-foo.md", kdPaths: "knowledge/intent-foo.md", expectMatch: /Read KDs from KD PATHS/, expectNoMatch: /Read the INTENT KD at/ },
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
RESULT KD: ${c.result}
${c.kdPaths ? `KD PATHS: ${c.kdPaths}` : ""}`;

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
        { mode: "review", agent: "inspector", kd: "knowledge/review-foo.md" },
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

  describe("Cleanup INTENT-KD Exemption", () => {
    it("exempts cleanup from the intent_kd required-field check like checkpoint", async () => {
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

    it("keeps the cleanup and preflight fallback templates free of the INTENT-KD read instruction", async () => {
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

  describe("Cleanup Push Framing", () => {
    it("renders the cleanup dispatch with positive push framing", async () => {
      // The cleanup template must instruct the committer to push by default —
      // positive framing only, no negative push clause (the recurring
      // lifecycle-end non-push defect came from a negative scope overriding
      // this template).
      const prompt = `AGENT: committer
MODE: cleanup
SESSION DATE: 2026-08-29
SCOPE: Test cleanup
RESULT KD: knowledge/cleanup-foo.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
      expect(output.args.prompt).toMatch(/Commit and push/);
      expect(output.args.prompt).not.toMatch(/do not push/i);
    });

    it("keeps the cleanup fallback template positively framed", async () => {
      // The in-code fallback (disk template missing) must carry the same
      // positive push instruction — assert it on the source so drift is
      // caught at test time.
      const src = readFileSync(new URL("../../../plugins/delegation-gate/index.js", import.meta.url), "utf8");
      const fallbackLines = src.split("\n").filter(l => /^    cleanup: /.test(l));
      expect(fallbackLines).toHaveLength(1);
      expect(fallbackLines[0]).toMatch(/Commit and push/);
      expect(fallbackLines[0]).not.toMatch(/do not push/i);
    });
  });

  describe("Memory Division of Labor", () => {
    // Evolve dispatches the Habit Builder — its rendered prompt must stay free
    // of the Scribe-writes-memory rule (the rule belongs to scribe.md
    // step 11, not Habit Builder surfaces) and of any memory-write instruction.
    const evolvePrompt = `AGENT: habit-builder
MODE: evolve
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-08-06
SCOPE: Test evolve memory scope
RESULT KD: knowledge/process-foo.md`;

    it("keeps the Scribe-writes-memory rule out of the evolve template", async () => {
      const output = { args: { prompt: evolvePrompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
      expect(output.args.prompt).not.toContain("written by the Scribe during EXTRACT");
    });

    it("renders the evolve template without a memory-write instruction", async () => {
      const output = { args: { prompt: evolvePrompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
      expect(output.args.prompt).not.toContain("memory_write tool");
    });

    it("keeps the Scribe-writes-memory rule out of the evolve fallback template", async () => {
      // The in-code fallback (disk template missing) must render the same
      // contract — assert it on the source so drift is caught at test time.
      const src = readFileSync(new URL("../../../plugins/delegation-gate/index.js", import.meta.url), "utf8");
      const fallbackLines = src.split("\n").filter(l => /^    evolve: /.test(l));
      expect(fallbackLines).toHaveLength(1);
      expect(fallbackLines[0]).not.toContain("written by the Scribe during EXTRACT");
    });
  });

  describe("Conditional KD PATHS Rendering", () => {
    it("omits the KD PATHS header line and body sentence when kd_paths is absent", async () => {
      const cases = [
        { mode: "preflight", agent: "committer", result: "knowledge/preflight-foo.md" },
        { mode: "checkpoint", agent: "committer", result: "knowledge/checkpoint-foo.md" },
        { mode: "cleanup", agent: "committer", result: "knowledge/cleanup-foo.md" },
      ];
      for (const { mode, agent, result } of cases) {
        const prompt = `AGENT: ${agent}
MODE: ${mode}
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-08-03
SCOPE: Test conditional KD PATHS
RESULT KD: ${result}`;

        const output = { args: { prompt } };
        await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
        expect(output.args.prompt).not.toMatch(/^KD PATHS:.*$/m);
        expect(output.args.prompt).not.toContain("Read KDs from KD PATHS");
      }
    });

    it("renders the KD PATHS header line and body sentence when kd_paths is supplied", async () => {
      const cases = [
        { mode: "preflight", agent: "committer", result: "knowledge/preflight-foo.md" },
        { mode: "checkpoint", agent: "committer", result: "knowledge/checkpoint-foo.md" },
        { mode: "cleanup", agent: "committer", result: "knowledge/cleanup-foo.md" },
      ];
      for (const { mode, agent, result } of cases) {
        const prompt = `AGENT: ${agent}
MODE: ${mode}
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-08-03
SCOPE: Test conditional KD PATHS
RESULT KD: ${result}
KD PATHS: knowledge/upstream-foo.md`;

        const output = { args: { prompt } };
        await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
        expect(output.args.prompt).toContain("KD PATHS: knowledge/upstream-foo.md");
        expect(output.args.prompt).toContain("Read KDs from KD PATHS");
      }
    });

    it("renders KD PATHS unchanged for legitimate modes with kd_paths supplied", async () => {
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

  describe("SESSION_KDS Expansion and KD PATHS Advisory", () => {
    const SID = "ses_kdstest";
    let knowledgeDir;
    let stateDir;
    let priorKnowledgeDir;
    let priorStateDir;
    const readLog = () => {
      try { return readFileSync(join(logDir, "delegation-gate.log"), "utf8"); } catch (_) { return ""; }
    };

    beforeAll(() => {
      priorKnowledgeDir = process.env.PROTOCOL_GATE_KNOWLEDGE_DIR;
      priorStateDir = process.env.PROTOCOL_GATE_STATE_DIR;
      stateDir = mkdtempSync(join(tmpdir(), "delegation-gate-state-"));
      process.env.PROTOCOL_GATE_STATE_DIR = stateDir;
    });

    afterAll(() => {
      if (priorKnowledgeDir === undefined) delete process.env.PROTOCOL_GATE_KNOWLEDGE_DIR;
      else process.env.PROTOCOL_GATE_KNOWLEDGE_DIR = priorKnowledgeDir;
      if (priorStateDir === undefined) delete process.env.PROTOCOL_GATE_STATE_DIR;
      else process.env.PROTOCOL_GATE_STATE_DIR = priorStateDir;
      rmSync(stateDir, { recursive: true, force: true });
    });

    beforeEach(() => {
      knowledgeDir = mkdtempSync(join(tmpdir(), "delegation-gate-knowledge-"));
      process.env.PROTOCOL_GATE_KNOWLEDGE_DIR = knowledgeDir;
      // Clean the log file between tests to prevent stale output leaking across assertions.
      try { rmSync(join(logDir, "delegation-gate.log")); } catch (_) {}
    });

    afterEach(() => {
      rmSync(knowledgeDir, { recursive: true, force: true });
    });

    const writeKd = (name) => writeFileSync(join(knowledgeDir, name), "---\ntitle: t\n---\nbody\n");
    const writeState = (generation) =>
      writeFileSync(join(stateDir, `.protocol-state-${SID}.json`), JSON.stringify({ generation }));

    // Dispatch helper — one structured prompt per mode with optional
    // GENERATION (omitted entirely when undefined so state-file fallback and
    // legacy-form paths stay exercisable).
    const dispatch = async (mode, kdPaths, overrides = {}) => {
      const agents = { swarm: "artisan", evolve: "habit-builder", extract: "scribe", checkpoint: "committer", explore: "explorer" };
      const results = { swarm: "knowledge/impl-M1-foo.md", evolve: "knowledge/process-foo.md", extract: "knowledge/composed-foo.md", checkpoint: "knowledge/checkpoint-foo.md", explore: "knowledge/exploration-foo.md" };
      const lines = [
        `AGENT: ${agents[mode]}`,
        `MODE: ${mode}`,
        "INTENT KD: knowledge/intent-foo.md",
        "SESSION DATE: 2026-08-21",
      ];
      if (overrides.milestone) lines.push(`MILESTONE ID: ${overrides.milestone}`);
      lines.push(`SESSION ID: ${SID}`);
      if (overrides.generation !== undefined) lines.push(`GENERATION: ${overrides.generation}`);
      lines.push("SCOPE: Test SESSION_KDS expansion");
      lines.push(`RESULT KD: ${results[mode]}`);
      if (kdPaths) lines.push(`KD PATHS: ${kdPaths}`);
      const output = { args: { prompt: lines.join("\n") } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: SID, callID: "c1" }, output);
      return output;
    };

    // Expansion assertions target the checkpoint template — it renders the
    // `KD PATHS: {kd_paths}` header line (the explore template carries none).
    it("expands SESSION_KDS to every on-disk KD of the current lifecycle generation", async () => {
      writeKd(`intent-foo-${SID}-gen1.md`);
      writeKd(`spec-foo-${SID}-gen1.md`);
      writeKd(`plan-foo-${SID}-gen1.md`);
      const output = await dispatch("checkpoint", "SESSION_KDS", { generation: 1 });
      expect(output.args.prompt).toMatch(new RegExp(`^KD PATHS: .+intent-foo-${SID}-gen1\\.md`, "m"));
      expect(output.args.prompt).toContain(`knowledge/spec-foo-${SID}-gen1.md`);
      expect(output.args.prompt).toContain(`knowledge/plan-foo-${SID}-gen1.md`);
    });

    it("expands only the current generation — prior-generation KDs are never listed", async () => {
      writeKd(`intent-foo-${SID}-gen1.md`);
      writeKd(`intent-old-${SID}-gen0.md`);
      writeKd(`plan-future-${SID}-gen2.md`);
      const output = await dispatch("checkpoint", "SESSION_KDS", { generation: 1 });
      expect(output.args.prompt).toContain(`knowledge/intent-foo-${SID}-gen1.md`);
      expect(output.args.prompt).not.toContain(`intent-old-${SID}-gen0.md`);
      expect(output.args.prompt).not.toContain(`plan-future-${SID}-gen2.md`);
    });

    it("dedupes a mixed SESSION_KDS and literal path list", async () => {
      writeKd(`intent-foo-${SID}-gen1.md`);
      writeKd(`spec-foo-${SID}-gen1.md`);
      const output = await dispatch("checkpoint", `SESSION_KDS, knowledge/spec-foo-${SID}-gen1.md`, { generation: 1 });
      const header = output.args.prompt.match(/^KD PATHS: (.*)$/m)[1];
      expect(header).toContain(`knowledge/intent-foo-${SID}-gen1.md`);
      expect(header.split(`knowledge/spec-foo-${SID}-gen1.md`)).toHaveLength(2);
    });

    it("keeps literal-path validation strict alongside the token", async () => {
      for (const bad of ["knowledge/*.md", "/abs/path.md"]) {
        await expect(dispatch("explore", `SESSION_KDS, ${bad}`, { generation: 1 })).rejects.toThrow("Foreign paths detected");
      }
      // knowledge/nested/foo.md is now accepted (subdirectory paths allowed)
      // The explore template doesn't render KD PATHS, so the path won't appear in the prompt.
      // The key assertion is that the dispatch succeeds (no FOREIGN_PATH error).
      const output = await dispatch("explore", `SESSION_KDS, knowledge/nested/foo.md`, { generation: 1 });
      expect(output.args.prompt).toContain("MODE: explore");
    });

    it("accepts only the exact uppercase token", async () => {
      await expect(dispatch("explore", "session_kds", { generation: 1 })).rejects.toThrow("Foreign paths detected");
    });

    it("renders no KD PATHS header when SESSION_KDS expands to nothing", async () => {
      const output = await dispatch("checkpoint", "SESSION_KDS", { generation: 1 });
      expect(output.args.prompt).not.toMatch(/^KD PATHS:/m);
      expect(output.args.prompt).not.toContain("Read KDs from KD PATHS");
    });

    it("includes the legacy bare filename form at generation 0", async () => {
      writeKd(`intent-foo-${SID}.md`);
      writeKd(`plan-foo-${SID}-gen0.md`);
      const output = await dispatch("checkpoint", "SESSION_KDS", { generation: 0 });
      expect(output.args.prompt).toContain(`knowledge/intent-foo-${SID}.md`);
      expect(output.args.prompt).toContain(`knowledge/plan-foo-${SID}-gen0.md`);
    });

    it("falls back to the legacy bare form when no generation is resolvable", async () => {
      writeKd(`intent-foo-${SID}.md`);
      writeKd(`plan-foo-${SID}-gen1.md`);
      const output = await dispatch("checkpoint", "SESSION_KDS");
      expect(output.args.prompt).toContain(`knowledge/intent-foo-${SID}.md`);
      expect(output.args.prompt).not.toContain(`plan-foo-${SID}-gen1.md`);
    });

    it("resolves the expansion generation from protocol-gate state", async () => {
      writeKd(`intent-foo-${SID}-gen3.md`);
      writeKd(`intent-old-${SID}-gen2.md`);
      writeState(3);
      const output = await dispatch("checkpoint", "SESSION_KDS");
      expect(output.args.prompt).toContain(`knowledge/intent-foo-${SID}-gen3.md`);
      expect(output.args.prompt).not.toContain(`intent-old-${SID}-gen2.md`);
    });

    it("warns without blocking when an all-upstream dispatch under-enumerates", async () => {
      writeKd(`exploration-a-${SID}-gen1.md`);
      writeKd(`analysis-b-${SID}-gen1.md`);
      writeKd(`impl-M1-c-${SID}-gen1.md`);
      const output = await dispatch("evolve", `knowledge/exploration-a-${SID}-gen1.md`, { generation: 1 });
      const log = readLog();
      expect(log).toContain("under-enumeration");
      expect(log).toContain("1 listed");
      expect(log).toContain("3 on-disk");
      expect(log).toContain("SESSION_KDS");
      expect(output.args.prompt).toContain("Produce a PROCESS KD");
    });

    it("stays silent when the enumeration is complete", async () => {
      writeKd(`exploration-a-${SID}-gen1.md`);
      writeKd(`analysis-b-${SID}-gen1.md`);
      writeKd(`impl-M1-c-${SID}-gen1.md`);
      await dispatch("evolve", `knowledge/exploration-a-${SID}-gen1.md, knowledge/analysis-b-${SID}-gen1.md, knowledge/impl-M1-c-${SID}-gen1.md`, { generation: 1 });
      expect(readLog()).not.toContain("under-enumeration");
    });

    it("stays silent for SESSION_KDS dispatches — complete by construction", async () => {
      writeKd(`exploration-a-${SID}-gen1.md`);
      writeKd(`analysis-b-${SID}-gen1.md`);
      writeKd(`impl-M1-c-${SID}-gen1.md`);
      await dispatch("evolve", "SESSION_KDS", { generation: 1 });
      expect(readLog()).not.toContain("under-enumeration");
    });

    it("stays silent for templates without the all-upstream sentence", async () => {
      writeKd(`spec-a-${SID}-gen1.md`);
      writeKd(`plan-b-${SID}-gen1.md`);
      writeKd(`impl-M1-c-${SID}-gen1.md`);
      const output = await dispatch("swarm", `knowledge/spec-a-${SID}-gen1.md`, { milestone: "M1", generation: 1 });
      expect(readLog()).not.toContain("under-enumeration");
      expect(output.args.prompt).toContain("Read SPEC KDs and PLAN KDs from KD PATHS.");
    });

    it("emits the advisory to the log file when DELEGATION_GATE_DEBUG is set", async () => {
      process.env.DELEGATION_GATE_DEBUG = "1";
      try {
        writeKd(`exploration-a-${SID}-gen1.md`);
        writeKd(`analysis-b-${SID}-gen1.md`);
        const output = await dispatch("extract", `knowledge/exploration-a-${SID}-gen1.md`, { generation: 1 });
        expect(readLog()).toContain("under-enumeration");
        expect(output.args.prompt).toContain("Produce a COMPOSED KD");
      } finally {
        delete process.env.DELEGATION_GATE_DEBUG;
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
      // Only current mode's KD prefix is injected — not all 10 modes
      expect(output.args.description).toContain("RESULT KD: knowledge/checkpoint-<name>-<session_id>.md");
      expect(output.args.description).toContain("- checkpoint: knowledge/checkpoint-<name>-<session_id>.md");
      for (const other of ["exploration", "analysis", "spec", "plan", "impl", "review", "composed", "process", "preflight", "cleanup"]) {
        expect(output.args.description).not.toContain(other);
      }
      // Genuine variables use parenthetical wording — the defused hint keeps no
      // whole-value <...> placeholder line that extraction could capture
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
        { agent: "analyzer", mode: "investigate", result: "knowledge/analysis-<name>-<session_id>.md", other: ["exploration", "review"] },
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
          // No other mode's KD path prefix may be injected — bare mode words
          // like "cleanup" legitimately appear in the description text.
          expect(output.args.description).not.toContain(`knowledge/${other}-`);
        }
      }
    });

    it("injects the single review KD prefix — the audit prefix is gone", async () => {
      const prompt = `AGENT: inspector
MODE: review
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-15
SCOPE: Review implementation
RESULT KD: knowledge/review-foo.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);

      expect(output.args.description).toContain("MODE: review");
      expect(output.args.description).toContain("RESULT KD: knowledge/review-<name>-<session_id>.md");
      expect(output.args.description).toContain("- review: knowledge/review-<name>-<session_id>.md");
      expect(output.args.description).toContain("RESULT KD Naming Convention:");
      expect(output.args.description).not.toContain("RESULT KD Naming Conventions:");
      // The merged review+audit surface shows ONE naming hint — no audit- prefix,
      // no dual naming conventions (audit merged into review).
      expect(output.args.description).not.toContain("knowledge/audit-");
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

    it("rejects an audit dispatch as an unknown mode (audit merged into review)", async () => {
      const prompt = `AGENT: inspector
MODE: audit
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-15
SCOPE: Audit implementation
RESULT KD: knowledge/audit-foo.md`;

      const output = { args: { prompt } };
      // audit is no longer a recognized mode: it is not in KNOWN_MODES, has no
      // KD-producing entry, and its template file is deleted — so the dispatch
      // is rejected at template lookup like any unknown mode.
      await expect(
        hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output)
      ).rejects.toThrow("No template found for mode: audit");

      expect(output.args.prompt).toContain("MODE: audit");
      expect(output.args.description).toContain("knowledge/<type>-<name>-<session_id>.md");
    });

    it("renders the merged review instruction and FAIL-citation mandate from templates/review.json", async () => {
      const prompt = `AGENT: inspector
MODE: review
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-15
SCOPE: Review implementation
RESULT KD: knowledge/review-foo.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);

      // Merged surface: one review dispatch instructs the security audit AND the
      // review — the audit is a section of the review KD, not a separate KD.
      expect(output.args.prompt).toContain("run the security audit per the scope above");
      expect(output.args.prompt).toContain("Produce a REVIEW KD (review findings + audit section)");
      // Single naming-convention hint on the merged surface — generation renders
      // when the dispatch carries one; the prefix hint is review-only.
      expect(output.args.prompt).toContain("knowledge/review-<name>-<session_id>-gen");
      // Verdict + OQ-4 citation mandate surfaced to the Inspector.
      expect(output.args.prompt).toContain("verdict: PASS | FAIL | FUNDAMENTAL");
      expect(output.args.prompt).toContain("CITATION MANDATE");
      expect(output.args.prompt).toContain("every FAIL finding MUST cite at least one milestone token");
      expect(output.args.prompt).toContain("MALFORMED");
      // No audit-specific dispatch remains on the surface.
      expect(output.args.prompt).not.toMatch(/MODE: audit/);
    });

    it("has no templates/audit.json on disk", () => {
      expect(existsSync(join(PLUGIN_TEMPLATES_DIR, "audit.json"))).toBe(false);
      expect(existsSync(join(PLUGIN_TEMPLATES_DIR, "review.json"))).toBe(true);
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

    // dispatcherFormatHint() is mode-agnostic —
    // injected via tool.definition before dispatch, when the mode is not yet known.
    // The swarm MILESTONE ID line therefore carries the "(swarm mode only)"
    // qualifier, and the KD PATHS line documents the comma-separated convention
    // that the validation split() (index.js:516-517) expects.
    it("annotates the task tool definition with the swarm MILESTONE ID and comma-separated KD PATHS conventions", async () => {
      const output = { description: "Delegate work to another agent." };
      await hooks["tool.definition"]({ toolID: "task" }, output);

      expect(output.description).toContain("Delegation Prompt Format:");
      expect(output.description).toContain("MILESTONE ID: milestone id — swarm mode only, exactly one, required");
      expect(output.description).toContain("swarm mode only");
      expect(output.description).toContain("KD PATHS: upstream KD paths, comma-separated (optional)");
      expect(output.description).toContain("comma-separated");
    });
  });

  describe("Defused Format Hints", () => {
    // Neither hint may contain a KEY: line whose value is a whole-value
    // angle-bracket placeholder — such a line, copied verbatim into a dispatch,
    // is exactly the leak source fixed. The RESULT KD example lines keep
    // <name>-<session_id> path components but are never whole-value <...>.
    const wholeValueAngleLine = /^(?:#{1,6}\s*)?(?:\*\*)?(?:AGENT|DISPATCH TO|MODE|MILESTONE[. _]ID|INTENT[. _]KD|SESSION[. _]DATE|SESSION[. _]ID|GENERATION|SCOPE|RESULT[. _]KD|KD[. _]PATHS)(?:\*\*)?:\s*<[^>]+>$/;

    it("emits no extractable whole-value angle-bracket line from dispatcherFormatHint", async () => {
      const output = { description: "Delegate work to another agent." };
      await hooks["tool.definition"]({ toolID: "task" }, output);

      const badLines = output.description.split("\n").filter(l => wholeValueAngleLine.test(l.trim()));
      expect(badLines).toEqual([]);
      // Instructional wording survives; the retained RESULT KD template form is
      // not a whole-value placeholder.
      expect(output.description).toContain("DISPATCH TO: agent name (e.g. explorer)");
      expect(output.description).toContain("MODE: delegation mode (e.g. explore)");
      expect(output.description).toContain("SESSION DATE: today's date (e.g. ");
      expect(output.description).toContain("KD PATHS: upstream KD paths, comma-separated (optional)");
      expect(output.description).toContain("RESULT KD: knowledge/<type>-<name>-<session_id>[-gen<N>].md");
    });

    it("emits no extractable whole-value angle-bracket line from the injected hint and renders concrete values", async () => {
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
      // Fixed fields render concrete values; genuine variables use
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
        { mode: "preflight", agent: "committer", scope: "Setup workspace" },
        { mode: "align", agent: "spec-weaver", scope: "Align requirements" },
        { mode: "review", agent: "inspector", scope: "Review implementation" },
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

  describe("Swarm Milestone Enforcement", () => {
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

  describe("Milestone-Scoped impl Result KD", () => {
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

  // BRANCH Contract tests removed — BRANCH parameter eliminated from delegation system

  describe("Backward Compatibility - BRANCH Removal", () => {
    it("accepts a preflight dispatch without BRANCH field", async () => {
      const prompt = `AGENT: committer
MODE: preflight
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-08-03
SCOPE: Test preflight without BRANCH
RESULT KD: knowledge/preflight-foo.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
      expect(output.args.prompt).toContain("MODE: preflight");
    });

    it("does not crash when BRANCH is present in prompt (backward compat)", async () => {
      const prompt = `AGENT: committer
MODE: preflight
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-08-03
BRANCH: fix/old-style
SCOPE: Test backward compat
RESULT KD: knowledge/preflight-foo.md`;

      const output = { args: { prompt } };
      // Should not throw — BRANCH is harmlessly ignored
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
      expect(output.args.prompt).toContain("MODE: preflight");
      // BRANCH line is stripped from rendered output since it's not a recognized field
      expect(output.args.prompt).not.toContain("BRANCH: fix/old-style");
    });
  });

  describe("Generation Propagation", () => {
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

    it("does not require PROTOCOL_GATE_STATE_DIR and leaves the real .state dir untouched", async () => {
      // The GENERATION-fallback state-file test now lives in the protocol-gate
      // suite. This suite runs against the plugin default without any env
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

  describe("Scope Classification Removal", () => {
    it("renders no SCOPE CLASSIFICATION line for an evolve dispatch omitting scope_classification", async () => {
      const prompt = `AGENT: habit-builder
MODE: evolve
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-08-30
SESSION ID: ses_scope3
GENERATION: 0
SCOPE: Evolve process
RESULT KD: knowledge/process-foo-ses_scope3-gen0.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "ses_scope3", callID: "c3" }, output);
      expect(output.args.prompt).not.toContain("SCOPE CLASSIFICATION");
    });

    it("renders no SCOPE CLASSIFICATION line for a swarm dispatch omitting scope_classification", async () => {
      const prompt = `AGENT: artisan
MODE: swarm
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-08-30
SESSION ID: ses_scope2
GENERATION: 0
MILESTONE ID: M2
SCOPE: Execute milestone M2
RESULT KD: knowledge/impl-M2-foo-ses_scope2-gen0.md
KD PATHS: knowledge/spec-foo.md, knowledge/plan-foo.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "ses_scope2", callID: "c2" }, output);
      expect(output.args.prompt).not.toContain("SCOPE CLASSIFICATION");
    });
  });

  describe("Log Isolation", () => {
    const promptFor = (mode, overrides = {}) => `AGENT: ${overrides.agent || "artisan"}
MODE: ${mode}
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-08-03
SCOPE: Log isolation test
RESULT KD: knowledge/${overrides.kd || "exploration"}-foo.md`;

    it("writes debug output to the env-seam directory when DELEGATION_GATE_LOG_DIR is set", async () => {
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

    it("honors a runtime DELEGATION_GATE_LOG_DIR change with no stale-cache writes", async () => {
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

    it("keeps the real plugins/logs log untouched and writes to the suite temp dir", async () => {
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

    it("does not write debug output when DELEGATION_GATE_DEBUG is unset", async () => {
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

    it("logs the FULL prompt text in RAW PROMPT with the (N chars) annotation for a 2000+ char prompt", async () => {
      // Trailing body text extends the prompt past 2000 chars while the
      // structured fields stay valid — the audit trail must carry every character.
      const longPrompt = promptFor("explore") + `\n\n${"x".repeat(2500)}`;
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, { args: { prompt: longPrompt } });

      const log = readFileSync(join(logDir, "delegation-gate.log"), "utf8");
      expect(log).toContain(`RAW PROMPT (${longPrompt.length} chars): ${longPrompt}`);
    });

    it("logs the FULL description text in RAW DESCRIPTION for a 2000+ char description", async () => {
      const longDescription = "d".repeat(2000);
      await hooks["tool.execute.before"](
        { tool: "task", sessionID: "s1", callID: "c1" },
        { args: { prompt: promptFor("explore"), description: longDescription } }
      );

      const log = readFileSync(join(logDir, "delegation-gate.log"), "utf8");
      expect(log).toContain(`RAW DESCRIPTION (${longDescription.length} chars): ${longDescription}`);
    });

    it("logs the FULL scope text in the scope-validation warning with no 50-char cut", async () => {
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
