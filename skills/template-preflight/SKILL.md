---
name: template-preflight
description: "KD template for creating PREFLIGHT documents. Load this skill, then use the template body as your KD structure reference."
---

---
title: "PREFLIGHT: {{workspace setup}}"
version: 1.0.0
status: draft
type: preflight
session_id: "{{session_id}}"
author: Committer
superseded_by: null
---

<!-- Filename: knowledge/preflight-{{feature}}-{{session_id}}-gen{{generation}}.md -->
<!-- GENERATION: {{generation}} is the lifecycle counter from protocol-gate state. Each lifecycle's KDs are scoped to its generation (`-genN-` after the session ID) so stale KDs from prior lifecycles are never matched. Use the generation value provided by the dispatcher. -->

# PREFLIGHT: {{workspace setup}}

## Workspace Setup Results

- **Repository initialized**: {{yes/no}}
- **Branch created**: {{branch name}}
- **Default branch pulled**: {{yes/no/skipped}}
- **Dirty workspace resolved**: {{yes/no/n/a}}

## Gitignore Changes

{{List any additions or modifications to .gitignore}}

## .ignore Changes

{{List any additions or modifications to .ignore}}

## Verification

- [ ] Branch is clean and ready for development
- [ ] `knowledge/` is in `.gitignore`
- [ ] `!knowledge/` is in `.ignore`
