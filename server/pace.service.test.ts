import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { preferences } from "../shared/preferences";
import type { SwitchRow } from "../shared/timeline";
import type { FamilyAdapter, UsageRead } from "./adapter";
import type { FamilyResolver } from "./families";
import { PACE } from "./pace";
import type { Reopener } from "./reopen";
import { Service } from "./service";
import { MAIN_ACCOUNT_ID, StateStore, type Binding, type StoredState } from "./state";

const MAIN = MAIN_ACCOUNT_ID.claude;
const SEAT = "claude-seat-1";
const HOUR = 3_600_000;
const MINUTE = 60_000;

let root: string;
let previousHome: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zerosub-pace-"));
  previousHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = root; // saved usage lands here, never in the real ~/.paseo
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = previousHome;
  await rm(root, { recursive: true, force: true });
});

/** Yesterday's readings, relative to the real clock: tom.gringauz 64% (resets in 4d9h), claude-seat-1 37% (2d7h). */
function yesterday(home: string | null): UsageRead {
  const now = Date.now();
  const [used, hours] = home === null ? [64, 105] : [37, 55];
  return {
    fetchedAt: new Date(now).toISOString(),
    windows: [
      { id: "five_hour", label: "5-hour", usedPercent: 20, resetsAt: new Date(now + 2 * HOUR).toISOString() },
      { id: "seven_day", label: "Weekly", usedPercent: used, resetsAt: new Date(now + hours * HOUR).toISOString() },
    ],
    error: null,
    cached: false,
    resets: null,
  };
}

function adapter(): FamilyAdapter {
  return {
    family: "claude",
    portable: true,
    usageSpacingMs: 0,
    available: async () => ({ ok: true, detail: null }),
    prepareHome: async () => undefined,
    env: async (home: string | null) => (home ? { CLAUDE_CONFIG_DIR: home } : {}),
    identity: async () => null,
    usage: async (home: string | null) => yesterday(home),
    detectLimit: () => null,
    detectSignOut: () => null,
  } as unknown as FamilyAdapter;
}

interface Listed {
  id: string;
  status?: string;
  archived?: boolean;
  /** Minutes since the agent last changed. */
  quietFor?: number;
  contextTokens?: number;
}

async function setUp(listed: Listed[], bindings: Record<string, Binding> = {}, paceWeeklyUsage = true) {
  const store = new StateStore(join(root, "state.json"));
  const openedAt = new Date().toISOString();
  const sessions: StoredState["sessions"] = {};
  for (const { id } of listed) sessions[id] = { accountId: bindings[id]?.accountId ?? MAIN, family: "claude", openedAt };
  await store.update((draft) =>
    Object.assign(draft, {
      accounts: [
        { id: MAIN, family: "claude", label: "tom.gringauz", kind: "main", home: null, createdAt: openedAt },
        { id: SEAT, family: "claude", label: "claude-seat-1", kind: "managed", home: join(tmpdir(), SEAT), createdAt: openedAt },
      ],
      defaults: { claude: MAIN, codex: null },
      bindings,
      sessions,
    }),
  );
  const agents = listed.map((entry) => ({
    id: entry.id,
    provider: "claude",
    status: entry.status ?? "idle",
    archivedAt: entry.archived ? openedAt : null,
    lastUserMessageAt: openedAt,
    updatedAt: new Date(Date.now() - (entry.quietFor ?? 30) * MINUTE).toISOString(),
    pendingPermissions: [],
    lastUsage: { contextWindowUsedTokens: entry.contextTokens ?? 50_000 },
  }));
  const rows: Array<{ agentId: string; row: SwitchRow }> = [];
  const lists: Array<boolean> = [];
  const paseo = {
    config: { get: async () => ({ config: { providers: {} } }) },
    agents: {
      list: async (options: { filter?: { includeArchived?: boolean } } = {}) => {
        lists.push(Boolean(options.filter?.includeArchived));
        const visible = options.filter?.includeArchived ? agents : agents.filter((agent) => !agent.archivedAt);
        return { entries: visible.map((agent) => ({ agent })), pageInfo: { hasMore: false, nextCursor: null } };
      },
      ref: (id: string) => ({
        refresh: async () => ({ agent: agents.find((agent) => agent.id === id) }),
        send: async () => undefined,
        timeline: {
          append: async (item: { data: SwitchRow }) => void rows.push({ agentId: id, row: item.data }),
          refetch: async () => ({ entries: [] }),
        },
      }),
    },
  };
  const context = { paseo } as never;
  const reopened: string[] = [];
  const service: Service = new Service(
    { claude: adapter(), codex: { ...adapter(), family: "codex", portable: false } as FamilyAdapter },
    store,
    { resolve: async () => ({ claude: "claude" as const }) } as unknown as FamilyResolver,
    {
      locate: async () => "/usr/local/bin/paseo",
      reopen: async (id: string) => {
        reopened.push(id);
        await service.onSessionOpen({ agentId: id, provider: "claude", reason: "refresh", purpose: "interactive", env: {} } as never, context);
        return { ok: true as const };
      },
    } as unknown as Reopener,
  );
  const make = (): Service => {
    const next: Service = new Service(
      { claude: adapter(), codex: { ...adapter(), family: "codex", portable: false } as FamilyAdapter },
      new StateStore(join(root, "state.json")),
      { resolve: async () => ({ claude: "claude" as const }) } as unknown as FamilyResolver,
      {
        locate: async () => "/usr/local/bin/paseo",
        reopen: async (id: string) => {
          reopened.push(id);
          await next.onSessionOpen({ agentId: id, provider: "claude", reason: "refresh", purpose: "interactive", env: {} } as never, context);
          return { ok: true as const };
        },
      } as unknown as Reopener,
    );
    next.setPreferences(preferences.schema.parse({ paceWeeklyUsage }));
    return next;
  };
  service.setPreferences(preferences.schema.parse({ paceWeeklyUsage }));
  await service.refreshUsage(MAIN, true);
  await service.refreshUsage(SEAT, true);
  /** The plugin reloaded: a new process with nothing in memory, over the same state file. */
  const reload = async (): Promise<Service> => {
    const next = make();
    await next.refreshUsage(MAIN, true);
    await next.refreshUsage(SEAT, true);
    return next;
  };
  return { service, store, paseo: paseo as never, reopened, rows, reload };
}

