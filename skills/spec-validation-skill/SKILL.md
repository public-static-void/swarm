---
name: spec-validation-skill
description: Specification validation and requirements analysis skill covering requirement coverage, ambiguity detection, testability verification, interface completeness, and acceptance criteria quality — trigger on: spec validation, requirements check, acceptance criteria, specification review.
---

# Spec Validation Skill

## OVERVIEW

This skill provides a systematic methodology for validating software specifications before implementation begins. It covers requirement coverage analysis (functional vs non-functional completeness, edge case coverage), ambiguity detection (vague language identification, contradictory requirements, missing constraints), testability verification (acceptance criteria measurability), interface completeness checks (endpoints, events, payloads, responses), and acceptance criteria quality assessment (clear pass/fail conditions, elimination of subjective language). The scope is limited to specification-level analysis; it does not validate implementation code or execute tests.

## CONVENTIONS

- Detect the project's existing specification format (user stories, use cases, PRDs, technical specs) before applying validation rules.
- Treat the specification as a contract between stakeholders and implementers; every statement must be unambiguous and verifiable.
- Apply the INVEST criteria for user stories: Independent, Negotiable, Valuable, Estimable, Small, Testable.
- Classify requirements into functional (what the system does) and non-functional (how well the system does it) categories for separate coverage analysis.
- Use Given/When/Then (Gherkin-style) structure as the reference format for acceptance criteria when the project does not define its own convention.

## CHECKLIST

- [ ] **Functional Requirement Coverage**: Verify every user-facing feature described in the specification has a corresponding, detailed requirement. Check that each requirement defines: trigger condition, system behavior, output or result, and affected data. Flag features mentioned in overview or context sections but lacking formal requirements.
- [ ] **Non-Functional Requirement Coverage**: Verify the specification addresses performance (response times, throughput, concurrency), security (authentication, authorization, data protection), reliability (availability targets, error recovery), scalability (growth expectations, horizontal or vertical scaling strategy), usability (accessibility standards, response time thresholds), and maintainability (logging, monitoring, configuration management). Flag missing non-functional categories as gaps.
- [ ] **Edge Case Coverage**: For each functional requirement, verify that the specification addresses: empty or null inputs, boundary values (min, max, zero, negative), concurrent access scenarios, error conditions (network failures, timeout, invalid state transitions), and data volume extremes (single record vs bulk operations). Flag requirements that only describe the happy path without edge case handling.
- [ ] **Ambiguity — Vague Language Detection**: Scan for subjective or imprecise terms that create implementation uncertainty: "fast," "user-friendly," "robust," "approximately," "should ideally," "as needed," "reasonable," "quickly." Flag each instance and require replacement with measurable criteria (e.g., "response time < 200ms" instead of "fast").
- [ ] **Ambiguity — Contradictory Requirements**: Cross-reference all requirements for logical contradictions. Detect cases where Requirement A mandates behavior X while Requirement B mandates behavior Y under overlapping conditions. Flag conflicts with both requirement references and the specific contradiction. Verify that exception clauses do not silently override base requirements without explicit priority rules.
- [ ] **Ambiguity — Missing Constraints**: Identify requirements that lack necessary constraints for correct implementation: data format specifications (JSON schema, date formats, character encoding), rate limits, pagination rules, idempotency requirements, retry policies, timeout values, and error response formats. Flag unconstrained requirements as incomplete.
- [ ] **Testability — Measurable Acceptance Criteria**: Verify every acceptance criterion can be evaluated as pass or fail without subjective interpretation. Criteria must reference observable system behavior (API responses, database state, UI rendering, log output) rather than internal implementation details. Flag criteria that require human judgment to evaluate (e.g., "the UI looks correct," "performance is acceptable").
- [ ] **Testability — Verifiable Conditions**: Confirm each acceptance criterion specifies: the test precondition (system state before the action), the action or stimulus, and the expected observable outcome. Criteria missing any of these three components are incomplete and must be flagged for revision. Verify that negative test cases (error conditions, invalid inputs) have corresponding acceptance criteria.
- [ ] **Interface Completeness — Endpoint or Event Definitions**: For API specifications, verify every endpoint defines: HTTP method, path template, authentication requirement, request headers, request body schema (with required and optional fields, types, constraints), all possible response status codes with their response body schemas, and error response format. For event-driven systems, verify every event defines: event name, trigger condition, payload schema, delivery guarantees, and consumer expectations. Flag partially defined interfaces.
- [ ] **Interface Completeness — Payload and Response Definitions**: Verify every data structure referenced in the specification is fully defined with field names, types, constraints (min or max length, pattern, enum values), nullability, and examples. Check that response schemas cover success, partial success, and error cases. Flag references to undefined types or inline schemas that duplicate existing type definitions inconsistently.
- [ ] **Acceptance Criteria Quality — Clear Pass/Fail Conditions**: Verify each acceptance criterion has a single, unambiguous condition that determines pass or fail. Split compound criteria (connected by "and" with independent conditions) into separate criteria for granular tracking. Flag criteria with multiple independent conditions as they obscure which specific aspect failed during verification.
- [ ] **Acceptance Criteria Quality — No Subjective Language**: Scan acceptance criteria for subjective qualifiers: "should," "might," "could," "preferably," "approximately," "roughly," "etc.," "and so on." Replace with definitive language: "must," "shall," "will," exact values, or explicit ranges. Flag any remaining subjective language as a quality defect.
- [ ] **Traceability — Requirement-to-Criteria Mapping**: Verify every requirement has at least one corresponding acceptance criterion. Verify every acceptance criterion traces back to a specific requirement. Flag orphaned criteria (no linked requirement) and uncovered requirements (no linked criteria) as traceability gaps.
- [ ] **Consistency — Terminology and Naming**: Verify consistent use of domain terms throughout the specification. Detect cases where the same concept is referred to by different names (e.g., "user ID" vs "userId" vs "customer identifier") or different concepts share the same name. Flag terminology inconsistencies that could cause implementation errors.
- [ ] **Completeness — State Transitions and Lifecycle**: For entities with defined lifecycles, verify the specification documents all valid states, all allowed state transitions, the conditions triggering each transition, and the system behavior during each transition. Flag missing states or undocumented transitions that could lead to invalid entity states at runtime.

