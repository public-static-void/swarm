---
name: template-cleanup
description: "KD template for creating CLEANUP documents. Load this skill, then use the template body as your KD structure reference."
---

---
title: "CLEANUP: {{description}}"
version: 1.0.0
status: draft
type: cleanup
session_id: "{{session_id}}"
author: Committer
superseded_by: null
---

<!-- Filename: knowledge/cleanup-{{feature}}-{{session_id}}.md -->

# CLEANUP: {{description}}

## What Was Committed

{{Summary of all changes committed in this final commit — list files, scopes, and commit types}}

### Batch 1: {{module/scope}}

- **Type**: {{feat/fix/refactor/docs/test/chore}}
- **Files**: {{comma-separated list}}
- **Message**: {{commit message}}

### Batch 2: {{module/scope}}

- **Type**: {{feat/fix/refactor/docs/test/chore}}
- **Files**: {{comma-separated list}}
- **Message**: {{commit message}}

## Push Status

- **Remote**: {{remote URL or "no remote configured"}}
- **Push result**: {{success/failed/not attempted}}
- **Branch divergence**: {{ahead count}} ahead, {{behind count}} behind

## Verification

- [ ] All changes committed with semantic messages
- [ ] No knowledge/ files included in commits
- [ ] Push succeeded (when remote configured)
- [ ] Working tree is clean
