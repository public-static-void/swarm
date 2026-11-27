import { defineConfig } from "vitest/config";

// Root-anchored include: bare `npx vitest run` collects only the swarm test
// files under tests/, never the gitignored references/ vendored tree (issue-34).
export default defineConfig({
  test: {
    include: ["tests/**/*.{test,spec}.?(c|m)[jt]s?(x)"],
    // Defense in depth: the explicit exclude keeps the vendored references/
    // tree out of collection even when include patterns widen later.
    exclude: ["references/**"],
    // The git-spawning suites wait on synchronous child processes whose
    // runtime is what the environment owes them under concurrent agent git
    // activity (the pre-commit hook runs the suite while agents run git), so
    // the budget is a deliberate value at this single config site rather than
    // a framework default crossed by load.
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
});
