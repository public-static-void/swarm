---
id: 16
title: "Stale-gate SAFETY_STUCK false positive — plugin gate-logic changes do not hot-reload; the fixing session hits the pre-fix code (M5 first dispatch)"
severity: high
status: resolved
created: 2026-08-03
session: ses_03799b83bffeW0NwRafS4VI0nX
assigned_to: state-persistence lifecycle (protocol-gate + opencode plugin reload semantics)
tags: [process, protocol-gate, safety, dispatch, lifecycle, restart]
---

# Issue 16: Stale-gate SAFETY_STUCK false positive — plugin gate-logic changes do not hot-reload

## Description

In the swarm-system-fixes lifecycle, milestone M5 was blocked on its FIRST dispatch by the very bug F1 exists to remove — because the fix had landed on disk but was not loaded into the running process:

1. F1's per-milestone redispatch counter landed in `plugins/protocol-gate/index.js` during M1.
2. opencode plugins load once per process; the running process kept the PRE-FIX phase-global counter code in memory.
3. M1–M4 dispatches (including M4's re-dispatch) continued incrementing the shared `${sessionID}:${phase}` key under the old code.
4. M5's first dispatch read `>= 5` → SAFETY_STUCK false positive → the dispatch produced no ALLOW/result; only a re-dispatch line appears in delegation-gate.log:7152.
5. Recovery required the user's `/phase` override (SAFETY_ESCAPE) and a restart; the re-dispatch succeeded because the restart loaded the new code with an empty counter Map.

Impact: a milestone that had done nothing wrong was falsely blocked mid-lifecycle; recovery required human intervention. This is the same class as issue [6] (restart-reset: plugin state/code does not survive or reload without restart) and a live demonstration of why the F1 fix protects the NEXT session, not the one that ships it. Distinct from issue-12 (the phase-global counter design flaw, now resolved by F1) — this is the reload-semantics facet: gate-logic changes require a process restart to take effect.

## Source KD Reference

- `knowledge/report-swarm-system-fixes-ses_03799b83bffeW0NwRafS4VI0nX-gen0.md` — durable substitute (the gen0 composed/process KDs were removed by lifecycle-end cleanup): Gate Anomaly G1 (reconstruction), Lesson, open follow-up #4, PF-01, R1
- `plugins/logs/delegation-gate.log` — M5 re-dispatch (:7152, :7168–7169), M4 re-dispatch (:7029)
- `knowledge/issues/issue-6.md` — restart-reset bug (related class, own INTENT `knowledge/intent-state-persistence-ses_047b8d61fffeVDL344LPyCj53t-gen0.md`)
- `knowledge/issues/issue-12.md` — the design-flaw facet this issue's symptom proved (resolved by F1)

## Recommended Fix

- Require a process restart (or explicit plugin reload) after any protocol-gate/delegation-gate code change lands mid-lifecycle; verify gate state post-restart before continuing dispatch.
- Fold plugin-code reload semantics into the state-persistence lifecycle scope (issue-6): plugin state AND code must survive/reload predictably, so a mid-session gate fix takes effect without human intervention.
- Document the protocol rule: expect one re-dispatch when a gate fix ships mid-session (the fixing session runs pre-change code until restart).

## Acceptance Criteria

- No lifecycle reports a SAFETY_STUCK false positive caused by stale in-memory gate code after a gate fix has landed on disk.
- A gate-logic change landing mid-session is either (a) followed by an automatic/forced reload before the next dispatch, or (b) explicitly documented as requiring a restart, with the re-dispatch handled without user `/phase` intervention.
- The plugin reload/state semantics are documented in the state-persistence lifecycle outcome.

## Resolution (2026-08-09)

Closed as **resolved-by-design** per the user's decision (INTENT `knowledge/intent-restart-resume-fixes-ses_01dc82bf9ffen46jTRrKJRAOkS-gen1.md` :32): no plugin hot-reload is needed — the restart-resume workflow IS the resolution. No code work.

- **No hot-reload is a runtime constraint** (MEM-059: "opencode plugins load once per process — gate-logic changes do not hot-reload"). Any gate-logic fix ships on disk but is only live in the next process.
- **The restart-resume workflow resolves this issue**: fix lands → user restarts opencode → loads the same session → `reconcileSessionState` restores phase/generation from the persisted `.state` (`plugins/protocol-gate/index.js:1400-1474`) → the fresh code is live → dispatch continues from the resumed phase. No `/phase` override is needed because the phase resumes automatically (see the issue-6 close evidence — same session `ses_01dc82bf9ffen46jTRrKJRAOkS` crossed gen0→gen1 across the user's restart).
- **The fresh counter map kills the SAFETY_STUCK false positive**: `phaseRedispatchCount` is an in-memory map (increment at `plugins/protocol-gate/index.js:2475`, cap at :2307-2333); a restart resets it to empty, so the first dispatch after restart reads a fresh budget and cannot inherit `>= 5` from pre-restart increments. This is the exact mechanism that resolved the original M5 incident, and it is non-recurring by construction for the restart-resume workflow.
- **Acceptance criteria satisfied**: (a) no future SAFETY_STUCK false positive from stale in-memory gate code — post-restart dispatch runs fresh code with an empty counter map; (b) gate-logic changes landing mid-session are documented as requiring a restart (MEM-059 rule: "any fix report must state the restart requirement"), and the re-dispatch after restart is handled without user `/phase` intervention via resumed-phase dispatch; (c) plugin reload/state semantics are documented in the state-persistence lifecycle outcome — this issue's close plus the issue-6 close evidence.

Source KD References repointed to the durable substitute `knowledge/report-swarm-system-fixes-ses_03799b83bffeW0NwRafS4VI0nX-gen0.md` (the gen0 composed/process KDs were removed by lifecycle-end cleanup — issue-41 rot pattern).
