import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Standing suite for the always-on load-signal and the writability probe:
// every gate leaves a status file on every start (even with logging off),
// appends one attributable loaded line per start when logging is on, and
// reports an unwritable log directory as data instead of going quiet.

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

function makeTemp() {
  const dir = mkdtempSync(join(tmpdir(), "audit-fix-signal-"));
  tempDirs.push(dir);
  return dir;
}

function enableViaSentinel(def, logDir) {
  const sentinel = join(makeTemp(), ".debug");
  writeFileSync(sentinel, "");
  process.env[def.logDirEnv] = logDir;
  process.env[def.debugFileEnv] = sentinel;
  delete process.env[def.debugEnv];
}

function disableLogging(def, logDir) {
  process.env[def.logDirEnv] = logDir;
  process.env[def.debugFileEnv] = join(makeTemp(), ".debug-missing");
  delete process.env[def.debugEnv];
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
});

afterEach(() => {
  for (const key of ALL_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  vi.resetModules();
});

describe("gate load-signal and writability probe", () => {
  for (const def of GATES) {
    describe(def.gate, () => {
      it("leaves an observable status file when logging is disabled", async () => {
        const logDir = makeTemp();
        disableLogging(def, logDir);

        const { hooks } = await loadGate(def);

        const statusFile = join(logDir, `${def.gate}.status`);
        expect(existsSync(statusFile)).toBe(true);
        const status = JSON.parse(readFileSync(statusFile, "utf8"));
        expect(status.gate).toBe(def.gate);
        expect(typeof status.ts).toBe("string");
        expect(typeof status.seq).toBe("number");
        expect(status.pid).toBe(process.pid);
        expect(status.enabled).toBe(false);
        expect(status.logFile).toBe(join(logDir, `${def.gate}.log`));
        expect(status.sentinelPath).toBe(hooks.getEnablementState().sentinelPath);
        expect(status.logWritable).toBe(true);
      });

      it("appends a timestamped process-attributed loaded line when logging is enabled", async () => {
        const logDir = makeTemp();
        enableViaSentinel(def, logDir);

        await loadGate(def);

        const body = readFileSync(join(logDir, `${def.gate}.log`), "utf8");
        const lines = body.split("\n").filter((l) => l.includes("gate loaded"));
        expect(lines.length).toBeGreaterThanOrEqual(1);
        expect(lines[0]).toContain(String(process.pid));
        expect(lines[0]).toContain("sentinel");
      });

      it("records one distinguishable loaded line per start", async () => {
        const logDir = makeTemp();
        enableViaSentinel(def, logDir);

        const first = await loadGate(def);
        await first.hooks.getEnablementState();
        const second = await loadGate(def);
        void second;

        const body = readFileSync(join(logDir, `${def.gate}.log`), "utf8");
        const lines = body.split("\n").filter((l) => l.includes("gate loaded"));
        expect(lines.length).toBeGreaterThanOrEqual(2);
        expect(new Set(lines).size).toBe(lines.length);
      });

      it("reports an unwritable log dir as data instead of going quiet", async () => {
        const blocker = join(makeTemp(), "blocker-file");
        writeFileSync(blocker, "not a directory");
        const logDir = join(blocker, "logs");
        process.env[def.logDirEnv] = logDir;
        process.env[def.debugFileEnv] = join(makeTemp(), ".debug-missing");
        delete process.env[def.debugEnv];

        const { hooks } = await loadGate(def);
        const state = hooks.getEnablementState();

        expect(state.logWritable).toBe(false);
        expect(typeof state.reason).toBe("string");
        expect(state.reason.length).toBeGreaterThan(0);
        expect(hooks.getDroppedLogCount()).toBeGreaterThan(0);
      });

      it("counts log write failures instead of swallowing them", async () => {
        const blocker = join(makeTemp(), "blocker-file");
        writeFileSync(blocker, "not a directory");
        process.env[def.logDirEnv] = join(blocker, "logs");
        process.env[def.debugFileEnv] = join(makeTemp(), ".debug-missing");
        process.env[def.debugEnv] = "1";

        const { hooks } = await loadGate(def);
        hooks.resetDroppedLogCount();
        hooks.emitLoadSignal(hooks.getEnablementState());

        expect(hooks.getDroppedLogCount()).toBeGreaterThanOrEqual(2);
      });
    });
  }
});
