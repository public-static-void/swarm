import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  adviseDenialFromAttemptLog,
  clearAttributionCache,
  loadAgentShellAllowlist,
} from "../../../plugins/protocol-gate/attribution.js";

// Post-denial bisect advisor: when the pre-execution path is unavailable,
// the same feedback shape is rebuilt from a per-segment solo-retry log.

const nonEmptyLineCount = (message) =>
  message.split("\n").filter((line) => line.trim().length > 0).length;

function realPatterns(agent) {
  const loaded = loadAgentShellAllowlist(agent);
  expect(loaded.patterns).not.toBeNull();
  return loaded.patterns;
}

beforeEach(() => {
  clearAttributionCache();
});

describe("post-denial bisect advisor", () => {
  it("rebuilds the builder-target feedback from a solo-retry log", () => {
    const advice = adviseDenialFromAttemptLog({
      agent: "artisan",
      rawCommand: "make lint",
      segmentResults: [{ segment: "make lint", allowed: false }],
      patterns: realPatterns("artisan"),
    });
    expect(advice.allowed).toBe(false);
    expect(advice.result.fallbackUsed).toBe(true);
    expect(advice.result.deniedSegments).toEqual(["make lint"]);
    expect(advice.message).toContain("`make lint`");
    expect(advice.message).toContain("make test*");
    expect(advice.message).toContain("make build*");
    expect(advice.message).toContain("alone");
    expect(nonEmptyLineCount(advice.message)).toBeLessThanOrEqual(5);
  });

  it("rebuilds the single-variant feedback for the analysis role", () => {
    const advice = adviseDenialFromAttemptLog({
      agent: "analyzer",
      rawCommand: "make build",
      segmentResults: [{ segment: "make build", allowed: false }],
      patterns: realPatterns("analyzer"),
    });
    expect(advice.allowed).toBe(false);
    expect(advice.result.fallbackUsed).toBe(true);
    expect(advice.message).toContain("make test*");
    expect(advice.message).not.toContain("make build*");
  });

  it("states the limitation instead of guessing when the allowlist is unreadable", () => {
    const advice = adviseDenialFromAttemptLog({
      agent: "no-such-agent",
      rawCommand: "make lint",
      segmentResults: [{ segment: "make lint", allowed: false }],
      patterns: null,
    });
    expect(advice.allowed).toBe(false);
    expect(advice.result.allowedVariants).toEqual([]);
    expect(advice.result.suggestedRetry).toBeUndefined();
    expect(advice.message).toContain("alone");
    expect(nonEmptyLineCount(advice.message)).toBeLessThanOrEqual(5);
  });
});

describe("shell interception wiring", () => {
  let savedLogDir;
  let savedDebugFile;
  let tempDirs;

  function makeTemp() {
    const dir = mkdtempSync(join(tmpdir(), "audit-fix-fallback-"));
    tempDirs.push(dir);
    return dir;
  }

  async function loadHooks() {
    vi.resetModules();
    const mod = await import("../../../plugins/protocol-gate/index.js");
    return mod.default.server({}, {});
  }

  beforeEach(() => {
    savedLogDir = process.env.PROTOCOL_GATE_LOG_DIR;
    savedDebugFile = process.env.PROTOCOL_GATE_DEBUG_FILE;
    tempDirs = [];
    const logDir = makeTemp();
    process.env.PROTOCOL_GATE_LOG_DIR = logDir;
    process.env.PROTOCOL_GATE_DEBUG_FILE = join(makeTemp(), ".debug");
  });

  afterEach(() => {
    if (savedLogDir === undefined) delete process.env.PROTOCOL_GATE_LOG_DIR;
    else process.env.PROTOCOL_GATE_LOG_DIR = savedLogDir;
    if (savedDebugFile === undefined)
      delete process.env.PROTOCOL_GATE_DEBUG_FILE;
    else process.env.PROTOCOL_GATE_DEBUG_FILE = savedDebugFile;
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });

  it("throws the attributed message for a denied code-execution probe", async () => {
    const hooks = await loadHooks();
    const sessionID = "fallback-wiring-denied";
    await hooks["chat.params"]({ sessionID, agent: "artisan" }, {});
    const failure = await hooks["tool.execute.before"](
      { tool: "shell", sessionID, callID: "call-1" },
      { args: { command: "python -c 'print(1)'" } }
    ).then(
      () => null,
      (error) => error
    );
    expect(failure).not.toBeNull();
    expect(failure.code).toBe("SHELL_DENIED_ATTRIBUTED");
    expect(failure.message).toContain("`python -c 'print(1)'`");
    expect(failure.message).toContain("python --version*");
  });

  it("passes an allowlisted builder target through untouched", async () => {
    const hooks = await loadHooks();
    const sessionID = "fallback-wiring-allowed";
    await hooks["chat.params"]({ sessionID, agent: "artisan" }, {});
    await hooks["tool.execute.before"](
      { tool: "shell", sessionID, callID: "call-2" },
      { args: { command: "make test" } }
    );
  });

  it("passes untracked sessions through without blocking", async () => {
    const hooks = await loadHooks();
    await hooks["tool.execute.before"](
      { tool: "shell", sessionID: "fallback-wiring-unknown", callID: "c3" },
      { args: { command: "make lint" } }
    );
  });
});
