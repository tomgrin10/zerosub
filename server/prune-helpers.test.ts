import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FamilyAdapter } from "./adapter";
import type { FamilyResolver } from "./families";
import type { Reopener } from "./reopen";
import { Service } from "./service";
import { MAIN_ACCOUNT_ID, StateStore, type Binding } from "./state";

const MAIN = MAIN_ACCOUNT_ID.claude;
const SEAT = "claude-seat";
const LONG_AGO = "2026-01-01T00:00:00.000Z";
const HELPER = { "smart-session.helper": "publish-as" };

let root: string;
let previousHome: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zerosub-prune-"));
  previousHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = root;
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = previousHome;
  await rm(root, { recursive: true, force: true });
});

describe("pruning a one-shot helper's binding", () => {
  it("drops it once the helper is archived, keeps every other pin, and wakes nothing", async () => {
    const pin = (accountId: string): Binding => ({ accountId, source: "user", at: LONG_AGO });
    const store = new StateStore(join(root, "state.json"));
    await store.update((draft) =>
      Object.assign(draft, {
        accounts: [
          { id: MAIN, family: "claude", label: "main", kind: "main", home: null, createdAt: LONG_AGO },
          { id: SEAT, family: "claude", label: "seat", kind: "managed", home: join(root, SEAT), createdAt: LONG_AGO },
        ],
        defaults: { claude: SEAT, codex: null },
        bindings: { "done-helper": pin(MAIN), "open-helper": pin(MAIN), "archived-agent": pin(MAIN), "other-helper": pin(MAIN) },
        sessions: { "done-helper": { accountId: MAIN, family: "claude", openedAt: LONG_AGO } },
      }),
    );
    const agent = (id: string, archived: boolean, labels: Record<string, string> = {}) => ({
      id, provider: "claude", status: archived ? "closed" : "idle", archivedAt: archived ? LONG_AGO : null, lastUserMessageAt: LONG_AGO, labels,
    });
    const agents = [
      agent("done-helper", true, HELPER),
      agent("open-helper", false, HELPER),
      agent("archived-agent", true),
      agent("other-helper", true, { "smart-session.helper": "something-else" }),
    ];
    const woken: string[] = [];
    const paseo = {
      config: { get: async () => ({ config: { providers: {} } }) },
      agents: {
        list: async () => ({ entries: agents.map((entry) => ({ agent: entry })), pageInfo: { hasMore: false, nextCursor: null } }),
        ref: (id: string) => ({
          refresh: async () => void woken.push(`refresh ${id}`),
          reload: async () => void woken.push(`reload ${id}`),
          send: async () => void woken.push(`send ${id}`),
        }),
      },
    };
    const service = new Service(
      { claude: { family: "claude", portable: true } as FamilyAdapter, codex: { family: "codex", portable: false } as FamilyAdapter },
      store,
      { resolve: async () => ({ claude: "claude" as const }) } as unknown as FamilyResolver,
      { locate: async () => null, reopen: async (id: string) => (woken.push(`cli ${id}`), { ok: true as const }) } as unknown as Reopener,
    );
    await (service as unknown as { prune(paseo: unknown): Promise<void> }).prune(paseo);

    const state = await store.read();
    expect(state.bindings["done-helper"]).toBeUndefined();
    expect(state.sessions["done-helper"]).toBeUndefined();
    expect(Object.keys(state.bindings).sort()).toEqual(["archived-agent", "open-helper", "other-helper"]);
    expect(woken).toEqual([]);
  });
});
