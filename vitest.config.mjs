import { defineConfig } from "vitest/config";

// Root-anchored include: bare `npx vitest run` collects only the swarm test
// files under tests/, never the gitignored references/ vendored tree (issue-34).
export default defineConfig({
  test: {
    include: ["tests/**/*.{test,spec}.?(c|m)[jt]s?(x)"]
  }
});
