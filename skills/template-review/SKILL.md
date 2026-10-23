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
verdict: {{PASS | FAIL}}
reopen_target: {{[M3, M7] — REQUIRED on FAIL, omitted on PASS}}
---

<!-- Filename: knowledge/review-{{artifact}}-{{session_id}}-gen{{generation}}.md -->
<!-- GENERATION: {{generation}} is the lifecycle counter from protocol-gate state. Each lifecycle's KDs are scoped to its generation (`-genN-` after the session ID) so stale KDs from prior lifecycles are never matched. Use the generation value provided by the dispatcher. -->

# REVIEW: {{artifact}}

## Verdict

{{PASS / FAIL}}

The `verdict` frontmatter field above is the single machine source — protocol-gate
reads it during VERIFY, and the REVIEW KD carries the lifecycle acceptance proof (full suite re-run, dependency and SAST scans, traceability matrix). `MISSING` (absent or invalid) blocks VERIFY with a
diagnostic and is not treated as PASS; `PASS` advances when this review KD is
newer than the newest `impl-*` KD (fresh PASS after the last fix — a stale PASS
blocks); `FAIL` auto-regresses VERIFY→SWARM and reopens the milestone rows named
by the `reopen_target` field.

**Escalation.** To block advancement and escalate a design-level failure instead of
requesting a fix, issue `FAIL` with no `reopen_target` field and add a level-2
section titled `Escalation` carrying at least one non-empty line before the next
level-2 heading. That section is the escalation: the gate blocks with
`REOPEN_TARGET_INVALID reason=no-reopen-target`, regresses nothing, and reopens
nothing, leaving the phase at VERIFY for a user decision. A `FAIL` that both names
targets and carries the section is `VERDICT_AMBIGUOUS` and blocks. An empty section
counts as absent, and `PASS` ignores the section.

## Verdict Rules (reopen_target mandate)

- A **FAIL** MUST carry `reopen_target` in the frontmatter, naming the checked-off
  milestone row ids the fix must redo — a list (`reopen_target: [M3, M7]`) or a
  single id (`reopen_target: M3`). The protocol-gate reads that field to reopen
  rows when a FAIL regresses VERIFY→SWARM.
- Prose is provenance: the field selects the rows. Milestone-shaped tokens in
  findings, the traceability matrix or a `References` list stay provenance, so
  name the rows under repair in the field.
- A field that is absent, empty, malformed, declared twice, or naming a row the
  registry does not have is **refused**: the gate blocks with
  `REOPEN_TARGET_INVALID` carrying `no-reopen-target`, `invalid-reopen-target`,
  `ambiguous-target` or `unresolvable-reopen-target`, regresses nothing and
  reopens nothing. Re-issue the review with a usable field rather than relying on
  the refusal.
- A target naming a row that is not checked-off reopens nothing and is recorded as
  `REOPEN_NOOP reason=not-checked-off`.
- `PASS` ignores the field: a field on a PASS is recorded as `REOPEN_TARGET_IGNORED`
  and changes no state.

## Review Findings

### F001: {{finding title}}

- **Requirement**: {{R001}}
- **Plan Step**: {{P001}}
- **File**: {{path/to/file}}:{{line}}
- **Severity**: {{critical / major / minor}}
- **Status**: {{PASS / FAIL}}
- **Detail**: {{what's wrong and why}}
- **Milestone** (provenance — the gate reads `reopen_target`, not this line): {{M\d+ id}}

### F002: {{finding title}}

### Traceability Matrix

| Req ID | Plan Step | Artifact  | Declared Gate | Actually-Run Gate | Test/Check     | Status      |
| ------ | --------- | --------- | ------------- | ----------------- | -------------- | ----------- |
| R###   | P###      | `src/...` | `npm test`    | `npm test`        | `npm test ...` | PASS / FAIL |
| R###   | P###      | `src/...` | `npm test`    | `npm test`        | `npm test ...` | PASS / FAIL |

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
- **Milestone** (provenance — the gate reads `reopen_target`, not this line): {{M\d+ id}}

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
- **Blocking failures**: list any ACs that failed with FAIL verdict

## Process Friction

_This section is optional — include it when friction was encountered during work._

| ID     | Issue                       | Severity            | Status                  | Fixed by            |
| ------ | --------------------------- | ------------------- | ----------------------- | ------------------- |
| PF-001 | {{description of friction}} | {{low/medium/high}} | {{unresolved/resolved}} | {{agent or PR ref}} |
