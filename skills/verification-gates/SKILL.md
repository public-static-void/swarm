---
name: verification-gates
description: "Verification Gate system for the Agentic Swarm. Use when performing reviews, security audits, validation checks, or any quality gate that separates production from inspection."
---

# Verification Gates

## Purpose

This prevents Unvalidated Leaps, catches blind spots (Feedback Flip), and ensures V-Model traceability.

## V-Model Traceability

Every requirement must have a verifiable counterpart in a downstream artifact. Every artifact must trace back to a requirement. This bidirectional traceability prevents untested requirements and orphan code.

### Forward Traceability (left side of V)

Each phase produces artifacts that satisfy upstream requirements:

```
Requirements (SPEC KD) ──► Plan steps (PLAN KD) ──► Implementation (code) ──► Tests
       │                          │                         │                    │
       └──── R001 ───────────────►└──── P001 ──────────────►└──── impl ─────────►└──── test passes
       └──── R002 ───────────────►└──── P002 ──────────────►└──── impl ─────────►└──── test passes
```

### Backward Traceability (right side of V)

Each verification artifact traces back to its source requirement:

```
Tests ──► Implementation ──► Plan step ──► Requirement (SPEC KD)
  │              │                │               │
  └─ test passes ──► impl works ──► P001 done ──►└─ R001 satisfied
```

### Traceability Matrix

Every REVIEW KD must include a traceability matrix like this:

| Req ID | Plan Step | Artifact          | Declared Gate   | Actually-Run Gate | Test/Check       | Status      |
| ------ | --------- | ----------------- | --------------- | ----------------- | ---------------- | ----------- |
| R###   | P###      | `src/auth.ts`     | `npm test auth` | `npm test auth`   | `npm test auth`  | PASS / FAIL |
| R###   | P###      | `src/login.tsx`   | `npm test`      | `npm test`        | `npm test login` | PASS / FAIL |
| R###   | P###      | `config/auth.yml` | `npm test`      | `npm test`        | Lint passes      | PASS / FAIL |

### Enforcement Rules

1. **Every acceptance criterion** in the SPEC KD must have at least one PASS or FAIL entry in the traceability matrix
2. **Every code artifact** must trace to at least one requirement — orphan code is a FAIL
3. **Every plan step** must map to at least one requirement — unplanned work is a FAIL
4. If any row in the matrix has **unchecked requirements** (neither PASS nor FAIL), the verdict is FAIL
5. The Inspector must verify the matrix is complete before issuing a verdict

## Gate Locations

Gate checks occur at these transition points:

```
Phase Output ──► Gate ──► Next Phase
     │                    ▲
     │   ┌──────────┐     │
     └──►│ VERIFY   │─────┘
         │ (PASS)   │
         └──────────┘
              │
         ┌────▼─────┐
         │ FAIL     │──► Back to producer or Happy to Delete
         └──────────┘
```

## Verification Matrix

| Producer                     | Artifact       | Verified By      | Gate Type                                                    |
| ---------------------------- | -------------- | ---------------- | ------------------------------------------------------------ |
| Spec Weaver                  | SPEC KD        | Inspector (Spec) | REVIEW — requirements quality                                |
| Pathfinder                   | PLAN KD        | Inspector (Plan) | REVIEW — plan feasibility                                    |
| Artisan                      | Code + IMPL KD | Inspector (Code) | REVIEW — implementation quality                              |
| Artisan (security-sensitive) | Code           | Inspector        | REVIEW — vulnerability scan (Audit section of the review KD) |
| ---                          | ---            | ---              | ---                                                          |

## Gate Checklist

### SPEC Gate (after ALIGN)

- [ ] All requirements numbered with requirement codes
- [ ] Acceptance criteria are checkboxes, independently verifiable
- [ ] No ambiguous language
- [ ] Active Partner was exercised (pushback on contradictions)
- [ ] Point the Target used — instructions use positive framing exclusively

### PLAN Gate (after DECOMPOSE)

- [ ] Each step maps to a SPEC requirement
- [ ] Steps are the smallest independently verifiable unit
- [ ] Dependency graph is explicit
- [ ] Each step has completion criteria

### Implementation Gate (after SWARM)

- [ ] Code compiles/runs without errors
- [ ] Acceptance criteria verified against implementation behavior — tests grouped per behavior, one group per behavior
- [ ] Tests pass (if tests were specified)
- [ ] Checkpoint commits exist per step
- [ ] IMPLEMENTATION SUMMARY KD documents deviations

## Verification Process

1. Inspector reads SPEC (requirements) + PLAN (steps) + artifact
2. Build a **traceability matrix** mapping every acceptance criterion to plan steps and implementation artifacts
3. Each finding traces to a specific requirement code and plan-step code
4. Each acceptance criterion receives a binary PASS/FAIL verdict
5. Check for orphan code: every artifact must trace to at least one requirement
6. Check for uncovered requirements: every requirement must have a verification entry
7. Findings are terse and actionable (Noise Cancellation)
8. Inspector reports findings with evidence and severity; all fix implementation is the artisan's responsibility

## Behavior-Based Tests

