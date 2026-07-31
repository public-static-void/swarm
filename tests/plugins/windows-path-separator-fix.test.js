import { describe, it, expect } from "vitest";

// Test the toProjectRelative function from protocol-gate
import protocolGateModule from "../../plugins/protocol-gate/index.js";

// Test the delegation-gate functions
import delegationGateModule from "../../plugins/delegation-gate/index.js";

describe("Windows Path Separator Fix", () => {
  describe("AC001: knowledge\\intent-foo.md matches knowledge/intent-*.md in protocol-gate", () => {
    it("should normalize backslashes to forward slashes in write handler", async () => {
      const hooks = await protocolGateModule.server({}, {});

      // Set up session in INTENT phase
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});
      hooks.sessionPhaseMap.set("test-1", 1); // INTENT

      // Windows-style path must pass INTENT write validation and not crash
      await expect(
        hooks["tool.execute.before"](
          { tool: "write", sessionID: "test-1", callID: "c1" },
          { args: { filePath: "knowledge\\intent-foo.md" } }
        )
      ).resolves.toBeUndefined();

      // No unintended phase transition (no session ID set means no disk check)
      expect(hooks.sessionPhaseMap.get("test-1")).toBe(1);
    });
  });

  describe("AC002: knowledge/intent-foo.md continues to match knowledge/intent-*.md", () => {
    it("should still work with forward slashes", async () => {
      const hooks = await protocolGateModule.server({}, {});

      // Set up session in INTENT phase
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});
      hooks.sessionPhaseMap.set("test-1", 1); // INTENT

      // Forward-slash path (existing behavior) must keep passing
      await expect(
        hooks["tool.execute.before"](
          { tool: "write", sessionID: "test-1", callID: "c1" },
          { args: { filePath: "knowledge/intent-foo.md" } }
        )
      ).resolves.toBeUndefined();

      expect(hooks.sessionPhaseMap.get("test-1")).toBe(1);
    });
  });

  describe("AC003: Absolute Windows path normalizes via toProjectRelative()", () => {
    it("should normalize absolute Windows paths", async () => {
      const hooks = await protocolGateModule.server({}, {});

      // Set up session in INTENT phase
      await hooks["chat.params"]({ sessionID: "test-1", agent: "overseer" }, {});
      hooks.sessionPhaseMap.set("test-1", 1); // INTENT

      // Absolute Windows path normalizes to a project-relative knowledge/ path
      await expect(
        hooks["tool.execute.before"](
          { tool: "write", sessionID: "test-1", callID: "c1" },
          { args: { filePath: "C:\\Users\\foo\\project\\knowledge\\intent-1.md" } }
        )
      ).resolves.toBeUndefined();

      expect(hooks.sessionPhaseMap.get("test-1")).toBe(1);
    });
  });

  describe("AC004: validateKDPath('knowledge\\\\intent-1.md') returns true", () => {
    it("should validate backslash KD paths", async () => {
      const hooks = await delegationGateModule.server({}, {});

      // Test the validateKDPath function indirectly via tool.execute.before
      const prompt = `AGENT: artisan
MODE: cleanup
INTENT KD: knowledge\\intent-1.md
SESSION DATE: 2026-07-21
SCOPE: Test backslash path
RESULT KD: knowledge/cleanup-result.md`;

      const output = { args: { prompt } };
      await expect(
        hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output)
      ).resolves.toBeUndefined();

      // Backslash INTENT KD path survives template rendering untouched
      expect(output.args.prompt).toContain("knowledge\\intent-1.md");
    });
  });

  describe("AC005: validateKDPath('knowledge/intent-1.md') returns true", () => {
    it("should still validate forward slash KD paths", async () => {
      const hooks = await delegationGateModule.server({}, {});

      // Test the validateKDPath function indirectly via tool.execute.before
      const prompt = `AGENT: artisan
MODE: cleanup
INTENT KD: knowledge/intent-1.md
SESSION DATE: 2026-07-21
SCOPE: Test forward slash path
RESULT KD: knowledge/cleanup-result.md`;

      const output = { args: { prompt } };
      await expect(
        hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output)
      ).resolves.toBeUndefined();

      expect(output.args.prompt).toContain("knowledge/intent-1.md");
    });
  });

  describe("AC006: isBareKDPath('knowledge\\\\intent-1.md') returns true", () => {
    it("should detect bare backslash KD paths", async () => {
      const hooks = await delegationGateModule.server({}, {});

      // Test isBareKDPath with backslash path
      const prompt = "knowledge\\intent-1.md";

      await expect(
        hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, { args: { prompt } })
      ).rejects.toThrow("Bare KD path without structured fields");
    });
  });

  describe("AC007: detectForeignPaths() does not falsely flag knowledge\\intent-1.md", () => {
    it("should not flag backslash KD paths as foreign", async () => {
      const hooks = await delegationGateModule.server({}, {});

      // Test detectForeignPaths with backslash KD path in non-field line
      const prompt = `AGENT: artisan
MODE: cleanup
INTENT KD: knowledge/intent-1.md
SESSION DATE: 2026-07-21
SCOPE: Test foreign detection
RESULT KD: knowledge/cleanup-result.md
knowledge\\intent-1.md`;

      const output = { args: { prompt } };
      await expect(
        hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output)
      ).resolves.toBeUndefined();
    });
  });

  describe("AC008: detectForeignPaths('/home/user/secret.md') still returns true", () => {
    it("should still flag absolute Unix paths as foreign", async () => {
      const hooks = await delegationGateModule.server({}, {});

      // Test detectForeignPaths with absolute Unix path
      const prompt = `AGENT: artisan
MODE: cleanup
INTENT KD: knowledge/intent-1.md
SESSION DATE: 2026-07-21
SCOPE: Test foreign detection
/home/user/secret.md`;

      await expect(
        hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, { args: { prompt } })
      ).rejects.toThrow("Foreign paths detected");
    });
  });

  describe("AC009: All tests pass on Linux with no behavioral change", () => {
    it("should not change behavior on Linux (forward slashes)", async () => {
      const hooks = await delegationGateModule.server({}, {});

      // Test with all forward slashes (Linux behavior)
      const prompt = `AGENT: artisan
MODE: cleanup
INTENT KD: knowledge/intent-1.md
SESSION DATE: 2026-07-21
SCOPE: Test Linux behavior
RESULT KD: knowledge/cleanup-result.md`;

      const output = { args: { prompt } };
      await expect(
        hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output)
      ).resolves.toBeUndefined();

      expect(output.args.prompt).toContain("knowledge/intent-1.md");
    });
  });

  describe("AC010: Mixed-separator path knowledge\\foo/intent-1.md normalizes correctly", () => {
    it("should normalize mixed separators", async () => {
      const hooks = await delegationGateModule.server({}, {});

      // Test with mixed separators
      const prompt = `AGENT: artisan
MODE: cleanup
INTENT KD: knowledge\\foo/intent-1.md
SESSION DATE: 2026-07-21
SCOPE: Test mixed separators
RESULT KD: knowledge/cleanup-result.md`;

      const output = { args: { prompt } };
      await expect(
        hooks["tool.execute.before"]({ tool: "task", sessionID: "s1", callID: "c1" }, output)
      ).resolves.toBeUndefined();

      // Mixed-separator KD path must survive rendering unchanged
      expect(output.args.prompt).toContain("knowledge\\foo/intent-1.md");
    });
  });
});
