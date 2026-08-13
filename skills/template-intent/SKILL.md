---
name: template-intent
description: "KD template for creating INTENT documents. Load this skill, then use the template body as your KD structure reference."
---

---

title: "INTENT: {{title of the request}}"
version: 1.0.0
status: draft
type: intent
session_id: "{{session_id}}"
author: Overseer
superseded_by: null
---

<!-- Filename: knowledge/intent-{{name}}-{{session_id}}-gen{{generation}}.md -->
<!-- GENERATION: {{generation}} is the lifecycle counter from protocol-gate state. Each lifecycle's KDs are scoped to its generation (`-genN-` after the session ID) so stale KDs from prior lifecycles are never matched. Use the generation value provided by the dispatcher. -->
<!-- Template has no decision points — the Overseer writes Raw Request verbatim. -->
<!-- Triage Notes are pre-filled; the Explorer fills them after dispatch. -->

# INTENT: {{title}}

## Raw Request

{{The user's original request, captured VERBATIM — copy word for word}}

## Triage Notes

- **Domain familiarity**: TBD — Explorer will assess after dispatch.
- **Clarity**: TBD — Explorer will assess after dispatch.
- **Estimated scope**: TBD — Explorer will assess after dispatch.

## Next Steps

- [ ] Dispatch Explorer to verify and explore