Tests verify behavior, not wording. Group tests by behavior — one group per behavior, each test covering one meaningful case — and name each test after the behavior it verifies. Test names and comments describe behavior, with requirement-ID codes (R/AC/M) and issue-number tokens (`issue-\d+`) living in the traceability matrix. A suite grows when new behavior appears, not when a requirement count suggests volume, and consolidation of overlapping or stale tests is part of normal maintenance. Static configuration guards are behavior tests when they protect a runtime contract — assert the contract, not the prose that describes it. Where the contract is an instruction with no executable surface, pin the smallest sentence that carries it.

## Gate Protocol

1. Inspector receives the artifact and the relevant SPEC + PLAN KDs
2. Inspector iterates through each acceptance criterion
3. For each criterion, record PASS or FAIL with evidence
4. If FAIL, trace to the specific requirement code and plan-step code (code plus file:line)
5. Write the verdict into the REVIEW KD frontmatter (`verdict: PASS | FAIL`) — the single machine source for the VERIFY gate
6. Produce ONE REVIEW KD containing the Review Findings (with traceability matrix) and the Audit section (Scope, Risk Summary, Security Findings)
7. On FAIL, the gate regresses VERIFY→SWARM automatically: the producer fixes the findings, re-submits, and the Inspector re-reviews — repeat until PASS or diminishing returns
8. On stalled progress (2-3 cycles without improvement), the Inspector issues a `FAIL` with no `reopen_target` field and a non-empty `Escalation` section, which blocks VERIFY advancement and escalates through the Overseer to the user (Happy to Delete)

### VERIFY Acceptance Proof

VERIFY produces the lifecycle acceptance proof in exactly one REVIEW KD: the full suite re-run, dependency and SAST scans, and the traceability matrix above carrying declared gate → actually-run gate → Test/Check → PASS/FAIL per row. The frontmatter verdict field carries the single lifecycle acceptance verdict under the `reopen_target` mandate (a FAIL names its checked-off row ids in that field) and the fresh PASS contract (a PASS advances when the review KD is newer than the newest impl KD; a stale PASS blocks pending re-review).

## Verdicts

| Verdict     | Meaning                 | Machine behavior                                                                                                                      |
| ----------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| PASS        | All criteria met, clean | VERIFY advances under the fresh-PASS rule — the review KD must be newer than the newest impl KD; a stale PASS blocks |
| FAIL        | Specific fixable issues | The gate auto-regresses VERIFY→SWARM and reopens checked-off milestone rows; the producer fixes the findings and re-submits |
| FAIL + `Escalation` section | Design-level flaw | The gate blocks VERIFY advancement with `REOPEN_TARGET_INVALID reason=no-reopen-target`, regresses nothing and reopens nothing; the phase stays at VERIFY for a decision that reaches the user through the Overseer — Happy to Delete |

A `FAIL` verdict in the newest review KD frontmatter machine-triggers the VERIFY→SWARM regression (once per KD filename, bounded by the lifecycle cycle cap). Every FAIL names its rows in the frontmatter `reopen_target` field — a list or a scalar of checked-off milestone row ids (`reopen_target: [M3, M7]`). Prose is provenance: the field selects the rows, so milestone-shaped tokens in findings, the traceability matrix or a `References` list stay provenance. A field that is absent, empty, malformed, declared twice, or naming a row the registry does not have is refused with `REOPEN_TARGET_INVALID` and the reason (`no-reopen-target`, `invalid-reopen-target`, `ambiguous-target`, `unresolvable-reopen-target`) — the gate blocks, regresses nothing, and reopens nothing; re-dispatch the review with a usable field. A target naming a row that is not checked-off records `REOPEN_NOOP reason=not-checked-off`, and `PASS` records `REOPEN_TARGET_IGNORED` and reopens nothing.

Escalation marker: a `FAIL` carrying a level-2 section titled `Escalation` with at least one non-empty line before the next level-2 heading escalates instead of requesting a fix. With no `reopen_target` it blocks as `REOPEN_TARGET_INVALID reason=no-reopen-target`; with a usable target it blocks as `VERDICT_AMBIGUOUS` because the review states a fix request and an escalation at once. Neither regresses nor reopens. An empty section counts as absent, a heading inside a fenced code block does not count, and `PASS` ignores the section.

`FUNDAMENTAL_RETIRED` lines in test output are asserted test output. Verify the line against the test source before treating it as a lifecycle anomaly.

## Feedback Loop

On FAIL with clear cause:

1. Producer receives REVIEW KD with specific findings
2. Producer addresses each finding specifically
3. Producer re-submits with updated artifact
4. Same Inspector re-reviews (consistency)
5. Loop until PASS; abort on diminishing returns (2-3 cycles without progress) → escalate to fundamental flaw

## Identical-Verdict Brake

2 consecutive identical gate verdicts on one milestone and session engage the brake, and the manual backward override that follows carries a recorded diagnosis plus an escalation-protocol invocation.

## Security Audits

Run separately from code reviews when:

- Authentication/authorization code changes
- Secrets or credentials are involved
- External dependencies are added
- Database queries change

Security audit findings land in the `## Audit` section of the review KD (Scope, Risk Summary, Security Findings A001… with Severity/CWE/File/Description/Remediation) — one Inspector pass, one KD, one verdict.
