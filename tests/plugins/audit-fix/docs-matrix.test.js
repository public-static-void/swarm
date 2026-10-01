import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import {
  clearAttributionCache,
  loadAgentShellAllowlist,
} from "../../../plugins/protocol-gate/attribution.js";

// The top-level doc pins the shell capability variance across roles and the
// gate debug switches, so agents read exact tokens and routing guidance there
// instead of guessing from a single denial.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const agentsDoc = readFileSync(join(repoRoot, "AGENTS.md"), "utf8");

function livePatterns(agent) {
  const loaded = loadAgentShellAllowlist(agent);
  expect(loaded.patterns).not.toBeNull();
  return loaded.patterns;
}

function docTableRows() {
  const lines = agentsDoc.split("\n").filter((line) => line.startsWith("|"));
  const header = lines.find((line) => line.includes("artisan"));
  expect(header).toBeDefined();
  const roles = header
    .split("|")
    .map((cell) => cell.trim().replace(/`/g, ""))
    .filter((cell) => cell.length > 0)
    .slice(1);
  const rows = lines.filter((line) => line.includes("`"));
  return { roles, rows };
}

function docCell(rowLine, roleIndex) {
  const cells = rowLine.split("|").map((cell) => cell.trim());
  return cells[roleIndex + 2].replace(/`/g, "");
}

beforeEach(() => {
  clearAttributionCache();
});

describe("doc make tokens", () => {
  it("carries the exact make family tokens", () => {
    expect(agentsDoc).toContain("make test*");
    expect(agentsDoc).toContain("make build*");
  });

  it("carries zero hyphenated make family tokens", () => {
    expect(agentsDoc).not.toContain("make test-*");
    expect(agentsDoc).not.toContain("make build-*");
  });
});

describe("capability matrix drift pin", () => {
  const families = [
    {
      label: "make test*",
      pattern: "make test*",
      cells: {
        artisan: true,
        analyzer: true,
        explorer: false,
        committer: false,
        overseer: false,
      },
    },
    {
      label: "make build*",
      pattern: "make build*",
      cells: {
        artisan: true,
        analyzer: false,
        explorer: false,
        committer: false,
        overseer: false,
      },
    },
    {
      label: "npx vitest*",
      pattern: "npx vitest*",
      cells: {
        artisan: true,
        analyzer: true,
        explorer: false,
        committer: false,
        overseer: false,
      },
    },
    {
      label: "cat*",
      pattern: "cat*",
      cells: {
        artisan: true,
        analyzer: true,
        explorer: true,
        committer: false,
        overseer: false,
      },
    },
    {
      label: "find*",
      pattern: "find*",
      cells: {
        artisan: false,
        analyzer: true,
        explorer: true,
        committer: false,
        overseer: false,
      },
    },
    {
      label: "grep*",
      pattern: "grep*",
      cells: {
        artisan: false,
        analyzer: false,
        explorer: false,
        committer: false,
        overseer: false,
      },
    },
  ];

  it("matches the live agent definitions cell by cell", () => {
    for (const family of families) {
      for (const [role, documented] of Object.entries(family.cells)) {
        const live = livePatterns(role).includes(family.pattern);
        expect(
          live,
          `matrix drift: ${role} ${family.pattern} documented ${documented}, live ${live}`
        ).toBe(documented);
      }
    }
  });

  it("publishes one matrix row per capability family with live-matching cells", () => {
    const { roles, rows } = docTableRows();
    for (const family of families) {
      const rowLine = rows.find((line) => line.includes(family.label));
      expect(rowLine, `matrix row present for ${family.label}`).toBeDefined();
      for (const role of Object.keys(family.cells)) {
        const roleIndex = roles.indexOf(role);
        expect(roleIndex).toBeGreaterThanOrEqual(0);
        const documented = docCell(rowLine, roleIndex) === "yes";
        const live = livePatterns(role).includes(family.pattern);
        expect(
          documented,
          `doc cell drift: ${role} ${family.label}`
        ).toBe(live);
      }
    }
  });

  it("routes shell search to the dedicated tool for every role", () => {
    expect(agentsDoc).toContain("Grep tool serves every role");
  });
});

describe("sentinel discoverability", () => {
  const gates = ["knowledge-gate", "delegation-gate", "protocol-gate"];

  it("names each gate sentinel path in the top-level doc", () => {
    for (const gate of gates) {
      expect(agentsDoc).toContain(`plugins/${gate}/.debug`);
    }
  });

  it("states each sentinel path in its plugin header", () => {
    for (const gate of gates) {
      const header = readFileSync(
        join(repoRoot, "plugins", gate, "index.js"),
        "utf8"
      )
        .split("\n")
        .slice(0, 60)
        .join("\n");
      expect(header).toContain(".debug");
      expect(header).toContain(`plugins/${gate}/.debug`);
    }
  });
});

describe("hook reference", () => {
  it("names the attribution message as the primary denial source", () => {
    expect(agentsDoc).toContain("attribution");
    expect(agentsDoc).toContain("DENIED segment");
    expect(agentsDoc).toContain("Try next");
  });

  it("keeps per-segment solo retry as the fallback path", () => {
    expect(agentsDoc).toContain("re-run each segment alone");
  });
});
