---
name: template-milestones
description: "KD template for creating MILESTONE REGISTRY documents. Load this skill, then use the template body as your KD structure reference."
---

---

title: "MILESTONE REGISTRY: {{feature name}}"
version: 1.0.0
status: draft
type: milestones
session_id: "{{session_id}}"
author: Pathfinder
superseded_by: null
---

<!-- Filename: knowledge/milestones-{{feature}}-{{session_id}}-gen{{generation}}.md -->
<!-- GENERATION: {{generation}} is the lifecycle counter from protocol-gate state. Each lifecycle's KDs are scoped to its generation (`-genN-` after the session ID) so stale KDs from prior lifecycles are never matched. Use the generation value provided by the dispatcher. -->

# MILESTONE REGISTRY: {{feature name}}

Source plan: `knowledge/plan-{{feature}}-{{session_id}}-gen{{generation}}.md`

## Milestone States

```yaml
milestones:
  M1: pending
  M2: pending
```

## State Model

**State values**: `pending`, `assigned`, `in-progress`, `evidence-landed`, `checked-off`, `failed`.

**State transitions** (writer ownership: the write hooks settle rows to their evidence state; exactly one mechanism — the VERIFY verdict-PASS commit — records completion):

| From                           | To              | Writer        | Condition                                                                                                                                                                                                                    |
| ------------------------------ | --------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (creation)                     | pending         | Pathfinder    | registry written at DECOMPOSE                                                                                                                                                                                                |
| pending / in-progress / failed | assigned        | protocol-gate | SWARM task dispatch with matching MILESTONE_ID                                                                                                                                                                               |
| assigned                       | in-progress     | protocol-gate | SWARM task dispatch fires — same pass as assigned                                                                                                                                                                            |
| in-progress                    | evidence-landed | protocol-gate | Live same-session milestone-scoped impl KD `impl-<milestone_id>-<name>-<session_id>[-gen{N}].md` arrives through a write hook — the row records landed, attributed evidence and nothing more                                   |
| in-progress / evidence-landed  | checked-off     | protocol-gate | VERIFY verdict `PASS` commit: the sole completion writer — every settled row flips as part of the same commit that advances VERIFY→EXTRACT                                                                                      |
| assigned / in-progress         | failed          | protocol-gate | automatic safety trigger during SWARM: 15-failure force-advance, 5-redispatch cap, or pendingVerification timeout marks the stuck row(s) failed, logs SAFETY_STUCK, and STAYS in SWARM — no automatic advance to VERIFY      |
| assigned / in-progress         | failed          | Artisan       | escalation without completion                                                                                                                                                                                                |
| checked-off / evidence-landed  | in-progress     | protocol-gate | FAIL verdict reopen citing the row (`reopen_target`): the row reopens and its invalidated impl KD is supersede-stamped in place                                                                                               |
| checked-off / evidence-landed  | (no transition) | protocol-gate | evaluation reads settled and completed rows and leaves them in place — the SWARM gate's disk check and the reconcile scan observe evidence and write no rows; a backward transition to SWARM (BACKWARD: true) resets dispatch counters and keeps rows as they are |

## SWARM→VERIFY Gate

SWARM advances to VERIFY when every milestone row carries its milestone-scoped live impl KD on disk (`checkAllMilestonesCheckedOff` — per-row disk evidence, computed purely: evaluation reads the evidence and leaves the registry bytes in place). The row completion record (`checked-off`) follows the verdict: the VERIFY verdict `PASS` commit promotes every `evidence-landed` row as part of the same commit that advances the lifecycle. The gate fails closed on missing/empty/unparsable registries (records `REGISTRY_MISSING`/`REGISTRY_EMPTY` on the gate log even with the debug flag unset). Count signals (`MILESTONE_COUNT`, dispatch counts) have no gating effect. The user's `/phase` override is the escape hatch from a stuck SWARM and logs `SAFETY_ESCAPE`.

## Parsing Contract

protocol-gate reads the `## Milestone States` fenced YAML block (`milestones:` mapping of ID → state). The YAML block is the single status surface for machine and human readers.

## Writing Rules

- One row per plan milestone; IDs must match `/^[A-Za-z0-9][A-Za-z0-9_-]*$/` and be unique within the plan.
- Writers use read-modify-write on the single registry file. Dispatches are serial (one `subagent` call at a time), so no concurrent writers are expected.
- The registry is the live state SSOT; the PLAN KD remains immutable after approval.
- **Update-in-place**: If a milestone registry already exists for this session, update it in-place using the edit tool. Create a new file when no registry exists for the current session and generation. Creating a duplicate registry causes the protocol-gate plugin to silently track the wrong file.
