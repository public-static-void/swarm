import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeSync } from "fs";

// Atomic durable write for protocol-gate (gate-local).
//
// Tmp file + fsync + rename. The rename is atomic on the same filesystem, so
// a crash mid-write can never leave a torn file at the target path. Throws on
// failure; callers surface the error. Stays inside plugins/protocol-gate/ —
// no cross-gate import — so each gate keeps its own write seam.
export function atomicWriteFileSync(targetPath, data) {
  const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    const fd = openSync(tmpPath, "w");
    try {
      writeSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmpPath, targetPath);
  } catch (e) {
    try { rmSync(tmpPath, { force: true }); } catch (_) {}
    throw e;
  }
}
