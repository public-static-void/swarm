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
<!-- Template has no decision points. The Overseer classifies the message before writing: a task specification addressed to the swarm is copied verbatim, because a paraphrase mangles what downstream agents must execute; a discussion with the Overseer about process is summarized, and its gist — what is to be done — becomes the request while the message itself goes to Triage Notes with its disposition. A message about the Overseer's conduct or the process state is a disposition: it belongs in Triage Notes, and the request text comes from the specification or the gist. Discriminating test: would a downstream agent need these exact words to do its job? Position is a tie-breaker, not the rule — a later message carrying the task specification becomes the Raw Request verbatim and the earlier discussion is triaged. -->

# INTENT: {{title}}

## Raw Request

{{The Raw Request, written from the classification: a task specification addressed to the swarm is copied verbatim — word for word, because a paraphrase mangles what downstream agents must execute; a discussion with the Overseer about process is summarized, and its gist — what is to be done — is the request, with the message listed in Triage Notes beside its disposition. A message about the Overseer's conduct or the process state is a disposition: it belongs in Triage Notes, and the request text comes from the specification or the gist. Discriminating test: would a downstream agent need these exact words to do its job? Position is a tie-breaker, not the rule — a later message carrying the task specification becomes the Raw Request verbatim.}}

## Triage Notes

- **Domain familiarity**: TBD — filled by Overseer at creation.
- **Clarity**: TBD — filled by Overseer at creation.
- **Estimated scope**: TBD — Explorer will assess after dispatch.

### Injected issues (Knowledge Gate)

_Include this subsection when the Knowledge Gate injects open issues; omit it otherwise._

- `{{store/id}}` — {{issue summary}}. Recommendation: {{address in this session / defer}}.
