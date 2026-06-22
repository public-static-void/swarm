---
name: committer-preflight
description: "Git workspace setup: status check, branch creation, dirty workspace resolution. Exit when workspace is ready."
---

# Committer Preflight

## Overview

PREFLIGHT mode sets up a clean git workspace for feature development. It handles repo initialization, branch creation, dirty workspace resolution, and .gitignore management. This mode handles workspace setup only.

## When to Load

Load this skill when dispatched in PREFLIGHT mode by the Overseer (Phase 2 — git workspace setup). The dispatch context contains the branch name.

## Protocol

1. **Accept branch name** — Accept a branch name parameter from the dispatching agent. Use the provided name instead of generating one independently. Fall back to `feature/unnamed` if none provided. Check `.git/` existence.

   - **No `.git/`**: `git init`, then `git checkout -b <branch-name>`.
   - **Clean repo**: Create feature branch with `git checkout -b <branch-name>`.
   - **Dirty repo**: `git stash` pending changes. If stash succeeds, note stashed changes in return message, create branch. If stash fails, report back with a clear message about what is stuck (files preventing stash, merge conflicts, etc.).

2. **Gitignore management** — Check if `.gitignore` exists. If not, create with project-appropriate patterns. If it exists, review and add missing standard patterns (e.g., `node_modules/`, `.env`, `*.log`, build output). Use the tech stack to determine relevant patterns. Preserve all existing entries.

3. **Feature branch** — If a branch name was provided, use it. Otherwise, `git branch --show-current`. If on main/default, `git checkout -b improve/{short-description}`. If already on a feature branch, use it. Skip for subsequent checkpoint commits.

## Exit

Report branch name, clean/dirty state, and any stashed changes. Exit after workspace is ready.