/** Runs pace once a minute for `minutes` simulated minutes; returns when each reload happened. */
async function run(service: Service, paseo: never, reopened: string[], minutes: number): Promise<number[]> {
  const start = Date.now();
  const at: number[] = [];
  for (let minute = 0; minute < minutes; minute += 1) {
    const before = reopened.length;
    await service.pace(paseo, start + minute * MINUTE);
    for (let index = before; index < reopened.length; index += 1) at.push(minute);
  }
  return at;
}

describe("pacing weekly usage", () => {
  it("doesn't speed up when the plugin reloads: the last move and hand re-routes outlive the process", async () => {
    const listed = Array.from({ length: 5 }, (_, index) => ({ id: `idle-${index}`, contextTokens: 10_000 + index }));
    const { service, paseo, reopened, reload } = await setUp(listed);
    const start = Date.now();
    await service.pace(paseo, start);
    expect(reopened).toHaveLength(1);
    // The user sends the next-cheapest agent back to the default by hand.
    await service.setAgentAccount(paseo, "idle-1", null);
    reopened.length = 0;

    // Reloaded a minute later: still inside the interval, so no move.
    let fresh = await reload();
    await fresh.pace(paseo, start + 60_000);
    expect(reopened).toEqual([]);

    // Reloaded again once the interval is over: one move, and not the agent the user re-routed.
    fresh = await reload();
    await fresh.pace(paseo, start + PACE.moveEveryMs);
    expect(reopened).toEqual(["idle-2"]);
  });


  it("never reloads agents in bulk: twenty idle agents move one per interval", async () => {
    const listed = Array.from({ length: 20 }, (_, index) => ({ id: `idle-${index}`, contextTokens: 10_000 + index }));
    const { service, paseo, reopened, rows, store } = await setUp(listed);
    const at = await run(service, paseo, reopened, 60);
    const interval = PACE.moveEveryMs / MINUTE;
    // Any path that reloads several agents at once (a reconcile, say) breaks both of these.
    expect(reopened.length).toBeLessThanOrEqual(Math.ceil(60 / interval));
    for (let index = 1; index < at.length; index += 1) expect(at[index]! - at[index - 1]!).toBeGreaterThanOrEqual(interval);
    // Cheapest first.
    expect(reopened[0]).toBe("idle-0");
    const state = await store.read();
    expect(state.bindings["idle-0"]).toMatchObject({ accountId: SEAT, source: "pace" });
    expect(state.sessions["idle-0"]?.accountId).toBe(SEAT);
    expect(rows[0]).toMatchObject({ agentId: "idle-0", row: { reason: "pace", from: "tom.gringauz", to: "claude-seat-1" } });
  });

  it("never touches closed, archived, running, dormant or manually pinned agents", async () => {
    const { service, paseo, reopened } = await setUp(
      [
        { id: "closed", status: "closed" },
        { id: "archived", archived: true },
        { id: "running", status: "running" },
        { id: "dormant", quietFor: 7 * 60 },
        { id: "pinned" },
      ],
      { pinned: { accountId: MAIN, source: "user", at: new Date().toISOString() } },
    );
    await run(service, paseo, reopened, 60);
    expect(reopened).toEqual([]);
  });

  it("leaves an agent the user just sent back to the default where it is", async () => {
    const { service, paseo, reopened } = await setUp([{ id: "mine" }]);
    await service.setAgentAccount(paseo, "mine", null);
    await run(service, paseo, reopened, 30);
    expect(reopened).toEqual([]);
  });

  it("turned off, drops closed agents' pace bindings without waking them and returns open ones one at a time", async () => {
    const paced = (): Binding => ({ accountId: SEAT, source: "pace", at: new Date(Date.now() - 7 * HOUR).toISOString() });
    const { service, paseo, reopened, store, rows } = await setUp(
      [{ id: "open-1" }, { id: "open-2" }, { id: "closed", status: "closed" }, { id: "gone", archived: true }],
      { "open-1": paced(), "open-2": paced(), closed: paced(), gone: paced() },
      false,
    );
    await service.pace(paseo);
    let state = await store.read();
    expect(state.bindings.closed).toBeUndefined();
    expect(state.bindings.gone).toBeUndefined();
    expect(reopened).toHaveLength(1);
    expect(rows[0]?.row).toMatchObject({ reason: "pace_off", to: "tom.gringauz" });
    await run(service, paseo, reopened, PACE.moveEveryMs / MINUTE);
    expect(reopened).toHaveLength(1);
    await service.pace(paseo, Date.now() + PACE.moveEveryMs);
    expect(reopened).toHaveLength(2);
    state = await store.read();
    expect(Object.values(state.bindings).filter((binding) => binding.source === "pace")).toEqual([]);
    expect(reopened).not.toContain("closed");
    expect(reopened).not.toContain("gone");
  });
});
