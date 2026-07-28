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

<!-- Filename: knowledge/spec-{{feature}}-{{session_id}}.md -->

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

## Open Questions

- {{Question that needs resolution}}

## Process Friction

_This section is optional — include only if friction was encountered during work._

| ID     | Issue                       | Severity            | Status                  | Fixed by            |
| ------ | --------------------------- | ------------------- | ----------------------- | ------------------- |
| PF-001 | {{description of friction}} | {{low/medium/high}} | {{unresolved/resolved}} | {{agent or PR ref}} |
