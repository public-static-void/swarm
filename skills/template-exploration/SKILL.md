---
name: template-exploration
description: "KD template for creating EXPLORATION documents. Load this skill, then use the template body as your KD structure reference."
---

---

title: "EXPLORATION: {{topic explored}}"
version: 1.0.0
status: draft
type: exploration
session_id: "{{session_id}}"
author: Explorer
superseded_by: null
---

<!-- Filename: knowledge/exploration-{{topic}}-{{session_id}}-gen{{generation}}.md -->
<!-- GENERATION: {{generation}} is the lifecycle counter from protocol-gate state. Each lifecycle's KDs are scoped to its generation (`-genN-` after the session ID) so stale KDs from prior lifecycles are never matched. Use the generation value provided by the dispatcher. -->

# EXPLORATION: {{topic}}

## Overview

{{Brief description of the purpose and scope of this exploration}}

## Scope

{{Boundaries of what was explored — components, directories, domains included and excluded}}

## Landscape

{{Codebase structure, technologies detected, architecture overview, entry points}}

## Key Files

- {{Path and purpose of key file 1}}
- {{Path and purpose of key file 2}}

## Key Findings

- {{Key finding 1}}
- {{Key finding 2}}

Completeness gate: every INTENT issue has at least one finding entry in the exploration inventory — re-explore until coverage holds.

## Map / Structure

{{Dependency graph, data flow, module relationships, or directory tree}}

## Risks / Unknowns

- {{Risk or uncertainty found during exploration}}
- {{Missing information that affects downstream decisions}}

## Recommendations

{{Suggested next steps, areas needing deeper investigation, or recommended approach}}

## Process Friction

_This section is optional — include it when friction was encountered during work._

| ID     | Issue                       | Severity            | Status                  | Fixed by            |
| ------ | --------------------------- | ------------------- | ----------------------- | ------------------- |
| PF-001 | {{description of friction}} | {{low/medium/high}} | {{unresolved/resolved}} | {{agent or PR ref}} |

## References

- {{Link to code, docs, or other resources}}
