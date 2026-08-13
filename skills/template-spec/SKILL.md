---
name: template-spec
description: "KD template for creating SPEC documents. Load this skill, then use the template body as your KD structure reference."
---

---

title: "SPEC: {{feature name}}"
version: 1.0.0
status: draft
type: spec
session_id: "{{session_id}}"
author: Spec Weaver
superseded_by: null
---

<!-- Filename: knowledge/spec-{{feature}}-{{session_id}}-gen{{generation}}.md -->
<!-- GENERATION: {{generation}} is the lifecycle counter from protocol-gate state. Each lifecycle's KDs are scoped to its generation (`-genN-` after the session ID) so stale KDs from prior lifecycles are never matched. Use the generation value provided by the dispatcher. -->

# SPEC: {{feature name}}

## Overview

{{One-paragraph description of the feature}}

## Functional Requirements

- **R001**: {{requirement}}
- **R002**: {{requirement}}

## Non-Functional Requirements

- **NFR001**: {{performance, security, UX constraint}}

## Interface Contracts

{{Inputs, outputs, API signatures}}

## Acceptance Criteria

- [ ] AC001: {{verifiable criterion referencing R001}}
- [ ] AC002: {{verifiable criterion referencing R002}}

Acceptance criteria for gitignored artifacts (`knowledge/`, `knowledge/issues/`, `knowledge/memory/`) are verified from disk via `read`/`glob`/`grep`. Stage the files this task changed; use the standard git workflow. Rewrite any AC that cannot be verified from disk so it verifies from disk.

## Open Questions

- {{Question that needs resolution}}

## Process Friction

_This section is optional — include it when friction was encountered during work._

| ID     | Issue                       | Severity            | Status                  | Fixed by            |
| ------ | --------------------------- | ------------------- | ----------------------- | ------------------- |
| PF-001 | {{description of friction}} | {{low/medium/high}} | {{unresolved/resolved}} | {{agent or PR ref}} |
