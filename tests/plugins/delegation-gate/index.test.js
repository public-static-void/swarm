import { describe, it, expect, vi, beforeEach } from "vitest";
import delegationGatePlugin from "../../../plugins/delegation-gate/index.js";

describe("Delegation-Gate Plugin", () => {
  let plugin;
  let mockCtx;

  beforeEach(async () => {
    plugin = await delegationGatePlugin();
    mockCtx = {
      type: "",
      input: {},
      output: {}
    };
  });

  describe("Default Export", () => {
    it("exports a function", () => {
      expect(typeof delegationGatePlugin).toBe("function");
    });

    it("has no named exports", () => {
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

      mockCtx.type = "tool.execute.before";
      mockCtx.input = { tool: "task", args: { prompt } };
      mockCtx.output = {};

      await plugin(mockCtx);

      expect(mockCtx.output.args.prompt).toContain("knowledge/intent-foo.md");
    });

    it("rejects prompt without structured fields", async () => {
      const prompt = "Please implement feature X";

      mockCtx.type = "tool.execute.before";
      mockCtx.input = { tool: "task", args: { prompt } };

      await expect(plugin(mockCtx)).rejects.toThrow("Missing required structured fields");
    });

    it("rejects prompt missing any required field", async () => {
      const prompt = `AGENT: artisan
MODE: checkpoint`;

      mockCtx.type = "tool.execute.before";
      mockCtx.input = { tool: "task", args: { prompt } };

      await expect(plugin(mockCtx)).rejects.toThrow("Missing required structured fields");
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

      mockCtx.type = "tool.execute.before";
      mockCtx.input = { tool: "task", args: { prompt } };

      await expect(plugin(mockCtx)).rejects.toThrow("Code blocks detected in prompt");
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

      mockCtx.type = "tool.execute.before";
      mockCtx.input = { tool: "task", args: { prompt } };

      await expect(plugin(mockCtx)).rejects.toThrow("Foreign paths detected");
    });

    it("rejects bare KD path without structured fields", async () => {
      const prompt = "knowledge/intent-foo.md";

      mockCtx.type = "tool.execute.before";
      mockCtx.input = { tool: "task", args: { prompt } };

      await expect(plugin(mockCtx)).rejects.toThrow("Bare KD path without structured fields");
    });

    it("validates KD paths against knowledge/*.md pattern", async () => {
      const prompt = `AGENT: artisan
MODE: checkpoint
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-15
SCOPE: Implement feature X
RESULT KD: invalid-path.md`;

      mockCtx.type = "tool.execute.before";
      mockCtx.input = { tool: "task", args: { prompt } };

      await expect(plugin(mockCtx)).rejects.toThrow("Invalid result KD path");
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

      mockCtx.type = "tool.execute.before";
      mockCtx.input = { tool: "task", args: { prompt } };

      await expect(plugin(mockCtx)).rejects.toThrow("Scope validation failed");
    });

    it("rejects scope exceeding 200 characters", async () => {
      const longScope = "A".repeat(201);
      const prompt = `AGENT: artisan
MODE: checkpoint
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-15
SCOPE: ${longScope}
RESULT KD: knowledge/impl-foo.md`;

      mockCtx.type = "tool.execute.before";
      mockCtx.input = { tool: "task", args: { prompt } };

      await expect(plugin(mockCtx)).rejects.toThrow("Scope validation failed");
    });

    it("rejects negative framing in scope", async () => {
      const prompt = `AGENT: artisan
MODE: checkpoint
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-15
SCOPE: Do not use TypeScript
RESULT KD: knowledge/impl-foo.md`;

      mockCtx.type = "tool.execute.before";
      mockCtx.input = { tool: "task", args: { prompt } };

      await expect(plugin(mockCtx)).rejects.toThrow("Scope validation failed");
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

      mockCtx.type = "tool.execute.before";
      mockCtx.input = { tool: "task", args: { prompt } };
      mockCtx.output = {};

      await plugin(mockCtx);

      expect(mockCtx.output.args.prompt).toContain("knowledge/intent-foo.md");
      expect(mockCtx.output.args.prompt).toContain("2026-07-15");
      expect(mockCtx.output.args.prompt).toContain("Implement feature X");
    });

    it("replaces output.args.prompt with rendered template", async () => {
      const prompt = `AGENT: artisan
MODE: checkpoint
INTENT KD: knowledge/intent-foo.md
SESSION DATE: 2026-07-15
SCOPE: Implement feature X
RESULT KD: knowledge/impl-foo.md`;

      mockCtx.type = "tool.execute.before";
      mockCtx.input = { tool: "task", args: { prompt } };
      mockCtx.output = {};

      await plugin(mockCtx);

      expect(mockCtx.output.args.prompt).not.toBe(prompt);
      expect(mockCtx.output.args.prompt).toBeDefined();
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

      mockCtx.type = "tool.execute.before";
      mockCtx.input = { tool: "task", args: { prompt } };
      mockCtx.output = {};

      await plugin(mockCtx);

      expect(mockCtx.output.args.prompt).toContain("knowledge/intent-foo.md");
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

      mockCtx.type = "tool.execute.before";
      mockCtx.input = { tool: "task", args: { prompt } };
      mockCtx.output = {};

      await plugin(mockCtx);

      expect(mockCtx.output.args.description).toContain("Delegation Prompt Format");
    });
  });

  describe("Non-Task Tools", () => {
    it("passes through non-task tools without validation", async () => {
      mockCtx.type = "tool.execute.before";
      mockCtx.input = { tool: "read", args: { filePath: "some-file.md" } };
      mockCtx.output = {};

      await plugin(mockCtx);
      // Should not throw — handler returns early for non-task tools
      expect(mockCtx.output).toEqual({});
    });
  });
});
