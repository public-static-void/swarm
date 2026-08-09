---
id: 39
title: "Grep tool behaviors block log/file inspection — skips .log files; file-path search falls back to parent directory"
severity: low
status: resolved
created: 2026-08-09
session: ses_01dc82bf9ffen46jTRrKJRAOkS
assigned_to: AGENTS.md Inspection Tools documentation owners (Overseer/Inspector)
tags: [process, tooling, inspection, evidence]
---

# Issue 39: Grep tool behaviors block log/file inspection

## Description

The Grep tool's behavior on `.log` files and file-path queries blocked evidence inspection three times in one lifecycle (overseer-issue-audit, ses_01dc82bf9ffen46jTRrKJRAOkS):

1. **ANALYSIS PF-001** — Grep returns "No files found" for `.log` files; log evidence had to be read via the Read tool with targeted offsets.
2. **EXPLORATION PF-002** — Grep with a specific file path fell back to a directory-wide search (noisy output); worked around with glob + targeted reads.
3. **REVIEW PF-002** — Grep with a file path searches the parent directory; per-file evidence confirmed via `include` filters on the directory.

This is a recurring tool-behavior gotcha (same class documented in prior lifecycles' friction entries — see issue-21 PROGRESS: compound/piped inspection denied, agents fall back to read/grep/glob). Each occurrence costs a discovery cycle: the agent must learn the workaround before the evidence is gathered. It is distinct from issue-21 (bash allowlist) — this is the dedicated read/grep/glob tooling itself, not bash permission rules.

## Source KD Reference

- `knowledge/report-overseer-issue-audit-ses_01dc82bf9ffen46jTRrKJRAOkS-gen0.md` — durable substitute for the deleted overseer-issue-audit lifecycle KDs (original ANALYSIS/EXPLORATION/REVIEW/PROCESS gen0 KDs removed by lifecycle-end cleanup): report Process Friction F-02 records the Grep-tool behavior class (`.log` skip + file-path fallback) and points back to this issue as the fix; Open Item 4 documents the issue's creation.

## Recommended Fix

Document the Grep tool behaviors in AGENTS.md `## Inspection Tools` so agents do not rediscover the workarounds per lifecycle:

- Grep skips `.log` files — use Read with targeted offsets for log evidence.
- Grep with a file path searches the parent directory (or falls back to directory-wide) — use `include` filters on the directory for per-file evidence, or glob + targeted reads.

## Acceptance Criteria

- No future lifecycle KD friction entry cites a Grep-tool behavior discovery as friction (`.log` skip or file-path fallback) after the documentation lands.
- AGENTS.md `## Inspection Tools` documents both behaviors and their workarounds.

## Resolution (2026-08-09)

Closed as **resolved** — the Grep tool workarounds are now documented in `AGENTS.md` `## Inspection Tools` (SPEC R003; committed in this lifecycle's M2). The AGENTS.md edit is the durable evidence (a committed file path that survives lifecycle-end cleanup):

- **Bullet 1** (fixes PF-001): "Read `.log` evidence with `read` using targeted offsets — `grep` skips `.log` files." Log evidence no longer requires rediscovering the Read-with-offsets workaround.
- **Bullet 2** (fixes PF-002): "For per-file evidence, use `include` filters on the directory (or glob + targeted reads) — `grep` with a file path falls back to a parent/directory-wide search." Per-file evidence no longer triggers a noisy parent-directory search.

Both bullets are phrased as positive instructions ("use X for Y"), per the AGENTS.md "Point the Target" principle. Each of the three observed friction occurrences (ANALYSIS PF-001, EXPLORATION PF-002, REVIEW PF-002) now maps to a documented rule, so future agents apply the workaround directly instead of rediscovering it.

Source KD References repointed to the durable substitute `knowledge/report-overseer-issue-audit-ses_01dc82bf9ffen46jTRrKJRAOkS-gen0.md` (the gen0 ANALYSIS/EXPLORATION/REVIEW/PROCESS KDs were removed by lifecycle-end cleanup — the issue-41 rot pattern). That report's Process Friction F-02 records the Grep-tool behavior class and cites this issue as the fix.

Distinct from issue-21 (bash permission allowlist): this issue covers the dedicated read/grep/glob tooling behaviors themselves, now documented per the Recommended Fix.
