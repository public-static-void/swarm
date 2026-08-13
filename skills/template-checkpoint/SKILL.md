---
name: template-checkpoint
description: "KD template for creating CHECKPOINT documents. Load this skill, then use the template body as your KD structure reference."
---

---

title: "CHECKPOINT: {{description}}"
version: 1.0.0
status: draft
type: checkpoint
session_id: "{{session_id}}"
author: Committer
superseded_by: null
---

<!-- Filename: knowledge/checkpoint-{{feature}}-{{session_id}}-gen{{generation}}.md -->
<!-- GENERATION: {{generation}} is the lifecycle counter from protocol-gate state. Each lifecycle's KDs are scoped to its generation (`-genN-` after the session ID) so stale KDs from prior lifecycles are never matched. Use the generation value provided by the dispatcher. -->

# CHECKPOINT: {{description}}

## What Was Committed

{{Summary of changes committed in this checkpoint — list files, scopes, and commit types}}

### Batch 1: {{module/scope}}

- **Type**: {{feat/fix/refactor/docs/test/chore}}
- **Files**: {{comma-separated list}}
- **Message**: {{commit message}}

### Batch 2: {{module/scope}}

- **Type**: {{feat/fix/refactor/docs/test/chore}}
- **Files**: {{comma-separated list}}
- **Message**: {{commit message}}

## Remaining Work

{{Description of what remains — uncommitted files, pending changes, or work still in progress}}

## Verification

- [ ] All staged changes committed successfully
- [ ] Commit messages follow repository conventions
- [ ] No knowledge/ files included in commits
