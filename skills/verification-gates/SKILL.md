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

| Req ID | Plan Step | Artifact | Test/Check | Status |
|--------|-----------|----------|------------|--------|
| R001   | P001      | `src/auth.ts` | `npm test auth` | PASS / FAIL |
| R002   | P002      | `src/login.tsx` | `npm test login` | PASS / FAIL |
| R003   | P003      | `config/auth.yml` | Lint passes | PASS / FAIL |

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

| Producer                     | Artifact            | Verified By          | Gate Type                       |
| ---------------------------- | ------------------- | -------------------- | ------------------------------- |
| Spec Weaver                  | SPEC KD             | Inspector (Spec)     | REVIEW — requirements quality   |
| Pathfinder                   | PLAN KD             | Inspector (Plan)     | REVIEW — plan feasibility       |
| Artisan                      | Code + IMPL SUMMARY | Inspector (Code)     | REVIEW — implementation quality |
| Artisan (security-sensitive) | Code                | Inspector           | AUDIT — vulnerability scan      |
| Scribe                       | Documentation + KD composition | Overseer            | REVIEW — cross-ref integrity + composition quality |
| ---                          | ---                            | ---                 | --- |

## Gate Checklist

### SPEC Gate (after ALIGN)

- [ ] All requirements numbered (R001, R002, ...)
- [ ] Acceptance criteria are checkboxes, independently verifiable
- [ ] No ambiguous language
- [ ] Active Partner was exercised (pushback on contradictions)
- [ ] Point the Target used (positive framing, no negation)

### PLAN Gate (after DECOMPOSE)

- [ ] Each step maps to a SPEC requirement
- [ ] Steps are the smallest independently verifiable unit
- [ ] Dependency graph is explicit
- [ ] Each step has completion criteria
- [ ] Knowledge Checkpoint committed

### Implementation Gate (after SWARM)

- [ ] Code compiles/runs without errors
- [ ] All acceptance criteria from SPEC addressed
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
4. Each acceptance criterion gets a binary PASS/FAIL — no partial credit
5. Check for orphan code: every artifact must trace to at least one requirement
6. Check for uncovered requirements: every requirement must have a verification entry
7. Findings are terse and actionable (Noise Cancellation)
8. Inspector does NOT suggest fixes (avoids Answer Injection)

## Gate Protocol

1. Inspector receives the artifact and the relevant SPEC + PLAN KDs
2. Inspector iterates through each acceptance criterion
3. For each criterion, record PASS or FAIL with evidence
4. If FAIL, trace to specific requirement (R001, P001, file:line)
5. Produce REVIEW KD
6. On FAIL, return to producer with feedback loop: fix → re-review → repeat until PASS or diminishing returns
7. On stalled progress (2-3 cycles without improvement), escalate to fundamental flaw → Happy to Delete

## Verdicts

| Verdict              | Meaning                        | Next Action                       |
| -------------------- | ------------------------------ | --------------------------------- |
| PASS                 | All criteria met, clean        | Advance to next phase             |
| FAIL (clear cause)   | Specific fixable issues        | Return to producer for fix        |
| FAIL (fundamental)   | Design-level flaw              | Revert (Happy to Delete), re-spec |

## Feedback Loop

On FAIL with clear cause:

1. Producer receives REVIEW KD with specific findings
2. Producer fixes within scope of findings only
3. Producer re-submits with updated artifact
4. Same Inspector re-reviews (consistency)
5. Loop until PASS; abort on diminishing returns (2-3 cycles without progress) → escalate to fundamental flaw

## Security Audits

Run separately from code reviews when:

- Authentication/authorization code changes
- Secrets or credentials are involved
- External dependencies are added
- Database queries change

Security audit uses AUDIT KD type (not REVIEW) to keep concerns separated.
