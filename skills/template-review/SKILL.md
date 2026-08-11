---
name: template-review
description: "KD template for creating REVIEW documents (merged review + audit: the review KD carries both the Review Findings and the Audit sections). Load this skill, then use the template body as your KD structure reference."
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

The `verdict` frontmatter field above is the single machine source — protocol-gate
reads it during VERIFY. `MISSING` (absent or invalid) blocks VERIFY with a
diagnostic and is not treated as PASS; `PASS` advances when this review KD is
newer than the newest `impl-*` KD (fresh PASS after the last fix — a stale PASS
blocks); `FAIL` auto-regresses VERIFY→SWARM and reopens exactly the milestone
row(s) its findings cite; `FUNDAMENTAL` blocks advancement and escalates.

## Verdict Rules (citation mandate — OQ-4)

- Every **FAIL** finding MUST cite at least one milestone token (`M\d+` id like
  `M3`, or an `impl-<milestone-id>-` path like `impl-M3-short-term-store-...`).
  The protocol-gate parses these tokens to reopen exactly the cited milestone
  rows when a FAIL regresses VERIFY→SWARM.
- A FAIL verdict with **zero milestone citations** is **MALFORMED**: the gate
  blocks with a diagnostic, regresses nothing, and reopens nothing. Re-dispatch
  the review with proper citations rather than relying on a citation-less FAIL.

## Review Findings

### F001: {{finding title}}

- **Requirement**: {{R001}}
- **Plan Step**: {{P001}}
- **File**: {{path/to/file}}:{{line}}
- **Severity**: {{critical / major / minor}}
- **Status**: {{PASS / FAIL}}
- **Detail**: {{what's wrong and why}}
- **Milestone citation** (FAIL findings): {{M\d+ or impl-<id>- token}}

### F002: ...

### Traceability Matrix

| Req ID | Plan Step | Artifact          | Test/Check       | Status      |
| ------ | --------- | ----------------- | ---------------- | ----------- |
| R001   | P001      | `src/...`         | `npm test ...`   | PASS / FAIL |
| R002   | P002      | `src/...`         | `npm test ...`   | PASS / FAIL |

## Audit

### Scope

{{What was audited — code, config, dependencies, infrastructure, secrets,
third-party dependency versions, SAST/dependency scan output}}

### Risk Summary

- **Critical**: {{count}}
- **High**: {{count}}
- **Medium**: {{count}}
- **Low**: {{count}}

### Security Findings

### A001: {{vulnerability}}

- **Severity**: {{critical / high / medium / low}}
- **CWE**: {{CWE-ID if applicable}}
- **File**: {{path}}
- **Description**: {{the vulnerability}}
- **Remediation**: {{how to fix}}
- **Milestone citation** (FAIL findings): {{M\d+ or impl-<id>- token}}

### A002: ...

## Test Results (optional)

Summarize test execution results relevant to each finding.

| Test Suite | Tests Run | Passed | Failed | Coverage |
| ---------- | --------- | ------ | ------ | -------- |
|            |           |        |        |          |

## Pass Rate (optional)

Overall acceptance criteria pass rate.

- **Passed**: X / Y criteria
- **Percentage**: XX%
- **Blocking failures**: list any ACs that failed with REJECT verdict

## Process Friction

_This section is optional — include it when friction was encountered during work._

| ID     | Issue                       | Severity            | Status                  | Fixed by            |
| ------ | --------------------------- | ------------------- | ----------------------- | ------------------- |
| PF-001 | {{description of friction}} | {{low/medium/high}} | {{unresolved/resolved}} | {{agent or PR ref}} |
