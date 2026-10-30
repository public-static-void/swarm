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
---

<!-- Filename: knowledge/report-{{session}}-{{session_id}}-gen{{generation}}.md -->
<!-- GENERATION: {{generation}} is the lifecycle counter from protocol-gate state. Each lifecycle's KDs are scoped to its generation (`-genN-` after the session ID) so stale KDs from prior lifecycles are never matched. Use the generation value provided by the dispatcher. -->

# REPORT: {{feature}}

<!-- A report is a status delivery: it states what the lifecycle reached and who
produced what, then points at the artifacts. Each row and each pointer comes from
the lifecycle's own state — the phase, the milestone registry, the dispatch
results and the KDs on disk — while the artifacts keep their own detail. -->

## Lifecycle Result

- Phase reached: {{phase name}}
- Milestones: {{total}} total / {{checked-off}} checked off / {{failed}} failed
- Session: `{{session_id}}`
- Generation: {{generation}}

## Agent Outcomes

| Phase | Agent | Outcome | Artifact KD path |
| ----- | ----- | ------- | ---------------- |
| {{phase name}} | {{agent}} | {{succeeded or failed}} | `knowledge/{{artifact-kd-file}}` |

## References

- Composed: `knowledge/{{composed-kd-file}}`
- Review: `knowledge/{{review-kd-file}}`
- Process: `knowledge/{{process-kd-file}}`
- Intent: `knowledge/{{intent-kd-file}}`

## Open Items

- {{Unresolved issues or known limitations}}

## Process Friction

_This section is optional — include it when friction was encountered during work._

| ID     | Issue                       | Severity            | Status                  | Fixed by            |
| ------ | --------------------------- | ------------------- | ----------------------- | ------------------- |
| PF-001 | {{description of friction}} | {{low/medium/high}} | {{unresolved/resolved}} | {{agent or PR ref}} |
