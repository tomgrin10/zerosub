import type { Family, Usage, UsageWindow } from "../shared/model";
import { FIVE_HOUR_MINUTES, WEEK_MINUTES } from "./codex";
import { isUsable } from "./routing";
import { accountsOf, defaultAccount, type Binding, type StoredAccount, type StoredState } from "./state";

/**
 * "Pace weekly usage": steer Claude work toward the account whose weekly quota is most at risk of
 * resetting unused, and move idle agents there a few at a time. Everything here is pure so the
 * service only feeds it state, readings and the agent list, then acts on one decision.
 */
export const PACE = {
  /** A reading older than this (or the CLI's own cached copy) says nothing about pace. */
  freshMs: 60 * 60_000,
  /** An account whose 5-hour window is this full gets no new or moved work. */
  fiveHourMaxUsed: 80,
  /** Hours to the reset are floored here, so a reset minutes away doesn't make the score explode. */
  minHours: 1,
  /** A move needs the target's score to be at least this many times the source's. Inverse is the dead band. */
  ratio: 1.5,
  /** At most one pace move (either direction) per this long. */
  moveEveryMs: 10 * 60_000,
  /** An agent pace moved, or the user re-routed, isn't pace-moved again for this long. */
  agentCooldownMs: 6 * 60 * 60_000,
  /** An agent must have been idle this long, so a reload doesn't race the user's next message. */
  minIdleMs: 3 * 60_000,
  /**
   * Only agents active this recently: a move shifts usage only if the agent works again soon, and
   * reloading a long-idle one restarts a process for nothing (dormant agents are never woken).
   */
  maxIdleMs: 6 * 60 * 60_000,
} as const;

/** A full week spread evenly: the score of an account exactly on pace, and what an unknown reading counts as. */
export const ON_PACE_SCORE = 100 / (WEEK_MINUTES / 60);

const WEEKLY_IDS = new Set(["seven_day", "secondary"]);
const SHORT_IDS = new Set(["five_hour", "primary"]);

function findWindow(usage: Usage, minutes: number, ids: ReadonlySet<string>): UsageWindow | undefined {
  // Codex says how long its windows are; Claude's are known by id.
  return usage.windows.find((window) => window.minutes === minutes) ??
    usage.windows.find((window) => window.minutes == null && ids.has(window.id));
}

export function weeklyWindow(usage: Usage): UsageWindow | undefined {
  return findWindow(usage, WEEK_MINUTES, WEEKLY_IDS);
}

export function fiveHourWindow(usage: Usage): UsageWindow | undefined {
  return findWindow(usage, FIVE_HOUR_MINUTES, SHORT_IDS);
}

/**
 * Remaining weekly % per hour left until the weekly reset: how fast the account would have to burn
 * to use its week. Higher means more is at risk of resetting unused. `null` when the reading can't
 * tell (missing, stale, cached, no weekly window, or its reset already passed).
 */
export function paceScore(usage: Usage | null | undefined, now: number): number | null {
  if (!usage || usage.cached) return null;
  const age = now - Date.parse(usage.fetchedAt);
  if (!Number.isFinite(age) || age < 0 || age > PACE.freshMs) return null;
  const weekly = weeklyWindow(usage);
  if (!weekly || !Number.isFinite(weekly.usedPercent) || !weekly.resetsAt) return null;
  const resetsAt = Date.parse(weekly.resetsAt);
  if (!Number.isFinite(resetsAt) || resetsAt <= now) return null;
  const remaining = Math.min(100, Math.max(0, 100 - weekly.usedPercent));
  const hours = Math.max(PACE.minHours, (resetsAt - now) / 3_600_000);
  return remaining / hours;
}

/** Can the account take more work now? Usable, and its 5-hour window has room (unknown counts as room). */
export function paceOpen(account: StoredAccount, usage: Usage | null | undefined, now: number): boolean {
  if (!isUsable(account, now)) return false;
  const short = usage ? fiveHourWindow(usage) : undefined;
  if (!short || (short.resetsAt && Date.parse(short.resetsAt) <= now)) return true;
  return short.usedPercent < PACE.fiveHourMaxUsed;
}

export interface PacedAccount {
  account: StoredAccount;
  /** `null`: unknown. */
  score: number | null;
}

/** The accounts of `family` that may take work, with their scores. */
export function pacedAccounts(
  state: StoredState,
  family: Family,
  usageOf: (accountId: string) => Usage | null | undefined,
  now: number,
): PacedAccount[] {
  return accountsOf(state, family)
    .filter((account) => paceOpen(account, usageOf(account.id), now))
    .map((account) => ({ account, score: paceScore(usageOf(account.id), now) }));
}

/**
 * Where a new agent goes: the open account with the highest score, an unknown one counting as
 * exactly on pace. Ties prefer the default, then the CLI login. `undefined` when no account is open,
 * so routing falls back to its usual choice.
 */
export function pacePick(
  state: StoredState,
  family: Family,
  usageOf: (accountId: string) => Usage | null | undefined,
  now: number,
): StoredAccount | undefined {
  const preferred = defaultAccount(state, family)?.id;
  const ranked = pacedAccounts(state, family, usageOf, now).sort(
    (a, b) =>
      (b.score ?? ON_PACE_SCORE) - (a.score ?? ON_PACE_SCORE) ||
      (a.account.id === preferred ? 0 : 1) - (b.account.id === preferred ? 0 : 1) ||
      (a.account.kind === "main" ? 0 : 1) - (b.account.kind === "main" ? 0 : 1),
  );
  return ranked[0]?.account;
}

