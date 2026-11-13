import { describe, expect, it } from "vitest";
import type { Usage } from "../shared/model";
import {
  ON_PACE_SCORE,
  PACE,
  paceBindingsToDrop,
  paceCanTouch,
  pacePick,
  paceScore,
  planPaceMove,
  type PaceAgent,
  type PlanInput,
} from "./pace";
import { chooseAccount } from "./routing";
import { emptyState, type Binding, type StoredAccount, type StoredState } from "./state";

const NOW = Date.parse("2026-11-10T12:00:00Z");
const HOUR = 3_600_000;
const MAIN = "claude-main"; // alice@example.com: the CLI login and the default
const SEAT = "seat-a";

function account(id: string, partial: Partial<StoredAccount> = {}): StoredAccount {
  return {
    id,
    family: "claude",
    label: id === MAIN ? "alice@example.com" : id,
    autoLabel: false,
    kind: id === MAIN ? "main" : "managed",
    home: id === MAIN ? null : `/homes/${id}`,
    email: null,
    plan: null,
    organization: null,
    identity: null,
    signedIn: true,
    disabled: false,
    limitedUntil: null,
    limitKind: null,
    limitedAt: null,
    createdAt: "2026-09-01T00:00:00Z",
    ...partial,
  };
}

/** A Claude reading: weekly `[used %, hours to reset]`, and the 5-hour window's used %. */
function reading(weekly: [number, number] | null, fiveHour = 20, patch: Partial<Usage> = {}): Usage {
  return {
    fetchedAt: new Date(NOW - 60_000).toISOString(),
    windows: [
      { id: "five_hour", label: "5-hour", usedPercent: fiveHour, resetsAt: new Date(NOW + 2 * HOUR).toISOString() },
      ...(weekly
        ? [{ id: "seven_day", label: "Weekly", usedPercent: weekly[0], resetsAt: new Date(NOW + weekly[1] * HOUR).toISOString() }]
        : []),
    ],
    error: null,
    cached: false,
    resets: null,
    credits: null,
    ...patch,
  };
}

/** Yesterday: alice@example.com 64% used, resets in 4d9h; seat-a 37% used, resets in 2d7h. */
const YESTERDAY: Record<string, Usage> = {
  [MAIN]: reading([64, 4 * 24 + 9]),
  [SEAT]: reading([37, 2 * 24 + 7]),
};

function stateWith(bindings: Record<string, Binding> = {}, accounts = [account(MAIN), account(SEAT)]): StoredState {
  return { ...emptyState(), accounts, defaults: { claude: MAIN, codex: null }, bindings };
}

function agent(id: string, partial: Partial<PaceAgent> = {}): PaceAgent {
  return {
    id,
    family: "claude",
    status: "idle",
    archived: false,
    background: false,
    pendingPermissions: 0,
    updatedAt: NOW - 30 * 60_000,
    contextTokens: 50_000,
    backgroundJobs: 0,
    runningOn: MAIN,
    ...partial,
  };
}

describe("background work", () => {
  it("an agent with background jobs is never touchable: a move would kill them", () => {
    expect(paceCanTouch(agent("a"), NOW)).toBe(true);
    expect(paceCanTouch(agent("a", { backgroundJobs: 1 }), NOW)).toBe(false);
  });
});

function plan(partial: Partial<PlanInput> = {}) {
  return planPaceMove({
    state: stateWith(),
    family: "claude",
    agents: [agent("a")],
    usageOf: (id) => YESTERDAY[id],
    now: NOW,
    enabled: true,
    lastMoveAt: 0,
    recentlyRouted: () => false,
    ...partial,
  });
}

