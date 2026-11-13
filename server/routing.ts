import { accountPeak } from "../shared/format";
import type { Family, Usage } from "../shared/model";
import { FIVE_HOUR_MINUTES, WEEK_MINUTES } from "./codex";
import { fiveHourWindow, PACE, pacePick, paceMayMove } from "./pace";
import {
  accountsOf,
  defaultAccount,
  findAccount,
  mainAccount,
  type Binding,
  type StoredAccount,
  type StoredState,
} from "./state";

/** Weekly resets only steer a new agent when every account it could use was read this recently. */
const FRESH_READING_MS = 30 * 60_000;
/** How soon a weekly reset has to be for its account to be preferred. */
const NEAR_RESET_MS = 24 * 60 * 60_000;
/** The most a near-reset account may have used of any window, so it still has room to spare. */
const NEAR_RESET_MAX_USED_PERCENT = 80;

export function isLimited(account: StoredAccount, now: number): boolean {
  if (!account.limitedUntil) return false;
  const until = Date.parse(account.limitedUntil);
  return Number.isFinite(until) && until > now;
}

export function isUsable(account: StoredAccount, now: number): boolean {
  return account.signedIn && !account.disabled && !isLimited(account, now);
}

/**
 * Lower is better. Unknown usage ranks in the middle so a known-quiet account wins over a mystery.
 * A full window of one model only, such as "Weekly · Opus", leaves the account its room for the rest.
 */
export function headroomScore(usage: Usage | null | undefined, now = Date.now()): number {
  // A window whose reset has passed since the reading starts again empty: an account that just
  // reset ranks by what is left, not by the full window its last reading showed.
  const windows = usage?.windows.map((window) =>
    window.resetsAt && Date.parse(window.resetsAt) <= now ? { ...window, usedPercent: 0 } : window);
  const peak = windows ? accountPeak(windows) : null;
  return peak ? peak.usedPercent : 50;
}

/**
 * Whether the account's 5-hour window is past pace's gate (`PACE.fiveHourMaxUsed`) and not reset yet.
 * A gated account is about to run out: new work, and work that reopens, goes to an account under the
 * gate first. Unknown counts as open, as it does for pace.
 */
export function fiveHourGated(usage: Usage | null | undefined, now: number): boolean {
  const short = usage ? fiveHourWindow(usage) : undefined;
  if (!short || !Number.isFinite(short.usedPercent)) return false;
  if (short.resetsAt && Date.parse(short.resetsAt) <= now) return false;
  return short.usedPercent >= PACE.fiveHourMaxUsed;
}

/**
 * The usable account with the most room: one under the 5-hour gate before one past it (the peak
 * alone let a seat at 81% of its 5 hours beat the CLI login at 88% of its week, and fill up minutes
 * later), then the lowest peak, preferring the default, then the CLI login, on ties.
 */
export function mostAvailable(
  state: StoredState,
  family: Family,
  usageOf: (accountId: string) => Usage | null | undefined,
  now: number,
  exclude: ReadonlySet<string> = new Set(),
): StoredAccount | undefined {
  const preferred = defaultAccount(state, family)?.id;
  const candidates = accountsOf(state, family).filter(
    (account) => !exclude.has(account.id) && isUsable(account, now),
  );
  const rank = (account: StoredAccount) => [
    fiveHourGated(usageOf(account.id), now) ? 1 : 0,
    headroomScore(usageOf(account.id), now),
    account.id === preferred ? 0 : 1,
    account.kind === "main" ? 0 : 1,
    Date.parse(account.createdAt) || 0,
  ];
  candidates.sort((a, b) => {
    const left = rank(a);
    const right = rank(b);
    for (let index = 0; index < left.length; index += 1) {
      const delta = (left[index] ?? 0) - (right[index] ?? 0);
      if (delta !== 0) return delta;
    }
    return 0;
  });
  return candidates[0];
}

/** Prefer a weekly reset within a day only when every usable account has fresh, complete usage. */
function soonestWeeklyReset(state: StoredState, family: Family, usageOf: RouteInput["usageOf"], now: number): StoredAccount | undefined {
  const candidates = accountsOf(state, family).filter((account) => isUsable(account, now));
  const readings = candidates.map((account) => ({ account, usage: usageOf(account.id) }));
  const complete = readings.every(({ usage }) => {
    if (!usage || usage.error || usage.cached) return false;
    const age = now - Date.parse(usage.fetchedAt);
    const short = usage.windows.find((window) => window.minutes === FIVE_HOUR_MINUTES);
    const weekly = usage.windows.find((window) => window.minutes === WEEK_MINUTES);
    return Number.isFinite(age) && age >= 0 && age <= FRESH_READING_MS && !!short && !!weekly &&
      [short, weekly].every((window) => Number.isFinite(window.usedPercent) && window.usedPercent >= 0 &&
        window.usedPercent <= 100 && window.resetsAt !== null && Date.parse(window.resetsAt) > now);
  });
  if (!complete) return undefined;
  return readings.filter(({ usage }) => {
    const weekly = usage!.windows.find((window) => window.minutes === WEEK_MINUTES)!;
    return usage!.windows.every((window) => window.usedPercent <= NEAR_RESET_MAX_USED_PERCENT) &&
      Date.parse(weekly.resetsAt!) - now <= NEAR_RESET_MS;
  }).sort((a, b) => Date.parse(a.usage!.windows.find((window) => window.minutes === WEEK_MINUTES)!.resetsAt!) -
    Date.parse(b.usage!.windows.find((window) => window.minutes === WEEK_MINUTES)!.resetsAt!))[0]?.account;
}

