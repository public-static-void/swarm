---
name: template-report
description: "KD template for creating REPORT documents. Load this skill, then use the template body as your KD structure reference."
---

---

title: "REPORT: {{feature name}}"
version: 1.0.0
status: draft
type: report
session_id: "{{session_id}}"
author: Overseer
superseded_by: null
scope: {{project|generic|swarm}}  # optional — omission defaults to swarm
---

<!-- Filename: knowledge/report-{{session}}-{{session_id}}-gen{{generation}}.md -->
<!-- GENERATION: {{generation}} is the lifecycle counter from protocol-gate state. Each lifecycle's KDs are scoped to its generation (`-genN-` after the session ID) so stale KDs from prior lifecycles are never matched. Use the generation value provided by the dispatcher. -->

# REPORT: {{feature}}

## Summary

{{What was built, at a high level}}

## What Changed

- {{File/component}} — {{change description}}

## Acceptance Criteria Status

- {{X}} / {{Y}} PASS
- {{Z}} FAIL (see open items)

## Open Items

- {{Unresolved issues or known limitations}}

## Documentation

- Spec: `knowledge/{{spec-kd-file}}`
- Plan: `knowledge/{{plan-kd-file}}`
- Reviews: `knowledge/{{review-kd-file}}`

## Process Friction

_This section is optional — include it when friction was encountered during work._

| ID     | Issue                       | Severity            | Status                  | Fixed by            |
| ------ | --------------------------- | ------------------- | ----------------------- | ------------------- |
| PF-001 | {{description of friction}} | {{low/medium/high}} | {{unresolved/resolved}} | {{agent or PR ref}} |