describe("pace score", () => {
  it("scores yesterday's accounts by remaining weekly % per hour to the reset", () => {
    expect(paceScore(YESTERDAY[MAIN], NOW)).toBeCloseTo(36 / 105, 5);
    expect(paceScore(YESTERDAY[SEAT], NOW)).toBeCloseTo(63 / 55, 5);
    // alice@example.com is over pace, seat-a well under it.
    expect(paceScore(YESTERDAY[MAIN], NOW)!).toBeLessThan(ON_PACE_SCORE);
    expect(paceScore(YESTERDAY[SEAT], NOW)!).toBeGreaterThan(ON_PACE_SCORE * PACE.ratio);
  });

  it("can't tell from a missing, stale, cached or past-reset reading", () => {
    expect(paceScore(undefined, NOW)).toBeNull();
    expect(paceScore(reading(null), NOW)).toBeNull();
    expect(paceScore(reading([40, 50], 20, { cached: true }), NOW)).toBeNull();
    expect(paceScore(reading([40, 50], 20, { fetchedAt: new Date(NOW - 2 * HOUR).toISOString() }), NOW)).toBeNull();
    expect(paceScore(reading([40, -1]), NOW)).toBeNull();
  });

  it("doesn't explode as the reset nears", () => {
    expect(paceScore(reading([10, 0.01]), NOW)).toBe(90 / PACE.minHours);
  });
});

describe("placing new agents", () => {
  it("puts yesterday's new agents on seat-a, bound by pace, not by the user", () => {
    expect(pacePick(stateWith(), "claude", (id) => YESTERDAY[id], NOW)?.id).toBe(SEAT);
    const decision = chooseAccount(stateWith(), {
      agentId: "new",
      family: "claude",
      reason: "create",
      now: NOW,
      autoSwitch: true,
      balanceNewAgents: false,
      paceWeeklyUsage: true,
      portable: true,
      usageOf: (id) => YESTERDAY[id],
    });
    expect(decision?.account.id).toBe(SEAT);
    expect(decision?.bind?.source).toBe("pace");
  });

  it("changes nothing with pacing off", () => {
    const decision = chooseAccount(stateWith(), {
      agentId: "new",
      family: "claude",
      reason: "create",
      now: NOW,
      autoSwitch: true,
      balanceNewAgents: false,
      paceWeeklyUsage: false,
      portable: true,
      usageOf: (id) => YESTERDAY[id],
    });
    expect(decision).toMatchObject({ account: { id: MAIN }, bind: null });
  });

  it("only places new agents: an existing one keeps its account", () => {
    const decision = chooseAccount(stateWith(), {
      agentId: "old",
      family: "claude",
      reason: "resume",
      now: NOW,
      autoSwitch: true,
      balanceNewAgents: false,
      paceWeeklyUsage: true,
      portable: true,
      usageOf: (id) => YESTERDAY[id],
    });
    expect(decision).toMatchObject({ account: { id: MAIN }, bind: null });
  });

  it("leaves conversations that can't change accounts (Codex) to their own rule", () => {
    const decision = chooseAccount(stateWith(), {
      agentId: "new",
      family: "claude",
      reason: "create",
      now: NOW,
      autoSwitch: true,
      balanceNewAgents: false,
      paceWeeklyUsage: true,
      portable: false,
      usageOf: (id) => YESTERDAY[id],
    });
    expect(decision?.bind?.source).toBe("thread");
    expect(decision?.account.id).toBe(MAIN);
  });

  it("counts an unknown reading as exactly on pace", () => {
    // Seat unknown: the over-paced default loses to it; an under-paced default beats it.
    expect(pacePick(stateWith(), "claude", (id) => (id === MAIN ? YESTERDAY[MAIN] : undefined), NOW)?.id).toBe(SEAT);
    expect(pacePick(stateWith(), "claude", (id) => (id === MAIN ? reading([10, 24]) : undefined), NOW)?.id).toBe(MAIN);
    // Nothing known: the default, and no pace binding.
    const decision = chooseAccount(stateWith(), {
      agentId: "new",
      family: "claude",
      reason: "create",
      now: NOW,
      autoSwitch: true,
      balanceNewAgents: false,
      paceWeeklyUsage: true,
      portable: true,
      usageOf: () => undefined,
    });
    expect(decision).toMatchObject({ account: { id: MAIN }, bind: null });
  });

  it("skips an account whose 5-hour window is nearly full, or that is limited", () => {
    const busySeat: Record<string, Usage> = { ...YESTERDAY, [SEAT]: reading([37, 55], PACE.fiveHourMaxUsed) };
    expect(pacePick(stateWith(), "claude", (id) => busySeat[id], NOW)?.id).toBe(MAIN);
    const limited = stateWith({}, [account(MAIN), account(SEAT, { limitedUntil: new Date(NOW + HOUR).toISOString() })]);
    expect(pacePick(limited, "claude", (id) => YESTERDAY[id], NOW)?.id).toBe(MAIN);
    const disabled = stateWith({}, [account(MAIN), account(SEAT, { disabled: true })]);
    expect(pacePick(disabled, "claude", (id) => YESTERDAY[id], NOW)?.id).toBe(MAIN);
  });
});

