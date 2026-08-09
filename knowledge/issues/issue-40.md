---
id: 40
title: "Milestone registry human-readable table drifts from machine YAML state — rows stay 'pending' after check-off"
severity: low
status: resolved
created: 2026-08-09
session: ses_01dc82bf9ffen46jTRrKJRAOkS
assigned_to: protocol-gate milestone-registry owners (Pathfinder + protocol-gate)
tags: [process, milestones, registry, state, lifecycle]
---

# Issue 40: Milestone registry human-readable table drifts from machine YAML state

## Description

The Milestone Details table in the milestone registry (`knowledge/milestones-*.md`) lists every row `pending` with blank artisan/timestamps while the `## Milestone States` YAML block correctly shows M1–M5 `checked-off`. Observed in the overseer-issue-audit lifecycle (REVIEW M1 Minor; COMPOSED PF-004).

Root cause: the Parsing Contract designates the YAML block as the machine-readable source that protocol-gate reads; the human-readable table is never updated by the gate, so it silently drifts after every check-off. Gating is unaffected (the gate reads the YAML), but any human (or agent) reading the table for status gets a false "pending" picture.

Severity: low — cosmetic; no gating impact (REVIEW: "Cosmetic; no action required").

## Source KD Reference

- `knowledge/report-overseer-issue-audit-ses_01dc82bf9ffen46jTRrKJRAOkS-gen0.md` — durable substitute for the deleted overseer-issue-audit lifecycle KDs (original REVIEW/COMPOSED/MILESTONES/PROCESS gen0 KDs removed by lifecycle-end cleanup — the issue-41 rot pattern): its Process Friction F-04 records the milestone-registry table/YAML drift observation that created this issue.

## Recommended Fix

Keep the human-readable Milestone Details table in sync with the machine YAML block at check-off time — either:

- Option A: protocol-gate (or the Pathfinder registry writer) updates the table rows (State, Assigned Artisan, Dispatched At, Checked Off At) when it updates the YAML block; or
- Option B: drop the Milestone Details table entirely and rely on the YAML block as the single source (the Parsing Contract already treats it as such), removing the misleading surface.

## Acceptance Criteria

- No future milestone registry shows a human-readable table contradicting the machine YAML state (rows `pending` for milestones the YAML marks `checked-off`).
- The registry has exactly one status surface (either a synced table or the YAML-only source).

## Resolution (2026-08-09)

Closed as **resolved** — Option B implemented per SPEC R004 (milestone M3): `skills/template-milestones/SKILL.md` no longer contains the `## Milestone Details` human-readable table; the `## Milestone States` YAML block is the single status surface for machine and human readers. The template edit is the durable evidence (a committed file path that survives lifecycle-end cleanup):

- **Table removed**: the `## Milestone Details` table (previously template lines 31–36) is deleted from the template body, so no future registry instantiation can show a human table contradicting the machine YAML.
- **Parsing Contract updated**: the clause "The Milestone Details table is human-readable; the YAML block is the machine-readable source" is replaced with "The YAML block is the single status surface for machine and human readers" — exactly one status surface, per this issue's acceptance criteria.
- **Historical registry cleaned**: the stale `## Milestone Details` table in `knowledge/milestones-milestone-tracking-ses_047b8d61fffeVDL344LPyCj53t-gen0.md` (finished milestone-tracking lifecycle) was stripped and its Parsing Contract aligned to the same single-surface wording.
- **This lifecycle's registry** (`knowledge/milestones-restart-resume-fixes-ses_01dc82bf9ffen46jTRrKJRAOkS-gen1.md`) was written without the table from the start (plan RA-3), so it already matches the post-fix template.

Root-cause loop closed: `updateMilestoneRegistry` (plugins/protocol-gate/index.js:442-478) rewrites only the YAML block; with the human table gone from the template, there is no second surface left to drift. Both acceptance criteria are met — no future registry shows a contradictory human table, and the registry has exactly one status surface (the YAML-only source).

Source KD References repointed to the durable substitute `knowledge/report-overseer-issue-audit-ses_01dc82bf9ffen46jTRrKJRAOkS-gen0.md` (the gen0 REVIEW/COMPOSED/MILESTONES/PROCESS KDs were removed by lifecycle-end cleanup — the issue-41 rot pattern). That report's Process Friction F-04 records the table-drift observation and cites this issue as the fix.
