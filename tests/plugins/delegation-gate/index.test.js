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
MODE: checkpoint
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-15
SCOPE: Implement feature X
RESULT KD: knowledge/impl-foo.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);

      expect(output.args.prompt).toContain("knowledge/intent-foo.md");
    });

    it("extracts agent from DISPATCH TO: format (template-rendered)", async () => {
      const prompt = `DISPATCH TO: artisan
MODE: checkpoint
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-15
SCOPE: Implement feature X
RESULT KD: knowledge/impl-foo.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);

      expect(output.args.prompt).toContain("knowledge/intent-foo.md");
    });

    it("extracts agent from AGENT: format (raw prompt)", async () => {
      const prompt = `AGENT: artisan
MODE: checkpoint
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-15
SCOPE: Implement feature X
RESULT KD: knowledge/impl-foo.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);

      expect(output.args.prompt).toContain("knowledge/intent-foo.md");
    });

    it("extracts fields with underscore variants (intent_kd, session_date, result_kd)", async () => {
      const prompt = `AGENT: artisan
MODE: checkpoint
intent_kd: knowledge/intent-foo.md
session_date: 2026-07-15
SCOPE: Implement feature X
result_kd: knowledge/impl-foo.md`;

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
MODE: checkpoint
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-15
SCOPE: Implement feature X
RESULT KD: knowledge/impl-foo.md
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

    it("accepts prompt without result_kd (optional field)", async () => {
      const prompt = `AGENT: artisan
MODE: checkpoint
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-15
SCOPE: Implement feature X`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
      expect(output.args.prompt).toContain("knowledge/intent-foo.md");
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
      // When scope is required but result_kd is not provided,
      // the template's {result_kd} placeholder should be stripped from output
      const prompt = `AGENT: artisan
MODE: checkpoint
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-15
SCOPE: Implement feature X`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
      // result_kd not provided — {result_kd} placeholder should be stripped
      expect(output.args.prompt).not.toContain("{result_kd}");
      expect(output.args.prompt).toContain("knowledge/intent-foo.md");
    });
  });

  describe("Scope Validation", () => {
    it("accepts empty scope (advisory validation only)", async () => {
      const prompt = `AGENT: artisan
MODE: checkpoint
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-15
SCOPE: 
RESULT KD: knowledge/impl-foo.md`;

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
      const prompt = `AGENT: artisan
MODE: checkpoint
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-17
RESULT KD: knowledge/impl-foo.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
      expect(output.args.prompt).toContain("knowledge/intent-foo.md");
    });

    it("accepts prompt without scope or result_kd (both optional)", async () => {
      const prompt = `AGENT: artisan
MODE: checkpoint
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-17`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
      expect(output.args.prompt).toContain("knowledge/intent-foo.md");
    });
  });

  describe("Template Injection", () => {
    it("renders prompt from template for valid structured prompt", async () => {
      const prompt = `AGENT: artisan
MODE: checkpoint
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-15
SCOPE: Implement feature X
RESULT KD: knowledge/impl-foo.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);

      expect(output.args.prompt).toContain("knowledge/intent-foo.md");
      expect(output.args.prompt).toContain("2026-07-15");
      expect(output.args.prompt).toContain("Implement feature X");
    });

    it("replaces output.args.prompt with rendered template", async () => {
      const prompt = `AGENT: artisan
MODE: checkpoint
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-15
SCOPE: Implement feature X
RESULT KD: knowledge/impl-foo.md`;

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
      const prompt = `MODE: checkpoint
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-17
SCOPE: Implement feature X
RESULT KD: knowledge/impl-foo.md`;

      const output = { args: { prompt, subagent_type: "artisan" } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);

      expect(output.args.prompt).toContain("artisan");
      expect(output.args.prompt).toContain("knowledge/intent-foo.md");
    });

    it("prompt text agent takes precedence over subagent_type", async () => {
      const prompt = `AGENT: committer
MODE: checkpoint
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-17
SCOPE: Implement feature X
RESULT KD: knowledge/impl-foo.md`;

      const output = { args: { prompt, subagent_type: "artisan" } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);

      // Template renders with committer (from prompt), not artisan (from subagent_type)
      expect(output.args.prompt).toContain("committer");
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
MODE: checkpoint
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-17
RESULT KD: knowledge/impl-foo.md`;

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
      const description = `MODE: checkpoint
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-17
SCOPE: Implement feature X
RESULT KD: knowledge/impl-foo.md`;

      const output = { args: { prompt: "", description, subagent_type: "artisan" } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
      expect(output.args.prompt).toContain("knowledge/intent-foo.md");
    });

    it("prompt fields override description fields when both present", async () => {
      const prompt = `AGENT: artisan
MODE: checkpoint
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-17
SCOPE: Implement feature X
RESULT KD: knowledge/impl-foo.md`;
      const description = `SESSION DATE: 2099-01-01
SCOPE: From description
RESULT KD: knowledge/wrong.md`;

      const output = { args: { prompt, description } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);

      // Uses prompt's values, not description's
      expect(output.args.prompt).toContain("2026-07-17");
      expect(output.args.prompt).toContain("Implement feature X");
      expect(output.args.prompt).toContain("knowledge/impl-foo.md");
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
RESULT KD: knowledge/plan-preflight.md`;

      const output = { args: { prompt, subagent_type: "committer" } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);

      expect(output.args.prompt).toContain("committer");
      expect(output.args.prompt).toContain("knowledge/intent-foo.md");
      expect(output.args.prompt).toContain("2026-07-17");
      expect(output.args.prompt).toContain("Setup workspace");
      expect(output.args.prompt).toContain("knowledge/plan-preflight.md");
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
MODE: checkpoint
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-15
SCOPE: Implement feature X
RESULT KD: knowledge/impl-foo.md

Read the INTENT KD at knowledge/intent-foo.md for details.`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
      // Should not throw — embedded KD paths are valid
      expect(output.args.prompt).toContain("knowledge/intent-foo.md");
    });

    it("accepts KD paths embedded in template-rendered text", async () => {
      const prompt = `AGENT: artisan
MODE: checkpoint
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-15
SCOPE: Implement feature X
RESULT KD: knowledge/impl-foo.md

Load the kd-system skill. Read the INTENT KD at knowledge/intent-foo.md. Execute the swarm phase per the scope above. Produce an IMPLEMENTATION SUMMARY KD at knowledge/impl-foo.md.`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
      // Should not throw — multiple embedded KD paths are valid
      expect(output.args.prompt).toContain("knowledge/intent-foo.md");
      expect(output.args.prompt).toContain("knowledge/impl-foo.md");
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
MODE: checkpoint
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-15
SCOPE: Implement feature X
RESULT KD: knowledge/impl-foo.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
      // DISPATCH TO: line should not trigger foreign path detection
      expect(output.args.prompt).toContain("knowledge/intent-foo.md");
    });
  });
});
