---
name: template-audit
description: "KD template for creating AUDIT documents. Load this skill, then use the template body as your KD structure reference."
---

---
title: "AUDIT: {{artifact audited}}"
version: 1.0.0
status: draft
type: audit
session_id: "{{session_id}}"
author: Inspector
superseded_by: null
verdict: {{PASS | FAIL | FUNDAMENTAL}}
---

<!-- Filename: knowledge/audit-{{artifact}}-{{session_id}}-gen{{generation}}.md -->
<!-- GENERATION: {{generation}} is the lifecycle counter from protocol-gate state. Each lifecycle's KDs are scoped to its generation (`-genN-` after the session ID) so stale KDs from prior lifecycles are never matched. Use the generation value provided by the dispatcher. -->

# AUDIT: {{artifact}}

## Verdict

{{PASS / FAIL / FUNDAMENTAL}}

The `verdict` frontmatter field above is the machine source — protocol-gate
reads it during VERIFY. `FAIL` auto-regresses VERIFY→SWARM; `FUNDAMENTAL`
blocks advancement and escalates; `PASS` advances.

## Scope

{{What was audited — code, config, dependencies, infrastructure}}

## Risk Summary

- **Critical**: {{count}}
- **High**: {{count}}
- **Medium**: {{count}}
- **Low**: {{count}}

## Findings

### A001: {{vulnerability}}

- **Severity**: {{critical / high / medium / low}}
- **CWE**: {{CWE-ID if applicable}}
- **File**: {{path}}
- **Description**: {{the vulnerability}}
- **Remediation**: {{how to fix}}

## Process Friction

_This section is optional — include only if friction was encountered during work._

| ID     | Issue                       | Severity            | Status                  | Fixed by            |
| ------ | --------------------------- | ------------------- | ----------------------- | ------------------- |
| PF-001 | {{description of friction}} | {{low/medium/high}} | {{unresolved/resolved}} | {{agent or PR ref}} |
