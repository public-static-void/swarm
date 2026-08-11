---
name: kd-system
description: "Knowledge Document System for the Agentic Swarm. Use when creating, updating, or managing Knowledge Documents (KDs) — intent, spec, plan, milestone registry, review (merged review+audit), analysis, report, process, implementation summary, checkpoint, or cleanup documents."
---

# KD System — Agentic Swarm

## Overview

The Knowledge Document System (KDS) is the communication backbone of the Agentic Swarm. All state passes through KDs. All agent communication flows through KDs.

## KD Types

| Type                   | Prefix         | Producer      | Consumer                                                  | Template Skill                                  |
| ---------------------- | -------------- | ------------- | --------------------------------------------------------- | ---------------------------------------------- |
| INTENT                 | `intent-`      | Overseer      | Explorer, Analyzer, Spec Weaver, Pathfinder, Artisan, Inspector, Scribe, Habit Builder | `template-intent` |
| PREFLIGHT              | `preflight-`   | Committer     | Scribe, Habit Builder                                     | `template-preflight`              |
| SPEC                   | `spec-`        | Spec Weaver   | Pathfinder, Artisan, Inspector, Scribe, Habit Builder     | `template-spec`                   |
| PLAN                   | `plan-`        | Pathfinder    | Artisan, Inspector, Scribe, Habit Builder                 | `template-plan`                   |
| MILESTONE REGISTRY     | `milestones-`  | Pathfinder    | Overseer, Artisan, Inspector                              | `template-milestones`             |
| IMPLEMENTATION SUMMARY | `impl-`        | Artisan       | Inspector, Scribe, Habit Builder                          | `template-impl` |
| REVIEW                 | `review-`      | Inspector     | Artisan, Scribe, Habit Builder                            | `template-review`                 |
| AUDIT                  | (merged into `review-`) | Inspector | — (audit content is a section of the review KD)       | `template-review` (audit section) |
| ANALYSIS               | `analysis-`    | Analyzer      | Spec Weaver, Scribe, Habit Builder                        | `template-analysis`              |
| REPORT                 | `report-`      | Overseer      | User                                                       | `template-report`                 |
| PROCESS                | `process-`     | Habit Builder | User                                                       | `template-process`                |
| COMPOSED               | `composed-`    | Scribe        | Habit Builder                                              | `template-composed`              |
| EXPLORATION            | `exploration-` | Explorer      | Analyzer, Spec Weaver, Scribe, Habit Builder               | `template-exploration`    |
| CHECKPOINT             | `checkpoint-`  | Committer     | Scribe, Habit Builder                                      | `template-checkpoint`             |
| CLEANUP                | `cleanup-`     | Committer     |                                                           | `template-cleanup`                |

**Consumer legend:**
- Agents: Spec Weaver, Pathfinder, Artisan, Inspector, Scribe, Analyzer, Habit Builder, Explorer, User
- Plugins read all KDs for disk checks — not listed as consumers
- Overseer writes INTENT/REPORT. Input comes from the user and from issue files surfaced by the Knowledge Gate plugin
- Committer writes PREFLIGHT/CHECKPOINT/CLEANUP. Input comes from the dispatch MODE field and skill protocols

## KD Structure

Every KD must have:

1. **YAML frontmatter** with: `title`, `version`, `status`, `type`, `session_id`, `author`, `superseded_by`
2. **Body** with sections appropriate to its type — see the Pre-Creation Compliance Checklist below and the corresponding template for the expected structure.

## Frontmatter Fields

```yaml
---
title: "TYPE: Descriptive Title"
version: 1.0.0
status: draft
type: spec
session_id: "{{session_id}}"
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
{type}-{descriptive-name}-{session_id}-gen{generation}.md
```

Example: `spec-auth-flow-ses_0711b9644ffe-gen1.md`

The `-gen{N}` suffix is the lifecycle generation from protocol-gate state. Each lifecycle's KDs are scoped to its generation — the protocol-gate matches KDs whose generation equals the current lifecycle generation, and stale KDs from prior lifecycles stay inert. Legacy KDs without `-genN-` are treated as generation 0.

## Storage

- Runtime KDs live under project-relative `knowledge/` directory

## Pre-Creation Compliance Checklist

Before creating any KD, verify each of these:

### Step 1: Frontmatter

- [ ] `title` — `"TYPE: Descriptive Title"` format
- [ ] `version` — Semantic version MAJOR.MINOR.PATCH
- [ ] `status` — `draft` | `review` | `approved` | `superseded`
- [ ] `type` — Matches one of the KD types defined in the table above
- [ ] `session_id` — `"{{session_id}}"`
- [ ] `author` — Your agent name
- [ ] `superseded_by` — `null` for new KDs, path string for superseded

### Step 2: Body Structure

- [ ] Body follows the structure defined in the corresponding template skill
- [ ] All template placeholders (`{{...}}`) replaced with actual content
- [ ] (optional) Process Friction section present if issues encountered
- [ ] Friction table has correct columns: ID, Issue, Severity, Status, Fixed by

### Step 3: Naming

- [ ] File name: `{prefix}-{descriptive-name}-{session_id}-gen{generation}.md`
- [ ] Prefix matches the KD type from the table above
- [ ] Generation matches the lifecycle generation provided by the dispatcher

### Step 4: Storage

- [ ] Saved to project-relative `knowledge/` directory
- [ ] Directory exists (create if missing)

### Step 5: Process Friction (optional)

- [ ] If friction was encountered during this work, append a `## Process Friction` section at the end of the body (after Content, before References)
- [ ] Table columns: ID, Issue, Severity, Status, Fixed by
- [ ] Severity follows the rubric in `agents/habit-builder.md` (low/medium/high)
- [ ] Omit the section when friction is absent

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
2. Load the corresponding template skill using the `skill` tool: `skill("template-{type}")`
3. Run the Pre-Creation Compliance Checklist above
4. Copy the template structure and fill in the placeholders
5. Save to `knowledge/{prefix}-{name}-{session_id}-gen{generation}.md`
6. Run Post-Creation Verification
7. Set `status: draft` initially, advance through states as it moves through gates
