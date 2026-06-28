---
name: code-review-skill
description: Code review skill covering review criteria checklist, V-Model traceability verification, architecture alignment validation, convention compliance checking, and documentation completeness assessment. Trigger on: review, code review, quality gate, traceability.
---

# Code Review Skill

## OVERVIEW

Covers systematic code review processes including review criteria evaluation, V-Model requirement-to-implementation traceability, architectural pattern alignment verification, project convention compliance checking, and documentation completeness assessment. Scope covers reviewing existing code changes for correctness, quality, and alignment. Security concerns are flagged during review.

## CONVENTIONS

- Reviews follow a structured checklist approach; every review evaluates the same categories consistently.
- Require every implementation change to trace to a requirement, user story, or bug report.
- Architecture alignment: changes must conform to the project's established architectural patterns (layering, module boundaries, dependency direction). Violations require explicit justification and architectural review approval.
- Convention compliance: code must follow the project's established conventions for naming, formatting, error handling, logging, and testing. Flag deviations; approve only those that improve clarity or correctness.
- Documentation completeness: changes affecting public APIs, configuration, or user-facing behavior must include corresponding documentation updates (API docs, README, inline comments for non-trivial logic).
- Review comments distinguish between blocking issues (must fix before merge) and suggestions (improvements that can be addressed later). Blocking issues are clearly marked.

## CHECKLIST

### Correctness and Completeness

- [ ] Implementation satisfies all acceptance criteria from the associated requirement or ticket
- [ ] Edge cases and error conditions are handled, including the happy path and edge cases
- [ ] No partially implemented features, TODO placeholders, or commented-out code blocks
- [ ] All new dependencies are justified and added to the project dependency manifest

### Architecture Alignment

- [ ] Changes follow established layering (controller -> service -> repository) without cross-layer coupling
- [ ] Module boundaries respected — circular dependencies are absent
- [ ] Dependency injection used consistently
- [ ] New abstractions justified by actual variation points

### Convention Compliance

- [ ] Naming follows project conventions (variables, functions, classes, files, directories)
- [ ] Error handling follows project pattern (consistent error types, propagation strategy)
- [ ] Logging follows structured format with appropriate levels (debug, info, warn, error)
- [ ] Code formatting matches project linter/formatter configuration

### Testing and Traceability

- [ ] New code has corresponding tests at the appropriate level (unit for logic, integration for boundaries)
- [ ] Tests cover happy path, edge cases, and error conditions
- [ ] V-Model traceability: every change links to a requirement, story, or bug report
- [ ] Test names describe the behavior under test

### Documentation

- [ ] Public API changes documented in API specification or OpenAPI/Swagger definitions
- [ ] Configuration changes documented with defaults, valid values, and effects
- [ ] Non-trivial logic has inline comments explaining the rationale (why); the code itself documents the mechanics (what)
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
| Suggestion | 💡     | Fix if feasible; does not block merge          | Naming improvement, minor refactoring        |
| Question   | ❓     | Clarify intent; change is optional | Unfamiliar pattern — request explanation     |

### Architecture Decision Documentation

When changes deviate from established patterns, document the rationale.

```markdown
## ADR-012: Direct Database Access in Reporting Module

**Context**: The reporting module requires complex aggregations beyond the ORM's efficient expression capability.
**Decision**: Allow raw SQL queries within the ReportingRepository implementation only.
**Consequences**: Bypasses ORM abstraction for this module. Requires manual index management and migration coordination.
```

## CONSTRAINTS

- Approve code changes only after all blocking issues are resolved.
- Evaluate code changes against existing project conventions only.
- Request changes only for violations of codified project conventions.
- Approve changes only when new business logic includes corresponding tests.
- Verify traceability for every change.
- Flag suspicious security patterns during review and escalate to security-audit-skill.
- Approve changes that maintain acyclic dependency graphs.
