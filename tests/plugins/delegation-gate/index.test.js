import { describe, it, expect, vi, beforeEach } from "vitest";
import delegationGatePlugin from "../../../plugins/delegation-gate/index.js";

describe("Delegation-Gate Plugin", () => {
  let hooks;

  beforeEach(async () => {
    hooks = await delegationGatePlugin({}, {});
  });

  describe("Default Export", () => {
    it("exports an async function", () => {
      expect(typeof delegationGatePlugin).toBe("function");
    });

    it("returns named hook functions", async () => {
      const result = await delegationGatePlugin({}, {});
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

    it("rejects relative file paths in non-field lines", async () => {
      const prompt = `AGENT: artisan
MODE: checkpoint
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-15
SCOPE: Implement feature X
RESULT KD: knowledge/impl-foo.md
docs/ROADMAP.md`;

      await expect(
        hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, { args: { prompt } })
      ).rejects.toThrow("Foreign paths detected");
    });

    it("validates KD paths against knowledge/*.md pattern", async () => {
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
  });

  describe("Scope Validation", () => {
    it("rejects empty scope", async () => {
      const prompt = `AGENT: artisan
MODE: checkpoint
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-15
SCOPE: 
RESULT KD: knowledge/impl-foo.md`;

      await expect(
        hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, { args: { prompt } })
      ).rejects.toThrow("Scope validation failed");
    });

    it("rejects scope exceeding 200 characters", async () => {
      const longScope = "A".repeat(201);
      const prompt = `AGENT: artisan
MODE: checkpoint
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-15
SCOPE: ${longScope}
RESULT KD: knowledge/impl-foo.md`;

      await expect(
        hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, { args: { prompt } })
      ).rejects.toThrow("Scope validation failed");
    });

    it("rejects negative framing in scope", async () => {
      const prompt = `AGENT: artisan
MODE: checkpoint
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-15
SCOPE: Do not use TypeScript
RESULT KD: knowledge/impl-foo.md`;

      await expect(
        hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, { args: { prompt } })
      ).rejects.toThrow("Scope validation failed");
    });

    it("rejects scope containing file paths", async () => {
      const prompt = `AGENT: explorer
MODE: explore
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-16
SCOPE: Read docs/ROADMAP.md and identify the best item
RESULT KD: knowledge/exploration-foo.md`;

      await expect(
        hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, { args: { prompt } })
      ).rejects.toThrow("Scope validation failed");
    });

    it("rejects scope containing URLs", async () => {
      const prompt = `AGENT: explorer
MODE: explore
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-16
SCOPE: Check https://example.com/docs for API details
RESULT KD: knowledge/exploration-foo.md`;

      await expect(
        hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, { args: { prompt } })
      ).rejects.toThrow("Scope validation failed");
    });

    it("rejects scope with multiple sentences", async () => {
      const prompt = `AGENT: explorer
MODE: explore
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-16
SCOPE: Read the docs first. Then identify gaps.
RESULT KD: knowledge/exploration-foo.md`;

      await expect(
        hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, { args: { prompt } })
      ).rejects.toThrow("Scope validation failed");
    });

    it("rejects scope with multi-step conjunctions", async () => {
      const prompt = `AGENT: explorer
MODE: explore
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-16
SCOPE: Find the config file and then update it
RESULT KD: knowledge/exploration-foo.md`;

      await expect(
        hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, { args: { prompt } })
      ).rejects.toThrow("Scope validation failed");
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
      // Should not throw — scope is a valid concise description
      expect(output.args.prompt).toContain("Explore the plugin system architecture");
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
    it("injects delegation format without schema mutation", async () => {
      const prompt = `AGENT: artisan
MODE: checkpoint
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-15
SCOPE: Implement feature X
RESULT KD: knowledge/impl-foo.md`;

      const output = { args: { prompt } };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output);

      expect(output.args.description).toContain("Delegation Prompt Format");
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
});
