---
title: "AUDIT: {{artifact audited}}"
version: 1.0.0
status: draft
type: audit
created: {{YYYY-MM-DD}}
author: Inspector
superseded_by: null
---
<!-- Filename: knowledge/audit-{{artifact}}-{{YYYY-MM-DD}}.md -->

# AUDIT: {{artifact}}

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

| ID | Issue | Severity | Status | Fixed by |
|-----|-------|----------|--------|----------|
| PF-001 | {{description of friction}} | {{low/medium/high}} | {{unresolved/resolved}} | {{agent or PR ref}} |
