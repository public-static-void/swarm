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
  // Each instruction states the expected action; limiter words belong to the
  // structural layers that enforce them.
  INTENT: "Call write to create an intent KD in one complete write — assemble every section and every amendment or correction before the first write, because the INTENT edit window closes on that successful write. Fill the Raw Request from the classification: a task specification addressed to the swarm is copied verbatim, because a paraphrase mangles what downstream agents must execute; a discussion with you about process is summarized, and its gist — what is to be done — becomes the request, with the message listed in Triage Notes beside its disposition. A message about your conduct or the process state is a disposition only, never request material. Discriminating test: would a downstream agent need these exact words to do its job? Position is a tie-breaker, not the rule — a later message carrying the task specification becomes the Raw Request verbatim. Distill later follow-up messages into Triage Notes with their disposition. The Explorer handles all codebase details after dispatch.",
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

// The short-term note family is phase-agnostic on purpose. The short-term store
// is the durable carrier for state that must survive a compaction, and the
// knowledge-gate advertises its resume read (`memory_note_read`) to every agent
// on every call — so a phase that admits the write without the read would leave
// a note no phase can retrieve. Admit the whole family everywhere; the store's
// own ownership rules (owner-only reads, Scribe's promotion scan) stay with the
// knowledge-gate, not the phase layer.
export const TOOL_ALLOWLIST = {
  INTENT: ["write", "edit", "read", "skill", "shell", "memory_note", "memory_note_read", "memory_notes_list", "memory_note_delete", "memory_search"],
  PREFLIGHT: ["subagent", "glob", "shell", "memory_note", "memory_note_read", "memory_notes_list", "memory_note_delete", "memory_search", "skill"],
  EXPLORE: ["subagent", "glob", "memory_note", "memory_note_read", "memory_notes_list", "memory_note_delete", "memory_search", "skill"],
  INVESTIGATE: ["subagent", "glob", "memory_note", "memory_note_read", "memory_notes_list", "memory_note_delete", "memory_search", "skill"],
  ALIGN: ["subagent", "glob", "memory_note", "memory_note_read", "memory_notes_list", "memory_note_delete", "memory_search", "skill"],
  DECOMPOSE: ["subagent", "glob", "read", "memory_note", "memory_note_read", "memory_notes_list", "memory_note_delete", "memory_search", "skill"],
  SWARM: ["subagent", "glob", "read", "skill", "memory_note", "memory_note_read", "memory_notes_list", "memory_note_delete", "memory_search"],
  VERIFY: ["subagent", "glob", "read", "memory_note", "memory_note_read", "memory_notes_list", "memory_note_delete", "memory_search", "skill"],
  EXTRACT: ["subagent", "glob", "memory_note", "memory_note_read", "memory_notes_list", "memory_note_delete", "memory_search", "skill"],
  EVOLVE: ["subagent", "glob", "memory_note", "memory_note_read", "memory_notes_list", "memory_note_delete", "memory_search", "skill"],
  CLEANUP: ["subagent", "glob", "shell", "memory_note", "memory_note_read", "memory_notes_list", "memory_note_delete", "memory_search", "skill"],
  REPORT: ["edit", "read", "write", "skill", "memory_note", "memory_note_read", "memory_notes_list", "memory_note_delete", "memory_search"]
};

// Tools that are never phase-blocked because they carry or delegate work: the
// phase gate governs the inner/child tool they invoke instead. `execute` is
// the Code Mode carrier whose nested calls reach the gate as their own tool
// ids; `subagent` dispatches to another agent whose session has its own phase
// context. Keeping the set here means one admission predicate feeds every
// enforcement and advertisement site, so a renamed carrier is one table entry.
export const TRANSPORT_TOOLS = ["subagent", "execute"];

// Single admission predicate for every enforcement and advertisement site: a
// tool may run in a phase when it is a transport tool or when the phase
// allowlist names it. Anything else is refused — an unknown id fails closed
// rather than being silently carried.
export function admitTool(phaseName, tool) {
  return TRANSPORT_TOOLS.includes(tool) || (TOOL_ALLOWLIST[phaseName] || []).includes(tool);
}

// Per-tool restrictions for tools that ARE in the allowlist but have path/scope limits.
// tool.definition appends these to the description so the LLM sees the restriction
// instead of treating the tool as fully available.
// Delegation templates are JSON files auto-injected by delegation-gate at
// dispatch — never read by the Overseer. KD-format templates are auto-loaded
// skills loaded via the skill tool. The read restrictions below scope the read
// tool to phase KDs; neither string instructs reading templates.
//
// glob needs the same treatment read gets: the gate advertises tools to the
// Overseer by name, while the Overseer's permission block grants glob by
// resource scope only (agents/overseer.md). Without a scope entry the
// advertisement promises tree browsing the grant refuses, so every phase that
// lists glob advertises the granted scope alongside the name. The grant stands
// — widening it to match the advertisement is the failure this closes.
const OVERSEER_GLOB_SCOPE =
  "ONLY knowledge/intent-*.md, knowledge/report-*.md, knowledge/milestones-*.md — docs-scoped: the Overseer glob grant stays as granted and is never widened to satisfy this advertisement";

export const TOOL_RESTRICTIONS = {
  INTENT: { read: "ONLY intent KDs — delegation templates are JSON files auto-injected by delegation-gate at dispatch, never read; KD-format templates are auto-loaded skills (load via the skill tool)", edit: "ONLY knowledge/intent-*.md files — the intent KD is the phase deliverable; other files are not editable in INTENT phase", shell: "ONLY mkdir for knowledge directory creation" },
  PREFLIGHT: { glob: OVERSEER_GLOB_SCOPE },
  EXPLORE: { glob: OVERSEER_GLOB_SCOPE },
  INVESTIGATE: { glob: OVERSEER_GLOB_SCOPE },
  ALIGN: { glob: OVERSEER_GLOB_SCOPE },
  DECOMPOSE: { read: "ONLY milestone registry KDs", glob: OVERSEER_GLOB_SCOPE },
  SWARM: { read: "ONLY milestone registry KDs", glob: OVERSEER_GLOB_SCOPE },
  VERIFY: { read: "ONLY milestone registry KDs", glob: OVERSEER_GLOB_SCOPE },
  EXTRACT: { glob: OVERSEER_GLOB_SCOPE },
  EVOLVE: { glob: OVERSEER_GLOB_SCOPE },
  CLEANUP: { glob: OVERSEER_GLOB_SCOPE },
  REPORT: { read: "ONLY report KDs — delegation templates are JSON files auto-injected by delegation-gate at dispatch, never read; KD-format templates are auto-loaded skills (load via the skill tool)" }
};
