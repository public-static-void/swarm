---
name: committer-preflight
description: "Git workspace setup: status check, branch creation, dirty workspace resolution. Exit when workspace is ready."
---

# Committer Preflight

## Overview

PREFLIGHT mode sets up a clean git workspace for feature development. It handles repo initialization, branch creation, dirty workspace resolution, and .gitignore management. This mode handles workspace setup exclusively.

## When to Load

Load this skill when dispatched in PREFLIGHT mode by the Overseer (Phase 2 — git workspace setup). The dispatch context contains the branch name.

## Protocol

1. **Accept branch name** — Accept a branch name parameter from the dispatching agent. Use the provided name instead of generating one independently. Fall back to `feature/unnamed` if none provided. Check `.git/` existence.
   - **When `.git/` is absent**: `git init`, then `git checkout -b <branch-name>`. Skip pull — remote is absent at this stage.
   - **Clean repo**: Run `git remote -v` to check remote configuration.
     - **When remote is absent**: Log a warning that no remote is available. Skip fetch and pull. Proceed with `git checkout -b <branch-name>` from current local state.
     - **Remote configured**: Proceed with the default-branch pull flow:
       1. `git fetch origin` — update all remote tracking refs
       2. Detect default branch: try `main`, fall back to `master`, then `git branch --show-current`. Log a warning if fallback used.
       3. **Detached HEAD check**: Check HEAD status with `git branch --show-current`. If detached, log a warning, skip `git checkout <default-branch>`. Proceed with `git pull --ff-only`, then `git checkout -b <branch-name>`.
       4. `git checkout <default-branch>` — switch to the default branch (skip if detached)
       5. `git pull --ff-only` — fast-forward to latest remote state
       6. On success: `git checkout -b <branch-name>` — create feature branch from latest state
       7. On pull failure: report the failure reason, proceed with `git checkout -b <branch-name>` from current state
   - **Dirty repo**:
     - **Stash**: Run `git stash push` to save pending changes.
       - If stash fails: log the error with details about what prevented the stash (files preventing stash, merge conflicts, etc.) and abort. Attempt pull only after the working tree is stable.
     - **Pull flow**: Apply the same default-branch pull flow as the clean-repo remote-configured path (steps 1-7 above), including the detached HEAD check.
     - **Restore**: After branch creation, run `git stash pop` to restore stashed changes. If pop fails, log a warning but continue.

2. **Gitignore management** — Check if `.gitignore` exists. If not, create with project-appropriate patterns. If it exists, review and verify all standard gitignore patterns for the project's tech stack are included (e.g., `node_modules/`, `.env`, `*.log`, build output). Preserve all existing entries.

3. **Feature branch** — If a branch name was provided, use it. Otherwise, `git branch --show-current`. If on main/default, `git checkout -b improve/{short-description}`. If already on a feature branch, use it. Skip for subsequent checkpoint commits.

## Exit

Report branch name, clean/dirty state, and any stashed changes. Exit after workspace is ready.
