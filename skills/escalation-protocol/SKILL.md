---
name: escalation-protocol
description: "Escalation protocol for the Agentic Swarm. Use when encountering an issue that cannot be resolved — defines two-step escalation, trigger conditions, the structured reporting format, and Overseer response procedures."
---

# Escalation Protocol

## Overview

When an agent encounters a situation it cannot resolve, it escalates rather than attempting to work around restrictions or fabricating results. This skill defines the complete escalation protocol — the single source of truth for all agents and the Overseer.

## When to Load This Skill

- **Agents**: Load this skill when you encounter an issue you cannot resolve (any of the 5 trigger conditions below). Use the ESCALATION format to report back to Overseer.
- **Overseer**: Load this skill when you receive an escalation from any agent. Follow the Overseer Response section to process it.

## Two-Step Escalation

### Step 1 (preferred): Agent → Overseer

Agent reports back to Overseer via the agent's return message. The agent describes: (a) what failed, (b) what was attempted, (c) what tool/permission/information is needed to proceed. The Overseer resolves or dispatches a different agent.

The agent uses this structured format:

```
ESCALATION:
Agent: <agent name>
Task: <what was being attempted>
Failed action: <what failed>
Attempted: <what the agent tried before escalating>
Needed: <what resource/permission/tool is missing>
Proposed resolution: <delegate to Agent X, grant permission Y, or use tool Z>
```

### Step 2 (fallback): Overseer → User

If the Overseer cannot resolve the issue, the Overseer uses the `question` tool to escalate to the user for guidance. Agents escalate solely through the Overseer.

## Trigger Conditions

An agent MUST escalate when any of these conditions apply:

| #   | Condition                | Description                                          | Example                                                       |
| --- | ------------------------ | ---------------------------------------------------- | ------------------------------------------------------------- |
| 1   | Missing permission       | A required action is denied by the permission system | Edit path denied, bash command denied                         |
| 2   | Missing tool             | The agent lacks a tool required for the task         | `webfetch`, `websearch`, `lsp`, etc.                          |
| 3   | Inaccessible information | The task requires data the agent cannot access       | External API, user credentials, offline resource              |
| 4   | Outside skillset         | The task falls outside the agent's defined role      | Scribe asked to write code, Overseer asked to edit files      |
| 5   | Ambiguous requirements   | Requirements cannot be resolved from existing KDs    | Missing SPEC, contradictory PLAN, unclear acceptance criteria |

## Overseer Response

On receiving an escalation, the Overseer must:

1. **Assess legitimacy** — Determine whether the request is legitimate (task truly requires the escalated resource)
2. **Resolve** — Take one of these actions:
   - Adjust permissions (if within the Overseer's power)
   - Dispatch a different agent whose skillset matches the requirement
   - Escalate to the user via the `question` tool (Step 2)
3. **Resolution** — Resolve restrictions by adjusting permissions, dispatching a different agent, or escalating to the user

## Agent Conduct Rules

- Operate within granted permissions; escalate when a required action is denied
- Report complete, accurate results or escalate unresolved issues
- Clearly communicate any incomplete output and specify what remains unresolved