describe("moving idle agents", () => {
  it("moves one of yesterday's idle alice@example.com agents to seat-a", () => {
    expect(plan()).toEqual({ agentId: "a", family: "claude", from: MAIN, to: SEAT, reason: "pace" });
  });

  it("moves at most one agent per interval", () => {
    const agents = Array.from({ length: 20 }, (_, index) => agent(`a${index}`));
    expect(plan({ agents, lastMoveAt: NOW - PACE.moveEveryMs + 1 })).toBeNull();
    expect(plan({ agents, lastMoveAt: NOW - PACE.moveEveryMs })).not.toBeNull();
  });

  it("holds still inside the dead band, and moves once the gap is clear", () => {
    // seat at 1.4× tom's score: nothing moves either way.
    const close: Record<string, Usage> = { [MAIN]: reading([50, 100]), [SEAT]: reading([30, 100]) }; // 0.5 vs 0.7 → 1.4×
    expect(plan({ usageOf: (id) => close[id] })).toBeNull();
    expect(plan({ usageOf: (id) => close[id], agents: [agent("b", { runningOn: SEAT })] })).toBeNull();
    const clear: Record<string, Usage> = { [MAIN]: reading([50, 100]), [SEAT]: reading([25, 100]) }; // 0.5 vs 0.75 → 1.5×
    expect(plan({ usageOf: (id) => clear[id] })?.to).toBe(SEAT);
  });

  it("moves back the other way only past the same gap", () => {
    const reversed: Record<string, Usage> = { [MAIN]: reading([10, 50]), [SEAT]: reading([60, 100]) }; // 1.8 vs 0.4
    expect(plan({ usageOf: (id) => reversed[id], agents: [agent("b", { runningOn: SEAT })] })?.to).toBe(MAIN);
  });

  it("needs both readings known, and the target open", () => {
    expect(plan({ usageOf: (id) => (id === MAIN ? YESTERDAY[MAIN] : undefined) })).toBeNull();
    expect(plan({ usageOf: (id) => (id === SEAT ? YESTERDAY[SEAT] : undefined) })).toBeNull();
    const busySeat: Record<string, Usage> = { ...YESTERDAY, [SEAT]: reading([37, 55], 90) };
    expect(plan({ usageOf: (id) => busySeat[id] })).toBeNull();
  });

  it("never moves a manual pin, a limit's move or a thread", () => {
    for (const source of ["user", "auto", "thread"] as const) {
      const state = stateWith({ a: { accountId: MAIN, source, at: new Date(NOW - 24 * HOUR).toISOString() } });
      expect(plan({ state })).toBeNull();
    }
  });

  it("moves agents that follow the default, were spread at creation, or were placed by pace", () => {
    expect(plan()?.agentId).toBe("a");
    const balance = stateWith({ a: { accountId: MAIN, source: "balance", at: new Date(NOW - 24 * HOUR).toISOString() } });
    expect(plan({ state: balance })?.agentId).toBe("a");
    const paced = stateWith({ a: { accountId: MAIN, source: "pace", at: new Date(NOW - 7 * HOUR).toISOString() } });
    expect(plan({ state: paced })?.agentId).toBe("a");
  });

  it("leaves an agent alone for a while after pace or the user moved it", () => {
    const paced = stateWith({ a: { accountId: MAIN, source: "pace", at: new Date(NOW - HOUR).toISOString() } });
    expect(plan({ state: paced })).toBeNull();
    expect(plan({ recentlyRouted: (id) => id === "a" })).toBeNull();
  });

  it("never picks a closed, archived, running, failed, starting or waiting agent", () => {
    for (const status of ["closed", "running", "initializing", "error"]) expect(plan({ agents: [agent("a", { status })] })).toBeNull();
    expect(plan({ agents: [agent("a", { archived: true })] })).toBeNull();
    // A background helper (another plugin's job) is never ours to move, whatever its binding.
    expect(plan({ agents: [agent("a", { background: true })] })).toBeNull();
    expect(plan({ agents: [agent("a", { background: true }), agent("b")] })?.agentId).toBe("b");
    expect(plan({ agents: [agent("a", { pendingPermissions: 1 })] })).toBeNull();
    // Never opened by ZeroSub: no session to move.
    expect(plan({ agents: [agent("a", { runningOn: undefined })] })).toBeNull();
  });

  it("only picks agents that went quiet a few minutes ago and were active within 6 hours", () => {
    expect(plan({ agents: [agent("a", { updatedAt: NOW - 60_000 })] })).toBeNull();
    expect(plan({ agents: [agent("a", { updatedAt: NOW - PACE.maxIdleMs - 1 })] })).toBeNull();
    expect(plan({ agents: [agent("a", { updatedAt: NOW - PACE.maxIdleMs })] })?.agentId).toBe("a");
  });

  it("picks the smallest context first, then the most recently active", () => {
    const agents = [
      agent("big", { contextTokens: 400_000 }),
      agent("unknown", { contextTokens: null }),
      agent("small-old", { contextTokens: 20_000, updatedAt: NOW - 5 * HOUR }),
      agent("small-recent", { contextTokens: 20_000, updatedAt: NOW - 10 * 60_000 }),
    ];
    expect(plan({ agents })?.agentId).toBe("small-recent");
    expect(plan({ agents: agents.filter((entry) => !entry.id.startsWith("small")) })?.agentId).toBe("big");
  });

  it("stops once the accounts are on pace with each other", () => {
    const even: Record<string, Usage> = { [MAIN]: reading([50, 84]), [SEAT]: reading([50, 84]) };
    expect(plan({ usageOf: (id) => even[id] })).toBeNull();
  });
});

