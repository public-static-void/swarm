---
name: resume-protocol
description: "Post-Compaction Resume protocol for the Agentic Swarm. Load after context compaction to resume work — reconstruct in-flight state from short-term memory notes and continue from the pending step."
---

# Resume Protocol

## Overview

Context compaction truncates the active conversation; agents resume with the anchored summary. The two-layer memory model makes resume mechanical instead of prose-driven. This skill is the home of the full protocol — the documented mitigation for the compaction-amnesia issues — preserved outside the auto-injected ground-rules file.

## When to Load This Skill

- Load after context compaction to resume work.
- Load when a session resumes mid-lifecycle and in-flight state must be reconstructed from short-term notes.

## Two-Layer Memory Model

### Short-Term Layer (in-flight state)

- Every agent persists its per-session scratch via `memory_note` at natural checkpoints: the current phase, the pending step, the open TODO list, and the paths of the KDs anchoring the work.
- Notes live in `knowledge/short-term/{sessionID}/{agent}/` and are read back with `memory_note_read`.
- The knowledge-gate resume hint (regenerated on every LLM call) reminds any agent with notes to read them, so the re-read instruction survives compaction.

### On Resume

1. Read your short-term notes first.
2. Re-read the anchoring KDs they name.
3. Confirm the phase from the protocol-gate state.
4. Continue from the pending step the notes name.

### Long-Term Layer (cross-lifecycle knowledge)

- Curated insights written by Scribe via `memory_write` into `knowledge/memory/`; every agent reads them with `memory_search`.
- Scribe promotes important short-term notes to long-term at EXTRACT.

## Compaction-Amnesia Mitigation

The two-layer model is the documented mitigation for compaction amnesia. The short-term layer anchors in-flight state; the knowledge-gate hint re-triggers the re-read instruction on every LLM call; the long-term layer carries cross-lifecycle insights. This skill preserves the full protocol in an on-demand home so the mitigation survives ground-rules trims.
