---
name: dispatch-validation
description: "Shared Dispatch Acceptance Gate for consistent dispatch validation across all agents. Contains the 7-check structural validation protocol."
---

# Dispatch Validation Skill

## Overview

This skill defines the shared Dispatch Acceptance Gate — a 7-check structural validation protocol that all agents use to verify dispatch integrity before executing. Using a shared skill ensures uniform validation and automatic propagation of updates across the Agentic Swarm.

## When to Load This Skill

- **All agents**: Load this skill when you receive a dispatch. Run the 7-check Dispatch Acceptance Gate before executing any dispatch. The checks must pass in order — if any check fails, do not proceed with the dispatch.

## Dispatch Acceptance Gate

### Check 1 — Field Presence

The dispatch contains all required fields:
- `DISPATCH TO` — Target agent name
- `ACTION` — The action to perform
- `ARTIFACT` — The artifact to produce
- `{DOMAIN | SCOPE | MODE}` — Context field (one of the three)
- `KDS` — KD path references
- `RETURN` — Return artifact path
- `ACCEPTANCE` — Acceptance criteria

### Check 2 — Field Order

Fields appear in the canonical sequence:
```
DISPATCH TO → ACTION → ARTIFACT → {DOMAIN | SCOPE | MODE} → KDS → RETURN → ACCEPTANCE
```

### Check 3 — Agent Identity

The `DISPATCH TO` field matches the receiving agent's name.

### Check 4 — KDS Are Paths

Every KDS entry is a KD path reference following the pattern:
`knowledge/{type}-{name}-{date}.md`

No entry contains inline content or narrative text.

### Check 5 — RETURN Is a Path Pattern

The RETURN field contains a single artifact path pattern — a concise deliverable reference.

### Check 6 — Content-Role Match

The dispatch fields describe a WHAT-level objective for the receiving agent. The context field must follow these rules:

- **DOMAIN** must be a noun phrase identifying a conceptual area. It must NOT contain:
  - File paths (e.g., `/home/`, `src/`, `./`)
  - File extensions (e.g., `.py`, `.ts`, `.rs`, `.md`)
  - "read" verbs or "return contents" language
  - Specific file names or directory names
- **SCOPE** must reference a spec or plan identifier by name
- **MODE** must be one of: `PREFLIGHT`, `CHECKPOINT`, or `CLEANUP`

If DOMAIN violates these rules, report using ESCALATION format and do NOT proceed.

### Check 7 — Phase Readiness

If a current-session INTENT KD does not exist (`knowledge/intent-{session-date}.md`) and the dispatch is not for Phase 1 or Phase 2, reject the dispatch.

Additional phase ordering checks per agent-specific Dispatch Acceptance Gate may apply.

## Rejection Protocol

If any check fails:

1. **Do not proceed** with execution
2. **Log the violation** in your response
3. **Return structured error** indicating which check failed and what the violation was
4. **Use ESCALATION format** for role-boundary violations (checks 4, 5, 6)

## Integration Notes

- This skill is a referenceable shared gate; each agent also has agent-specific checks in its definition file
- Updates to this skill propagate automatically to all agents that load it
- The 7 checks here must pass before agent-specific validation begins
