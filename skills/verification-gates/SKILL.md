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

| Req ID | Plan Step | Artifact          | Test/Check       | Status      |
| ------ | --------- | ----------------- | ---------------- | ----------- |
| R001   | P001      | `src/auth.ts`     | `npm test auth`  | PASS / FAIL |
| R002   | P002      | `src/login.tsx`   | `npm test login` | PASS / FAIL |
| R003   | P003      | `config/auth.yml` | Lint passes      | PASS / FAIL |

### Enforcement Rules

1. **Every acceptance criterion** in the SPEC KD must have at least one PASS or FAIL entry in the traceability matrix
2. **Every code artifact** must trace to at least one requirement — orphan code is a FAIL
3. **Every plan step** must map to at least one requirement — unplanned work is a FAIL
4. If any row in the matrix has **unchecked requirements** (neither PASS nor FAIL), the verdict is REJECT
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
         │ REJECT   │──► Back to producer or Happy to Delete
         └──────────┘
```

## Verification Matrix

| Producer                     | Artifact                       | Verified By      | Gate Type                                          |
| ---------------------------- | ------------------------------ | ---------------- | -------------------------------------------------- |
| Spec Weaver                  | SPEC KD                        | Inspector (Spec) | REVIEW — requirements quality                      |
| Pathfinder                   | PLAN KD                        | Inspector (Plan) | REVIEW — plan feasibility                          |
| Artisan                      | Code + IMPL KD                 | Inspector (Code) | REVIEW — implementation quality                    |
| Artisan (security-sensitive) | Code                           | Inspector        | REVIEW — vulnerability scan (Audit section of the review KD)   |
| ---                          | ---                            | ---              | ---                                                |

## Gate Checklist

### SPEC Gate (after ALIGN)

- [ ] All requirements numbered (R001, R002, ...)
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

### Integration Gate (after INTEGRATE)

- [ ] All parallel branches merged
- [ ] Conflicts resolved
- [ ] Integration tests pass
- [ ] No regressions detected

## Verification Process

1. Inspector reads SPEC (requirements) + PLAN (steps) + artifact
2. Build a **traceability matrix** mapping every acceptance criterion to plan steps and implementation artifacts
3. Each finding traces to a specific requirement (R001, R002, ...) and plan step (P001, P002, ...)
4. Each acceptance criterion receives a binary PASS/FAIL verdict
5. Check for orphan code: every artifact must trace to at least one requirement
6. Check for uncovered requirements: every requirement must have a verification entry
7. Findings are terse and actionable (Noise Cancellation)
8. Inspector reports findings with evidence and severity; all fix implementation is the artisan's responsibility

## Behavior-Based Tests

Tests verify behavior, not wording. Group tests by behavior — one group per behavior, each test covering one meaningful case — and name each test after the behavior it verifies. Test names and comments carry no requirement-ID codes (R/AC/M); the traceability matrix maps acceptance criteria to the test groups that verify them. A suite grows when new behavior appears, not when a requirement count suggests volume, and consolidation of overlapping or stale tests is part of normal maintenance. Static configuration guards are behavior tests when they protect a runtime contract — assert the contract, not the prose that describes it.

## Gate Protocol

1. Inspector receives the artifact and the relevant SPEC + PLAN KDs
2. Inspector iterates through each acceptance criterion
3. For each criterion, record PASS or FAIL with evidence
4. If FAIL, trace to specific requirement (R001, P001, file:line)
5. Write the verdict into the REVIEW KD frontmatter (`verdict: PASS | FAIL | FUNDAMENTAL`) — the single machine source for the VERIFY gate
6. Produce ONE REVIEW KD containing the Review Findings (with traceability matrix) and the Audit section (Scope, Risk Summary, Security Findings)
7. On FAIL, protocol-gate machine-regresses VERIFY→SWARM automatically (no `BACKWARD: true` flag, no explicit dispatch): the producer fixes the findings, re-submits, and the Inspector re-reviews — repeat until PASS or diminishing returns
8. On stalled progress (2-3 cycles without improvement), the Inspector issues a FUNDAMENTAL verdict, which blocks VERIFY advancement and escalates to the user (Happy to Delete)

## Verdicts

| Verdict     | Meaning                 | Machine behavior                                                                          |
| ----------- | ----------------------- | ----------------------------------------------------------------------------------------- |
| PASS        | All criteria met, clean | VERIFY advances to the next phase (presence-based)                                        |
| FAIL        | Specific fixable issues | protocol-gate auto-regresses VERIFY→SWARM and reopens checked-off milestone rows; producer fixes |
| FUNDAMENTAL | Design-level flaw       | protocol-gate blocks VERIFY advancement and escalates to the user; a FUNDAMENTAL verdict leaves the phase at VERIFY — Happy to Delete |

A `FAIL` verdict in the newest review KD frontmatter machine-triggers the VERIFY→SWARM regression (once per KD filename, bounded by the lifecycle cycle cap). Every FAIL finding MUST cite at least one milestone token (`M\d+` or `impl-<id>-`); a FAIL verdict with zero milestone citations is MALFORMED — the gate blocks, regresses nothing, and reopens nothing (re-dispatch the review with citations). A `FUNDAMENTAL` verdict blocks advancement and escalates; the phase stays at VERIFY.

During protocol-gate vitest runs, `FUNDAMENTAL_ESCALATION` lines are asserted test output from the F1 AC104 fixture (`tests/plugins/protocol-gate/index.test.js`). Verify the line against the test source before treating it as a lifecycle anomaly.

## Feedback Loop

On FAIL with clear cause:

1. Producer receives REVIEW KD with specific findings
2. Producer addresses each finding specifically
3. Producer re-submits with updated artifact
4. Same Inspector re-reviews (consistency)
5. Loop until PASS; abort on diminishing returns (2-3 cycles without progress) → escalate to fundamental flaw

## /phase SAFETY_ESCAPE Counter Semantics

The user's `/phase` slash-command override is the escape hatch from a stuck SWARM phase — the automatic safety mechanisms keep the phase at SWARM (protocol-gate logs `SAFETY_ESCAPE` on the escape). Its effect on the redispatch counters (issue-18, R007):

- **Resets per-milestone redispatch budgets.** Escaping SWARM → non-SWARM deletes every non-numeric `{sessionID}:{milestone}` key (e.g. `sid:M1`) in `phaseRedispatchCount`, so an escaped-and-continued lifecycle restarts each milestone with a fresh budget instead of inheriting stale pre-escape caps.
- **Preserves phase counters.** Numeric `{sessionID}:{phase-constant}` keys (e.g. `sid:7` for SWARM) are untouched — the phase's own dispatch count is not reset by the escape.
- **Same-phase override fires nothing.** `/phase SWARM → SWARM` is not an escape (`prevPhase === SWARM && n !== SWARM` is false); budgets and counters are preserved for the no-op override.
- Other `/phase` transitions (into or between non-SWARM phases) leave redispatch counters unchanged.

## Security Audits

Run separately from code reviews when:

- Authentication/authorization code changes
- Secrets or credentials are involved
- External dependencies are added
- Database queries change

Security audit findings land in the `## Audit` section of the review KD (Scope, Risk Summary, Security Findings A001… with Severity/CWE/File/Description/Remediation) — one Inspector pass, one KD, one verdict.
