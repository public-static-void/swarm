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

// Extracts the embedded `-gen{N}` generation for a session-scoped KD
// filename. Returns the generation number, 0 for the legacy
// `-{sessionID}.md` suffix (generation-0 naming), or null when the filename
// carries no marker for this session at all (foreign lifecycle or non-KD
// name). A `.superseded.md` double suffix never yields a generation —
// renamed provenance is not evidence under any matcher.
export function extractImplKDGeneration(filename, sessionID) {
  if (typeof filename !== "string" || !sessionID) return null;
  if (filename.toLowerCase().endsWith(".superseded.md")) return null;
  const genMarker = `-${sessionID}-gen`;
  const genIdx = filename.lastIndexOf(genMarker);
  if (genIdx !== -1) {
    const genMatch = filename.slice(genIdx + genMarker.length).match(/^(\d+)\.md$/);
    if (genMatch) return parseInt(genMatch[1], 10);
  }
  if (filename.endsWith(`-${sessionID}.md`)) return 0;
  return null;
}

// Generation-pinned session KD matcher — the milestone-evidence predicate.
// True only when the filename's embedded generation equals the persisted
// lifecycle generation. Legacy suffix-less files count as generation 0 (same
// convention as matchesSessionKD), so at any persisted generation above 0
// they never satisfy the predicate and are skipped with a diagnostic.
export function matchesSessionKDPinnedGeneration(filename, sessionID, generation) {
  if (typeof filename !== "string" || !sessionID || typeof generation !== "number") return false;
  const fileGen = extractImplKDGeneration(filename, sessionID);
  if (fileGen === null) return false;
  return fileGen === generation;
}

// Session match independent of the persisted lifecycle generation — used by
// disk-evidence reconciliation, where the FILENAME's own embedded `-gen{N}`
// (any N, including one that differs from the persisted generation — the
// observed gen0/gen1 divergence) or the legacy
// `-{sessionID}.md` suffix is the evidence. The session-id match remains
// mandatory: a foreign lifecycle's impl KD never promotes a row.
//
// DEPRECATED FOR MILESTONE-EVIDENCE PROMOTION (swarm/50): automatic promotion
// paths (isLiveMilestoneEvidence, reconcileStuckRowsFromDiskEvidence,
// autoCheckOffMilestone, checkMilestoneCheckedOff/findMilestoneImplKD) use
// matchesSessionKDPinnedGeneration. This matcher stays ONLY for
// non-promoting uses: supersede-on-reopen stamping, superseded/stamped
// diagnostic probes, and the explicit audited remediation path.
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
