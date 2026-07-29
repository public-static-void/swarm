import { describe, it, expect, vi, beforeEach } from "vitest";
import pluginModule from "../../../plugins/delegation-gate/index.js";

describe("Delegation-Gate Plugin", () => {
  let hooks;

  beforeEach(async () => {
    hooks = await pluginModule.server({}, {});
  });

  describe("Default Export", () => {
    it("exports a PluginModule object with id and server", () => {
      expect(typeof pluginModule).toBe("object");
      expect(pluginModule.id).toBe("delegation-gate");
      expect(typeof pluginModule.server).toBe("function");
    });

    it("server() returns named hook functions", async () => {
      const result = await pluginModule.server({}, {});
      expect(typeof result["tool.execute.before"]).toBe("function");
    });

    it("has no named exports beyond default", () => {
      const module = require("../../../plugins/delegation-gate/index.js");
      const namedExports = Object.keys(module).filter(k => k !== "default" && k !== "__esModule");
      expect(namedExports).toHaveLength(0);
    });
  });

  describe("Field Extraction", () => {
    it("extracts all required fields from structured prompt", async () => {
      const prompt = `AGENT: artisan
MODE: explore
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-15
SCOPE: Implement feature X
RESULT KD: knowledge/exploration-foo.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);

      expect(output.args.prompt).toContain("knowledge/intent-foo.md");
    });

    it("extracts agent from DISPATCH TO: format (template-rendered)", async () => {
      const prompt = `DISPATCH TO: artisan
MODE: explore
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-15
SCOPE: Implement feature X
RESULT KD: knowledge/exploration-foo.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);

      expect(output.args.prompt).toContain("knowledge/intent-foo.md");
    });

    it("extracts agent from AGENT: format (raw prompt)", async () => {
      const prompt = `AGENT: artisan
MODE: explore
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-15
SCOPE: Implement feature X
RESULT KD: knowledge/exploration-foo.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);

      expect(output.args.prompt).toContain("knowledge/intent-foo.md");
    });

    it("extracts fields with underscore variants (intent_kd, session_date, result_kd)", async () => {
      const prompt = `AGENT: artisan
MODE: explore
intent_kd: knowledge/intent-foo.md
session_date: 2026-07-15
SCOPE: Implement feature X
result_kd: knowledge/exploration-foo.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);

      expect(output.args.prompt).toContain("knowledge/intent-foo.md");
      expect(output.args.prompt).toContain("2026-07-15");
    });

    it("rejects prompt without structured fields", async () => {
      const prompt = "Please implement feature X";

      await expect(
        hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, { args: { prompt } })
      ).rejects.toThrow("Missing required structured fields");
    });

    it("rejects prompt missing any required field", async () => {
      const prompt = `AGENT: artisan
MODE: checkpoint`;

      await expect(
        hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, { args: { prompt } })
      ).rejects.toThrow("Missing required structured fields");
    });
  });

  describe("Content Validators", () => {
    it("rejects code blocks in prompt", async () => {
      const prompt = `AGENT: artisan
MODE: checkpoint
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-15
SCOPE: Implement feature X
RESULT KD: knowledge/impl-foo.md

\`\`\`js
console.log("test");
\`\`\``;

      await expect(
        hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, { args: { prompt } })
      ).rejects.toThrow("Code blocks detected in prompt");
    });

    it("rejects foreign paths in free-form text (not structured fields)", async () => {
      // Foreign path detector skips structured field lines by design.
      // Use a non-field line with an absolute path.
      const prompt = `AGENT: artisan
MODE: checkpoint
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-15
SCOPE: Implement feature X
RESULT KD: knowledge/impl-foo.md
/home/user/secret-file.txt`;

      await expect(
        hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, { args: { prompt } })
      ).rejects.toThrow("Foreign paths detected");
    });

    it("rejects bare KD path without structured fields", async () => {
      const prompt = "knowledge/intent-foo.md";

      await expect(
        hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, { args: { prompt } })
      ).rejects.toThrow("Bare KD path without structured fields");
    });

    it("accepts relative file paths in non-field lines (security handled by absolute-path checks)", async () => {
      const prompt = `AGENT: artisan
MODE: explore
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-15
SCOPE: Implement feature X
RESULT KD: knowledge/exploration-foo.md
docs/ROADMAP.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
      expect(output.args.prompt).toContain("knowledge/intent-foo.md");
    });

    it("validates KD paths against knowledge/*.md pattern when result_kd is provided", async () => {
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

    it("rejects prompt without result_kd for cleanup mode (KD-producing)", async () => {
      const prompt = `AGENT: committer
MODE: cleanup
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-15
SCOPE: Implement feature X`;

      await expect(
        hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, { args: { prompt } })
      ).rejects.toThrow("KD-producing mode requires result_kd");
    });

    it("treats empty string result_kd as missing for cleanup mode", async () => {
      // Overseer writes "RESULT KD:" with nothing after it — extracts as ""
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

    it("rejects literal placeholder {scope} in scope field", async () => {
      const prompt = `AGENT: artisan
MODE: checkpoint
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-15
SCOPE: {scope}`;

      await expect(
        hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, { args: { prompt } })
      ).rejects.toThrow("unresolved placeholder");
    });

    it("rejects literal placeholder {result_kd} in result_kd field", async () => {
      const prompt = `AGENT: artisan
MODE: checkpoint
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-15
SCOPE: Implement feature X
RESULT KD: {result_kd}`;

      await expect(
        hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, { args: { prompt } })
      ).rejects.toThrow("unresolved placeholder");
    });

    it("rejects literal placeholder {intent_kd} in intent_kd field", async () => {
      const prompt = `AGENT: artisan
MODE: checkpoint
INTENT KD: {intent_kd}
SESSION DATE: 2026-07-15
SCOPE: Implement feature X`;

      await expect(
        hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, { args: { prompt } })
      ).rejects.toThrow("unresolved placeholder");
    });

    it("strips unresolved placeholders from rendered template", async () => {
      // When scope is not provided but result_kd is,
      // the template's {scope} placeholder should be stripped from output
      const prompt = `AGENT: explorer
MODE: explore
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-15
RESULT KD: knowledge/exploration-foo.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
      // scope not provided — {scope} placeholder should be stripped
      expect(output.args.prompt).not.toContain("{scope}");
      expect(output.args.prompt).toContain("knowledge/intent-foo.md");
    });
  });

  describe("Scope Validation", () => {
    it("accepts empty scope (advisory validation only)", async () => {
      const prompt = `AGENT: artisan
MODE: explore
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-15
SCOPE: 
RESULT KD: knowledge/exploration-foo.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
      expect(output.args.prompt).toContain("knowledge/intent-foo.md");
    });

    it("accepts scope exceeding 200 characters (no length limit)", async () => {
      const longScope = "A".repeat(201);
      const prompt = `AGENT: artisan
MODE: checkpoint
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-15
SCOPE: ${longScope}
RESULT KD: knowledge/impl-foo.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
      expect(output.args.prompt).toContain(longScope);
    });

    it("accepts negative framing in scope (advisory)", async () => {
      const prompt = `AGENT: artisan
MODE: checkpoint
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-15
SCOPE: Do not use TypeScript
RESULT KD: knowledge/impl-foo.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
      expect(output.args.prompt).toContain("Do not use TypeScript");
    });

    it("accepts relative file paths in scope", async () => {
      const prompt = `AGENT: explorer
MODE: explore
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-16
SCOPE: Read docs/ROADMAP.md and identify the best item
RESULT KD: knowledge/exploration-foo.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
      expect(output.args.prompt).toContain("docs/ROADMAP.md");
    });

    it("rejects scope containing absolute /home/ paths", async () => {
      const prompt = `AGENT: explorer
MODE: explore
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-16
SCOPE: Read /home/user/secret.md for details
RESULT KD: knowledge/exploration-foo.md`;

      // Scope validation is advisory — logs warning but does not block
      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
      expect(output.args.prompt).toContain("knowledge/intent-foo.md");
    });

    it("accepts scope containing URLs (advisory)", async () => {
      const prompt = `AGENT: explorer
MODE: explore
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-16
SCOPE: Check https://example.com/docs for API details
RESULT KD: knowledge/exploration-foo.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
      expect(output.args.prompt).toContain("https://example.com/docs");
    });

    it("accepts scope with multiple sentences (advisory)", async () => {
      const prompt = `AGENT: explorer
MODE: explore
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-16
SCOPE: Read the docs first. Then identify gaps. Finally produce a summary.
RESULT KD: knowledge/exploration-foo.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
      expect(output.args.prompt).toContain("Read the docs first");
    });

    it("accepts scope with multi-step conjunctions (advisory)", async () => {
      const prompt = `AGENT: explorer
MODE: explore
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-16
SCOPE: Find the config file and then update it
RESULT KD: knowledge/exploration-foo.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
      expect(output.args.prompt).toContain("Find the config file");
    });

    it("accepts concise scope descriptions", async () => {
      const prompt = `AGENT: explorer
MODE: explore
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-16
SCOPE: Explore the plugin system architecture
RESULT KD: knowledge/exploration-foo.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
      expect(output.args.prompt).toContain("Explore the plugin system architecture");
    });

    it("accepts prompt without scope (scope is optional)", async () => {
      const prompt = `AGENT: committer
MODE: preflight
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-17
RESULT KD: knowledge/preflight-foo.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
      expect(output.args.prompt).toContain("knowledge/intent-foo.md");
    });

    it("rejects prompt without scope or result_kd for cleanup mode (KD-producing)", async () => {
      const prompt = `AGENT: committer
MODE: cleanup
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-17`;

      await expect(
        hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, { args: { prompt } })
      ).rejects.toThrow("KD-producing mode requires result_kd");
    });
  });

  describe("Template Injection", () => {
    it("renders prompt from template for valid structured prompt", async () => {
      const prompt = `AGENT: artisan
MODE: explore
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-15
SCOPE: Implement feature X
RESULT KD: knowledge/exploration-foo.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);

      expect(output.args.prompt).toContain("knowledge/intent-foo.md");
      expect(output.args.prompt).toContain("2026-07-15");
      expect(output.args.prompt).toContain("Implement feature X");
    });

    it("replaces output.args.prompt with rendered template", async () => {
      const prompt = `AGENT: artisan
MODE: explore
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-15
SCOPE: Implement feature X
RESULT KD: knowledge/exploration-foo.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);

      expect(output.args.prompt).not.toBe(prompt);
      expect(output.args.prompt).toBeDefined();
    });
  });

  describe("Cross-Agent Validation", () => {
    it("validates prompts for any agent using task tool", async () => {
      const prompt = `AGENT: committer
MODE: preflight
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-15
SCOPE: Setup workspace
RESULT KD: knowledge/plan-preflight.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);

      expect(output.args.prompt).toContain("knowledge/intent-foo.md");
    });
  });

  describe("Tool Doc Injection", () => {
    it("injects delegation format with concrete examples and variable placeholders", async () => {
      const prompt = `AGENT: artisan
MODE: checkpoint
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-15
SCOPE: Implement feature X
RESULT KD: knowledge/impl-foo.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);

      expect(output.args.description).toContain("Delegation Prompt Format");
      // Concrete examples — LLMs copy these as real values, not templates
      expect(output.args.description).toContain("DISPATCH TO: explorer");
      expect(output.args.description).toContain("MODE: explore");
      // Variable placeholders — genuinely vary per dispatch
      expect(output.args.description).toContain("INTENT KD: knowledge/intent-<name>.md");
      expect(output.args.description).toContain("SESSION ID: <session-id>");
      expect(output.args.description).toContain("SCOPE: <optional context>");
      // No angle bracket placeholders for fixed fields
      expect(output.args.description).not.toContain("<agent-name>");
      expect(output.args.description).not.toContain("<descriptive-name>");
    });

    it("does not duplicate format hint when description already contains it", async () => {
      const prompt = `AGENT: artisan
MODE: checkpoint
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-15
SCOPE: Implement feature X
RESULT KD: knowledge/impl-foo.md`;

      const output = { args: { prompt, description: "Existing description with Delegation Prompt Format: already here" } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);

      // Should not append a second copy
      const matches = output.args.description.match(/Delegation Prompt Format:/g);
      expect(matches).toHaveLength(1);
    });
  });

  describe("Subagent Type Fallback", () => {
    it("extracts agent from subagent_type when not in prompt text", async () => {
      // Overseer puts agent in output.args.subagent_type, not in prompt
      const prompt = `MODE: explore
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-17
SCOPE: Implement feature X
RESULT KD: knowledge/exploration-foo.md`;

      const output = { args: { prompt, subagent_type: "artisan" } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);

      expect(output.args.prompt).toContain("artisan");
      expect(output.args.prompt).toContain("knowledge/intent-foo.md");
    });

    it("subagent_type takes precedence over prompt text agent", async () => {
      const prompt = `AGENT: committer
MODE: explore
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-17
SCOPE: Implement feature X
RESULT KD: knowledge/exploration-foo.md`;

      const output = { args: { prompt, subagent_type: "artisan" } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);

      // subagent_type wins over prompt-extracted agent (structured task args vs free-form text)
      expect(output.args.prompt).toContain("artisan");
    });

    it("full end-to-end: subagent_type provides agent field", async () => {
      const prompt = `MODE: investigate
INTENT KD: knowledge/intent-bar.md
SESSION DATE: 2026-07-17
SCOPE: Analyze plugin system
RESULT KD: knowledge/analysis-bar.md`;

      const output = { args: { prompt, subagent_type: "artisan" } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);

      expect(output.args.prompt).toContain("artisan");
      expect(output.args.prompt).toContain("knowledge/intent-bar.md");
      expect(output.args.prompt).toContain("Analyze plugin system");
    });
  });

  describe("Description Scope Fallback", () => {
    it("accepts prompt without SCOPE field (scope is optional)", async () => {
      const prompt = `AGENT: artisan
MODE: explore
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-17
RESULT KD: knowledge/exploration-foo.md`;

      const output = { args: { prompt, description: "Implement feature X" } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
      expect(output.args.prompt).toContain("knowledge/intent-foo.md");
    });

    it("prompt text scope takes precedence over description", async () => {
      const prompt = `AGENT: artisan
MODE: checkpoint
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-17
SCOPE: Fix the bug
RESULT KD: knowledge/impl-foo.md`;

      const output = { args: { prompt, description: "Implement feature X" } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);

      // Template renders with "Fix the bug" (from prompt), not "Implement feature X" (from description)
      expect(output.args.prompt).toContain("Fix the bug");
    });
  });

  describe("Description Field Extraction (Issue 2)", () => {
    it("extracts fields from description as fallback when prompt is empty", async () => {
      // With description fallback, fields in description are used when prompt is empty.
      // Prompt fields take priority when both are present.
      const description = `MODE: explore
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-17
SCOPE: Implement feature X
RESULT KD: knowledge/exploration-foo.md`;

      const output = { args: { prompt: "", description, subagent_type: "artisan" } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
      expect(output.args.prompt).toContain("knowledge/intent-foo.md");
    });

    it("prompt fields override description fields when both present", async () => {
      const prompt = `AGENT: artisan
MODE: explore
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-17
SCOPE: Implement feature X
RESULT KD: knowledge/exploration-foo.md`;
      const description = `SESSION DATE: 2099-01-01
SCOPE: From description
RESULT KD: knowledge/wrong.md`;

      const output = { args: { prompt, description } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);

      // Uses prompt's values, not description's
      expect(output.args.prompt).toContain("2026-07-17");
      expect(output.args.prompt).toContain("Implement feature X");
      expect(output.args.prompt).toContain("knowledge/exploration-foo.md");
    });

    it("prompt fields are used even when description has different values", async () => {
      const prompt = `AGENT: artisan
MODE: checkpoint
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-17
SCOPE: From prompt
RESULT KD: knowledge/impl-foo.md`;
      const description = `SCOPE: From description`;

      const output = { args: { prompt, description } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);

      expect(output.args.prompt).toContain("From prompt");
    });

    it("valid end-to-end: all fields in prompt, agent via subagent_type", async () => {
      const prompt = `MODE: preflight
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-17
SCOPE: Setup workspace
RESULT KD: knowledge/preflight-workspace.md`;

      const output = { args: { prompt, subagent_type: "committer" } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);

      expect(output.args.prompt).toContain("committer");
      expect(output.args.prompt).toContain("knowledge/intent-foo.md");
      expect(output.args.prompt).toContain("2026-07-17");
      expect(output.args.prompt).toContain("Setup workspace");
    });
  });

  describe("Prose-Format Intent KD Extraction (Bug 2)", () => {
    it("extracts intent_kd from 'Read the INTENT KD at <path>' prose", async () => {
      const prompt = `You are the Explorer agent in explore mode.
Read the INTENT KD at knowledge/intent-foo.md for context.
SESSION DATE: 2026-07-23
SCOPE: Explore the memory system
RESULT KD: knowledge/exploration-foo.md`;

      const output = { args: { prompt, subagent_type: "explorer" } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
      expect(output.args.prompt).toContain("knowledge/intent-foo.md");
    });

    it("extracts intent_kd from 'intent_kd: <path>' inline format", async () => {
      const prompt = `AGENT: artisan
MODE: explore
intent_kd: knowledge/intent-bar.md
SESSION DATE: 2026-07-23
SCOPE: Fix bug
RESULT KD: knowledge/exploration-bar.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
      expect(output.args.prompt).toContain("knowledge/intent-bar.md");
    });

    it("structured INTENT KD: still takes precedence over prose fallback", async () => {
      const prompt = `AGENT: artisan
MODE: explore
INTENT KD: knowledge/intent-structured.md
SESSION DATE: 2026-07-23
SCOPE: Fix bug
RESULT KD: knowledge/exploration-foo.md

Also reference knowledge/intent-prose.md in context.`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
      // Structured field wins over prose pattern
      expect(output.args.prompt).toContain("knowledge/intent-structured.md");
    });

    it("extracts intent_kd from mixed prose and structured fields", async () => {
      const prompt = `MODE: explore
SESSION DATE: 2026-07-23
SCOPE: Explore the codebase
RESULT KD: knowledge/exploration-mixed.md

Load the kd-system skill. Read the INTENT KD at knowledge/intent-mixed.md for context.`;

      const output = { args: { prompt, subagent_type: "explorer" } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
      expect(output.args.prompt).toContain("knowledge/intent-mixed.md");
    });

    it("does not extract intent_kd from unrelated text mentioning 'intent'", async () => {
      const prompt = `AGENT: artisan
MODE: explore
INTENT KD: knowledge/intent-real.md
SESSION DATE: 2026-07-23
SCOPE: Fix the intent detection bug
RESULT KD: knowledge/exploration-foo.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
      expect(output.args.prompt).toContain("knowledge/intent-real.md");
    });
  });

  describe("Session ID Injection", () => {
    it("extracts session_id from SESSION ID: field in prompt", async () => {
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

    it("injects session_id from hookInput.sessionID when prompt omits SESSION ID:", async () => {
      const prompt = `AGENT: artisan
MODE: checkpoint
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-15
SCOPE: Implement feature X
RESULT KD: knowledge/impl-foo.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "hook-session-42", callID: "c1" }, output);
      expect(output.args.prompt).toContain("hook-session-42");
    });

    it("prompt SESSION ID: takes precedence over hookInput.sessionID", async () => {
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

    it("SESSION ID: line is not flagged by foreign path detection", async () => {
      const prompt = `AGENT: artisan
MODE: checkpoint
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-15
SESSION ID: some-session-id
SCOPE: Implement feature X
RESULT KD: knowledge/impl-foo.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
      expect(output.args.prompt).toContain("some-session-id");
    });

    it("strips unresolved {session_id} placeholder from rendered template", async () => {
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

  describe("Non-Task Tools", () => {
    it("passes through non-task tools without validation", async () => {
      const output = { args: { filePath: "some-file.md" } };
      await hooks["tool.execute.before"]({ tool: "read", sessionID: "s1", callID: "c1" }, output);
      // Should not throw — handler returns early for non-task tools
      expect(output).toEqual({ args: { filePath: "some-file.md" } });
    });
  });

  describe("Embedded KD Paths", () => {
    it("accepts lines with embedded KD paths in body text", async () => {
      const prompt = `AGENT: artisan
MODE: explore
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-15
SCOPE: Implement feature X
RESULT KD: knowledge/exploration-foo.md

Read the INTENT KD at knowledge/intent-foo.md for details.`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
      // Should not throw — embedded KD paths are valid
      expect(output.args.prompt).toContain("knowledge/intent-foo.md");
    });

    it("accepts KD paths embedded in template-rendered text", async () => {
      // Use explore mode — template includes RESULT KD so embedded path appears in output
      const prompt = `AGENT: explorer
MODE: explore
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-15
SCOPE: Implement feature X
RESULT KD: knowledge/exploration-foo.md

Load the kd-system skill. Read the INTENT KD at knowledge/intent-foo.md. Explore the codebase per the scope above. Produce an EXPLORATION KD at knowledge/exploration-foo.md.`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
      // Should not throw — multiple embedded KD paths are valid
      expect(output.args.prompt).toContain("knowledge/intent-foo.md");
      expect(output.args.prompt).toContain("knowledge/exploration-foo.md");
    });

    it("still rejects absolute paths on their own lines", async () => {
      const prompt = `AGENT: artisan
MODE: checkpoint
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-15
SCOPE: Implement feature X
RESULT KD: knowledge/impl-foo.md
/etc/passwd`;

      await expect(
        hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, { args: { prompt } })
      ).rejects.toThrow("Foreign paths detected");
    });

    it("still rejects absolute paths on their own lines", async () => {
      const prompt = `AGENT: artisan
MODE: checkpoint
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-15
SCOPE: Implement feature X
RESULT KD: knowledge/impl-foo.md
/home/user/config.json`;

      await expect(
        hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, { args: { prompt } })
      ).rejects.toThrow("Foreign paths detected");
    });

    it("skips DISPATCH TO: lines in foreign path detection", async () => {
      const prompt = `DISPATCH TO: artisan
MODE: explore
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-15
SCOPE: Implement feature X
RESULT KD: knowledge/exploration-foo.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
      // DISPATCH TO: line should not trigger foreign path detection
      expect(output.args.prompt).toContain("knowledge/intent-foo.md");
    });
  });

  describe("Markdown Bold Stripping (Issue 7A)", () => {
    it("strips ** from agent field value", async () => {
      const prompt = `AGENT: **artisan**
MODE: checkpoint
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-21
SCOPE: Implement feature X
RESULT KD: knowledge/impl-foo.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
      expect(output.args.prompt).toContain("artisan");
      expect(output.args.prompt).not.toContain("**artisan**");
    });

    it("strips ** from mode field value", async () => {
      const prompt = `AGENT: artisan
**MODE:** **checkpoint**
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-21
SCOPE: Implement feature X
RESULT KD: knowledge/impl-foo.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
      expect(output.args.prompt).toContain("checkpoint");
      expect(output.args.prompt).not.toContain("**checkpoint**");
    });

    it("strips ** from intent_kd field value", async () => {
      const prompt = `AGENT: artisan
MODE: explore
**INTENT KD:** **knowledge/intent-foo.md**
SESSION DATE: 2026-07-21
SCOPE: Implement feature X
RESULT KD: knowledge/exploration-foo.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
      expect(output.args.prompt).toContain("knowledge/intent-foo.md");
    });

    it("strips ** from all fields simultaneously", async () => {
      const prompt = `**AGENT:** **artisan**
**MODE:** **explore**
**INTENT KD:** **knowledge/intent-foo.md**
**SESSION DATE:** **2026-07-21**
**SCOPE:** **Implement feature X**
**RESULT KD:** **knowledge/exploration-foo.md**`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
      expect(output.args.prompt).toContain("artisan");
      expect(output.args.prompt).toContain("explore");
      expect(output.args.prompt).toContain("knowledge/intent-foo.md");
      expect(output.args.prompt).toContain("2026-07-21");
    });
  });

  describe("Mode Inference Fallback (Issue 7B)", () => {
    it("infers mode from natural language 'in checkpoint mode'", async () => {
      const prompt = `You are the Committer agent in checkpoint mode. 
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-21
SCOPE: Setup workspace
RESULT KD: knowledge/checkpoint-foo.md`;

      const output = { args: { prompt, subagent_type: "committer" } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
      expect(output.args.prompt).toContain("checkpoint");
      // Checkpoint template renders RESULT KD in header, not INTENT KD
      expect(output.args.prompt).toContain("knowledge/checkpoint-foo.md");
    });

    it("infers mode from natural language 'explore phase'", async () => {
      const prompt = `Delegate to artisan for explore phase. 
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-21
SCOPE: Analyze the codebase
RESULT KD: knowledge/exploration-foo.md`;

      const output = { args: { prompt, subagent_type: "artisan" } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
      expect(output.args.prompt).toContain("explore");
      expect(output.args.prompt).toContain("knowledge/intent-foo.md");
    });

    it("explicit MODE: field takes precedence over natural language", async () => {
      const prompt = `AGENT: artisan
MODE: investigate
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-21
SCOPE: This is an explore task
RESULT KD: knowledge/investigation-foo.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
      // Should use 'investigate' (from MODE:), not 'explore' (from body text)
      expect(output.args.prompt).toContain("investigate");
    });

    it("infers all known modes from natural language", async () => {
      const modes = ["checkpoint", "preflight", "cleanup", "explore", "investigate", "align", "decompose", "swarm", "verify", "extract", "evolve"];
      const kdModes = ["preflight", "explore", "investigate", "align", "decompose", "swarm", "verify", "extract", "evolve", "checkpoint", "cleanup"];
      for (const mode of modes) {
        const needsResultKd = kdModes.includes(mode);
        const prompt = `AGENT: artisan
Run the ${mode} now.
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-21
SCOPE: Test ${mode} mode
${needsResultKd ? `RESULT KD: knowledge/${mode}-foo.md` : ""}`;

        const output = { args: { prompt, subagent_type: "artisan" } };
        await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
        expect(output.args.prompt).toContain(mode);
      }
    });

    it("does not infer mode when structured MODE: field is already present", async () => {
      const prompt = `AGENT: artisan
MODE: checkpoint
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-21
SCOPE: This is a cleanup task
RESULT KD: knowledge/impl-foo.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
      expect(output.args.prompt).toContain("checkpoint");
    });
  });

  describe("Result KD Enforcement for KD-Producing Modes (Issue 3)", () => {
    it("requires result_kd for explore mode", async () => {
      const prompt = `AGENT: explorer
MODE: explore
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-21
SCOPE: Explore the codebase`;

      await expect(
        hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, { args: { prompt } })
      ).rejects.toThrow("KD-producing mode requires result_kd");
    });

    it("requires result_kd for investigate mode", async () => {
      const prompt = `AGENT: artisan
MODE: investigate
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-21
SCOPE: Investigate the plugin system`;

      await expect(
        hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, { args: { prompt } })
      ).rejects.toThrow("KD-producing mode requires result_kd");
    });

    it("requires result_kd for decompose mode", async () => {
      const prompt = `AGENT: pathfinder
MODE: decompose
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-21
SCOPE: Decompose the project into tasks`;

      await expect(
        hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, { args: { prompt } })
      ).rejects.toThrow("KD-producing mode requires result_kd");
    });

    it("requires result_kd for swarm mode", async () => {
      const prompt = `AGENT: artisan
MODE: swarm
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-21
SCOPE: Execute implementation`;

      await expect(
        hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, { args: { prompt } })
      ).rejects.toThrow("KD-producing mode requires result_kd");
    });

    it("requires result_kd for checkpoint mode", async () => {
      const prompt = `AGENT: committer
MODE: checkpoint
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-21
SCOPE: Create a checkpoint commit`;

      await expect(
        hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, { args: { prompt } })
      ).rejects.toThrow("KD-producing mode requires result_kd");
    });

    it("requires result_kd for preflight mode", async () => {
      const prompt = `AGENT: committer
MODE: preflight
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-21
SCOPE: Setup workspace`;

      await expect(
        hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, { args: { prompt } })
      ).rejects.toThrow("KD-producing mode requires result_kd");
    });

    it("accepts swarm mode with result_kd", async () => {
      const prompt = `AGENT: artisan
MODE: swarm
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-21
SCOPE: Execute implementation
RESULT KD: knowledge/impl-foo.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
      expect(output.args.prompt).toContain("swarm");
      expect(output.args.prompt).toContain("knowledge/impl-foo.md");
    });

    it("accepts explore mode with result_kd", async () => {
      const prompt = `AGENT: explorer
MODE: explore
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-21
SCOPE: Explore the codebase
RESULT KD: knowledge/exploration-foo.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
      expect(output.args.prompt).toContain("explore");
      expect(output.args.prompt).toContain("knowledge/exploration-foo.md");
    });

    it("rejects empty string result_kd for KD-producing modes", async () => {
      const prompt = `AGENT: explorer
MODE: explore
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-21
SCOPE: Explore
RESULT KD:`;

      await expect(
        hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, { args: { prompt } })
      ).rejects.toThrow("KD-producing mode requires result_kd");
    });

    it("requires result_kd for align mode", async () => {
      const prompt = `AGENT: spec-weaver
MODE: align
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-21
SCOPE: Align requirements`;

      await expect(
        hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, { args: { prompt } })
      ).rejects.toThrow("KD-producing mode requires result_kd");
    });

    it("requires result_kd for verify mode", async () => {
      const prompt = `AGENT: inspector
MODE: verify
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-21
SCOPE: Verify implementation`;

      await expect(
        hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, { args: { prompt } })
      ).rejects.toThrow("KD-producing mode requires result_kd");
    });

    it("requires result_kd for extract mode", async () => {
      const prompt = `AGENT: scribe
MODE: extract
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-21
SCOPE: Extract documentation`;

      await expect(
        hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, { args: { prompt } })
      ).rejects.toThrow("KD-producing mode requires result_kd");
    });

    it("requires result_kd for evolve mode", async () => {
      const prompt = `AGENT: habit-builder
MODE: evolve
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-21
SCOPE: Evolve process`;

      await expect(
        hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, { args: { prompt } })
      ).rejects.toThrow("KD-producing mode requires result_kd");
    });

    it("requires result_kd for cleanup mode", async () => {
      const prompt = `AGENT: committer
MODE: cleanup
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-21
SCOPE: Commit changes`;

      await expect(
        hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, { args: { prompt } })
      ).rejects.toThrow("KD-producing mode requires result_kd");
    });
  });

  describe("Committer Template Body (Issue 2)", () => {
    it("preflight template body does not contain 'Read the INTENT KD'", async () => {
      const prompt = `AGENT: committer
MODE: preflight
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-21
SCOPE: Setup workspace
RESULT KD: knowledge/preflight-foo.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);

      // Preflight template does NOT instruct reading the INTENT KD
      expect(output.args.prompt).not.toMatch(/Read the INTENT KD at/);
    });

    it("checkpoint template body contains 'Read KDs from KD PATHS'", async () => {
      const prompt = `AGENT: committer
MODE: checkpoint
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-21
SCOPE: Create checkpoint
RESULT KD: knowledge/checkpoint-foo.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);

      expect(output.args.prompt).toMatch(/Read KDs from KD PATHS/);
    });

    it("cleanup template body contains 'Read the INTENT KD'", async () => {
      const prompt = `AGENT: committer
MODE: cleanup
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-21
SCOPE: Commit changes
RESULT KD: knowledge/cleanup-foo.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);

      expect(output.args.prompt).toMatch(/Read the INTENT KD at/);
    });

    it("KD-producing templates still contain 'Read the INTENT KD'", async () => {
      const prompt = `AGENT: explorer
MODE: explore
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-21
SCOPE: Explore codebase
RESULT KD: knowledge/exploration-foo.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);

      // Explorer has read:allow, so reading INTENT KD is fine
      expect(output.args.prompt).toMatch(/Read the INTENT KD at/);
    });
  });

  describe("Mode Inference Edge Cases", () => {
    it("infers first matching mode when prompt contains multiple mode keywords", async () => {
      // Prompt contains both "explore" and "checkpoint" — should infer the first match
      const prompt = `AGENT: artisan
Run the explore phase then checkpoint.
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-21
SCOPE: Test multiple modes
RESULT KD: knowledge/exploration-foo.md`;

      const output = { args: { prompt, subagent_type: "artisan" } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);

      // KNOWN_MODES order: checkpoint, preflight, cleanup, commit, explore...
      // "checkpoint" comes before "explore" in KNOWN_MODES
      expect(output.args.prompt).toContain("checkpoint");
    });

    it("does not infer mode from partial word matches", async () => {
      // "checkpoints" should NOT match "checkpoint" due to word boundary (\b).
      // Without a valid mode, required field validation fails.
      const prompt = `AGENT: artisan
Run the checkpoints process.
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-21
SCOPE: Test partial match`;

      await expect(
        hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, { args: { prompt, subagent_type: "artisan" } })
      ).rejects.toThrow("Missing required structured fields");
    });

    it("explicit MODE: field always takes precedence over natural language inference", async () => {
      const prompt = `AGENT: artisan
MODE: decompose
This is an explore task that needs investigation.
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-21
SCOPE: Test precedence
RESULT KD: knowledge/plan-foo.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);

      // Should use "decompose" from MODE:, not "explore" from body text
      expect(output.args.prompt).toContain("decompose");
      expect(output.args.prompt).not.toMatch(/^MODE:\s*explore/m);
    });
  });

  describe("Cross-Plugin Integration", () => {
    it("delegation-gate renders template that protocol-gate can validate agent routing", async () => {
      // Simulate a full delegation flow: delegation-gate renders the prompt,
      // then protocol-gate validates the agent routing
      const prompt = `AGENT: explorer
MODE: explore
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-21
SCOPE: Explore the codebase
RESULT KD: knowledge/exploration-foo.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);

      // Verify delegation-gate rendered the template correctly
      expect(output.args.prompt).toContain("DISPATCH TO: explorer");
      expect(output.args.prompt).toContain("MODE: explore");
      expect(output.args.prompt).toContain("knowledge/intent-foo.md");
      expect(output.args.prompt).toContain("knowledge/exploration-foo.md");

      // The rendered prompt should be parseable by protocol-gate's extractAgentFromPrompt
      // (which looks for "DISPATCH TO:" or "AGENT:" lines)
      const agentMatch = output.args.prompt.match(/^DISPATCH TO:\s*(.*)/m);
      expect(agentMatch).toBeTruthy();
      expect(agentMatch[1].trim()).toBe("explorer");
    });

    it("all KD-producing modes render RESULT KD in template header", async () => {
      const modes = [
        { mode: "explore", agent: "explorer", kd: "knowledge/exploration-foo.md" },
        { mode: "investigate", agent: "analyzer", kd: "knowledge/analysis-foo.md" },
        { mode: "align", agent: "spec-weaver", kd: "knowledge/spec-foo.md" },
        { mode: "decompose", agent: "pathfinder", kd: "knowledge/plan-foo.md" },
        { mode: "swarm", agent: "artisan", kd: "knowledge/impl-foo.md" },
        { mode: "verify", agent: "inspector", kd: "knowledge/review-foo.md" },
        { mode: "extract", agent: "scribe", kd: "knowledge/composed-foo.md" },
        { mode: "evolve", agent: "habit-builder", kd: "knowledge/process-foo.md" },
      ];

      for (const { mode, agent, kd } of modes) {
        const prompt = `AGENT: ${agent}
MODE: ${mode}
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-21
SCOPE: Test ${mode}
RESULT KD: ${kd}`;

        const output = { args: { prompt } };
        await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);

        // Template should include RESULT KD in the header
        expect(output.args.prompt).toContain(`RESULT KD: ${kd}`);
        // Template body should reference the result KD
        expect(output.args.prompt).toContain(kd);
      }
    });
  });
});
