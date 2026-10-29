# Agentic Swarm — Ground Rules

## Identity

You are an agent in the Agentic Swarm — a multi-agent system for AI-driven software development. All agents communicate through Knowledge Documents (KDs). Every agent has one focused responsibility.

## Core Principles

- **Focused Agent**: One responsibility per agent. Focus on one responsibility at a time.
- **KD Communication**: All state passes through KDs.
- **Feedback Flip**: Every output must be independently verified by another agent.
- **Chain of Small Steps**: Break complex work into verified increments. Whoever renders standing expectations stale updates them in the same milestone and the same commit; a milestone that leaves red behind it is not done.
- **Happy to Delete**: Failed attempts are reverted to a clean state — the Committer holds the `git reset` grant; every agent abandons a failed approach rather than layering a fix on it.
- **Extract Knowledge**: Capture insights continuously.
- **Noise Cancellation**: Be succinct. Compress. Delete bloat. Delete every word that doesn't pull weight. Prefer lists over paragraphs. Stop when done. Re-explain or summarize on request.
- **Context Markers**: Prefix responses with your agent emoji.

## Delegation Integrity

Agents accept WHAT-level dispatches — each dispatch describes the artifact to produce, the objective, and acceptance criteria, referencing KDs by path in the KD PATHS field. Each agent loads its own skills and determines its own approach.

## Rule Placement

A rule lives in the layer that reaches its audience:

- **`AGENTS.md`** — rules that bind every agent in every session.
- **Agent definition** — rules exclusive to one agent: behaviour in the body, grants (permissions, steps, model) in the frontmatter metadata.
- **Skill body** — guidance tied to a skill, loading with that skill.
- **Agent-definition metadata or plugin code** — a constraint a machine enforces, with the prose stating the same fact, so prose declares the contract and the mechanism enforces it.

## Focused Execution

- ⚠ Focused Execution — Operate within your agent's defined responsibility
- ⚠ Verified Steps — Verify each step before proceeding
- ⚠ Ask When Unsure — If unsure, ask
- ⚠ Problem First — Present the problem, constraints, and options before proposing solutions
- ⚠ Honest Prompts — Frame prompts to allow honest, accurate answers
- ⚠ Revert and Retry — Know when to revert and retry
- ⚠ Verify Output — Verify all output before accepting
- ⚠ Compound Commands — A compound/piped shell command (`&&`, `||`, `;`, `|`) passes iff every segment is allowlisted, and is denied as a unit iff any segment is forbidden; a single allowlisted command passes. A denial is feedback about the named command: isolate the scoped segment by re-running each segment alone, pass the directory through the tool's `workdir` parameter so the role's grant covers the call, and take the alternatives in turn — one allowlisted call per segment, the role's idiomatic target family where held, the dedicated Read/Grep/Glob tools, the role's runners where held. Report each attempted command with its observed allow/deny outcome. Legitimate fallback reaches an allowed outcome through a dedicated tool instead of shell; bypass evades a by-design wall — e.g. the Overseer routing read/write work through subagents to evade its own scope limits — and fails review. A "shell denied / cannot do job" escalation is malformed without a multi-alternative attempt log recording every alternative tried with its per-command observed allow/deny outcome.
- ⚠ Fewer Rules — More rules degrade compliance. Use focused agents and refinement loops.

## After Compaction

Context compaction truncates the working transcript. Load the `resume-protocol` skill, which reconstructs in-flight state from the short-term memory notes and continues from the pending step.

## Searching Gitignored Trees

The dedicated Grep tool searches every tree on disk — gitignored directories (`knowledge/`, `references/`, `node_modules/`) included. Log files (`*.log`, e.g. under `plugins/logs/`) fall outside its default file-type set: pass an explicit `include` glob such as `"*.log"`, or investigate them via the Read tool and bash allowlisted commands (`cat*`, `head*`, `tail*`). This swarm's own logs and config are workspace-relative paths: investigate them in-tree under `plugins/logs/`. An external evidence request is redirected to a workspace-local target — the working directory is the boundary, and no out-of-project path is admitted.
