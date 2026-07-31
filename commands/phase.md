---
description: Set the protocol phase for the current session (number 0-12 or phase name)
---

Set the protocol phase for the current session.

Argument: $ARGUMENTS

1. If the protocol-gate plugin already applied the override (it reports "Phase set to ..."), just confirm the current phase and do nothing else.
2. Otherwise validate the argument: it must be a number 0-12 or one of the phase names INTENT, PREFLIGHT, EXPLORE, INVESTIGATE, ALIGN, DECOMPOSE, SWARM, VERIFY, EXTRACT, EVOLVE, CLEANUP, REPORT, PROTOCOL_NOT_LOADED. If it is invalid, reply with: Error: invalid phase "<value>". Valid: a number 0-12 or a phase name. Do not change anything.
3. Write the override file plugins/protocol-gate/.state/.override-<sessionID>.json (session ID from your context) with content {"phase": <number>, "sessionID": "<sessionID>", "createdAt": "<ISO timestamp>"} and confirm with: Phase set to <NAME> (<number>) for session <sessionID>.
