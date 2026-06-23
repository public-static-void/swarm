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
   - **No `.git/`**: `git init`, then `git checkout -b <branch-name>`. Skip pull — no remote configured yet.
   - **Clean repo**: Check `git remote -v`. If a remote is configured, run `git pull --ff-only`.
     - On success: create feature branch with `git checkout -b <branch-name>`.
     - On failure: report the failure reason, proceed with `git checkout -b <branch-name>`.
     - No remote configured: skip pull, proceed with `git checkout -b <branch-name>`.
   - **Dirty repo**: `git stash` pending changes. If stash succeeds, apply the same pull logic as the clean repo path (check remote, pull --ff-only, handle failure) before branching. If stash fails, report back with a clear message about what is stuck (files preventing stash, merge conflicts, etc.) — do not attempt pull on an unstable working tree.

2. **Gitignore management** — Check if `.gitignore` exists. If not, create with project-appropriate patterns. If it exists, review and verify all standard gitignore patterns for the project's tech stack are included (e.g., `node_modules/`, `.env`, `*.log`, build output). Preserve all existing entries.

3. **Feature branch** — If a branch name was provided, use it. Otherwise, `git branch --show-current`. If on main/default, `git checkout -b improve/{short-description}`. If already on a feature branch, use it. Skip for subsequent checkpoint commits.

## Exit

Report branch name, clean/dirty state, and any stashed changes. Exit after workspace is ready.
