---
name: template-impl
description: "KD template for creating IMPLEMENTATION SUMMARY documents. Load this skill, then use the template body as your KD structure reference."
---

---
title: "IMPLEMENTATION SUMMARY: {{feature name}} — {{step reference}}"
version: 1.0.0
status: draft
type: impl
session_id: "{{session_id}}"
author: Artisan
superseded_by: null
---

<!-- Filename: knowledge/impl-{{step}}-{{session_id}}-gen{{generation}}.md -->
<!-- GENERATION: {{generation}} is the lifecycle counter from protocol-gate state. Each lifecycle's KDs are scoped to its generation (`-genN-` after the session ID) so stale KDs from prior lifecycles are never matched. Use the generation value provided by the dispatcher. -->

# IMPLEMENTATION SUMMARY: {{feature}}

## What Was Built

{{Summary of code changes}}

## Files Changed

- `{{path/to/file}}` — {{reason for change}}

## Deviations from Plan

- {{Any deviation from SPEC or PLAN, with rationale}}

## Verification Notes

{{How to verify this works — test commands, manual steps}}

## Process Friction

_This section is optional — include it when friction was encountered during work._

| ID     | Issue                       | Severity            | Status                  | Fixed by            |
| ------ | --------------------------- | ------------------- | ----------------------- | ------------------- |
| PF-001 | {{description of friction}} | {{low/medium/high}} | {{unresolved/resolved}} | {{agent or PR ref}} |
