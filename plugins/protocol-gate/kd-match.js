// KD session-matching helpers for protocol-gate (gate-local).
//
// Pure filename/session predicates with no module state, so the gate entry
// and the suite can share them by reference. Stays inside
// plugins/protocol-gate/ — no cross-gate import — so each gate keeps loading
// and operating with the other two disabled.

// Generation-aware session KD matcher. Accepts both naming variants:
//   - `...-${sessionID}.md`         (generation 0, legacy naming)
//   - `...-${sessionID}-gen${N}.md` (generation N naming)
// A file matches only when its generation equals the current state generation.
// Gen-less files are treated as generation 0 and are NOT matched when the
// current generation is > 0 — they belong to a prior lifecycle and must not
// advance or suppress the new one.
export function matchesSessionKD(filename, sessionID, generation) {
  if (typeof filename !== "string" || !sessionID) return false;
  // Generation N variant: `...-${sessionID}-gen${N}.md`
  const genMarker = `-${sessionID}-gen`;
  const genIdx = filename.lastIndexOf(genMarker);
  if (genIdx !== -1) {
    const tail = filename.slice(genIdx + genMarker.length);
    const genMatch = tail.match(/^(\d+)\.md$/);
    if (genMatch) {
      return parseInt(genMatch[1], 10) === generation;
    }
  }
  // Legacy variant: `...-${sessionID}.md`
  if (generation > 0) return false;
  return filename.endsWith(`-${sessionID}.md`);
}

// Resolves the session IDs whose KDs belong to the current lifecycle for
// READ/scan purposes. Cross-session adoption was removed — a session never
// inherits another lifecycle's phase or `:sid` — and stale `:sid` entries are
// healed at reconcile, so the lookup set is exactly [current sessionID]. No
// read path can ever scan a prior lifecycle's KDs.
export function getKDLookupSIDs(sessionPhaseMap, sessionID) {
  return [sessionID];
}

// Generation-scoped KD matcher against the session's single-session lookup set
// ([current sessionID] only — cross-session adoption removed). True when the
// file belongs to the lifecycle at the given generation under the current
// session id.
export function matchesSessionKDForSession(filename, sessionPhaseMap, sessionID, generation) {
  return getKDLookupSIDs(sessionPhaseMap, sessionID).some(sid => matchesSessionKD(filename, sid, generation));
}

// Session match independent of the persisted lifecycle generation — used by
// disk-evidence reconciliation, where the FILENAME's own embedded `-gen{N}`
// (any N, including one that differs from the persisted generation — the
// observed gen0/gen1 divergence) or the legacy
// `-{sessionID}.md` suffix is the evidence. The session-id match remains
// mandatory: a foreign lifecycle's impl KD never promotes a row.
export function matchesSessionKDAnyGeneration(filename, sessionID) {
  if (typeof filename !== "string" || !sessionID) return false;
  const genMarker = `-${sessionID}-gen`;
  const genIdx = filename.lastIndexOf(genMarker);
  if (genIdx !== -1 && /^(\d+)\.md$/.test(filename.slice(genIdx + genMarker.length))) {
    return true;
  }
  return filename.endsWith(`-${sessionID}.md`);
}

// Session IDs reach file paths and can be attacker-influenced. Reject path
// separators, NUL, and the traversal entries so a crafted ID can never escape
// the plugin's .state directory. opencode session IDs (ses_...) pass.
export function sanitizeSessionID(sessionID) {
  if (typeof sessionID !== "string" || sessionID.length === 0) return null;
  if (sessionID === "." || sessionID === "..") return null;
  if (/[\\/\0]/.test(sessionID)) return null;
  return sessionID;
}

export function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
