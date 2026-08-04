---
name: template-review
description: "KD template for creating REVIEW documents. Load this skill, then use the template body as your KD structure reference."
---

---
title: "REVIEW: {{artifact reviewed}}"
version: 1.0.0
status: draft
type: review
session_id: "{{session_id}}"
author: Inspector
superseded_by: null
verdict: {{PASS | FAIL | FUNDAMENTAL}}
---

<!-- Filename: knowledge/review-{{artifact}}-{{session_id}}-gen{{generation}}.md -->
<!-- GENERATION: {{generation}} is the lifecycle counter from protocol-gate state. Each lifecycle's KDs are scoped to its generation (`-genN-` after the session ID) so stale KDs from prior lifecycles are never matched. Use the generation value provided by the dispatcher. -->

# REVIEW: {{artifact}}

## Verdict

{{PASS / FAIL / FUNDAMENTAL}}

The `verdict` frontmatter field above is the machine source — protocol-gate
reads it during VERIFY. `FAIL` auto-regresses VERIFY→SWARM; `FUNDAMENTAL`
blocks advancement and escalates; `PASS` advances.

## Findings

### F001: {{finding title}}

- **Requirement**: {{R001}}
- **Plan Step**: {{P001}}
- **File**: {{path/to/file}}:{{line}}
- **Severity**: {{critical / major / minor}}
- **Status**: {{PASS / FAIL}}
- **Detail**: {{what's wrong and why}}

### F002: ...

### Test Results (optional)

Summarize test execution results relevant to each finding.

| Test Suite | Tests Run | Passed | Failed | Coverage |
| ---------- | --------- | ------ | ------ | -------- |
|            |           |        |        |          |

### Pass Rate (optional)

Overall acceptance criteria pass rate.

- **Passed**: X / Y criteria
- **Percentage**: XX%
- **Blocking failures**: list any ACs that failed with REJECT verdict

## Process Friction

_This section is optional — include only if friction was encountered during work._

| ID     | Issue                       | Severity            | Status                  | Fixed by            |
| ------ | --------------------------- | ------------------- | ----------------------- | ------------------- |
| PF-001 | {{description of friction}} | {{low/medium/high}} | {{unresolved/resolved}} | {{agent or PR ref}} |
