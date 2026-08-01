---
name: template-composed
description: "KD template for creating COMPOSED documents. Load this skill, then use the template body as your KD structure reference."
---

---
title: "COMPOSED: Context for {{target agent}} — {{task}}"
version: 1.0.0
status: draft
type: composed
session_id: "{{session_id}}"
author: Scribe
superseded_by: null
---

<!-- Filename: knowledge/composed-{{agent}}-{{task}}-{{session_id}}-gen{{generation}}.md -->
<!-- GENERATION: {{generation}} is the lifecycle counter from protocol-gate state. Each lifecycle's KDs are scoped to its generation (`-genN-` after the session ID) so stale KDs from prior lifecycles are never matched. Use the generation value provided by the dispatcher. -->

# COMPOSED: Context for {{target agent}}

## Target

- **Agent**: {{agent name}}
- **Task**: {{task description}}
- **Overseer Reference**: `knowledge/{{intent-kd}}`

## Required Reading

These KDs must be loaded for this task:

- `knowledge/{{spec-kd}}` — Specification with requirements and acceptance criteria
- `knowledge/{{plan-kd}}` — Task plan with steps and dependencies
- `knowledge/{{analysis-kd}}` — (if applicable) Exploration or investigation findings

## Reference Documents

(Load only those relevant to the task domain)

- {{path to skill or reference doc}}
- {{path to style guide or convention doc}}

## Optional Reading

(Not critical but helpful for context)

- `knowledge/{{review-kd}}` — Previous review findings (for fix tasks)
- `knowledge/{{impl-kd}}` — Previous implementation summary (for follow-up tasks)

## Excluded

These are NOT needed for this task:

- {{document}} — {{reason why excluded}}

## Cross-References

- {{Related KD path}}: {{relationship description}}
- {{Related KD path}}: {{relationship description}}

## Process Friction

_This section is optional — include only if friction was encountered during work._

| ID     | Issue                       | Severity            | Status                  | Fixed by            |
| ------ | --------------------------- | ------------------- | ----------------------- | ------------------- |
| PF-001 | {{description of friction}} | {{low/medium/high}} | {{unresolved/resolved}} | {{agent or PR ref}} |
