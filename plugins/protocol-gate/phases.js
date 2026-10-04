// Phase tables for protocol-gate (gate-local).
//
// The state enum plus the per-phase prompt, allowlist, and restriction tables
// move together so phase numbering stays single-source. Stays inside
// plugins/protocol-gate/ — no cross-gate import — so the WHEN state machine
// keeps loading with the other gates disabled.

export const STATES = {
  INTENT: 1,
  PREFLIGHT: 2,
  EXPLORE: 3,
  INVESTIGATE: 4,
  ALIGN: 5,
  DECOMPOSE: 6,
  SWARM: 7,
  VERIFY: 8,
  EXTRACT: 9,
  EVOLVE: 10,
  CLEANUP: 11,
  REPORT: 12
};

// Behavioral constraints injected into the system prompt per phase.
// The Overseer sees these instead of a tool list — tells it WHAT to do and what NOT to do.
export const PHASE_INSTRUCTIONS = {
  // Absolute single-action directive: names the tool and content, no reasoning gap.
  // Positive framing per AGENTS.md — no negative "do NOT" instructions.
  INTENT: "Call write to create an intent KD with the user's exact words as the Raw Request. The Explorer handles all codebase details after dispatch.",
  PREFLIGHT: "Dispatch the Committer agent.",
  EXPLORE: "Dispatch the Explorer agent.",
  INVESTIGATE: "Dispatch the Analyzer agent.",
  ALIGN: "Dispatch the Spec Weaver agent.",
  DECOMPOSE: "Dispatch the Pathfinder agent.",
  SWARM: "Dispatch the Artisan agent. Read the milestone registry KD to track milestone state before each dispatch. Include exactly one MILESTONE ID: matching the registry row you are dispatching. Name the dispatch's RESULT KD milestone-scoped — knowledge/impl-<milestone_id>-<name>-<session_id>-gen<N>.md — so the impl KD checks that milestone off on write.",
  VERIFY: "Dispatch the Inspector agent.",
  EXTRACT: "Dispatch the Scribe agent.",
  EVOLVE: "Dispatch the Habit Builder agent.",
  CLEANUP: "Dispatch the Committer agent.",
  REPORT: "Write a report KD summarizing lifecycle results. Include any corrections and amendments from the lifecycle (e.g., Correction sections) in the report content."
};

export const TOOL_ALLOWLIST = {
  INTENT: ["write", "edit", "read", "skill", "shell", "memory_search"],
  PREFLIGHT: ["subagent", "glob", "shell", "memory_search", "skill"],
  EXPLORE: ["subagent", "glob", "memory_search", "skill"],
  INVESTIGATE: ["subagent", "glob", "memory_search", "skill"],
  ALIGN: ["subagent", "glob", "memory_search", "skill"],
  DECOMPOSE: ["subagent", "glob", "read", "memory_search", "skill"],
  SWARM: ["subagent", "glob", "read", "skill", "memory_search"],
  VERIFY: ["subagent", "glob", "read", "memory_search", "skill"],
  EXTRACT: ["subagent", "glob", "memory_search", "skill"],
  EVOLVE: ["subagent", "glob", "memory_search", "skill"],
  CLEANUP: ["subagent", "glob", "shell", "memory_search", "skill"],
  REPORT: ["edit", "read", "write", "skill", "memory_search"]
};

// Per-tool restrictions for tools that ARE in the allowlist but have path/scope limits.
// tool.definition appends these to the description so the LLM sees the restriction
// instead of treating the tool as fully available.
// Delegation templates are JSON files auto-injected by delegation-gate at
// dispatch — never read by the Overseer. KD-format templates are auto-loaded
// skills loaded via the skill tool. The read restrictions below scope the read
// tool to phase KDs; neither string instructs reading templates.
export const TOOL_RESTRICTIONS = {
  INTENT: { read: "ONLY intent KDs — delegation templates are JSON files auto-injected by delegation-gate at dispatch, never read; KD-format templates are auto-loaded skills (load via the skill tool)", edit: "ONLY knowledge/intent-*.md files — the intent KD is the phase deliverable; other files are not editable in INTENT phase", shell: "ONLY mkdir for knowledge directory creation" },
  DECOMPOSE: { read: "ONLY milestone registry KDs" },
  SWARM: { read: "ONLY milestone registry KDs" },
  VERIFY: { read: "ONLY milestone registry KDs" },
  REPORT: { read: "ONLY knowledge KDs — delegation templates are JSON files auto-injected by delegation-gate at dispatch, never read; KD-format templates are auto-loaded skills (load via the skill tool)" }
};
