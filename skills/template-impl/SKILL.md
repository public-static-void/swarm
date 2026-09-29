---
name: template-impl
description: "KD template for creating IMPLEMENTATION SUMMARY documents. Load this skill, then use the template body as your KD structure reference."
---

---

title: "IMPLEMENTATION SUMMARY: {{feature name}} — {{step reference}}"
version: 1.0.0
status: draft
type: impl
session_id: "{{session_id}}"
author: Artisan
superseded_by: null
---

<!-- Filename: knowledge/impl-{{step}}-{{session_id}}-gen{{generation}}.md -->
<!-- GENERATION: {{generation}} is the lifecycle counter from protocol-gate state. Each lifecycle's KDs are scoped to its generation (`-genN-` after the session ID) so stale KDs from prior lifecycles are never matched. Use the generation value provided by the dispatcher. -->

# IMPLEMENTATION SUMMARY: {{feature}}

## What Was Built

{{Summary of code changes}}

## Files Changed

- `{{path/to/file}}` — {{reason for change}}

## Deviations from Plan

- {{Any deviation from SPEC or PLAN, with rationale}}

## Verification Notes

tests touched: {{suite files created or extended for this milestone behavior}}
handoff:
  touched surface: {{files and behaviors this milestone changed}}
  compile-level status: {{targeted check run and status for that surface}}
  declared gate: {{project-declared command plus manifest source path}}
  attempted alternatives: {{what was tried when the declared gate could not run, or n/a — gate ran as declared}}
  actually-run gate: {{executed command plus green run status}}
  run status: {{PASS | FAIL | NOT-RUN}}
  full-gate status: {{green run precondition for Committer dispatch}}

Docs-only milestones (zero behavior files changed) write zero tests and carry both lines:

tests touched: {{unchanged}}
no behavior change, suite untouched
handoff:
  touched surface: {{docs files this milestone changed}}
  compile-level status: {{targeted check run and status for that surface}}
  declared gate: {{project-declared command plus manifest source path}}
  attempted alternatives: {{what was tried when the declared gate could not run, or n/a — gate ran as declared}}
  actually-run gate: {{executed command plus green run status}}
  run status: {{PASS | FAIL | NOT-RUN}}
  full-gate status: {{green run precondition for Committer dispatch}}

## Process Friction

_This section is optional — include it when friction was encountered during work._

| ID     | Issue                       | Severity            | Status                  | Fixed by            |
| ------ | --------------------------- | ------------------- | ----------------------- | ------------------- |
| PF-001 | {{description of friction}} | {{low/medium/high}} | {{unresolved/resolved}} | {{agent or PR ref}} |

## KD Supersession Convention

When superseding an impl KD, write the new canonical file FIRST, then rename the old one to `.superseded.md`. The canonical path stays occupied, so the SWARM→VERIFY gate does not stall on a missing impl KD. Remove the old file after the new one is committed to disk.
