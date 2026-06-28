---
name: plan-validation-skill
description: "Plan validation and feasibility assessment skill covering resource estimation, dependency graph verification, task completeness, milestone sequencing, and risk identification — trigger on: plan validation, feasibility, task plan, milestone check."
---

# Plan Validation Skill

## OVERVIEW

This skill provides a systematic methodology for validating implementation plans before execution begins. It covers feasibility assessment (resource estimation, timeline realism, technical risk), dependency graph verification (cycle detection, missing prerequisites, ordering correctness), task completeness checks (spec coverage, orphaned tasks), milestone sequencing validation (logical progression, gate criteria), and proactive risk identification (single points of failure, external dependencies, unknown unknowns). Scope limited to plan-level analysis.

## CONVENTIONS

- Detect the project's existing planning conventions (Agile sprints, Kanban phases, waterfall stages) before applying validation rules.
- Treat the specification document as the single source of truth for requirement coverage analysis.
- Use the project's defined task granularity level (epic to story to task to subtask) consistently throughout validation.
- Validate dependency graphs using topological sort principles; flag any cycles or unreachable nodes immediately.
- Assess feasibility against the team's known velocity and capacity.
- Distinguish between hard dependencies (blocking, must-complete-first) and soft dependencies (preferable ordering, non-blocking).

## CHECKLIST

- [ ] **Resource Estimation**: Verify each task has an effort estimate (story points, hours, or t-shirt size). Cross-reference total estimated effort against available team capacity for the planned timeline. Flag tasks with missing estimates or estimates that exceed sprint or phase boundaries.
- [ ] **Timeline Realism**: Validate that planned start and end dates respect dependency ordering. Check for parallel task assignments that exceed team member availability. Verify buffer time is allocated for integration, testing, and unforeseen blockers. Verify every task is scheduled after its prerequisites.
- [ ] **Technical Risk Assessment**: Identify tasks involving unfamiliar technologies, unproven integrations, or architectural changes. Flag tasks with high uncertainty and verify that risk mitigation strategies (spikes, prototypes, proof-of-concepts) are included in the plan. Check that technical debt items are accounted for with scheduled remediation.
- [ ] **Dependency Graph — Cycle Detection**: Construct a directed graph of task dependencies and verify it is acyclic. Report any circular dependencies with the full cycle path (e.g., Task A to Task B to Task C to Task A). Circular dependencies indicate a design flaw that must be resolved before execution.
- [ ] **Dependency Graph — Missing Prerequisites**: Verify every task's declared dependencies reference existing tasks in the plan. Flag dangling references to non-existent tasks. Check that external dependencies (third-party APIs, infrastructure provisioning, stakeholder approvals) are explicitly listed with responsible parties and expected delivery dates.
- [ ] **Dependency Graph — Ordering Correctness**: Validate that the planned execution order respects all dependency constraints. Verify every task follows its prerequisite ordering. Verify that integration tasks are positioned after all component tasks they depend on.
- [ ] **Task Completeness — Spec Coverage**: Map every requirement from the specification document to at least one task in the plan. Flag uncovered requirements as gaps requiring new tasks. Verify both functional requirements (features, behaviors) and non-functional requirements (performance, security, accessibility) have corresponding implementation tasks.
- [ ] **Task Completeness — Trace to Specification**: Verify every task in the plan traces back to a specification requirement or an explicitly approved out-of-scope addition. Flag tasks missing specification linkage for review, as they may represent scope creep or residual work from previous iterations.
- [ ] **Milestone Sequencing — Logical Progression**: Validate that milestones follow a logical build order: foundation to core features to integration to testing to deployment. Confirm each milestone delivers a verifiable increment of value. Verify that each milestone builds on earlier milestones without depending on later milestone deliverables.
- [ ] **Milestone Sequencing — Gate Criteria Defined**: Verify each milestone has explicit, measurable gate criteria that determine whether the team can proceed to the next phase. Gate criteria must be objective (e.g., "all critical tests passing," "API contract signed off") rather than subjective (e.g., "looks good," "seems ready"). Flag milestones with missing or vague gate criteria.
- [ ] **Risk — Single Points of Failure**: Identify tasks or milestones that depend on a single individual, a single external service, or a single untested technology. Flag these as single points of failure and verify that contingency plans (knowledge sharing, fallback options, parallel exploration) are documented.
- [ ] **Risk — External Dependencies**: Catalog all external dependencies (third-party services, vendor deliverables, regulatory approvals, infrastructure provisioning). Verify each has a named owner, expected delivery date, and escalation path if delayed. Flag external dependencies lacking confirmed commitment as high-risk.
- [ ] **Risk — Unknown Unknowns**: Identify areas where the plan assumes knowledge requiring validation (e.g., "API will support feature X," "database can handle Y throughput"). Recommend discovery tasks (spikes, proof-of-concepts, load tests) to convert unknowns into known risks before committing to timelines.
- [ ] **Cross-Cutting Concerns**: Verify the plan includes tasks for logging, monitoring, error handling, documentation, and deployment configuration. Flag plans that treat cross-cutting concerns as afterthoughts or assume they are "handled elsewhere" without evidence.

