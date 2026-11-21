import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createWalkHarness } from "./walk-unification-fixture.js";

// A single-phase override is a one-hop detour: once the pinned phase's own
// work completes, the lifecycle lands back on the phase the override was
// issued from, not on the hop's serial successor. The return must win even
// when the origin sits numerically behind the hop — VERIFY (8) issued to
// EVOLVE (10) has to come back to 8, where a serial step would carry the
// pointer on to CLEANUP (11) and past the origin the operator left.
describe("Protocol-Gate single-phase override origin-return", () => {
  const h = createWalkHarness(beforeAll, afterAll, beforeEach);

  function clearRecords(s) {
    return h.records("WALK_CLEARED").map(h.parseRecord).filter((r) => r.fields.session === s);
  }

  it("lands back on VERIFY when a hop issued from VERIFY completes", async () => {
    const s = "pin-origin-verify";
    await h.initOverseer(s);
    h.hooks.sessionPhaseMap.set(s, h.hooks.STATES.VERIFY);
    h.hooks.sessionPhaseMap.set(`${s}:sid`, s);

    await h.commit(s, "EVOLVE");
    expect(h.hooks.sessionPhaseMap.get(s), "the pin did not move to the named hop").toBe(h.hooks.STATES.EVOLVE);
    expect(h.safePoint(s)?.phase, "the pin did not snapshot its origin").toBe(h.hooks.STATES.VERIFY);

    // Fresh evidence at the pinned phase completes the hop.
    h.createFreshKD(`process-${s}.md`, "process evidence");
    await h.tick(s, "origin-verify-complete");

    expect(
      h.hooks.sessionPhaseMap.get(s),
      "the completed hop advanced to the default successor instead of returning to its origin"
    ).toBe(h.hooks.STATES.VERIFY);
    expect(h.marker(s), "the completed hop left its override marker behind").toBeFalsy();
    expect(h.safePoint(s), "the completed hop left its safe point behind").toBeFalsy();

    const cleared = clearRecords(s);
    expect(cleared, "the completed hop left no clear record").toHaveLength(1);
    expect(cleared[0].fields.reason).toBe("origin-return");
    expect(cleared[0].fields.to).toBe(String(h.hooks.STATES.VERIFY));
  });

  it("lands back on CLEANUP when a hop issued from CLEANUP completes", async () => {
    const s = "pin-origin-cleanup";
    await h.initOverseer(s);
    h.hooks.sessionPhaseMap.set(s, h.hooks.STATES.CLEANUP);
    h.hooks.sessionPhaseMap.set(`${s}:sid`, s);

    await h.commit(s, "VERIFY");
    expect(h.hooks.sessionPhaseMap.get(s), "the pin did not move to the named hop").toBe(h.hooks.STATES.VERIFY);
    expect(h.safePoint(s)?.phase, "the pin did not snapshot its origin").toBe(h.hooks.STATES.CLEANUP);

    // A fresh passing review completes the hop at VERIFY.
    h.createFreshKD(`review-pass-${s}.md`, h.reviewKD("PASS"));
    await h.tick(s, "origin-cleanup-complete");

    expect(h.hooks.sessionPhaseMap.get(s)).toBe(h.hooks.STATES.CLEANUP);
    expect(h.marker(s), "the completed hop left its override marker behind").toBeFalsy();
    expect(h.safePoint(s), "the completed hop left its safe point behind").toBeFalsy();

    const cleared = clearRecords(s);
    expect(cleared, "the completed hop left no clear record").toHaveLength(1);
    expect(cleared[0].fields.reason).toBe("origin-return");
    expect(cleared[0].fields.to).toBe(String(h.hooks.STATES.CLEANUP));
  });
});
