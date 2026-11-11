import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backgroundShells, captureDaemonLogs, DuplicateWatch, findDuplicates, REAP, scanProviderProcesses, type AgentContext, type Duplicate } from "./duplicates";

// A synthetic /proc and daemon home; nothing real is scanned, signalled or copied.
let root: string;
let proc: string;
const BOOT = 1_794_380_000; // btime, seconds
const SECRET = "sk-should-never-leave";

const CLAUDE = ["/home/u/.local/bin/claude", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose"];

async function fakeProcess(pid: number, options: { ppid?: number; argv: string[]; env: Record<string, string>; startSec?: number; cpu?: number }) {
  const dir = join(proc, String(pid));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "cmdline"), options.argv.join("\0") + "\0");
  await writeFile(join(dir, "environ"), Object.entries({ ANTHROPIC_API_KEY: SECRET, ...options.env }).map(([k, v]) => `${k}=${v}`).join("\0") + "\0");
  // pid (comm) state ppid ... field 22 = starttime in clock ticks; the name holds a space and parens.
  // utime/stime are fields 14/15 (index 11/12 here).
  const cpu = options.cpu ?? 0;
  const fields = ["S", String(options.ppid ?? 1), ...Array(9).fill("0"), String(cpu), "0", ...Array(6).fill("0"), String((options.startSec ?? 0) * 100), "0"];
  await writeFile(join(dir, "stat"), `${pid} (claude (x) y) ${fields.join(" ")}\n`);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zerosub-dups-"));
  proc = join(root, "proc");
  await mkdir(proc, { recursive: true });
  await writeFile(join(proc, "stat"), `cpu  1 2 3\nbtime ${BOOT}\n`);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function liveShape() {
  // The 2026-11-11 incident: an orphan on the seat home and the live process on the CLI login, same resume.
  await fakeProcess(641228, { ppid: 2639, argv: [...CLAUDE, "--resume=c3bdfba3"], env: { PASEO_AGENT_ID: "agent-a", CLAUDE_CONFIG_DIR: "/z/homes/claude-seat" }, startSec: 100 });
  await fakeProcess(1888151, { ppid: 2639, argv: [...CLAUDE, "--resume", "c3bdfba3"], env: { PASEO_AGENT_ID: "agent-a" }, startSec: 900 });
  // One healthy agent, a non-provider process of the same agent, an MCP child of a provider, and no agent id.
  await fakeProcess(500, { ppid: 2639, argv: CLAUDE, env: { PASEO_AGENT_ID: "agent-b" }, startSec: 50 });
  await fakeProcess(501, { ppid: 2639, argv: ["/bin/bash", "-c", "sleep 1"], env: { PASEO_AGENT_ID: "agent-b" } });
  await fakeProcess(502, { ppid: 500, argv: CLAUDE, env: { PASEO_AGENT_ID: "agent-b" }, startSec: 60 });
  await fakeProcess(503, { ppid: 1, argv: CLAUDE, env: {} });
}

