---
name: code-review-skill
description: Code review skill covering review criteria checklist, V-Model traceability verification, architecture alignment validation, convention compliance checking, and documentation completeness assessment. Trigger on: review, code review, quality gate, traceability.
---

# Code Review Skill

## OVERVIEW

Covers systematic code review processes including review criteria evaluation, V-Model requirement-to-implementation traceability, architectural pattern alignment verification, project convention compliance checking, and documentation completeness assessment. Scope is bounded to reviewing existing code changes for correctness, quality, and alignment; does not cover writing new code, performance profiling, or security penetration testing (though security concerns are flagged).

## CONVENTIONS

- Reviews follow a structured checklist approach rather than ad-hoc inspection. Every review evaluates the same categories consistently.
- V-Model traceability: every implementation change must be traceable to a requirement, user story, or bug report. Orphaned code without a traced origin is flagged for justification.
- Architecture alignment: changes must conform to the project's established architectural patterns (layering, module boundaries, dependency direction). Violations require explicit justification and architectural review approval.
- Convention compliance: code must follow the project's established conventions for naming, formatting, error handling, logging, and testing. Deviations are flagged unless they improve clarity or correctness.
- Documentation completeness: changes affecting public APIs, configuration, or user-facing behavior must include corresponding documentation updates (API docs, README, inline comments for non-trivial logic).
- Review comments distinguish between blocking issues (must fix before merge) and suggestions (improvements that can be addressed later). Blocking issues are clearly marked.

## CHECKLIST

### Correctness and Completeness

- [ ] Implementation satisfies all acceptance criteria from the associated requirement or ticket
- [ ] Edge cases and error conditions are handled, not just the happy path
- [ ] No partially implemented features, TODO placeholders, or commented-out code blocks
- [ ] All new dependencies are justified and added to the project dependency manifest

### Architecture Alignment

- [ ] Changes follow established layering (controller -> service -> repository) without cross-layer coupling
- [ ] Module boundaries respected — no circular dependencies introduced
- [ ] Dependency injection used where applicable — no hardcoded service instantiation
- [ ] New abstractions are justified by actual variation points, not hypothetical future needs

### Convention Compliance

- [ ] Naming follows project conventions (variables, functions, classes, files, directories)
- [ ] Error handling follows project pattern (consistent error types, propagation strategy)
- [ ] Logging follows structured format with appropriate levels (debug, info, warn, error)
- [ ] Code formatting matches project linter/formatter configuration

### Testing and Traceability

- [ ] New code has corresponding tests at the appropriate level (unit for logic, integration for boundaries)
- [ ] Tests cover happy path, edge cases, and error conditions
- [ ] V-Model traceability: every change links to a requirement, story, or bug report
- [ ] Test names describe behavior, not implementation

### Documentation

- [ ] Public API changes documented in API specification or OpenAPI/Swagger definitions
- [ ] Configuration changes documented with defaults, valid values, and effects
- [ ] Non-trivial logic has inline comments explaining the rationale (why), not the mechanics (what)
- [ ] Breaking changes include migration guide or deprecation notice

### Security and Performance

- [ ] No hardcoded secrets, credentials, or API keys
- [ ] Input validation applied at all external boundaries
- [ ] No obvious performance anti-patterns (N+1 queries, unbounded loops, missing indexes)
- [ ] Sensitive data handled appropriately (masked in logs, encrypted at rest if PII)

## PATTERNS

### Structured Review Comment Format

Review comments follow a consistent format: location -> issue type -> description -> recommendation.

```
📍 File: src/services/order.ts, Line 45
🚫 Blocking: Missing input validation
💬 The `quantity` parameter is used in arithmetic without validation. Negative or zero values will produce incorrect totals.
✅ Recommendation: Add validation at the service boundary: if (quantity <= 0) throw new ValidationError('Quantity must be positive');
```

### V-Model Traceability

See verification-gates skill for V-Model traceability matrix format.

### Review Decision Framework

Classify findings into three categories to guide resolution priority.

| Category   | Symbol | Action                             | Example                                      |
| ---------- | ------ | ---------------------------------- | -------------------------------------------- |
| Blocking   | 🚫     | Must fix before merge              | Security vulnerability, broken functionality |
| Suggestion | 💡     | Fix if feasible, no block          | Naming improvement, minor refactoring        |
| Question   | ❓     | Clarify intent, no change required | Unfamiliar pattern — request explanation     |

### Architecture Decision Documentation

When changes deviate from established patterns, document the rationale.

```markdown
## ADR-012: Direct Database Access in Reporting Module

**Context**: The reporting module requires complex aggregations that the ORM cannot express efficiently.
**Decision**: Allow raw SQL queries within the ReportingRepository implementation only.
**Consequences**: Bypasses ORM abstraction for this module. Requires manual index management and migration coordination.
```

## CONSTRAINTS

- Do not approve code changes that have blocking issues unresolved — the merge gate is non-negotiable.
- Do not introduce new conventions during review — evaluate against existing project standards only.
- Do not request changes for stylistic preferences that are not codified in project conventions.
- Do not approve changes without corresponding tests for new or modified business logic.
- Do not overlook traceability — code without a linked requirement, story, or bug report must be justified.
- Do not perform security penetration testing as part of code review — flag suspicious patterns and escalate to the security-audit-skill.
- Do not approve changes that introduce circular dependencies between modules or layers.
