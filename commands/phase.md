---
description: Set the protocol phase for the current session (number 0-12 or phase name)
---

Set the protocol phase for the current session.

Argument: $ARGUMENTS

Phase was manually overridden to $ARGUMENTS. The protocol-gate /phase hook already applied and persisted the override — relay its response and do nothing else.

## Milestone-Registry Read Contract (SWARM-only)

Reads of `knowledge/milestones-*.md` are **SWARM-only** (protocol-gate `TOOL_RESTRICTIONS.SWARM.read`; MEM-046 least-privilege rationale). The read is blocked in DECOMPOSE and every pre-SWARM phase. The live milestone list is injected into Overseer context once SWARM begins (R010 systemTransform) — do not attempt a registry read before SWARM and do not expect one.

## Correcting a Phase Artifact

When a user corrects a phase artifact after the producing phase has advanced, use one of the two sanctioned paths:

1. **Backward override**: explicit `/phase <producing-phase>` override (backward-transition semantics, `BACKWARD: true` flow) returning to the producing phase, then re-dispatch the producing agent.
2. **Role deviation**: route the correction through the current phase's agent with an explicit role-deviation scope note (the M1 pattern).

Do not instruct an arbitrary earlier agent to act in a later phase; the WRONG_AGENT guard still blocks out-of-phase dispatch.