## PATTERNS

### Dependency Graph Validation

Represent task dependencies as a directed acyclic graph (DAG) and validate:
`
Tasks: [A, B, C, D, E]
Edges: A->C, B->C, C->D, D->E
Topological Sort: [A, B, C, D, E] or [B, A, C, D, E]

Cycle Detection (DFS-based):
Visit node -> mark gray -> visit neighbors -> if neighbor is gray, cycle found -> mark black on backtrack

Missing Prerequisite Check:
For each edge (X->Y), verify both X and Y exist in the task set.
Flag edges referencing tasks outside the plan as external dependencies requiring explicit tracking.
`

### Feasibility Assessment Formula

Calculate plan feasibility using capacity-constrained analysis:
`
Total Effort = sum(task_estimates)
Available Capacity = team_size x working_days x daily_capacity
Feasibility Ratio = Total Effort / Available Capacity

If ratio > 1.0: Plan is over-committed by (ratio - 1.0) x 100%
If ratio < 0.7: Plan may be under-estimated; verify completeness
Target range: 0.8 to 0.9 (allows 10-20% buffer for unknowns)
`

### Milestone Gate Criteria Pattern

Define objective gate criteria using the SMART framework:
`Milestone: "API Core Complete"
Gate Criteria:
  [ ] All defined endpoints return correct responses against contract tests
  [ ] Integration test suite passes with >=95% coverage on API layer
  [ ] Performance benchmark: p95 latency < 200ms under 1000 RPS load
  [ ] Security audit completed with zero Critical or High findings
  [ ] API documentation published and reviewed by at least one consumer team`

### Risk Register Pattern

Maintain a structured risk register for plan-level risks:
`| ID   | Risk Description          | Probability | Impact | Score    | Mitigation Strategy         | Owner     |
|------|---------------------------|-------------|--------|----------|-----------------------------|-----------|
| R-01 | Third-party API delay     | High        | High   | Critical | Identify fallback provider  | PM        |
| R-02 | Database migration failure| Medium      | High   | High     | Dry-run on staging replica  | DBA Lead  |
| R-03 | Key developer unavailable | Low         | High   | Medium   | Pair programming, docs      | Tech Lead |`

## CONSTRAINTS

- Report findings and recommendations separately; leave plan modification to the planner.
- Validate plan-level properties: completeness, ordering, feasibility, risk coverage.
- Request historical metrics for team velocity before rendering feasibility judgment.
- Approve plans only after resolving all circular dependencies.
- Flag external dependencies explicitly and require contingency plans.
- Validate cross-cutting concerns (testing, documentation, monitoring, deployment) in every plan.