describe("duplicate provider processes", () => {
  it("finds an agent with two provider processes, and only that one", async () => {
    await liveShape();
    const processes = await scanProviderProcesses(proc);
    expect(processes.map((entry) => entry.pid).sort((a, b) => a - b)).toEqual([500, 502, 641228, 1888151]);
    const duplicates = findDuplicates(processes);
    expect(duplicates).toEqual([
      {
        agentId: "agent-a",
        processes: [
          { pid: 641228, ppid: 2639, agentId: "agent-a", home: "claude-seat", resume: "c3bdfba3", startedAt: new Date((BOOT + 100) * 1000).toISOString(), startTicks: 10_000, cpuTicks: 0 },
          { pid: 1888151, ppid: 2639, agentId: "agent-a", home: null, resume: "c3bdfba3", startedAt: new Date((BOOT + 900) * 1000).toISOString(), startTicks: 90_000, cpuTicks: 0 },
        ],
      },
    ]);
  });

  it("keeps nothing from the environment but the agent id and the home", async () => {
    await liveShape();
    const processes = await scanProviderProcesses(proc);
    expect(JSON.stringify(processes)).not.toContain(SECRET);
    for (const entry of processes) expect(Object.keys(entry).sort()).toEqual(["agentId", "cpuTicks", "home", "pid", "ppid", "resume", "startTicks", "startedAt"]);
  });

  it("logs and captures each new duplicate once, at most once a minute, and reports it while it lasts", async () => {
    await liveShape();
    let now = 1_000_000;
    const lines: string[] = [];
    const captured: Duplicate[] = [];
    const watch = new DuplicateWatch({
      procRoot: proc,
      now: () => now,
      log: (line) => lines.push(line),
      capture: async (duplicate) => {
        captured.push(duplicate);
        return "/captures/x.log";
      },
    });
    await watch.check();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("agent agent-a has 2 provider processes");
    expect(lines[0]).toContain("pid 641228");
    expect(lines[0]).toContain("home claude-seat");
    expect(lines[0]).toContain("resume c3bdfba3");
    expect(lines[0]).toContain("Nothing was stopped; log copy in /captures/x.log");
    expect(lines[0]).not.toContain(SECRET);
    expect(captured).toHaveLength(1);
    expect(watch.duplicates.map((entry) => entry.since)).toEqual([new Date(1_000_000).toISOString()]);

    // Within the minute: not even scanned again.
    await rm(join(proc, "1888151"), { recursive: true });
    now += 30_000;
    await watch.check();
    expect(watch.duplicates).toHaveLength(1);

    // Gone: no longer reported. A new duplicate later is logged and captured again.
    now += 31_000;
    await watch.check();
    expect(watch.duplicates).toHaveLength(0);
    await fakeProcess(1999999, { ppid: 2639, argv: CLAUDE, env: { PASEO_AGENT_ID: "agent-a" }, startSec: 1200 });
    now += 60_000;
    await watch.check();
    await watch.check();
    expect(lines).toHaveLength(2);
    expect(captured).toHaveLength(2);
  });

  it("copies what the daemon logged about the agent and its pids, plus the current log's tail, read-only", async () => {
    const home = join(root, "paseo");
    await mkdir(home);
    const old = '{"time":1,"agentId":"agent-a","msg":"reloaded"}\n{"time":2,"agentId":"other","msg":"x"}\n';
    const current = '{"time":3,"pid":2639,"msg":"unrelated"}\n{"time":4,"pid":641228,"msg":"spawned"}\n{"time":5,"msg":"last line"}\n';
    await writeFile(join(home, "20261111-1206-01-daemon.log"), old);
    await writeFile(join(home, "daemon.log"), current);
    const duplicate: Duplicate = {
      agentId: "agent-a",
      processes: [{ pid: 641228, ppid: 2639, agentId: "agent-a", home: "claude-seat", resume: "c3bdfba3", startedAt: null, startTicks: 1, cpuTicks: 0 }],
    };
    const path = await captureDaemonLogs(duplicate, "2026-11-11T14:00:00.000Z", { dir: join(root, "captures"), home, tailBytes: 1000 });
    expect(path).toBe(join(root, "captures", "2026-11-11T14-00-00-000Z-agent-a.log"));
    const text = await readFile(path, "utf8");
    expect(text).toContain('"agentId":"agent-a","msg":"reloaded"');
    expect(text).toContain('"pid":641228,"msg":"spawned"');
    expect(text).toContain("last line");
    const rotatedSection = text.split("==== 20261111-1206-01-daemon.log")[1]!.split("====")[0]!;
    expect(rotatedSection).toContain('"agentId":"agent-a"');
    expect(rotatedSection).not.toContain('"agentId":"other"');
    // The logs themselves are untouched.
    expect(await readFile(join(home, "daemon.log"), "utf8")).toBe(current);
    expect((await readdir(home)).sort()).toEqual(["20261111-1206-01-daemon.log", "daemon.log"]);
  });
});

