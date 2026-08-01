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

## Milestone Details

| Milestone ID | Description | Plan Steps | Completion Criteria | State | Assigned Artisan | Dispatched At | Checked Off At |
| ------------ | ----------- | ---------- | ------------------- | ----- | ---------------- | ------------- | -------------- |
| M1 | {{description}} | {{P001, P002}} | {{criteria}} | pending | — | — | — |
| M2 | {{description}} | {{P003}} | {{criteria}} | pending | — | — | — |

## State Model

**State values**: `pending`, `assigned`, `in-progress`, `checked-off`, `failed`.

**State transitions**:

| From | To | Writer | Condition |
|------|-----|--------|-----------|
| (creation) | pending | Pathfinder | registry written at DECOMPOSE |
| pending / in-progress / failed | assigned | protocol-gate | SWARM task dispatch with matching MILESTONE_ID |
| assigned | in-progress | protocol-gate | SWARM task dispatch fires — same pass as assigned (M3) |
| in-progress | checked-off | Artisan | successful completion: steps done, tests green, impl KD written, checkpoint commit |
| assigned / in-progress | failed | protocol-gate | automatic safety trigger during SWARM |
| assigned / in-progress | failed | Artisan | escalation without completion |
| checked-off | pending | protocol-gate | backward transition to SWARM when impl KD missing |

## Parsing Contract

protocol-gate reads the `## Milestone States` fenced YAML block (`milestones:` mapping of ID → state). The Milestone Details table is human-readable; the YAML block is the machine-readable source.

## Writing Rules

- One row per plan milestone; IDs must match `/^[A-Za-z0-9][A-Za-z0-9_-]*$/` and be unique within the plan.
- Writers use read-modify-write on the single registry file. Dispatches are serial (one `task` call at a time), so no concurrent writers are expected.
- The registry is the live state SSOT; the PLAN KD remains immutable after approval.
