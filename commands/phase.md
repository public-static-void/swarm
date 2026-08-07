---
description: Set the protocol phase for the current session (number 0-12 or phase name)
---

Set the protocol phase for the current session.

Argument: $ARGUMENTS

Phase was manually overridden to $ARGUMENTS. The protocol-gate /phase hook already applied and persisted the override — relay its response and do nothing else.

## What /phase does

`/phase <0-12|PHASE_NAME>` manually overrides the protocol phase for the current session. The protocol-gate hook validates the argument, sets the phase, persists the override marker, and replies with a confirmation. The hook performs every state change — never hand-write phase state or override files.

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

## Correcting the intent KD in place

A corrected intent KD can be fixed with `edit` (scoped to `knowledge/intent-*.md` in INTENT phase) and advances to PREFLIGHT on the next disk-check tool call. Editing the KD does not require re-running `/phase INTENT`.

## Milestone-Registry Read Contract (SWARM-only)

Reads of `knowledge/milestones-*.md` are **SWARM-only** (protocol-gate `TOOL_RESTRICTIONS.SWARM.read`; MEM-046 least-privilege rationale). The read is blocked in DECOMPOSE and every pre-SWARM phase. The live milestone list is injected into Overseer context once SWARM begins (R010 systemTransform) — do not attempt a registry read before SWARM and do not expect one.

## Correcting a Phase Artifact

When a user corrects a phase artifact after the producing phase has advanced, use one of the two sanctioned paths:

1. **Backward override**: explicit `/phase <producing-phase>` override (backward-transition semantics, `BACKWARD: true` flow) returning to the producing phase, then re-dispatch the producing agent.
2. **Role deviation**: route the correction through the current phase's agent with an explicit role-deviation scope note (the M1 pattern).

Do not instruct an arbitrary earlier agent to act in a later phase; the WRONG_AGENT guard still blocks out-of-phase dispatch.
