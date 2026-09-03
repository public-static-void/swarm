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
scope: {{project|generic|swarm}}  # optional — omission defaults to swarm
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

**State values**: `pending`, `assigned`, `in-progress`, `checked-off`, `failed`.

**State transitions**:

| From                           | To              | Writer        | Condition                                                                                                                                                                                                                    |
| ------------------------------ | --------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (creation)                     | pending         | Pathfinder    | registry written at DECOMPOSE                                                                                                                                                                                                |
| pending / in-progress / failed | assigned        | protocol-gate | SWARM task dispatch with matching MILESTONE_ID                                                                                                                                                                               |
| assigned                       | in-progress     | protocol-gate | SWARM task dispatch fires — same pass as assigned (M3)                                                                                                                                                                       |
| in-progress                    | checked-off     | protocol-gate | Artisan writes the milestone-scoped impl KD `impl-<milestone_id>-<name>-<session_id>[-gen{N}].md` — the KD on disk is the verifiable evidence; in-progress rows complete on that evidence (M4)                               |
| assigned / in-progress         | failed          | protocol-gate | automatic safety trigger during SWARM (M5): 15-failure force-advance, 5-redispatch cap, or pendingVerification timeout marks the stuck row(s) failed, logs SAFETY_STUCK, and STAYS in SWARM — no automatic advance to VERIFY |
| assigned / in-progress         | failed          | Artisan       | escalation without completion                                                                                                                                                                                                |
| checked-off                    | (no transition) | protocol-gate | checked-off rows stay checked-off across re-dispatch; a backward transition to SWARM (BACKWARD: true) resets dispatch counters and keeps checked-off rows checked-off                                                        |

## SWARM→VERIFY Gate (M5)

SWARM advances to VERIFY when every milestone row is `checked-off` AND each row has its milestone-scoped impl KD on disk (`checkAllMilestonesCheckedOff` — registry state cross-checked against `checkMilestoneCheckedOff` disk evidence). The gate fails closed on missing/empty/unparsable registries (logs `REGISTRY_MISSING`/`REGISTRY_EMPTY`). Count signals (`MILESTONE_COUNT`, dispatch counts) have no gating effect. The user's `/phase` override is the escape hatch from a stuck SWARM and logs `SAFETY_ESCAPE`.

## Parsing Contract

protocol-gate reads the `## Milestone States` fenced YAML block (`milestones:` mapping of ID → state). The YAML block is the single status surface for machine and human readers.

## Writing Rules

- One row per plan milestone; IDs must match `/^[A-Za-z0-9][A-Za-z0-9_-]*$/` and be unique within the plan.
- Writers use read-modify-write on the single registry file. Dispatches are serial (one `task` call at a time), so no concurrent writers are expected.
- The registry is the live state SSOT; the PLAN KD remains immutable after approval.
- **Update-in-place**: If a milestone registry already exists for this session, update it in-place using the edit tool. Only create a new file if no registry exists for the current session and generation. Creating a duplicate registry causes the protocol-gate plugin to silently track the wrong file.