describe("stopping detached duplicates", () => {
  const MIN = 60_000;
  function harness(options: { reap?: boolean; context?: (agentId: string) => Promise<AgentContext>; exitOnTerm?: boolean } = {}) {
    let now = 1_000_000;
    const events: string[] = [];
    const watch = new DuplicateWatch({
      procRoot: proc,
      now: () => now,
      log: (line) => events.push(`log ${line}`),
      capture: async () => {
        events.push("capture");
        return "/captures/x.log";
      },
      reap: () => options.reap ?? true,
      context: options.context ?? (async () => ({ busy: false, home: null })),
      signal: (pid, sig) => {
        events.push(`${sig} ${pid}`);
        if (sig === "SIGKILL" || options.exitOnTerm !== false) void rm(join(proc, String(pid)), { recursive: true });
      },
      sleep: async () => undefined,
    });
    return {
      watch,
      events,
      signals: () => events.filter((e) => e.startsWith("SIG")),
      advance: (ms: number) => {
        now += ms;
      },
    };
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  it("stops an older process on another account after two checks, logging and capturing first, never the newest", async () => {
    await liveShape(); // agent-a: 641228 on claude-seat (older), 1888151 on the CLI login (newest)
    const h = harness();
    await h.watch.check();
    expect(h.signals()).toEqual([]); // first sighting: only suspected
    h.advance(MIN);
    await h.watch.check();
    await settle();
    expect(h.signals()).toEqual(["SIGTERM 641228"]);
    const stopLine = h.events.findIndex((e) => e.includes("stopping detached duplicate of agent agent-a: pid 641228"));
    expect(stopLine).toBeGreaterThan(-1);
    expect(h.events[stopLine]).toContain("isn't the agent's account (CLI login)");
    expect(h.events[stopLine]).toContain("keeping the newest, pid 1888151");
    expect(h.events.lastIndexOf("capture", stopLine)).toBe(stopLine - 1); // capture, then log, then signal
    expect(h.events.indexOf("SIGTERM 641228")).toBeGreaterThan(stopLine);
    expect(h.events.some((e) => e.includes("641228 of agent agent-a has exited"))).toBe(true);
  });

  it("sends SIGKILL only if the very same process outlived SIGTERM", async () => {
    await liveShape();
    const h = harness({ exitOnTerm: false });
    await h.watch.check();
    h.advance(MIN);
    await h.watch.check();
    await settle();
    expect(h.signals()).toEqual(["SIGTERM 641228", "SIGKILL 641228"]);
  });

  it("never signals a pid that now belongs to another process", async () => {
    await liveShape();
    const h = harness({ exitOnTerm: false });
    await h.watch.check();
    h.advance(MIN);
    // Between the two checks the orphan exits and its pid is reused by a newer process.
    await rm(join(proc, "641228"), { recursive: true });
    await fakeProcess(641228, { ppid: 2639, argv: CLAUDE, env: { PASEO_AGENT_ID: "agent-a", CLAUDE_CONFIG_DIR: "/z/homes/claude-seat" }, startSec: 950 });
    await h.watch.check();
    await settle();
    // 641228 is now the newest, so it is kept; nothing else is older than 1888151 on another account.
    expect(h.signals()).toEqual([]);
  });

  it("does nothing with the preference off, while the agent is busy, or when its state can't be read", async () => {
    await liveShape();
    for (const options of [
      { reap: false },
      { context: async () => ({ busy: true, home: null }) },
      { context: async (): Promise<AgentContext> => { throw new Error("no paseo"); } },
    ]) {
      const h = harness(options);
      for (let i = 0; i < 5; i++) {
        await h.watch.check();
        h.advance(MIN);
      }
      await settle();
      expect(h.signals()).toEqual([]);
    }
  });

  it("acts after a busy spell without starting the wait over", async () => {
    await liveShape();
    let busy = false;
    const h = harness({ context: async () => ({ busy, home: null }) });
    await h.watch.check();
    busy = true;
    h.advance(MIN);
    await h.watch.check();
    expect(h.signals()).toEqual([]);
    busy = false;
    h.advance(MIN);
    await h.watch.check();
    await settle();
    expect(h.signals()).toEqual(["SIGTERM 641228"]);
  });

  it("on the agent's own account, waits for the older process to sit idle (under 1% CPU) for ten minutes", async () => {
    await fakeProcess(701, { ppid: 2639, argv: CLAUDE, env: { PASEO_AGENT_ID: "agent-c" }, startSec: 20, cpu: 5 });
    const h = harness({ context: async () => ({ busy: false, home: null }) });
    for (let minute = 0; minute < REAP.idleMs / MIN; minute++) {
      // A detached Claude process still ticks: 24 ticks a minute is 0.4% of a core.
      await fakeProcess(700, { ppid: 2639, argv: CLAUDE, env: { PASEO_AGENT_ID: "agent-c" }, startSec: 10, cpu: 5 + 24 * minute });
      await h.watch.check();
      h.advance(MIN);
    }
    expect(h.signals()).toEqual([]);
    await h.watch.check(); // idle 10 min: suspected now
    h.advance(MIN);
    await h.watch.check();
    await settle();
    expect(h.signals()).toEqual(["SIGTERM 700"]);
  });

  it("leaves an older process on the agent's own account alone while it works (over 1% CPU)", async () => {
    await fakeProcess(700, { ppid: 2639, argv: CLAUDE, env: { PASEO_AGENT_ID: "agent-c" }, startSec: 10, cpu: 5 });
    await fakeProcess(701, { ppid: 2639, argv: CLAUDE, env: { PASEO_AGENT_ID: "agent-c" }, startSec: 20, cpu: 5 });
    const h = harness();
    for (let minute = 0; minute < 20; minute++) {
      // 120 ticks a minute: 2% of a core, a slow turn.
      await fakeProcess(700, { ppid: 2639, argv: CLAUDE, env: { PASEO_AGENT_ID: "agent-c" }, startSec: 10, cpu: 5 + 120 * minute });
      await h.watch.check();
      h.advance(MIN);
    }
    expect(h.signals()).toEqual([]);
  });

  it("invariant: a detached duplicate on another account is gone within about two minutes of appearing", async () => {
    await fakeProcess(800, { ppid: 2639, argv: CLAUDE, env: { PASEO_AGENT_ID: "agent-d" }, startSec: 10 });
    const h = harness({ context: async () => ({ busy: false, home: "claude-seat" }) });
    await h.watch.check(); // just before the duplicate appears
    await fakeProcess(801, { ppid: 2639, argv: CLAUDE, env: { PASEO_AGENT_ID: "agent-d", CLAUDE_CONFIG_DIR: "/z/homes/claude-seat" }, startSec: 20 });
    let elapsed = 0;
    while (h.signals().length === 0 && elapsed <= 3 * MIN) {
      h.advance(MIN);
      elapsed += MIN;
      await h.watch.check();
      await settle();
    }
    expect(h.signals()).toEqual(["SIGTERM 800"]);
    expect(elapsed).toBeLessThanOrEqual(2 * MIN);
  });
});

describe("background shells", () => {
  it("counts Bash-tool shells under the agent's newest provider process, not MCP servers, hooks or other agents", async () => {
    await fakeProcess(900, { ppid: 2639, argv: CLAUDE, env: { PASEO_AGENT_ID: "agent-e" }, startSec: 10 });
    await fakeProcess(901, { ppid: 900, argv: ["/bin/bash", "-c", "source /h/.claude/shell-snapshots/snapshot-bash-1.sh && eval 'npm run render'"], env: {} });
    await fakeProcess(902, { ppid: 900, argv: ["/bin/bash", "-c", "source /h/.claude/shell-snapshots/snapshot-bash-1.sh && eval 'tail -f log'"], env: {} });
    await fakeProcess(903, { ppid: 900, argv: ["node", "/opt/mcp/server.js"], env: {} });
    await fakeProcess(904, { ppid: 900, argv: ["/bin/sh", "-c", "node hooks/stop.mjs"], env: {} });
    await fakeProcess(905, { ppid: 2639, argv: CLAUDE, env: { PASEO_AGENT_ID: "agent-f" }, startSec: 10 });
    await fakeProcess(906, { ppid: 905, argv: ["/bin/bash", "-c", "source /h/.claude/shell-snapshots/snapshot-bash-2.sh && eval 'sleep 9'"], env: {} });
    expect(await backgroundShells("agent-e", proc)).toBe(2);
    expect(await backgroundShells("agent-f", proc)).toBe(1);
    expect(await backgroundShells("agent-none", proc)).toBe(0);
  });
});
