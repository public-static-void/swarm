---
id: 6
title: "Restart-reset bug — opencode restart wipes protocol-gate phase state AND knowledge/ KDs mid-lifecycle"
severity: high
status: resolved
created: 2026-08-01
session: ses_047b8d61fffeVDL344LPyCj53t
assigned_to: state-persistence lifecycle (own INTENT: knowledge/intent-state-persistence-ses_047b8d61fffeVDL344LPyCj53t-gen0.md)
tags: [process, state-persistence, restart, protocol-gate, lifecycle]
---

# Issue 6: Restart-reset bug — opencode restart wipes protocol-gate phase state AND knowledge/ KDs mid-lifecycle

## Description

An opencode restart during this lifecycle reset the protocol-gate phase state (back to PROTOCOL_NOT_LOADED/INTENT) AND wiped the project's `knowledge/` KDs mid-lifecycle. Evidence from the milestone-tracking lifecycle:

- **Wiped KDs**: INTENT, SPEC, PLAN, EXPLORATION, ANALYSIS, PREFLIGHT, PROCESS and the original impl-M1 KD — none exist on disk today; only 13 KDs survived (report, milestones registry, impl-M1…M5, review, audit, checkpoints step1–4) plus memory entries MEM-015/MEM-028 and committed code (COMPOSED:30).
- **Wiped in-memory state**: the protocol-gate `overseerSessions` map was emptied, so the M4 `autoCheckOffMilestone` write-signal hook could not match a parent SWARM session after the restart — registry rows M1–M5 had to be reconciled manually (REVIEW F003/PF-009, COMPOSED D7).
- **Recovery cost**: AC/R mapping reconstructed from dispatch scope + REPORT + memory; impl-M1 restored as an evidence-restoration KD from `git log`/`git diff` (no code modified); registry recreated per `template-milestones`; every impl KD documents its reconstruction in "Reconstructed Acceptance Criteria" sections.

