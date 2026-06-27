---
name: kd-system
description: "Knowledge Document System for the Agentic Swarm. Use when creating, updating, or managing Knowledge Documents (KDs) — intent, spec, plan, review, audit, analysis, report, process, or implementation summary documents."
---

# KD System — Agentic Swarm

## Overview

The Knowledge Document System (KDS) is the communication backbone of the Agentic Swarm. All state passes through KDs. Agents never communicate directly.

## KD Types

| Type                   | Prefix         | Producer      | Consumer                       | Template File                                  |
| ---------------------- | -------------- | ------------- | ------------------------------ | ---------------------------------------------- |
| INTENT                 | `intent-`      | Overseer      | Spec Weaver, Pathfinder        | `templates/template-intent.md`                 |
| SPEC                   | `spec-`        | Spec Weaver   | Pathfinder, Artisan, Inspector | `templates/template-spec.md`                   |
| PLAN                   | `plan-`        | Pathfinder    | Artisan, Inspector             | `templates/template-plan.md`                   |
| IMPLEMENTATION SUMMARY | `impl-`        | Artisan       | Inspector, Scribe              | `templates/template-implementation-summary.md` |
| REVIEW                 | `review-`      | Inspector     | Artisan (for fixes), Overseer  | `templates/template-review.md`                 |
| AUDIT                  | `audit-`       | Inspector     | Overseer                       | `templates/template-audit.md`                  |
| ANALYSIS               | `analysis-`    | Analyzer      | Spec Weaver, Pathfinder        | `templates/template-analysis.md`               |
| REPORT                 | `report-`      | Overseer      | User                           | `templates/template-report.md`                 |
| PROCESS                | `process-`     | Habit Builder | All agents                     | `templates/template-process.md`                |
| COMPOSED               | `composed-`    | Scribe        | Assigned agent                 | `templates/template-composed.md`               |
| EXPLORATION            | `exploration-` | Explorer      | Spec Weaver, Pathfinder        | `templates/template-exploration.md`            |

## KD Structure

Every KD must have:

1. **YAML frontmatter** with: `title`, `version`, `status`, `type`, `created`, `author`, `superseded_by`
2. **Body** with sections appropriate to its type — see the Pre-Creation Compliance Checklist below and the corresponding template for the expected structure.

## Frontmatter Fields

```yaml
---
title: "TYPE: Descriptive Title"
version: 1.0.0
status: draft
type: spec
created: YYYY-MM-DD
author: Agent Name
superseded_by: null
---
```

**Status values:** `draft` → `review` → `approved` → `superseded`

## Status Transitions

```
draft──►review──►approved──►superseded
  ▲        ▲          ▲            ▲
Created  Ready     Passed       Replaced
by agent for rev.  review      by new KD
```

## Naming Convention

```
{type}-{descriptive-name}-{YYYY-MM-DD}.md
```

Example: `spec-auth-flow-2026-05-22.md`

## Storage

- Runtime KDs live under project-relative `knowledge/` directory
- Templates are bundled with this skill at `templates/*.md` (relative to SKILL.md location)
- When reading template files, use the `read` tool (not `external_directory`)
- Template access is pre-authorized for all agents — agents must not request additional permission
- The correct read pattern for templates is `**/skills/kd-system/templates/*.md`

## Pre-Creation Compliance Checklist

Before creating any KD, verify each of these:

### Step 1: Frontmatter

- [ ] `title` — `"TYPE: Descriptive Title"` format
- [ ] `version` — Semantic version MAJOR.MINOR.PATCH
- [ ] `status` — `draft` | `review` | `approved` | `superseded`
- [ ] `type` — Matches one of the 11 KD types from the table above
- [ ] `created` — ISO 8601 date (YYYY-MM-DD)
- [ ] `author` — Your agent name
- [ ] `superseded_by` — `null` for new KDs, path string for superseded

### Step 2: Body Structure

- [ ] Body follows the structure defined in the corresponding template file
- [ ] All template placeholders (`{{...}}`) replaced with actual content
- [ ] (optional) Process Friction section present if issues encountered
- [ ] Friction table has correct columns: ID, Issue, Severity, Status, Fixed by

### Step 3: Naming

- [ ] File name: `{prefix}-{descriptive-name}-{YYYY-MM-DD}.md`
- [ ] Prefix matches the KD type from the table above

### Step 4: Storage

- [ ] Saved to project-relative `knowledge/` directory
- [ ] Directory exists (create if missing)

### Step 5: Process Friction (optional)

- [ ] If friction was encountered during this work, append a `## Process Friction` section at the end of the body (after Content, before References)
- [ ] Table columns: ID, Issue, Severity, Status, Fixed by
- [ ] Severity follows the rubric in `agents/habit-builder.md` (low/medium/high)
- [ ] If no friction encountered, omit the section entirely

## Post-Creation Verification

After writing the KD file:

1. File exists on disk at expected path
2. Frontmatter parses correctly as YAML
3. All 7 required frontmatter fields are present
4. Body follows expected structure for the KD type
5. (optional) If Process Friction section is present, verify table columns: ID, Issue, Severity, Status, Fixed by

**Complete all checks before concluding your task.**

## Usage

When creating a KD:

1. Load this skill to access the template reference
2. Read the corresponding template file from `templates/`
3. Run the Pre-Creation Compliance Checklist above
4. Copy the template structure and fill in the placeholders
5. Save to `knowledge/{prefix}-{name}-{date}.md`
6. Run Post-Creation Verification
7. Set `status: draft` initially, advance through states as it moves through gates
