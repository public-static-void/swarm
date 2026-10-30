# Agentic Swarm

This repository is the opencode configuration for the Agentic Swarm — a multi-agent system for AI-driven software development. This directory is also the global OpenCode config directory: the `AGENTS.md` and agent definitions it holds reach every project opened on this machine, which is why they state swarm method and never facts about one codebase. Everything specific to this repository — its architecture, paths, tooling and maintenance — lives here, in the one file only maintainers read.

This README sets the swarm's architecture in stone: the focused-agent concept, the subdivision of labor, how agents are dispatched, how the layers divide their audiences, and how the configuration enforces the design. Every agent in the swarm operates within this architecture.

## Requirements

This configuration targets **opencode v2** — the plugins import `@opencode/plugin` and register through the v2 `setup()` adapter. Run it with an opencode v2 build.

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
- **Git operations go to the Committer.** The Overseer dispatches the Committer for git lifecycle work (preflight, cleanup); the Artisan dispatches the Committer for checkpoint commits. This keeps the git lifecycle in one focused role with one verified workflow.
- Agents accept WHAT-level dispatches and produce their results as KDs on disk.

## Permissions Are Limited by Design

Permissions are limited by design. Only the Overseer and the Artisan hold the `subagent` tool — delegation is a fixed lifecycle channel, not a general capability. When a denial blocks a task, the affected agent stops, documents the gap, and escalates to the Overseer, who re-dispatches the correct owner. Permissions are the enforcement of the division of labor, not a gap to be widened: keeping permissions tight is what makes the architecture verifiable.

## Plugins Enforce the Architecture Structurally

Behavioral rules alone are not robust enough — the swarm's plugins enforce the architecture as structural constraints:

- **protocol-gate** guards lifecycle phase transitions, milestone check-offs, and the git staging contract (intended tracked files enter a commit).
- **delegation-gate** validates every dispatch and logs the raw prompt through its debug channel — file-only, and only while the plugin's own debug switch is on. It keeps no persisted audit trail of the dispatches it validates.
- **knowledge-gate** surfaces open issues and prior insights to the lifecycle.

Structural enforcement fails closed: when a rule is violated, the operation is rejected at the tool layer rather than relying on an agent to remember a behavioral rule.

## Layers

The configuration is organized in five layers. Each layer has one audience, and the audience is what decides which rules belong there:

| Layer | Content | Audience |
| --- | --- | --- |
| `AGENTS.md` | Swarm method | Binds every agent, in every project |
| agent definition body | The rules exclusive to that role | Reaches that role, in every project it runs in |
| agent definition frontmatter | The entitlements a mechanism enforces | Enforced by the mechanism, never by the agent's memory |
| skill body | Guidance that loads with the task | Reaches the agents that load it, for the task that loaded it |
| `README.md` | This repository's architecture, paths, tooling and maintenance | Reaches maintainers of this repository |

The five layers are exhaustive for rule text: a rule belongs to the narrowest audience that needs it, and no always-injected layer restates this table. Enforcement is the sixth mechanism rather than a sixth layer — `plugins/` turns a rule into a tool-layer constraint, so an operation is rejected instead of relying on an agent to remember.

## Investigating Gitignored Trees

The dedicated Grep tool searches every tree on disk — gitignored directories (`knowledge/`, `references/`, `node_modules/`) included. Log files (`*.log`, such as those under `plugins/logs/`) fall outside its default file-type set: pass an explicit `include` glob such as `"*.log"`, or read them with the Read tool and allowlisted read commands (`cat*`, `head*`, `tail*`). This repository's logs and config are workspace-relative paths, so investigate them in-tree under `plugins/logs/`. An external evidence request is redirected to a workspace-local target — the working directory is the boundary, and no out-of-project path is admitted.

## Running the Tests

The suite runs via `npx vitest run` from the repository root — the canonical invocation, and the same command the commit hook runs. `package.json` declares three scripts: `audit` runs the dependency audit at high severity, `prepare` points `core.hooksPath` at `.githooks` so the commit hook is installed with the dependencies, and `test` is `vitest run`. The vitest config pins collection to `tests/**`, so a root-level run collects exactly the swarm suite and reports its true signal.

## Running the Security Gate

Run the SAST gate from the repository root with this invocation:

```sh
npx eslint -c eslint.security.config.mjs
```

Run it during review, and whenever the commit hook reports a lint finding: the flat config lives at `eslint.security.config.mjs` instead of the default `eslint.config.*` filename, so a bare `npx eslint` finds no config and the `-c` flag points ESLint at the security baseline. The `security` ruleset reports warn-level findings and error-level blocks.

## Debug Logging

Plugin diagnostics are file-only by design: nothing a plugin writes reaches stdout or stderr, so debug output stays out of the user prompt. Logging stays off unless explicitly enabled per plugin.

| Plugin | Enable with | Default log file | Directory override |
| --- | --- | --- | --- |
| delegation-gate | `DELEGATION_GATE_DEBUG=1` | `plugins/logs/delegation-gate.log` | `DELEGATION_GATE_LOG_DIR` |
| protocol-gate | `PROTOCOL_GATE_DEBUG=1` | `plugins/logs/protocol-gate.log` | `PROTOCOL_GATE_LOG_DIR` |
| knowledge-gate | `KNOWLEDGE_GATE_DEBUG=1` | `plugins/logs/knowledge-gate.log` | `KNOWLEDGE_GATE_LOG_DIR` |

Example:

```sh
PROTOCOL_GATE_DEBUG=1 opencode
```

Point a `*_LOG_DIR` variable at any directory to redirect that plugin's log there (the directory is created as needed). A failed write is counted via `getDroppedLogCount()` and surfaced in the enablement state / status file, so logging never blocks a hook and never fails silently. Log files (`*.log`) stay gitignored.

## The Git Contract

git tracks swarm config: `AGENTS.md`, `agents/`, `skills/`, `plugins/`, `tests/`, `opencode.json`. `knowledge/` is workflow meta and stays gitignored. Verification is tree-level — working tree and tracked diffs — using the standard git workflow with hooks enabled. A version-controlled pre-commit hook (`.githooks/pre-commit`, wired via `core.hooksPath` set by the `prepare` script on `npm install`) runs the repo gates — `npx vitest run` + `npx eslint -c eslint.security.config.mjs` — automatically at commit time and fails the commit when a gate fails. The Committer stays git-only; manual gate runs belong to the Inspector, which runs the declared suite, dependency-audit and SAST gates as part of review.