describe("turning pacing off", () => {
  const paced = (at = NOW - HOUR): Binding => ({ accountId: SEAT, source: "pace", at: new Date(at).toISOString() });

  it("returns one open idle pace agent to the default per interval", () => {
    const state = stateWith({ a: paced(), b: paced(), c: { accountId: SEAT, source: "user", at: new Date(NOW).toISOString() } });
    const agents = ["a", "b", "c"].map((id) => agent(id, { runningOn: SEAT }));
    expect(plan({ state, agents, enabled: false })).toMatchObject({ to: null, from: SEAT, reason: "pace_off" });
    expect(plan({ state, agents, enabled: false, lastMoveAt: NOW - 60_000 })).toBeNull();
    // A manual pin is never returned.
    expect(plan({ state, agents: [agent("c", { runningOn: SEAT })], enabled: false })).toBeNull();
    // Nor a busy one.
    expect(plan({ state, agents: [agent("a", { runningOn: SEAT, status: "running" })], enabled: false })).toBeNull();
  });

  it("drops the bindings of agents that aren't open without waking them, and keeps the open ones for later", () => {
    const state = stateWith({ open: paced(), closed: paced(), pinned: { accountId: SEAT, source: "user", at: new Date(NOW).toISOString() } });
    expect(paceBindingsToDrop(state, false, new Set(["open"]))).toEqual(["closed"]);
    expect(paceBindingsToDrop(state, true, new Set(["open"]))).toEqual([]);
    // An incomplete agent list drops nothing.
    expect(paceBindingsToDrop(state, false, null)).toEqual([]);
  });

  it("drops a pace binding that already points at the default without a reload", () => {
    const state = stateWith({ a: { accountId: MAIN, source: "pace", at: new Date(NOW).toISOString() } });
    expect(paceBindingsToDrop(state, false, new Set(["a"]))).toEqual(["a"]);
  });
});
