import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

// Standing suite for gate debug enablement: every gate resolves its log
// file from its own plugin directory, switches on through either the env
// flag or the on-disk sentinel, and reports the outcome as structured
// state. Tests drive each gate through a fresh import with isolated env
// seams so no assertion touches the real log tree.

const GATES = [
  {
    gate: "knowledge-gate",
    modulePath: "../../../plugins/knowledge-gate/index.js",
    debugEnv: "KNOWLEDGE_GATE_DEBUG",
    logDirEnv: "KNOWLEDGE_GATE_LOG_DIR",
    debugFileEnv: "KNOWLEDGE_GATE_DEBUG_FILE",
  },
  {
    gate: "delegation-gate",
    modulePath: "../../../plugins/delegation-gate/index.js",
    debugEnv: "DELEGATION_GATE_DEBUG",
    logDirEnv: "DELEGATION_GATE_LOG_DIR",
    debugFileEnv: "DELEGATION_GATE_DEBUG_FILE",
  },
  {
    gate: "protocol-gate",
    modulePath: "../../../plugins/protocol-gate/index.js",
    debugEnv: "PROTOCOL_GATE_DEBUG",
    logDirEnv: "PROTOCOL_GATE_LOG_DIR",
    debugFileEnv: "PROTOCOL_GATE_DEBUG_FILE",
  },
];

const ALL_ENV_KEYS = GATES.flatMap((g) => [g.debugEnv, g.logDirEnv, g.debugFileEnv]);

let savedEnv;
let tempDirs;
let savedCwd;

function makeTemp() {
  const dir = mkdtempSync(join(tmpdir(), "audit-fix-enablement-"));
  tempDirs.push(dir);
  return dir;
}

async function loadGate(def) {
  vi.resetModules();
  const mod = await import(def.modulePath);
  const hooks = await mod.default.server({}, {});
  return { mod, hooks };
}

beforeEach(() => {
  savedEnv = {};
  for (const key of ALL_ENV_KEYS) savedEnv[key] = process.env[key];
  tempDirs = [];
  savedCwd = process.cwd();
});