export interface RouteInput {
  agentId: string;
  family: Family;
  reason: "create" | "resume" | "refresh" | "import";
  now: number;
  autoSwitch: boolean;
  balanceNewAgents: boolean;
  /** Place new portable agents on the account whose weekly quota is most at risk of resetting unused. */
  paceWeeklyUsage?: boolean;
  /**
   * Whether an existing conversation can open on a different account. When it can't (Codex), a
   * thread stays on the account it started on, and only brand-new agents are balanced or rerouted.
   */
  portable: boolean;
  usageOf(accountId: string): Usage | null | undefined;
}

export interface RouteDecision {
  account: StoredAccount;
  /** A binding to persist so the agent stays where it was routed. */
  bind: Binding | null;
  /** Why the preferred account was skipped, if it was. */
  skipped: { account: StoredAccount; why: "limited" | "signed_out" | "disabled" } | null;
}

/**
 * Which account a session opens on: the agent's own binding, else (for balanced new agents) the
 * roomiest account, else the default. An exhausted or signed-out choice is swapped for the roomiest
 * usable account when automatic switching is on — for new agents always, and for existing ones
 * only when their conversation can move between accounts. A disabled choice is always swapped,
 * and the agent keeps its own binding so it returns once the account is enabled again.
 */
export function chooseAccount(state: StoredState, input: RouteInput): RouteDecision | null {
  const accounts = accountsOf(state, input.family);
  if (accounts.length === 0) return null;
  const at = new Date(input.now).toISOString();
  const fresh = input.reason === "create";

  const binding = state.bindings[input.agentId];
  const bound = findAccount(state, binding?.accountId);
  let account = bound && bound.family === input.family ? bound : undefined;
  let bind: Binding | null = null;

  if (!account && fresh && input.paceWeeklyUsage && input.portable && accounts.length > 1) {
    const paced = pacePick(state, input.family, input.usageOf, input.now);
    // Landing on the default changes nothing, so the agent just follows it (and pace may move it later).
    if (paced && paced.id !== defaultAccount(state, input.family)?.id) {
      account = paced;
      bind = { accountId: paced.id, source: "pace", at };
    }
  }
  if (!account && fresh && input.balanceNewAgents && accounts.length > 1) {
    const nearReset = input.family === "codex" ? soonestWeeklyReset(state, input.family, input.usageOf, input.now) : undefined;
    account = nearReset ?? mostAvailable(state, input.family, input.usageOf, input.now);
    if (account) bind = { accountId: account.id, source: "balance", at, selectionReason: nearReset ? "weekly_reset" : "headroom" };
  }
  if (account && !fresh && input.portable && input.autoSwitch && paceMayMove(binding) && accounts.length > 1 &&
      isUsable(account, input.now) && fiveHourGated(input.usageOf(account.id), input.now)) {
    // A reopening agent that ZeroSub placed (spread at creation, or paced) on an account about to run
    // out of its 5 hours goes to one under the gate instead, if there is one. The user's own choice,
    // a limit's re-pin and a thread stay put.
    const open = mostAvailable(state, input.family, input.usageOf, input.now, new Set([account.id]));
    if (open && !fiveHourGated(input.usageOf(open.id), input.now)) {
      account = open;
      bind = { accountId: open.id, source: "balance", at, selectionReason: "headroom" };
    }
  }
  if (!account) {
    // An existing Codex thread ZeroSub never routed (imported from the user's own CLI, or started
    // while ZeroSub was off) ran on the CLI login, so it belongs to that login: on any other account
    // its encrypted reasoning can't be read. Only a brand-new agent follows the default.
    const unrouted = !input.portable && !fresh && !state.sessions[input.agentId] ? mainAccount(state, input.family) : undefined;
    account = unrouted ?? defaultAccount(state, input.family);
    // A thread that can't move is pinned to the account it first opened on.
    if (account && !input.portable) bind = { accountId: account.id, source: "thread", at };
  }
  if (!account) return null;

  let skipped: RouteDecision["skipped"] = null;
  const why = !account.signedIn ? "signed_out" : account.disabled ? "disabled" : isLimited(account, input.now) ? "limited" : null;
  const mayMove = fresh || input.portable;
  // A one-shot helper pinned with `allowLimited` runs on its account's paid usage on purpose.
  const keepLimited = why === "limited" && binding?.allowLimited === true && account === bound;
  if (why && mayMove && !keepLimited && (input.autoSwitch || why !== "limited")) {
    const alternative = mostAvailable(state, input.family, input.usageOf, input.now, new Set([account.id]));
    if (alternative) {
      skipped = { account, why };
      account = alternative;
      // A thread that can't move lives where it starts. Otherwise a disabled account keeps its
      // agents' bindings, so they return when it's enabled again; a limit re-pins them.
      bind =
        !input.portable
          ? { accountId: alternative.id, source: "thread", at }
          : why === "disabled"
            ? null
            : { accountId: alternative.id, source: "auto", at };
    }
  }
  return { account, bind, skipped };
}

/** The account an agent is routed to right now, without side effects (for display). */
export function effectiveAccountId(state: StoredState, agentId: string, family: Family): string | undefined {
  const bound = findAccount(state, state.bindings[agentId]?.accountId);
  if (bound && bound.family === family) return bound.id;
  return defaultAccount(state, family)?.id;
}
