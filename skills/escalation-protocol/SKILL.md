---
name: escalation-protocol
description: "Escalation protocol for the Agentic Swarm. Use when encountering an issue beyond the agent's resolution capability — defines two-step escalation, trigger conditions, the structured reporting format, and Overseer response procedures."
---

# Escalation Protocol

## Overview

When an agent encounters a situation beyond its resolution scope, it escalates directly and produces verified results. This skill defines the complete escalation protocol — the single source of truth for all agents and the Overseer.

## When to Load This Skill

- **Agents**: Load this skill when you encounter an issue beyond your resolution scope (any of the 5 trigger conditions below). Use the ESCALATION format to report back to Overseer.
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

When the Overseer lacks resolution capability, the Overseer escalates to the user via structured REPORT KDs. Agents escalate solely through the Overseer.

## Trigger Conditions

An agent MUST escalate when any of these conditions apply:

| #   | Condition                | Description                                          | Example                                                       |
| --- | ------------------------ | ---------------------------------------------------- | ------------------------------------------------------------- |
| 1   | Missing permission       | A required action is denied by the permission system | Edit path denied, bash command denied                         |
| 2   | Missing tool             | The agent lacks a tool required for the task         | `webfetch`, `websearch`, `lsp`, etc.                          |
| 3   | Inaccessible information | The task requires data inaccessible to the agent     | External API, user credentials, offline resource              |
| 4   | Outside skillset         | The task falls outside the agent's defined role      | Scribe asked to write code, Overseer asked to edit files      |
| 5   | Ambiguous requirements   | Requirements unresolvable from existing KDs          | Missing SPEC, contradictory PLAN, unclear acceptance criteria |

## Blocked Path Procedure

When information is blocked by permission rules:

1. **Accept the block** — Permission restrictions are intentional by design. The Overseer does not need this information to dispatch correctly.
2. **Document** — Note the information gap in the REPORT KD.
3. **Continue lifecycle** — Dispatch the next-phase agent with available KDs. The receiving agent reads what it needs independently.
4. **Network Effect** — Sub-agents have broader permissions by design. They access information through their own tool set and report findings through KDs. The Overseer receives KD paths as the report channel.

## Overseer Response

On receiving an escalation, the Overseer must:

1. **Assess legitimacy** — Determine whether the request is legitimate (task truly requires the escalated resource)
2. **Resolve** — Take one of these actions:
   - Continue the lifecycle normally — the receiving agent reads what it needs independently
   - Escalate to the user via REPORT KD (Step 2)
3. **Resolution** — Resolve restrictions by continuing the lifecycle or escalating to the user

## Agent Conduct Rules

- Operate within granted permissions; escalate when a required action is denied
- Report complete, accurate results or escalate unresolved issues
- Clearly communicate any incomplete output and specify what remains unresolved