afterEach(() => {
  for (const key of ALL_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  process.chdir(savedCwd);
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  vi.resetModules();
});

describe("gate debug enablement", () => {
  for (const def of GATES) {
    describe(def.gate, () => {
      it("resolves log and sentinel paths inside the config dir regardless of startup cwd", async () => {
        const logDir = makeTemp();
        const foreignCwd = makeTemp();
        process.env[def.logDirEnv] = logDir;
        process.env[def.debugFileEnv] = join(makeTemp(), ".debug");
        delete process.env[def.debugEnv];
        process.chdir(foreignCwd);

        const { hooks } = await loadGate(def);
        const state = hooks.getEnablementState();

        expect(state.logFile).toBe(join(logDir, `${def.gate}.log`));
        expect(isAbsolute(state.logFile)).toBe(true);
        expect(isAbsolute(state.sentinelPath)).toBe(true);
        expect(state.logFile.startsWith(foreignCwd)).toBe(false);
        const leaked = readdirSync(foreignCwd).filter((f) => f.endsWith(".log") || f.endsWith(".status"));
        expect(leaked).toEqual([]);
      });

      it("switches on through the sentinel file when the env flag is unset", async () => {
        const logDir = makeTemp();
        const sentinelDir = makeTemp();
        const sentinel = join(sentinelDir, ".debug");
        writeFileSync(sentinel, "");
        process.env[def.logDirEnv] = logDir;
        process.env[def.debugFileEnv] = sentinel;
        delete process.env[def.debugEnv];

        const { hooks } = await loadGate(def);
        const state = hooks.getEnablementState();

        expect(state.enabled).toBe(true);
        expect(state.via).toBe("sentinel");
        const logFile = join(logDir, `${def.gate}.log`);
        expect(existsSync(logFile)).toBe(true);
        const body = readFileSync(logFile, "utf8");
        expect(body).toContain("gate loaded");
        expect(body).toContain(String(process.pid));
      });

      it("switches on through the env flag when the sentinel is absent", async () => {
        const logDir = makeTemp();
        process.env[def.logDirEnv] = logDir;
        process.env[def.debugFileEnv] = join(makeTemp(), ".debug-missing");
        process.env[def.debugEnv] = "1";

        const { hooks } = await loadGate(def);
        const state = hooks.getEnablementState();

        expect(state.enabled).toBe(true);
        expect(state.via).toBe("env");
        expect(existsSync(join(logDir, `${def.gate}.log`))).toBe(true);
      });

      it("reports env first when both signals are present", async () => {
        const logDir = makeTemp();
        const sentinelDir = makeTemp();
        const sentinel = join(sentinelDir, ".debug");
        writeFileSync(sentinel, "");
        process.env[def.logDirEnv] = logDir;
        process.env[def.debugFileEnv] = sentinel;
        process.env[def.debugEnv] = "true";

        const { hooks } = await loadGate(def);
        const state = hooks.getEnablementState();

        expect(state.enabled).toBe(true);
        expect(state.via).toBe("env");
      });

      it("stays off with a discoverable state when both signals are absent", async () => {
        const logDir = makeTemp();
        process.env[def.logDirEnv] = logDir;
        process.env[def.debugFileEnv] = join(makeTemp(), ".debug-missing");
        delete process.env[def.debugEnv];

        const { hooks } = await loadGate(def);
        const state = hooks.getEnablementState();

        expect(state.enabled).toBe(false);
        expect(state.via).toBe("none");
        expect(existsSync(join(logDir, `${def.gate}.log`))).toBe(false);
        const statusFile = join(logDir, `${def.gate}.status`);
        expect(existsSync(statusFile)).toBe(true);
        const status = JSON.parse(readFileSync(statusFile, "utf8"));
        expect(status.enabled).toBe(false);
        expect(status.sentinelPath).toBe(state.sentinelPath);
      });

      it("treats zero-like env values as off so the sentinel stays unambiguous", async () => {
        const logDir = makeTemp();
        process.env[def.logDirEnv] = logDir;
        process.env[def.debugFileEnv] = join(makeTemp(), ".debug-missing");
        process.env[def.debugEnv] = "0";

        const { hooks } = await loadGate(def);

        expect(hooks.getEnablementState().enabled).toBe(false);
      });

      it("counts a log-dir mkdir failure in the dropped counter instead of losing it", async () => {
        const logDir = makeTemp();
        process.env[def.logDirEnv] = logDir;
        process.env[def.debugFileEnv] = join(makeTemp(), ".debug-missing");
        delete process.env[def.debugEnv];

        const { hooks } = await loadGate(def);
        hooks.resetDroppedLogCount();

        const blocker = join(makeTemp(), "blocker-file");
        writeFileSync(blocker, "not a directory");
        process.env[def.logDirEnv] = join(blocker, "logs");

        const state = hooks.getEnablementState();

        expect(state.logWritable).toBe(false);
        expect(hooks.getDroppedLogCount()).toBe(1);
      });
    });
  }
});

// The shipped posture: with no enablement signal the shipped config resolves
// off. These cases leave the sentinel seam unset so each gate resolves its own
// default sentinel path inside the plugin directory and every gate stays
// silent — a committed sentinel or a default flipped on turns them red.
describe("shipped default-off logging posture", () => {
  for (const def of GATES) {
    it(`resolves logging off from the shipped config for ${def.gate}`, async () => {
      const logDir = makeTemp();
      process.env[def.logDirEnv] = logDir;
      delete process.env[def.debugFileEnv];
      delete process.env[def.debugEnv];

      const { hooks } = await loadGate(def);
      const state = hooks.getEnablementState();

      expect(state.enabled).toBe(false);
      expect(state.via).toBe("none");
      expect(isAbsolute(state.sentinelPath)).toBe(true);
      expect(state.sentinelPath.endsWith(join("plugins", def.gate, ".debug"))).toBe(true);
      expect(existsSync(state.sentinelPath)).toBe(false);
      expect(existsSync(join(logDir, `${def.gate}.log`))).toBe(false);
    });
  }
});

// The enablement path carries deny/override seam evidence: each gate's
// file-only seam channel writes nothing while logging stays off and appends a
// structured line once logging is on. Drive a real denial through the public
// shell hook so the pin covers the channel seam events travel on rather than
// the load signal alone. Live seam evidence from a running host remains
// harness-side; this pins the in-tree mechanism that would carry it.
describe("deny seam evidence channel", () => {
  const protocolGate = GATES.find((g) => g.gate === "protocol-gate");

  async function denyOnce(sessionID) {
    const { hooks } = await loadGate(protocolGate);
    await hooks["chat.params"]({ sessionID, agent: "artisan" }, {});
    return hooks["tool.execute.before"](
      { tool: "shell", sessionID, callID: `${sessionID}-call` },
      { args: { command: "python -c 'print(1)'" } }
    ).then(
      () => null,
      (error) => error
    );
  }

  it("writes no deny seam line while logging stays off", async () => {
    const logDir = makeTemp();
    process.env[protocolGate.logDirEnv] = logDir;
    process.env[protocolGate.debugFileEnv] = join(makeTemp(), ".debug-missing");
    delete process.env[protocolGate.debugEnv];

    const failure = await denyOnce("seam-logging-off");

    expect(failure).not.toBeNull();
    expect(failure.code).toBe("SHELL_DENIED_ATTRIBUTED");
    expect(existsSync(join(logDir, "protocol-gate.log"))).toBe(false);
  });

  it("appends a deny seam line when logging is enabled", async () => {
    const logDir = makeTemp();
    process.env[protocolGate.logDirEnv] = logDir;
    process.env[protocolGate.debugFileEnv] = join(makeTemp(), ".debug-missing");
    process.env[protocolGate.debugEnv] = "1";

    const failure = await denyOnce("seam-logging-on");

    expect(failure).not.toBeNull();
    expect(failure.code).toBe("SHELL_DENIED_ATTRIBUTED");
    const body = readFileSync(join(logDir, "protocol-gate.log"), "utf8");
    expect(body).toContain("SHELL ATTRIBUTION");
    expect(body).toContain("denied=");
  });
});
