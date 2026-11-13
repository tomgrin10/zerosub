import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FamilyAdapter, UsageRead } from "./adapter";
import type { FamilyResolver } from "./families";
import { Reopener } from "./reopen";
import { Service } from "./service";
import { MAIN_ACCOUNT_ID, StateStore } from "./state";

// Paseo hides background agents (`background: true`, e.g. a helper created with no prompt) from its
// agent lists unless asked. `paseo agent reload` resolves the id from such a list, so it can't find
// one; ZeroSub's own list missed them too, and pruned their bindings as gone.

const MAIN = MAIN_ACCOUNT_ID.claude;
const SEAT = "claude-seat";
const HELPER = "helper-1";
const LONG_AGO = "2026-01-01T00:00:00.000Z";

let root: string;
const saved = { PASEO_HOME: process.env.PASEO_HOME, PATH: process.env.PATH, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zerosub-background-"));
  process.env.PASEO_HOME = root;
  // No paseo CLI anywhere it's looked for: a CLI reload can't happen, and the real one never runs.
  process.env.PATH = "";
  process.env.HOME = root;
  process.env.USERPROFILE = root;
});

afterEach(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
});

function adapter(): FamilyAdapter {
  const reading = (): UsageRead => ({ fetchedAt: new Date().toISOString(), windows: [], error: null, cached: false, resets: null });
  return {
    family: "claude",
    portable: true,
    usageSpacingMs: 0,
    available: async () => ({ ok: true, detail: null }),
    prepareHome: async () => undefined,
    env: async (home: string | null) => (home ? { CLAUDE_CONFIG_DIR: home } : {}),
    identity: async () => null,
    usage: async () => reading(),
    detectLimit: () => null,
    detectSignOut: () => null,
  } as unknown as FamilyAdapter;
}

/** A host like Paseo 0.16: background agents only with `includeBackground`, and a reload of its own. */
async function setUp(options: { hostReload: boolean; backgroundListing: "works" | "unsupported"; mainLimited?: boolean; labels?: Record<string, string> }) {
  const store = new StateStore(join(root, "state.json"));
  await store.update((draft) =>
    Object.assign(draft, {
      accounts: [
        { id: MAIN, family: "claude", label: "main", kind: "main", home: null, createdAt: LONG_AGO,
          ...(options.mainLimited ? { limitedUntil: new Date(Date.now() + 86_400_000).toISOString(), limitKind: "window" } : {}) },
        { id: SEAT, family: "claude", label: "seat", kind: "managed", home: join(root, SEAT), createdAt: LONG_AGO },
      ],
      defaults: { claude: SEAT, codex: null },
      sessions: { [HELPER]: { accountId: SEAT, family: "claude", openedAt: LONG_AGO } },
    }),
  );
  const helper = { id: HELPER, provider: "claude", status: "idle", archivedAt: null, lastUserMessageAt: null, background: true, labels: options.labels ?? {} };
  const reloads: string[] = [];
  let service: Service;
  const paseo = {
    config: { get: async () => ({ config: { providers: {} } }) },
    agents: {
      list: async (query: { filter?: { includeBackground?: boolean } } = {}) => {
        if (query.filter?.includeBackground && options.backgroundListing === "unsupported") {
          throw new Error("Update the host to use background workspaces.");
        }
        const entries = query.filter?.includeBackground ? [{ agent: helper }] : [];
        return { entries, pageInfo: { hasMore: false, nextCursor: null } };
      },
      ref: (id: string) => ({
        refresh: async () => ({ agent: id === HELPER ? helper : null }),
        timeline: { append: async () => undefined, refetch: async () => ({ entries: [] }) },
        ...(options.hostReload
          ? {
              reload: async () => {
                reloads.push(id);
                await service.onSessionOpen(
                  { agentId: id, provider: "claude", reason: "refresh", purpose: "interactive", env: {} } as never,
                  { paseo } as never,
                );
              },
            }
          : {}),
      }),
    },
  };
  service = new Service(
    { claude: adapter(), codex: { ...adapter(), family: "codex", portable: false } as FamilyAdapter },
    store,
    { resolve: async () => ({ claude: "claude" as const }) } as unknown as FamilyResolver,
    new Reopener(),
  );
  return { service, store, paseo: paseo as never, reloads };
}

