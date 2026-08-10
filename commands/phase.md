---
description: Set the protocol phase for the current session (number 0-12 or phase name)
---

Set the protocol phase for the current session.

Argument: $ARGUMENTS

Phase was manually overridden to $ARGUMENTS. The protocol-gate /phase hook already applied and persisted the override — relay its response.

## What /phase does

The hook performs every state change and persists the override marker; relay its confirmation.

## overrideUntil marker

Every `/phase` invocation records an override marker `{ phase, since }`:

- `phase` — the override target phase.
- `since` — the timestamp of the override.

While the current phase equals the marker's target, disk-based advancement requires **fresh** evidence: a phase KD whose mtime is at or after `since`. This prevents a pre-existing KD from silently undoing a manual override.

The marker is cleared when:

- the phase advances away from the override target on fresh evidence;
- a backward transition moves to an earlier phase;
- the lifecycle ends with a REPORT KD;
- a new `/phase` invocation replaces it.

## INTENT override exemption

The INTENT target is the one exception to the fresh-evidence rule: the intent KD *is* the phase deliverable, so any present session-matching intent KD counts as evidence regardless of its mtime. With an intent KD present, `/phase INTENT` advances to PREFLIGHT on the next disk-check tool call (`write`, `glob`, `todowrite`, `task`). INTENT is not a parking phase — to redo a later phase, override directly to that phase.

## Recovery path

`/phase <phase>` is the manual escape hatch for any stuck phase. If a phase holds unexpectedly, move back or forward explicitly — for example `/phase PREFLIGHT` after correcting the intent KD. A manual override supersedes any pending auto-advance announcement, so redispatches are clean.

## Restart catch-up

After a restart, the gate may advance one phase per tool call (`write`, `glob`, `todowrite`, `task`) across phases whose KDs already exist on disk. This is disk-evidence catch-up, not a bug: the state file restores the phase, and each disk check re-reads `knowledge/` — pre-existing KDs from before the restart are legitimate evidence, so the lifecycle walks forward one hop per call until it reaches the phase whose KD is missing. With `PROTOCOL_GATE_DEBUG=1`, catch-up hops are logged as `RESTART_CATCH_UP: <from> → <to> on pre-existing KD`.

`/phase <phase>` pins a phase at any point — a manual override takes precedence over catch-up. The one-shot auto-advance announcement (`Phase auto-advanced: <from> → <to>`) explains each hop as it happens, so a "phase jumped" read during catch-up is accumulated disk evidence, not a skipped phase.

## Correcting the intent KD in place

A corrected intent KD can be fixed with `edit` (scoped to `knowledge/intent-*.md` in INTENT phase) and advances to PREFLIGHT on the next disk-check tool call. Editing the KD does not require re-running `/phase INTENT`.

## Milestone-Registry Read Contract (SWARM-only)

Registry reads are SWARM-only; the injected milestone list is the live source after SWARM begins.

## Correcting a Phase Artifact

When a user corrects a phase artifact after the producing phase has advanced, use one of the two sanctioned paths:

1. **Backward override**: explicit `/phase <producing-phase>` override (backward-transition semantics, `BACKWARD: true` flow) returning to the producing phase, then re-dispatch the producing agent.
2. **Role deviation**: route the correction through the current phase's agent with an explicit role-deviation scope note (the M1 pattern).

Route later-phase corrections through the two sanctioned paths: backward override or role deviation; the WRONG_AGENT guard enforces the phase-agent pairing.
