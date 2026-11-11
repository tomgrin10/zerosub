import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureDaemonLogs, DuplicateWatch, findDuplicates, scanProviderProcesses, type Duplicate } from "./duplicates";

// A synthetic /proc and daemon home; nothing real is scanned, signalled or copied.
let root: string;
let proc: string;
const BOOT = 1_794_380_000; // btime, seconds
const SECRET = "sk-should-never-leave";

const CLAUDE = ["/home/u/.local/bin/claude", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose"];

async function fakeProcess(pid: number, options: { ppid?: number; argv: string[]; env: Record<string, string>; startSec?: number }) {
  const dir = join(proc, String(pid));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "cmdline"), options.argv.join("\0") + "\0");
  await writeFile(join(dir, "environ"), Object.entries({ ANTHROPIC_API_KEY: SECRET, ...options.env }).map(([k, v]) => `${k}=${v}`).join("\0") + "\0");
  // pid (comm) state ppid ... field 22 = starttime in clock ticks; the name holds a space and parens.
  const fields = ["S", String(options.ppid ?? 1), ...Array(17).fill("0"), String((options.startSec ?? 0) * 100), "0"];
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
          { pid: 641228, ppid: 2639, agentId: "agent-a", home: "claude-seat", resume: "c3bdfba3", startedAt: new Date((BOOT + 100) * 1000).toISOString() },
          { pid: 1888151, ppid: 2639, agentId: "agent-a", home: null, resume: "c3bdfba3", startedAt: new Date((BOOT + 900) * 1000).toISOString() },
        ],
      },
    ]);
  });

  it("keeps nothing from the environment but the agent id and the home", async () => {
    await liveShape();
    const processes = await scanProviderProcesses(proc);
    expect(JSON.stringify(processes)).not.toContain(SECRET);
    for (const entry of processes) expect(Object.keys(entry).sort()).toEqual(["agentId", "home", "pid", "ppid", "resume", "startedAt"]);
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
      processes: [{ pid: 641228, ppid: 2639, agentId: "agent-a", home: "claude-seat", resume: "c3bdfba3", startedAt: null }],
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
