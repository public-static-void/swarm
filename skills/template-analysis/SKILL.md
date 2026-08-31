---
name: template-analysis
description: "KD template for creating ANALYSIS documents. Load this skill, then use the template body as your KD structure reference."
---

---

title: "ANALYSIS: {{topic investigated}}"
version: 1.0.0
status: draft
type: analysis
session_id: "{{session_id}}"
author: Explorer/Analyzer
superseded_by: null
scope: {{project|generic|swarm}}  # optional — omission defaults to swarm
---

<!-- Filename: knowledge/analysis-{{topic}}-{{session_id}}-gen{{generation}}.md -->
<!-- GENERATION: {{generation}} is the lifecycle counter from protocol-gate state. Each lifecycle's KDs are scoped to its generation (`-genN-` after the session ID) so stale KDs from prior lifecycles are never matched. Use the generation value provided by the dispatcher. -->

# ANALYSIS: {{topic}}

## Landscape

{{Codebase structure, technologies, entry points}}

## Findings

- {{Key finding 1}}
- {{Key finding 2}}

## Risks & Unknowns

- {{Risk or unknown}}

## Recommendations

{{What approach is recommended and why}}

## Process Friction

_This section is optional — include it when friction was encountered during work._

| ID     | Issue                       | Severity            | Status                  | Fixed by            |
| ------ | --------------------------- | ------------------- | ----------------------- | ------------------- |
| PF-001 | {{description of friction}} | {{low/medium/high}} | {{unresolved/resolved}} | {{agent or PR ref}} |

## References

- {{Link to code, docs, or other resources}}