`knowledge/` is gitignored runtime state; committed code is the only durable source (COMPOSED insight #5). The bug has its own INTENT on disk (`knowledge/intent-state-persistence-ses_047b8d61fffeVDL344LPyCj53t-gen0.md`) and needs a dedicated Explorer mapping of state locations + a persistence fix.

## Source KD Reference

- `knowledge/composed-milestone-tracking-ses_047b8d61fffeVDL344LPyCj53t-gen0.md` — Context Continuity, PF-S1, open follow-up #1
- `knowledge/impl-M1-milestone-tracking-ses_047b8d61fffeVDL344LPyCj53t-gen0.md` — PF-M1-1 (evidence restoration)
- `knowledge/impl-M2-milestone-tracking-ses_047b8d61fffeVDL344LPyCj53t-gen0.md` — PF-M2-1; `impl-M3` PF-M3-1; `impl-M4` PF-008; `impl-M5` PF-009
- `knowledge/review-milestone-tracking-ses_047b8d61fffeVDL344LPyCj53t-gen0.md` — F003, PF-R1
- `knowledge/report-milestone-tracking-ses_047b8d61fffeVDL344LPyCj53t-gen0.md` — PF-012

## Recommended Fix

Persist protocol-gate lifecycle state (phase, registry pointer, overseer-session map) to disk on every transition and restore from disk on load, so a restart never resets to PROTOCOL_NOT_LOADED/INTENT. Protect `knowledge/` KD evidence from wipe: either commit evidence KDs (impl/registry/composed) at milestone boundaries or exclude `knowledge/` from the destructive cleanup. Document a mechanical restore-evidence protocol (inventory survivors → reconstruct AC/R mapping → restore impl KDs from git → reconcile registry rows).

## Acceptance Criteria

- A restart mid-lifecycle preserves phase state and on-disk KDs; no manual registry reconciliation required.
- A restarted lifecycle resumes from its COMPOSED/registry state without reconstruction.
- No future KD friction entry cites "wiped by an opencode restart".

## Resolution (2026-08-09)

Closed as **resolved — verified working, no code fix required**. protocol-gate already persists and restores phase/generation across a restart + same-session reload, and the original wipe root cause was fixed (MEM-029). This closure supersedes the state-persistence INTENT ownership recorded in `assigned_to` (`knowledge/intent-state-persistence-ses_047b8d61fffeVDL344LPyCj53t-gen0.md` remains on disk as historical context).

1. **Live proof — same session crossed gen0→gen1 across the user's restart.** The user restarted opencode after the gen0 lifecycle (overseer-issue-audit); this same session (`ses_01dc82bf9ffen46jTRrKJRAOkS`) resumed and produced the gen1 lifecycle KDs (`intent-…-gen1.md`, `preflight-…-gen1.md`, `exploration-…-gen1.md`). The gen0 report KD `knowledge/report-overseer-issue-audit-ses_01dc82bf9ffen46jTRrKJRAOkS-gen0.md` exists on disk (`<!-- GENERATION: 0 -->`). The `.state` file content quoted at capture time (2026-08-09, SWARM/M1 dispatch):

   ```json
   {"phase":7,"generation":1,"timestamp":1786272764233,"sid":"ses_01dc82bf9ffen46jTRrKJRAOkS"}
   ```

   Verifiable constants: `"generation":1` and `"sid":"ses_01dc82bf9ffen46jTRrKJRAOkS"`. The phase value is the value at capture time and advances as the lifecycle proceeds — it is never pinned. History: ANALYSIS-time observation was `{"phase":4,"generation":1,"timestamp":1786271638991,"sid":"ses_01dc82bf9ffen46jTRrKJRAOkS"}`.

2. **Code anchors** (`plugins/protocol-gate/index.js`):
   - `saveState` (:1259-1314) — atomically persists `{phase, generation, timestamp, sid?, overrideUntil?}` (tmp + fsync + rename, NFR001); the generation counter survives lifecycle resets via the `:gen` map entry.
   - `reconcileSessionState` (:1400-1474) — restores phase/generation/sid/overrideUntil on every overseer `chat.params` (the file always wins, P002/R001); heals a stale `:sid` (R002); records `:restoredAt` on first load only (R005).
   - `RESTART_CATCH_UP` (:2192-2210) — log-only diagnostic (`debug()`); no state mutation (MEM-083).
   - `cleanupLifecycleKDs` (:223-247) — generation-scoped deletion (`-${sessionID}-gen${gen}.md` plus legacy `-${sessionID}.md` when gen 0).

3. **Wipe root cause + fix (MEM-029).** The original wipe was generation-unsafe `cleanupLifecycleKDs` matching by session ID only, which deleted BOTH the legacy `-sid.md` and EVERY `-sid-genN.md` variant when a stray/duplicate REPORT event fired after a new lifecycle began (the issue-6 restart-wipe root cause; the prior ses_047b8d61 incident lost 13 KDs). Fixed by generation-scoped `cleanupLifecycleKDs(sessionID, generation)` with `currentGen` captured BEFORE the increment at both REPORT call sites (write handler :1960, edit handler :2101; capture at :1925/:2074).

4. **Test-suite pointer** — restart-resume is covered in `tests/plugins/protocol-gate/index.test.js`: AC003 (:944 same-session restart restores phase), AC019 (:289 catch-up one-hop-per-call), AC020 (:312), AC021 (:330 gen0-KD-at-gen1-restart no-advance), AC016 (:351 RESTART_CATCH_UP logged), AC017 (:381 no false catch-up mid-session), AC013 (:1744 milestone check-off after restart from impl-KD filename + on-disk state), AC014 (:1771 row reconstruction with empty in-memory map), AC-R009 (:1334 generation across 3 restarts), AC008 (:853 override persists restart), AC010b (:3069 override marker survives mid-session restart).

5. **Non-persistence statement (by design, NFR003).** In-memory maps/counters are deliberately NOT persisted to `.state` — documented at `plugins/protocol-gate/index.js:1214-1239` (`freshAdvancement` "In-memory only — not persisted to .state files (NFR003)", `verdictRegressedKDs`, `advancementAnnouncements`, `rawIntentCapture`). Every gate re-derives state from disk evidence, and milestone-registry state is durable via the registry KD (`knowledge/milestones-*.md` YAML block), not `.state`. No persistence code is added — full in-memory-map persistence would contradict documented semantics and would require a user design decision (MEM-089).

Each original acceptance criterion is met:
- Restart preserves phase state and on-disk KDs, no manual registry reconciliation — phase/generation restore is tested (AC003/AC019/AC020/AC021); the registry is a durable KD read from disk (`locateMilestoneRegistry` :494-538, `checkAllMilestonesCheckedOff` :605-627).
- Restarted lifecycle resumes from registry state without reconstruction — AC013/AC014 prove check-off and row reconstruction with an empty in-memory map.
- No future KD friction entry cites "wiped by an opencode restart" — none since the MEM-029 fix.

Evidence source: ANALYSIS F1-F3 of the restart-resume-fixes lifecycle (`knowledge/analysis-restart-resume-fixes-ses_01dc82bf9ffen46jTRrKJRAOkS-gen1.md`); live `.state` quoted inline per AGENTS.md durability rules.