describe("background agents", () => {
  it("move to a chosen account right away, through the host's own reload", async () => {
    const { service, store, paseo, reloads } = await setUp({ hostReload: true, backgroundListing: "works" });
    const summary = await service.setAgentAccount(paseo, HELPER, MAIN);
    expect(summary.failed).toEqual([]);
    expect(summary.reopened).toEqual([HELPER]);
    expect(reloads).toEqual([HELPER]);
    const state = await store.read();
    expect(state.bindings[HELPER]).toMatchObject({ accountId: MAIN, source: "user" });
    expect(state.sessions[HELPER]?.accountId).toBe(MAIN);
  });

  it("keep their bindings when stale ones are pruned", async () => {
    const { service, store, paseo } = await setUp({ hostReload: true, backgroundListing: "works" });
    await store.update((draft) => {
      draft.bindings[HELPER] = { accountId: MAIN, source: "user", at: LONG_AGO };
    });
    await (service as unknown as { prune(paseo: unknown): Promise<void> }).prune(paseo);
    const state = await store.read();
    expect(state.bindings[HELPER]).toMatchObject({ accountId: MAIN, source: "user" });
    expect(state.sessions[HELPER]).toBeDefined();
  });

  it("are never taken for gone on a host that can't list them", async () => {
    const { service, store, paseo } = await setUp({ hostReload: false, backgroundListing: "unsupported" });
    await store.update((draft) => {
      draft.bindings[HELPER] = { accountId: MAIN, source: "user", at: LONG_AGO };
    });
    await (service as unknown as { prune(paseo: unknown): Promise<void> }).prune(paseo);
    expect((await store.read()).bindings[HELPER]).toMatchObject({ accountId: MAIN });
  });
});

describe("reopening", () => {
  it("uses the host's reload when it has one, and reports its error", async () => {
    const ok = await new Reopener().reopen("a", { agents: { ref: () => ({ reload: async () => undefined }) } });
    expect(ok).toEqual({ ok: true });
    const failed = await new Reopener().reopen("a", {
      agents: { ref: () => ({ reload: async () => Promise.reject(new Error("Agent a is not loaded")) }) },
    });
    expect(failed).toEqual({ ok: false, error: "Agent a is not loaded", timedOut: false });
  });

  it("falls back to the CLI on a host without one", async () => {
    const result = await new Reopener().reopen("a", { agents: { ref: () => ({}) } });
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/command-line tool was not found/) });
  });
});

// Smart Session's publish-as helper may publish on the main account's Extra usage while the main
// account is out (an opt-in there). Routing swaps a limited account for one with room, which put the
// helper on a seat; the pin's `allowLimited` keeps a one-shot helper where it was pinned, and only it.
describe("a one-shot helper pinned to a limited account", () => {
  const HELPER_LABELS = { "smart-session.helper": "publish-as" };

  it("stays on that account when the pin allows a limited one", async () => {
    const { service, store, paseo } = await setUp({ hostReload: true, backgroundListing: "works", mainLimited: true, labels: HELPER_LABELS });
    await service.setAgentAccount(paseo, HELPER, MAIN, { allowLimited: true });
    const state = await store.read();
    expect(state.sessions[HELPER]?.accountId).toBe(MAIN);
    expect(state.bindings[HELPER]).toMatchObject({ accountId: MAIN, source: "user", allowLimited: true });
  });

  it("is moved to an account with room without it, as before", async () => {
    const { service, store, paseo } = await setUp({ hostReload: true, backgroundListing: "works", mainLimited: true, labels: HELPER_LABELS });
    await service.setAgentAccount(paseo, HELPER, MAIN);
    const state = await store.read();
    expect(state.sessions[HELPER]?.accountId).toBe(SEAT);
    expect(state.bindings[HELPER]?.allowLimited).toBeUndefined();
  });

  it("is refused for any agent that isn't a one-shot helper", async () => {
    const { service, store, paseo } = await setUp({ hostReload: true, backgroundListing: "works", mainLimited: true });
    await expect(service.setAgentAccount(paseo, HELPER, MAIN, { allowLimited: true })).rejects.toThrow(/one-shot helper/);
    expect((await store.read()).bindings[HELPER]).toBeUndefined();
  });

  it("is refused without an account to pin to", async () => {
    const { service, paseo } = await setUp({ hostReload: true, backgroundListing: "works", labels: HELPER_LABELS });
    await expect(service.setAgentAccount(paseo, HELPER, null, { allowLimited: true })).rejects.toThrow(/account/);
  });
});