## PATTERNS

### Requirement Coverage Matrix

Map requirements against coverage dimensions to identify gaps:
`| Req ID | Description          | Functional | Non-Functional | Edge Cases | Acceptance Criteria | Traceable |
|--------|----------------------|------------|----------------|------------|---------------------|-----------|
| R-001  | User registration    | Yes        | Yes (perf, sec)| Yes        | Yes (3 criteria)    | Yes       |
| R-002  | Password reset       | Yes        | No             | Partial    | Yes (2 criteria)    | Yes       |
| R-003  | Data export          | Yes        | No             | No         | No                  | No        |`
Any column with "No" indicates a validation gap requiring specification revision.

### Ambiguity Detection Pattern

Classify ambiguous language into categories for targeted remediation:
`
VAGUE ADJECTIVE: "The system should be fast"
-> Replace with: "API response time must be <= 200ms at p95 under 1000 concurrent users"

OPEN-ENDED SCOPE: "Handle errors appropriately"
-> Replace with: "Return HTTP 422 with JSON body {code, message, details} for validation errors; log and return HTTP 500 for unhandled exceptions"

IMPLIED CONSTRAINT: "Support large datasets"
-> Replace with: "Export operations must handle datasets up to 10 million records without timeout (30-minute maximum duration)"

CONTRADICTION: R-010: "Delete is permanent and irreversible"
R-015: "Deleted items can be restored within 30 days"
-> Resolve by: Defining soft-delete vs hard-delete operations with distinct endpoints and behaviors
`

### Testable Acceptance Criteria Pattern (Given/When/Then)

Structure acceptance criteria for unambiguous verification:
`
Scenario: Successful user registration
Given a user provides valid email, password meeting complexity requirements, and confirmed password
When the user submits the registration form
Then the system creates a new user record with status "pending_verification"
And the system sends a verification email to the provided address
And the API returns HTTP 201 with the user object (excluding password hash)

Scenario: Registration with duplicate email
Given a user account already exists with email "test@example.com"
When a registration request is submitted with email "test@example.com"
Then the API returns HTTP 409 Conflict
And the response body contains error code "EMAIL_ALREADY_REGISTERED"
And no new user record is created
`

### Interface Completeness Checklist Pattern

Validate each API endpoint against a completeness template:
`Endpoint: POST /api/v1/users
  [ ] Method defined (POST)
  [ ] Path template defined (/api/v1/users)
  [ ] Authentication requirement specified (Bearer token, admin role)
  [ ] Request headers documented (Content-Type: application/json)
  [ ] Request body schema defined with field types, constraints, required and optional flags
  [ ] Success response: HTTP 201, schema defined, example provided
  [ ] Error responses: HTTP 400 (validation), 401 (unauthorized), 409 (conflict), 500 (server error) — each with schema
  [ ] Rate limit documented (e.g., 100 requests per minute)
  [ ] Idempotency behavior specified (not idempotent for POST; use PUT /users/{id} for idempotent updates)`

## CONSTRAINTS

- Do NOT modify the specification during validation. Report findings, gaps, and recommendations separately; specification revision is the author's responsibility.
- Do NOT validate implementation details or architectural decisions within requirements. This skill validates specification quality: completeness, clarity, testability, and consistency — not technical correctness of proposed solutions.
- Do NOT flag requirements as ambiguous solely because they allow implementation flexibility. Distinguish between intentional flexibility ("the system shall use a caching strategy") and genuine ambiguity ("the system should handle caching well").
- Do NOT require acceptance criteria for out-of-scope items explicitly excluded by the specification. Validate that exclusions are clearly stated, then skip coverage checks for those areas.
- Do NOT assume domain knowledge not documented in the specification. If a term or concept is undefined, flag it as a terminology gap rather than inferring meaning from context.
- Do NOT treat examples as specifications. Examples illustrate requirements but do not replace formal definitions. Flag cases where behavior is defined only by example without a corresponding general rule.
