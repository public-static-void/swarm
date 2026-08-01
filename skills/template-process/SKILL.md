---
name: template-process
description: "KD template for creating PROCESS documents. Load this skill, then use the template body as your KD structure reference."
---

---
title: "PROCESS: {{process name}}"
version: 1.0.0
status: draft
type: process
session_id: "{{session_id}}"
author: Habit Builder
superseded_by: null
---

<!-- Filename: knowledge/process-{{pattern}}-{{session_id}}-gen{{generation}}.md -->
<!-- GENERATION: {{generation}} is the lifecycle counter from protocol-gate state. Each lifecycle's KDs are scoped to its generation (`-genN-` after the session ID) so stale KDs from prior lifecycles are never matched. Use the generation value provided by the dispatcher. -->

# PROCESS: {{process name}}

## Trigger

{{What condition starts this process}}

## Steps

1. {{Step 1}} — {{what to do, by whom}}
2. {{Step 2}}
3. {{Step 3}}

## Automation Status

- [ ] **Show**: Process documented
- [ ] **Repeat**: Verified with agent execution
- [ ] **Automate**: Mechanical steps replaced with scripts

## Gotchas

- {{Things that went wrong and how to avoid them}}

## Scripts / Tools

{{Links to decisions, resolution notes, or references related to this process}}

## Process Friction

_This section is optional — include only if friction was encountered during work._

| ID     | Issue                       | Severity            | Status                  | Fixed by            |
| ------ | --------------------------- | ------------------- | ----------------------- | ------------------- |
| PF-001 | {{description of friction}} | {{low/medium/high}} | {{unresolved/resolved}} | {{agent or PR ref}} |
