---
name: systematic-reasoning
description: "Structured reasoning for decision-making, design, and analysis. Provides multi-approach evaluation and first-principles thinking. Load on-demand when weighing options or analyzing complex problems."
---

# Systematic Reasoning

## OVERVIEW

Structured reasoning techniques for agents that need to weigh options, reason from fundamentals, or design solutions. Replace gut-feel decisions with traceable, principled analysis.

## Multi-Approach Thinking

- Generate 2-3 distinct approaches before choosing any single one
- Evaluate each against explicit criteria: complexity, maintainability, correctness, and fit
- Document why the chosen approach wins — not "best" but "best because..."
- If approaches are too similar to distinguish, merge them and find a genuinely different third path
- Avoid anchoring on the first idea; the first approach is rarely the best

## First-Principles Analysis

- Identify assumptions embedded in the problem statement and conventional wisdom
- Strip each assumption — ask "is this actually true?" and "what evidence supports this?"
- Rebuild from what's provably true, not from what's conventionally done
- If rebuilding from first principles leads to the same solution, that validates your starting point
- Distinguish between constraints (real, immutable boundaries) and conventions (habits, defaults, cargo cult)

## Purpose Check

- After choosing an approach, step back and ask: "Does this actually solve the user's problem?"
- A technically elegant solution that misses the user's need is a failed solution
- If the answer is unclear, restate the user's problem in plain language and re-evaluate
- Flag scope creep: clever additions that weren't requested and don't serve the core need

## Trade-Off Documentation

- When choosing between approaches, record the trade-off explicitly: "Chose X over Y because Z"
- This traceability aids later reviews, rollbacks, and architectural decision records
- If a trade-off later proves wrong, the documentation tells you which assumption to revisit
- Use this format for recording decisions:

  ```
  Decision: <what was chosen>
  Rejected: <what was considered but not chosen>
  Rationale: <why this choice wins for this context>
  Trade-off: <what was sacrificed>
  ```

## CONSTRAINTS

- Do not choose an approach without generating at least one alternative — even if both are evaluated and one wins
- Do not skip the purpose check for time; an irrelevant correct solution is worse than a delayed relevant one
- Do not document trade-offs after the fact as justification — document them during the decision
- Do not treat conventions as constraints; always ask whether the convention serves the current context
