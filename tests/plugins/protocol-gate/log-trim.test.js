import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { fileURLToPath } from "url";
import pluginModule from "../../../plugins/protocol-gate/index.js";

// Write-time retention at the always-on gateRecord seam: before appending a
// record, the seam rewrites the log to a complete-line tail (cap/2) and
// appends one LOG_TRIMMED record. The bound lives on disk, so it survives
// process restarts. The generation allocator is the write trigger — one
// always-on record per call, and equal-length session names keep record
// bytes uniform so the trim sequence below is exact. Self-contained: own
// temp knowledge/state/log dirs, no dependence on live lifecycle state.
describe("Protocol-Gate log trim", () => {
  let tempRoot;
  let knowledgeDir;
  let stateDir;
  let logDir;
  let priorKnowledgeDir;
  let priorStateDir;
  let priorLogDir;
  let priorMax;
  let priorDebug;
  let hooks;

  beforeAll(async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "pg-trim-"));
    knowledgeDir = join(tempRoot, "knowledge");
    stateDir = join(tempRoot, "state");
    logDir = join(tempRoot, "logs");
    for (const d of [knowledgeDir, stateDir, logDir]) {
      rmSync(d, { recursive: true, force: true });
      mkdirSync(d, { recursive: true });
    }
    priorKnowledgeDir = process.env.PROTOCOL_GATE_KNOWLEDGE_DIR;
    priorStateDir = process.env.PROTOCOL_GATE_STATE_DIR;
    priorLogDir = process.env.PROTOCOL_GATE_LOG_DIR;
    priorMax = process.env.PROTOCOL_GATE_LOG_MAX_BYTES;
    priorDebug = process.env.PROTOCOL_GATE_DEBUG;
    process.env.PROTOCOL_GATE_KNOWLEDGE_DIR = knowledgeDir;
    process.env.PROTOCOL_GATE_STATE_DIR = stateDir;
    process.env.PROTOCOL_GATE_LOG_DIR = logDir;
    delete process.env.PROTOCOL_GATE_DEBUG; // the record is always-on
    hooks = await pluginModule.server({}, {});
  });

  afterAll(() => {
    if (priorKnowledgeDir === undefined) delete process.env.PROTOCOL_GATE_KNOWLEDGE_DIR;
    else process.env.PROTOCOL_GATE_KNOWLEDGE_DIR = priorKnowledgeDir;
    if (priorStateDir === undefined) delete process.env.PROTOCOL_GATE_STATE_DIR;
    else process.env.PROTOCOL_GATE_STATE_DIR = priorStateDir;
    if (priorLogDir === undefined) delete process.env.PROTOCOL_GATE_LOG_DIR;
    else process.env.PROTOCOL_GATE_LOG_DIR = priorLogDir;
    if (priorMax === undefined) delete process.env.PROTOCOL_GATE_LOG_MAX_BYTES;
    else process.env.PROTOCOL_GATE_LOG_MAX_BYTES = priorMax;
    if (priorDebug === undefined) delete process.env.PROTOCOL_GATE_DEBUG;
    else process.env.PROTOCOL_GATE_DEBUG = priorDebug;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    // Each case owns a clean log; the cap env seam is set per test only.
    try { rmSync(join(logDir, "protocol-gate.log")); } catch (_) {}
    delete process.env.PROTOCOL_GATE_LOG_MAX_BYTES;
  });

  const LOG_FILE = () => join(logDir, "protocol-gate.log");

  it("rewrites the log to a bounded complete-line tail with one LOG_TRIMMED record per trim", async () => {
    // Measure one record's exact byte length with the cap far above it.
    process.env.PROTOCOL_GATE_LOG_MAX_BYTES = "100000000";
    hooks.allocateLifecycleGeneration("trim-sess-A0");
    const first = readFileSync(LOG_FILE(), "utf8").split("\n").filter((l) => l.length > 0);
    expect(first, "one always-on record per allocation").toHaveLength(1);
    const L = Buffer.byteLength(first[0]) + 1;
    rmSync(LOG_FILE());

    // cap = 5 records: the seventh append's pre-append check trims to the
    // last two complete lines plus one LOG_TRIMMED record; the eighth lands
    // back under the cap.
    const cap = 5 * L;
    process.env.PROTOCOL_GATE_LOG_MAX_BYTES = String(cap);
    for (const tag of ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8"]) {
      hooks.allocateLifecycleGeneration(`trim-sess-${tag}`);
    }

    const lines = readFileSync(LOG_FILE(), "utf8").split("\n").filter((l) => l.length > 0);
    const trimLines = lines.filter((l) => l.includes("LOG_TRIMMED"));
    expect(trimLines, "exactly one trim event, one record").toHaveLength(1);

    // Every surviving line is a complete, parseable gate line — the tail cut
    // landed on a line boundary, never mid-record.
    for (const l of lines) {
      expect(l, `line parses: ${l}`).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] \[protocol-gate\] /);
    }

    const m = trimLines[0].match(/LOG_TRIMMED: kept (\d+) of (\d+), dropped (\d+) lines$/);
    expect(m, `trim record shape: ${trimLines[0]}`).toBeTruthy();
    expect(Number(m[1]), "kept bytes").toBe(2 * L);
    expect(Number(m[2]), "pre-trim bytes").toBe(6 * L);
    expect(Number(m[3]), "dropped lines").toBe(4);

    // The newest records survive a trim; the pre-trim head is gone.
    const log = lines.join("\n");
    expect(log).toContain("session=trim-sess-A5");
    expect(log).toContain("session=trim-sess-A8");
    expect(log).not.toContain("session=trim-sess-A4");
    expect(log).not.toContain("session=trim-sess-A1");

    // Bounded at the cap in the same file — no rotation siblings beside the
    // log (the tiny status file is a separate, pre-existing surface).
    expect(statSync(LOG_FILE()).size).toBeLessThanOrEqual(cap);
    expect(readdirSync(logDir).filter((f) => /^protocol-gate\.log/.test(f))).toEqual(["protocol-gate.log"]);
  });

  it("stays silent below the 2 MB default when PROTOCOL_GATE_LOG_MAX_BYTES is unset", async () => {
    for (let i = 0; i < 70; i++) {
      hooks.allocateLifecycleGeneration(`trim-sess-D${String(i).padStart(3, "0")}`);
    }
    const log = readFileSync(LOG_FILE(), "utf8");
    expect(log).not.toContain("LOG_TRIMMED");
    expect(statSync(LOG_FILE()).size).toBeGreaterThan(5_000);
    // The default cap is one literal number per gate, pinned at its home.
    const src = readFileSync(fileURLToPath(new URL("../../../plugins/protocol-gate/index.js", import.meta.url)), "utf8");
    expect(src).toContain("LOG_MAX_BYTES_DEFAULT = 2_000_000");
  });
});