/** What the planner needs to know about an agent. */
export interface PaceAgent {
  id: string;
  family: Family;
  status: string;
  archived: boolean;
  /** A background helper (another plugin's job, say): short-lived, never ours to move. */
  background: boolean;
  /** Permission prompts waiting on the user. */
  pendingPermissions: number;
  /** When the agent last changed (Paseo's `updatedAt`), as epoch ms. */
  updatedAt: number;
  /** Tokens in its context window after the last turn; a move costs a cache miss of about this much. */
  contextTokens: number | null;
  /** The account its live session runs on. */
  runningOn: string | undefined;
}

export interface PaceMove {
  agentId: string;
  family: Family;
  from: string;
  /** `null`: back to following the default (pace was turned off). */
  to: string | null;
  reason: "pace" | "pace_off";
}

export interface PlanInput {
  state: StoredState;
  family: Family;
  agents: readonly PaceAgent[];
  usageOf(accountId: string): Usage | null | undefined;
  now: number;
  enabled: boolean;
  /** When the last pace move (either direction) happened, epoch ms; 0 if never. */
  lastMoveAt: number;
  /** The user (or pace) changed this agent's account recently; leave it alone. */
  recentlyRouted(agentId: string): boolean;
}

/** Bindings pace may move: following the default, spread at creation, or pace's own. Never the user's, a limit's or a thread's. */
export function paceMayMove(binding: Binding | undefined): boolean {
  return !binding || binding.source === "balance" || binding.source === "pace";
}

/**
 * Open, between turns, nothing asked of the user, quiet for a few minutes but active within the last
 * few hours. Closed, archived, running, failed, dormant and background agents never qualify.
 */
export function paceCanTouch(agent: PaceAgent, now: number): boolean {
  const idle = now - agent.updatedAt;
  return !agent.archived && !agent.background && agent.status === "idle" && agent.pendingPermissions === 0 &&
    Number.isFinite(idle) && idle >= PACE.minIdleMs && idle <= PACE.maxIdleMs;
}

/** Cheapest first: the smallest context to re-read, unknown last; then the most recently active. */
function byCost(a: PaceAgent, b: PaceAgent): number {
  const left = a.contextTokens ?? Number.POSITIVE_INFINITY;
  const right = b.contextTokens ?? Number.POSITIVE_INFINITY;
  if (left !== right) return left < right ? -1 : 1;
  return b.updatedAt - a.updatedAt;
}

function cooling(binding: Binding | undefined, now: number): boolean {
  if (binding?.source !== "pace") return false;
  const at = Date.parse(binding.at);
  return Number.isFinite(at) && now - at < PACE.agentCooldownMs;
}

/**
 * At most one move, and only once `moveEveryMs` has passed since the last. On: one cheap idle agent
 * from the account with the lowest score to the one with the highest, while the gap is at least
 * `ratio` and both readings are known. Off: one idle pace-bound agent back to the default.
 */
export function planPaceMove(input: PlanInput): PaceMove | null {
  const { state, family, now } = input;
  if (now - input.lastMoveAt < PACE.moveEveryMs) return null;
  const touchable = input.agents.filter(
    (agent) => agent.family === family && agent.runningOn !== undefined && paceCanTouch(agent, now),
  );

  if (!input.enabled) {
    const fallback = defaultAccount(state, family)?.id;
    if (!fallback) return null;
    const agent = touchable
      .filter((agent) => state.bindings[agent.id]?.source === "pace" && agent.runningOn !== fallback)
      .sort(byCost)[0];
    return agent ? { agentId: agent.id, family, from: agent.runningOn!, to: null, reason: "pace_off" } : null;
  }

  const known = pacedAccounts(state, family, input.usageOf, now).filter(
    (entry): entry is PacedAccount & { score: number } => entry.score !== null,
  );
  if (known.length < 2) return null;
  known.sort((a, b) => b.score - a.score);
  const target = known[0]!;
  // The source is the most over-paced account with an agent to spare, so a gated or unknown account is never drained.
  for (const source of [...known].reverse()) {
    if (source.account.id === target.account.id) break;
    if (target.score < source.score * PACE.ratio) break;
    const agent = touchable
      .filter((agent) => {
        if (agent.runningOn !== source.account.id) return false;
        const binding = state.bindings[agent.id];
        return paceMayMove(binding) && !cooling(binding, now) && !input.recentlyRouted(agent.id);
      })
      .sort(byCost)[0];
    if (agent) return { agentId: agent.id, family, from: source.account.id, to: target.account.id, reason: "pace" };
  }
  return null;
}

/**
 * Pace bindings that can go without reloading anything: with pace off, those of agents that aren't
 * open (they follow the default when they next open), and those already on the default. Never wakes
 * an agent. `openAgentIds` must be complete, or nothing is dropped.
 */
export function paceBindingsToDrop(
  state: StoredState,
  enabled: boolean,
  openAgentIds: ReadonlySet<string> | null,
): string[] {
  if (enabled || !openAgentIds) return [];
  return Object.entries(state.bindings)
    .filter(([agentId, binding]) => {
      if (binding.source !== "pace") return false;
      const account = state.accounts.find((entry) => entry.id === binding.accountId);
      if (!account) return true;
      return !openAgentIds.has(agentId) || defaultAccount(state, account.family)?.id === account.id;
    })
    .map(([agentId]) => agentId);
}
