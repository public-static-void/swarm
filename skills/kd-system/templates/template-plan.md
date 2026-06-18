---
title: "PLAN: {{feature name}}"
version: 1.0.0
status: draft
type: plan
created: {{YYYY-MM-DD}}
author: Pathfinder
superseded_by: null
---
<!-- Filename: knowledge/plan-{{feature}}-{{YYYY-MM-DD}}.md -->

# PLAN: {{feature name}}

## Dependency Graph

```mermaid
flowchart LR
    P001 --> P002
    P001 --> P003
    P002 --> P004
    P003 --> P004
```

## Steps

### P001: {{step description}}

- **Owner**: Artisan
- **Depends on**: {{none / P00X}}
- **Completion**: {{what must be true when done}}
- **Output**: {{what KDs or artifacts produced}}

### P002: {{step description}}

- **Owner**: {{Artisan}}
- **Depends on**: {{P001}}
- **Completion**: {{condition}}
- **Output**: {{artifacts}}

## Knowledge Checkpoint

This PLAN KD is the checkpoint. Commit it before any implementation starts.

## Process Friction

_This section is optional — include only if friction was encountered during work._

| ID | Issue | Severity | Status | Fixed by |
|-----|-------|----------|--------|----------|
| PF-001 | {{description of friction}} | {{low/medium/high}} | {{unresolved/resolved}} | {{agent or PR ref}} |
