# Agentic Swarm

This repository is the opencode configuration for the Agentic Swarm — a multi-agent system for AI-driven software development. This README sets the swarm's architecture in stone: the focused-agent concept, the subdivision of labor, how agents are dispatched, and how the configuration enforces the design. Every agent in the swarm operates within this architecture.

## Design Principles

- **Focused Agents** — one responsibility per agent. Each agent concentrates on a single job, and each job is owned by exactly one agent. Focused agents stay reliable: fewer responsibilities mean fewer behavioral conflicts and clearer verification.
- **KD Communication** — all state passes through Knowledge Documents (KDs). Agents communicate by writing and reading KDs, and every dispatch references its inputs and outputs by KD path.
- **Feedback Flip** — every output is independently verified by another agent. Verification is a first-class step.
- **Chain of Small Steps** — complex work is broken into verified increments. Each step produces evidence on disk before the next step starts.
- **Point the Target** — rules are written in positive framing. Instructions state what should happen, so they are unambiguous and directly executable.
- **Extract Knowledge** — insights are captured continuously into durable knowledge, so the swarm improves across lifecycles.

## Labor Subdivision

The swarm divides the work of a software lifecycle into focused roles. Each responsibility is owned by exactly one agent, and the right agent for a task is always the one whose description matches the task.

| Agent | Responsibility |
| --- | --- |
| Overseer | Captures user intent, orchestrates the lifecycle by delegation, and reports the final result |
| Explorer | Maps the codebase and surfaces current state — exploration and mapping |
| Analyzer | Performs deep-dive root-cause analysis of issues |
| Spec Weaver | Turns intent into specifications |
| Pathfinder | Turns specifications into plans and milestone registries |
| Artisan | Implements the artifacts — code, configs, presentations |
| Inspector | Verifies implementations against specs and runs the quality gates |
| Committer | Owns the git lifecycle: preflight, checkpoint commits, and cleanup |
| Scribe | Manages and consolidates knowledge |
| Habit Builder | Optimizes the swarm from the process friction captured in KDs |

## Role Boundaries

- The **Explorer** maps the codebase — exploration and mapping.
- The **Analyzer** dives deep into root causes — investigation.
- Every capability is owned by exactly one role — role boundaries are disjoint. When a task matches a role, that role's agent owns it end to end, so dispatch choices are deterministic and verification stays independent.

## Dispatch Semantics

- The **Overseer** delegates _what_ to do. Dispatches describe the artifact to produce, the objective, and the acceptance criteria, referencing KDs by path. Each agent loads its own skills and determines its own approach.
- **Git operations go to the Committer.** The Committer owns the git lifecycle: preflight, staging, checkpoint commits, resets, and cleanup. An agent that needs a checkpoint dispatches the Committer; an agent that needs git lifecycle work dispatches the Committer. This keeps the git lifecycle in one focused role with one verified workflow.
- Agents accept WHAT-level dispatches and produce their results as KDs on disk.

## Permissions Are Limited by Design

Permissions are limited by design. Every agent's permission allowlist matches its role exactly. Permissions are the enforcement of the division of labor, not a gap to be widened: when work belongs to another role, the correct action is to dispatch that role's agent. A denial is a signal to re-dispatch correctly, not a prompt to widen access. Keeping permissions tight is what makes the architecture verifiable.

## Plugins Enforce the Architecture Structurally

Behavioral rules alone are not robust enough — the swarm's plugins enforce the architecture as structural constraints:

- **protocol-gate** guards lifecycle phase transitions, milestone check-offs, and the git staging contract (intended tracked files enter a commit).
- **delegation-gate** validates every dispatch and records the full dispatch text as the audit trail.
- **knowledge-gate** surfaces open issues and prior insights to the lifecycle.

Structural enforcement fails closed: when a rule is violated, the operation is rejected at the tool layer rather than relying on an agent to remember a behavioral rule.

## Layer Discipline

The configuration is organized in layers, each with one job:

| Layer | Content | Role |
| --- | --- | --- |
| `AGENTS.md` | General ground rules | Valid for all agents at all times |
| `agents/*.md` | Agent-specific knowledge | Valid for the respective agent at all times — role, protocol, and permission allowlist |
| `skills/*/SKILL.md` | Domain knowledge | Loaded on demand depending on the task at hand |
| `plugins/` | Structural constraints | Enforced at runtime because behavioral constraints are not robust enough |

Ground rules live in `AGENTS.md`; agent-specific knowledge lives in the agent files; domain knowledge lives in skills; enforcement lives in plugins. Each layer stays in its place, so rules are easy to find and hard to contradict.

## The Git Contract

git tracks swarm config: `AGENTS.md`, `agents/`, `skills/`, `plugins/`, `tests/`, `commands/`, `opencode.json`. `knowledge/` is workflow meta and stays gitignored. Verification is tree-level — working tree and tracked diffs — using the standard git workflow with hooks enabled.
