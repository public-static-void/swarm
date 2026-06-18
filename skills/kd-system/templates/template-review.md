---
title: "REVIEW: {{artifact reviewed}}"
version: 1.0.0
status: draft
type: review
created: {{YYYY-MM-DD}}
author: Inspector
superseded_by: null
---
<!-- Filename: knowledge/review-{{artifact}}-{{YYYY-MM-DD}}.md -->

# REVIEW: {{artifact}}

## Verdict

{{PASS / FAIL}}

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
|------------|-----------|--------|--------|----------|
|            |           |        |        |          |

### Pass Rate (optional)

Overall acceptance criteria pass rate.

- **Passed**: X / Y criteria
- **Percentage**: XX%
- **Blocking failures**: list any ACs that failed with REJECT verdict

## Process Friction

_This section is optional — include only if friction was encountered during work._

| ID | Issue | Severity | Status | Fixed by |
|-----|-------|----------|--------|----------|
| PF-001 | {{description of friction}} | {{low/medium/high}} | {{unresolved/resolved}} | {{agent or PR ref}} |
