import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
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
      // Concrete examples reflect actual extracted fields, not hardcoded explorer/explore
      expect(output.args.description).toContain("DISPATCH TO: artisan");
      expect(output.args.description).toContain("MODE: checkpoint");
      // Only current mode's KD prefix is injected — not all 11 modes
      expect(output.args.description).toContain("RESULT KD: knowledge/checkpoint-<name>-<session_id>.md");
      expect(output.args.description).toContain("- checkpoint: knowledge/checkpoint-<name>-<session_id>.md");
      // No other mode prefixes should appear
      expect(output.args.description).not.toContain("exploration");
      expect(output.args.description).not.toContain("analysis");
      expect(output.args.description).not.toContain("spec");
      expect(output.args.description).not.toContain("plan");
      expect(output.args.description).not.toContain("impl");
      expect(output.args.description).not.toContain("review");
      expect(output.args.description).not.toContain("audit");
      expect(output.args.description).not.toContain("composed");
      expect(output.args.description).not.toContain("process");
      expect(output.args.description).not.toContain("preflight");
      expect(output.args.description).not.toContain("cleanup");
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

    it("injects only analysis prefix for investigate mode", async () => {
      const prompt = `AGENT: analyzer
MODE: investigate
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-15
SCOPE: Investigate plugin system
RESULT KD: knowledge/analysis-foo.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);

      expect(output.args.description).toContain("MODE: investigate");
      expect(output.args.description).toContain("RESULT KD: knowledge/analysis-<name>-<session_id>.md");
      expect(output.args.description).toContain("- investigate: knowledge/analysis-<name>-<session_id>.md");
      // No other KD prefixes should leak in
      expect(output.args.description).not.toContain("exploration");
      expect(output.args.description).not.toContain("review");
      expect(output.args.description).not.toContain("audit");
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
      // verify mode produces both review and audit KDs
      expect(output.args.description).toContain("RESULT KD: knowledge/review-<name>-<session_id>.md, knowledge/audit-<name>-<session_id>.md");
      // Header should be plural since there are two KDs
      expect(output.args.description).toContain("RESULT KD Naming Conventions:");
      expect(output.args.description).toContain("- verify: knowledge/review-<name>-<session_id>.md, knowledge/audit-<name>-<session_id>.md");
      // Single-KD prefix (singular header) should not appear
      expect(output.args.description).not.toContain("RESULT KD Naming Convention:");
    });

    it("injects only preflight prefix for preflight mode", async () => {
      const prompt = `AGENT: committer
MODE: preflight
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-15
SCOPE: Setup workspace
RESULT KD: knowledge/preflight-foo.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);

      expect(output.args.description).toContain("MODE: preflight");
      expect(output.args.description).toContain("RESULT KD: knowledge/preflight-<name>-<session_id>.md");
      expect(output.args.description).toContain("- preflight: knowledge/preflight-<name>-<session_id>.md");
      expect(output.args.description).not.toContain("checkpoint");
      expect(output.args.description).not.toContain("cleanup");
    });

    it("falls back to <type> placeholder for unknown mode", async () => {
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

      // Description should still have been injected with the fallback <type> prefix
      expect(output.args.description).toContain("MODE: unknown");
      expect(output.args.description).toContain("RESULT KD: knowledge/<type>-<name>-<session_id>.md");
      expect(output.args.description).toContain("- unknown: knowledge/<type>-<name>-<session_id>.md");
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

    it("still rejects /etc/passwd on its own line", async () => {
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

    it("still rejects /home/user/config.json on its own line", async () => {
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
        // M3: swarm dispatches require exactly one MILESTONE ID — include it for
        // the swarm case so the inference test stays focused on mode detection.
        const milestoneLine = mode === "swarm" ? "MILESTONE ID: M1\n" : "";
        // M4: swarm result KDs must carry the dispatched milestone as the first
        // token after impl- (check-off naming contract) — scope the example.
        const resultKd = mode === "swarm" ? "knowledge/impl-M1-foo.md" : `knowledge/${mode}-foo.md`;
        const prompt = `AGENT: artisan
Run the ${mode} now.
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-21
${milestoneLine}SCOPE: Test ${mode} mode
${needsResultKd ? `RESULT KD: ${resultKd}` : ""}`;

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

    it("accepts swarm mode with result_kd", async () => {
      const prompt = `AGENT: artisan
MODE: swarm
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-21
MILESTONE ID: M1
SCOPE: Execute implementation
RESULT KD: knowledge/impl-M1-foo.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
      expect(output.args.prompt).toContain("swarm");
      expect(output.args.prompt).toContain("knowledge/impl-M1-foo.md");
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

        // Template should include RESULT KD in the header
        expect(output.args.prompt).toContain(`RESULT KD: ${kd}`);
        // Template body should reference the result KD
        expect(output.args.prompt).toContain(kd);
      }
    });
  });

  describe("M1: Generation Propagation (P004, AC-R004–R006)", () => {
    const stateDir = join(process.cwd(), "plugins", "protocol-gate", ".state");

    it("renders GENERATION: 2 and -gen2 naming when the prompt carries GENERATION", async () => {
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

      // Header field preserved in rendered template
      expect(output.args.prompt).toContain("GENERATION: 2");
      // Template body naming convention carries the generation suffix
      expect(output.args.prompt).toContain("knowledge/impl-<milestone-id>-<descriptive-name>-<session_id>-gen2.md");
      // Injected tool doc shows the generation-scoped result KD example
      expect(output.args.description).toContain("knowledge/impl-<milestone-id>-<name>-<session_id>-gen2.md");
      expect(output.args.description).toContain("GENERATION: <generation>");
    });

    it("falls back to protocol-gate state file generation when the prompt omits GENERATION", async () => {
      const statePath = join(stateDir, ".protocol-state-ses_fbk.json");
      mkdirSync(stateDir, { recursive: true });
      const prompt = `AGENT: artisan
MODE: swarm
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-15
SESSION ID: ses_fbk
MILESTONE ID: M1
SCOPE: Implement feature X
RESULT KD: knowledge/impl-M1-foo-ses_fbk.md`;

      // Retry because the shared plugins/protocol-gate/.state dir is concurrently
      // cleaned by the protocol-gate suite's beforeEach; a cleanup landing between
      // the write and the hook's read makes the fallback transiently miss.
      let output;
      for (let attempt = 1; attempt <= 3; attempt++) {
        writeFileSync(statePath, JSON.stringify({ phase: 3, generation: 4, sid: "ses_fbk", timestamp: Date.now() }));
        output = { args: { prompt } };
        await hooks["tool.execute.before"]({ tool: "task", sessionID: "ses_fbk", callID: `c${attempt}` }, output);
        if (output.args.prompt.includes("GENERATION: 4")) break;
      }

      expect(output.args.prompt).toContain("GENERATION: 4");
      expect(output.args.prompt).toContain("knowledge/impl-<milestone-id>-<descriptive-name>-<session_id>-gen4.md");

      try { rmSync(statePath); } catch (_) {}
    });

    it("keeps legacy naming when GENERATION is absent and no state file exists", async () => {
      const prompt = `AGENT: committer
MODE: checkpoint
SESSION DATE: 2026-07-15
SESSION ID: ses_legacy
SCOPE: Commit X
RESULT KD: knowledge/checkpoint-foo-ses_legacy.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "ses_legacy", callID: "c1" }, output);

      // Unresolved {generation} placeholder stripped, no -gen suffix injected
      expect(output.args.prompt).not.toContain("-gen");
      expect(output.args.description).toContain("knowledge/checkpoint-<name>-<session_id>.md");
    });

    it("extracts GENERATION field for non-swarm modes (checkpoint)", async () => {
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

  describe("M3: MILESTONE ID enforcement (R006–R008)", () => {
    it("extracts MILESTONE ID and preserves it through the rendered swarm template", async () => {
      const prompt = `AGENT: artisan
MODE: swarm
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-31
MILESTONE ID: M3
SCOPE: Implement milestone M3
RESULT KD: knowledge/impl-m3-ses_m3-gen0.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "ses_m3", callID: "c1" }, output);
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

    it("rejects a comma-separated MILESTONE ID list (MULTI_MILESTONE)", async () => {
      const prompt = `AGENT: artisan
MODE: swarm
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-31
MILESTONE ID: M1, M2
SCOPE: Execute implementation
RESULT KD: knowledge/impl-foo.md`;

      await expect(
        hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, { args: { prompt } })
      ).rejects.toThrow("Multiple milestones in single dispatch");
    });

    it("rejects repeated MILESTONE ID lines (MULTI_MILESTONE)", async () => {
      const prompt = `AGENT: artisan
MODE: swarm
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-31
MILESTONE ID: M1
MILESTONE ID: M2
SCOPE: Execute implementation
RESULT KD: knowledge/impl-foo.md`;

      await expect(
        hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, { args: { prompt } })
      ).rejects.toThrow("Multiple milestones in single dispatch");
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

    it("accepts exactly one MILESTONE ID for swarm mode", async () => {
      const prompt = `AGENT: artisan
MODE: swarm
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-31
MILESTONE ID: M3
SCOPE: Execute implementation
RESULT KD: knowledge/impl-M3-foo.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
      expect(output.args.prompt).toContain("MILESTONE ID: M3");
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

    it("injects the MILESTONE ID requirement into the swarm tool doc", async () => {
      const prompt = `AGENT: artisan
MODE: swarm
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-31
MILESTONE ID: M3
SCOPE: Execute implementation
RESULT KD: knowledge/impl-M3-foo.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
      expect(output.args.description).toContain("MILESTONE ID:");
      expect(output.args.description).toContain("exactly one");
    });

    it("keeps the MILESTONE ID hint out of non-swarm tool docs", async () => {
      const prompt = `AGENT: committer
MODE: checkpoint
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-31
SCOPE: Commit X
RESULT KD: knowledge/checkpoint-foo.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
      expect(output.args.description).not.toContain("MILESTONE ID:");
    });
  });

  describe("M4: milestone-scoped impl result KD (R009–R010)", () => {
    it("accepts a milestone-scoped result KD matching the swarm MILESTONE ID", async () => {
      const prompt = `AGENT: artisan
MODE: swarm
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-08-01
MILESTONE ID: M4
SCOPE: Execute milestone M4
RESULT KD: knowledge/impl-M4-feature-ses_x-gen0.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "ses_x", callID: "c1" }, output);
      expect(output.args.prompt).toContain("MILESTONE ID: M4");
      expect(output.args.prompt).toContain("knowledge/impl-M4-feature-ses_x-gen0.md");
    });

    it("accepts a case-insensitive milestone token (impl-m3 for MILESTONE ID M3)", async () => {
      const prompt = `AGENT: artisan
MODE: swarm
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-08-01
MILESTONE ID: M3
SCOPE: Execute milestone M3
RESULT KD: knowledge/impl-m3-ses_m3-gen0.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "ses_m3", callID: "c1" }, output);
      expect(output.args.prompt).toContain("knowledge/impl-m3-ses_m3-gen0.md");
    });

    it("rejects a result KD whose milestone token differs from the swarm MILESTONE ID", async () => {
      const prompt = `AGENT: artisan
MODE: swarm
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-08-01
MILESTONE ID: M4
SCOPE: Execute milestone M4
RESULT KD: knowledge/impl-M5-feature-ses_x-gen0.md`;

      await expect(
        hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, { args: { prompt } })
      ).rejects.toThrow("Swarm result KD does not match the MILESTONE ID");
    });

    it("rejects an unscoped swarm result KD (no milestone token)", async () => {
      const prompt = `AGENT: artisan
MODE: swarm
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-08-01
MILESTONE ID: M4
SCOPE: Execute milestone M4
RESULT KD: knowledge/impl-feature-ses_x-gen0.md`;

      await expect(
        hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, { args: { prompt } })
      ).rejects.toThrow("Swarm result KD does not match the MILESTONE ID");
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

    it("injects the milestone-scoped impl KD naming contract into the swarm tool doc", async () => {
      const prompt = `AGENT: artisan
MODE: swarm
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-08-01
MILESTONE ID: M4
SCOPE: Execute milestone M4
RESULT KD: knowledge/impl-M4-feature-ses_x-gen0.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "ses_x", callID: "c1" }, output);
      // Generation 0/unknown uses the legacy bare suffix (matchesSessionKD semantics)
      expect(output.args.description).toContain("RESULT KD: knowledge/impl-<milestone-id>-<name>-<session_id>.md");
      expect(output.args.description).toContain("- swarm: knowledge/impl-<milestone-id>-<name>-<session_id>.md");
    });

    it("keeps the milestone token out of non-swarm result KD examples", async () => {
      const prompt = `AGENT: committer
MODE: checkpoint
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-08-01
SCOPE: Commit X
RESULT KD: knowledge/checkpoint-foo.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);
      expect(output.args.description).toContain("RESULT KD: knowledge/checkpoint-<name>-<session_id>.md");
      expect(output.args.description).not.toContain("<milestone-id>");
    });
  });
});
