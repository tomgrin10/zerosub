import { createReadStream, existsSync } from "node:fs";
import { mkdir, open, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { dataDir, paseoHome } from "./paths";

/**
 * Watch for agents with more than one provider process: an orphaned process keeps writing the same
 * transcript and holds memory (getpaseo/paseo#9408). Logs and captures each occurrence while the
 * daemon's logs still cover it, and stops detached ones (see `DuplicateWatch`).
 *
 * It only ever signals a duplicate that looks detached (`detachedCandidates`), and only with the
 * `reapDetachedDuplicates` preference on. It reads a process's environment only after its command line
 * shows it's a provider process, and keeps nothing from it but PASEO_AGENT_ID and CLAUDE_CONFIG_DIR.
 */

/** What the watch keeps about one provider process. Nothing else is read into it. */
export interface ProviderProcess {
  pid: number;
  ppid: number;
  agentId: string;
  /** CLAUDE_CONFIG_DIR's last path segment, or null on the CLI login. */
  home: string | null;
  /** The session it resumes (`--resume`), when it has one. */
  resume: string | null;
  /** ISO time the process started, when /proc says. */
  startedAt: string | null;
  /** Start time in clock ticks since boot: orders processes, and tells a reused pid apart. */
  startTicks: number;
  /** CPU time used so far (user + system), in clock ticks. */
  cpuTicks: number;
}

export interface Duplicate {
  agentId: string;
  /** Oldest first. */
  processes: ProviderProcess[];
}

const KEPT_ENV = ["PASEO_AGENT_ID", "CLAUDE_CONFIG_DIR"] as const;
/** Linux reports process start times in clock ticks; 100 everywhere Paseo runs. */
const CLOCK_TICKS = 100;

/** A provider's own process, by its command line: Claude Code in stream-json mode, or Codex's app server. */
export function isProviderCommand(argv: readonly string[]): boolean {
  const exe = basename(argv[0] ?? "");
  if (argv.includes("--input-format") && argv.includes("stream-json")) return true;
  return exe === "codex" && argv.includes("app-server");
}

function resumeOf(argv: readonly string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--resume=")) return arg.slice("--resume=".length) || null;
    if (arg === "--resume") return argv[i + 1] ?? null;
  }
  return null;
}

/** Only the kept keys; every other variable is dropped as it's read. */
function keptEnv(raw: string): Partial<Record<(typeof KEPT_ENV)[number], string>> {
  const kept: Partial<Record<(typeof KEPT_ENV)[number], string>> = {};
  for (const entry of raw.split("\0")) {
    for (const key of KEPT_ENV) {
      if (entry.startsWith(`${key}=`)) kept[key] = entry.slice(key.length + 1);
    }
  }
  return kept;
}

async function bootTime(procRoot: string): Promise<number | null> {
  const stat = await readFile(join(procRoot, "stat"), "utf8").catch(() => "");
  const match = /^btime (\d+)$/m.exec(stat);
  return match ? Number(match[1]) * 1000 : null;
}

/** Provider processes that carry a PASEO_AGENT_ID, from a /proc-shaped directory. */
export async function scanProviderProcesses(procRoot = "/proc"): Promise<ProviderProcess[]> {
  const boot = await bootTime(procRoot);
  const found: ProviderProcess[] = [];
  for (const name of await readdir(procRoot).catch(() => [] as string[])) {
    if (!/^\d+$/.test(name)) continue;
    const dir = join(procRoot, name);
    try {
      const argv = (await readFile(join(dir, "cmdline"), "utf8")).split("\0").filter(Boolean);
      if (!isProviderCommand(argv)) continue;
      const env = keptEnv(await readFile(join(dir, "environ"), "utf8"));
      if (!env.PASEO_AGENT_ID) continue;
      // Fields after the command name, which may itself hold spaces or parentheses.
      const stat = await readFile(join(dir, "stat"), "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const ticks = Number(fields[19]);
      const cpu = Number(fields[11]) + Number(fields[12]);
      found.push({
        pid: Number(name),
        ppid: Number(fields[1]),
        agentId: env.PASEO_AGENT_ID,
        home: env.CLAUDE_CONFIG_DIR ? basename(env.CLAUDE_CONFIG_DIR) : null,
        resume: resumeOf(argv),
        startedAt: boot !== null && Number.isFinite(ticks) ? new Date(boot + (ticks / CLOCK_TICKS) * 1000).toISOString() : null,
        startTicks: Number.isFinite(ticks) ? ticks : 0,
        cpuTicks: Number.isFinite(cpu) ? cpu : 0,
      });
    } catch {
      // Gone, or not ours to read: skip it.
    }
  }
  return found;
}

/** Agents with more than one provider process of their own (a provider's child of the same agent doesn't count). */
export function findDuplicates(processes: readonly ProviderProcess[]): Duplicate[] {
  const pids = new Set(processes.map((entry) => entry.pid));
  const byAgent = new Map<string, ProviderProcess[]>();
  for (const entry of processes) {
    const parent = processes.find((other) => other.pid === entry.ppid);
    if (pids.has(entry.ppid) && parent?.agentId === entry.agentId) continue;
    byAgent.set(entry.agentId, [...(byAgent.get(entry.agentId) ?? []), entry]);
  }
  return [...byAgent.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([agentId, list]) => ({
      agentId,
      processes: [...list].sort((a, b) => a.startTicks - b.startTicks || a.pid - b.pid),
    }));
}

export function describeProcess(entry: ProviderProcess): string {
  return `pid ${entry.pid} (started ${entry.startedAt ?? "unknown"}, home ${entry.home ?? "CLI login"}, resume ${entry.resume ?? "none"})`;
}

/** Where captures go: Tom's harness notes when they exist, else ZeroSub's data dir. */
export function defaultCaptureDir(): string {
  if (process.env.ZEROSUB_ORPHAN_CAPTURE_DIR) return process.env.ZEROSUB_ORPHAN_CAPTURE_DIR;
  const notes = join(homedir(), "paseo-harness", "notes");
  return existsSync(notes) ? join(notes, "orphan-captures") : join(dataDir(), "orphan-captures");
}

/** Daemon log files, oldest first: the rotated ones (named by time) and the current one. */
async function daemonLogs(home: string): Promise<string[]> {
  const names = await readdir(home).catch(() => [] as string[]);
  const rotated = names.filter((name) => /^\d{8}-\d{4}-\d+-daemon\.log$/.test(name)).sort();
  return [...rotated, ...(names.includes("daemon.log") ? ["daemon.log"] : [])].map((name) => join(home, name));
}

async function linesMentioning(file: string, needles: readonly string[], limit: number): Promise<string[]> {
  const hits: string[] = [];
  const lines = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (needles.some((needle) => line.includes(needle))) {
      hits.push(line);
      if (hits.length > limit) hits.shift();
    }
  }
  return hits;
}

async function tail(file: string, bytes: number): Promise<string> {
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const text = buffer.toString("utf8");
    return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    await handle.close();
  }
}

/**
 * A read-only copy of what the daemon logged about the agent and its processes, plus the current log's
 * tail, into one file per detection. Returns its path.
 */
export async function captureDaemonLogs(
  duplicate: Duplicate,
  detectedAt: string,
  options: { dir?: string; home?: string; tailBytes?: number; maxLines?: number } = {},
): Promise<string> {
  const dir = options.dir ?? defaultCaptureDir();
  const home = options.home ?? paseoHome();
  const needles = [duplicate.agentId, ...duplicate.processes.map((entry) => `"pid":${entry.pid}`)];
  const sections = [
    `ZeroSub duplicate provider processes, detected ${detectedAt}`,
    `agent ${duplicate.agentId}`,
    ...duplicate.processes.map((entry) => `  ${describeProcess(entry)}`),
    "",
  ];
  const logs = await daemonLogs(home);
  for (const file of logs) {
    const hits = await linesMentioning(file, needles, options.maxLines ?? 2000).catch(() => []);
    sections.push(`==== ${basename(file)}: ${hits.length} line(s) mentioning the agent or its pids`, ...hits, "");
  }
  const current = logs.at(-1);
  if (current) sections.push(`==== ${basename(current)}: last ${options.tailBytes ?? 2_000_000} bytes`, await tail(current, options.tailBytes ?? 2_000_000).catch((error) => `(unreadable: ${String(error)})`));
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${detectedAt.replace(/[:.]/g, "-")}-${duplicate.agentId.slice(0, 8)}.log`);
  await writeFile(path, sections.join("\n"));
  return path;
}

/** What the watch needs to know about an agent before it may stop one of its processes. */
export interface AgentContext {
  /** Mid-turn or waiting on the user, or its status couldn't be read: never act then. */
  busy: boolean;
  /** Last path segment of the home of the account its session runs on; `null` the CLI login; `undefined` unknown. */
  home: string | null | undefined;
}

export const REAP = {
  /** A process has to look detached on checks at least this far apart before it's stopped. */
  confirmMs: 55_000,
  /** With no account mismatch to go by, it must also have been idle this long. */
  idleMs: 10 * 60_000,
  /**
   * Idle: under this share of one core between checks. A detached Claude process still ticks (about
   * 0.4% measured); a turn uses far more.
   */
  idleCpuShare: 0.01,
  /** SIGTERM, then SIGKILL after this long if it's still the same process. */
  killAfterMs: 10_000,
} as const;

export interface DuplicateWatchOptions {
  procRoot?: string;
  everyMs?: number;
  capture?: (duplicate: Duplicate, detectedAt: string) => Promise<string>;
  log?: (line: string) => void;
  now?: () => number;
  /** Whether stopping detached duplicates is on (the `reapDetachedDuplicates` preference). */
  reap?: () => boolean;
  /** The agent's state; when it throws or isn't given, nothing is stopped. */
  context?: (agentId: string) => Promise<AgentContext>;
  signal?: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
  /** Waits between SIGTERM and SIGKILL. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Which of an agent's duplicate processes look detached: never the newest (the one the daemon tracks:
 * a reload or close ends only it), and only one whose home isn't the account the agent now runs on, or
 * that has been idle (under `REAP.idleCpuShare` of a core) for `REAP.idleMs`.
 */
export function detachedCandidates(
  duplicate: Duplicate,
  home: string | null | undefined,
  idleSince: (entry: ProviderProcess) => number,
  now: number,
): Array<{ entry: ProviderProcess; why: string }> {
  const older = duplicate.processes.slice(0, -1);
  const out: Array<{ entry: ProviderProcess; why: string }> = [];
  for (const entry of older) {
    if (home !== undefined && entry.home !== home) {
      out.push({ entry, why: `its home (${entry.home ?? "CLI login"}) isn't the agent's account (${home ?? "CLI login"})` });
    } else if (now - idleSince(entry) >= REAP.idleMs) {
      out.push({ entry, why: `it has been idle (under 1% CPU) for ${Math.round((now - idleSince(entry)) / 60_000)} min` });
    }
  }
  return out;
}

/**
 * Checks at most once a `everyMs`; logs and captures each new set of duplicate processes once. With
 * reaping on, stops a process that has looked detached on two checks (`detachedCandidates`), with
 * SIGTERM and then SIGKILL, after logging it and copying the daemon log. Invariant: an agent never
 * keeps a detached duplicate whose home differs from its account for more than about two minutes.
 */
export class DuplicateWatch {
  private lastAt = Number.NEGATIVE_INFINITY;
  private seen = new Map<string, string>();
  private current: Array<Duplicate & { since: string }> = [];
  /** pid:startTicks -> CPU ticks at the last check, and since when it has been idle. */
  private cpu = new Map<string, { ticks: number; at: number; idleSince: number }>();
  /** pid:startTicks -> when it first looked detached. */
  private suspect = new Map<string, number>();
  private stopping = new Set<string>();

  constructor(private readonly options: DuplicateWatchOptions = {}) {}

  /** The duplicates found by the last check, each with when it was first seen. */
  get duplicates(): ReadonlyArray<Duplicate & { since: string }> {
    return this.current;
  }

  async check(): Promise<void> {
    if (process.platform !== "linux" && !this.options.procRoot) return;
    const now = (this.options.now ?? Date.now)();
    if (now - this.lastAt < (this.options.everyMs ?? 60_000)) return;
    this.lastAt = now;
    const processes = await scanProviderProcesses(this.options.procRoot);
    this.trackCpu(processes, now);
    const found = findDuplicates(processes);
    const log = this.options.log ?? ((line: string) => console.log(line));
    const capture = this.options.capture ?? ((dup: Duplicate, at: string) => captureDaemonLogs(dup, at));
    const next = new Map<string, string>();
    this.current = [];
    for (const duplicate of found) {
      const key = `${duplicate.agentId}:${duplicate.processes.map((entry) => entry.pid).join(",")}`;
      const since = this.seen.get(key) ?? new Date(now).toISOString();
      next.set(key, since);
      this.current.push({ ...duplicate, since });
      if (this.seen.has(key)) continue;
      const saved = await capture(duplicate, since).then((path) => `log copy in ${path}`, (error: unknown) => `log copy failed: ${String(error)}`);
      log(`[ZeroSub] agent ${duplicate.agentId} has ${duplicate.processes.length} provider processes: ${duplicate.processes.map(describeProcess).join("; ")}. Nothing was stopped; ${saved}`);
    }
    this.seen = next;
    await this.reapDetached(found, now, log, capture);
  }

  private trackCpu(processes: readonly ProviderProcess[], now: number): void {
    const next = new Map<string, { ticks: number; at: number; idleSince: number }>();
    for (const entry of processes) {
      const id = identity(entry);
      const before = this.cpu.get(id);
      const elapsedTicks = before ? ((now - before.at) / 1000) * CLOCK_TICKS : 0;
      const busy = !before || entry.cpuTicks - before.ticks > REAP.idleCpuShare * elapsedTicks;
      next.set(id, { ticks: entry.cpuTicks, at: now, idleSince: busy ? now : before.idleSince });
    }
    this.cpu = next;
  }

  private async reapDetached(
    found: readonly Duplicate[],
    now: number,
    log: (line: string) => void,
    capture: (duplicate: Duplicate, at: string) => Promise<string>,
  ): Promise<void> {
    const suspects = new Map<string, number>();
    if (this.options.reap?.() && this.options.context) {
      for (const duplicate of found) {
        const context = await this.options.context(duplicate.agentId).catch(() => null);
        if (!context || context.busy) {
          // Can't tell, or mid-turn: keep what was suspected, act on a later check.
          for (const entry of duplicate.processes) {
            const at = this.suspect.get(identity(entry));
            if (at !== undefined) suspects.set(identity(entry), at);
          }
          continue;
        }
        const idleSince = (entry: ProviderProcess) => this.cpu.get(identity(entry))?.idleSince ?? now;
        for (const { entry, why } of detachedCandidates(duplicate, context.home, idleSince, now)) {
          const id = identity(entry);
          const firstAt = this.suspect.get(id) ?? now;
          suspects.set(id, firstAt);
          if (now - firstAt < REAP.confirmMs || this.stopping.has(id)) continue;
          const at = new Date(now).toISOString();
          const saved = await capture(duplicate, at).then((path) => `log copy in ${path}`, (error: unknown) => `log copy failed: ${String(error)}`);
          log(`[ZeroSub] stopping detached duplicate of agent ${duplicate.agentId}: ${describeProcess(entry)}, because ${why}; keeping the newest, pid ${duplicate.processes.at(-1)!.pid}. ${saved}`);
          this.stopping.add(id);
          void this.stop(entry, log).finally(() => this.stopping.delete(id));
        }
      }
    }
    this.suspect = suspects;
  }

  /** SIGTERM, then SIGKILL if the very same process is still there; never a pid that was reused. */
  private async stop(entry: ProviderProcess, log: (line: string) => void): Promise<void> {
    const signal = this.options.signal ?? ((pid: number, sig: "SIGTERM" | "SIGKILL") => process.kill(pid, sig));
    const sleep = this.options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.()));
    if (!(await this.sameProcess(entry))) return;
    try {
      signal(entry.pid, "SIGTERM");
    } catch (error) {
      log(`[ZeroSub] couldn't stop pid ${entry.pid}: ${String(error)}`);
      return;
    }
    await sleep(REAP.killAfterMs);
    if (!(await this.sameProcess(entry))) {
      log(`[ZeroSub] detached duplicate pid ${entry.pid} of agent ${entry.agentId} has exited`);
      return;
    }
    try {
      signal(entry.pid, "SIGKILL");
      log(`[ZeroSub] detached duplicate pid ${entry.pid} of agent ${entry.agentId} ignored SIGTERM; sent SIGKILL`);
    } catch (error) {
      log(`[ZeroSub] couldn't kill pid ${entry.pid}: ${String(error)}`);
    }
  }

  private async sameProcess(entry: ProviderProcess): Promise<boolean> {
    const now = await scanProviderProcesses(this.options.procRoot).catch(() => []);
    return now.some((other) => other.pid === entry.pid && other.startTicks === entry.startTicks && other.agentId === entry.agentId);
  }
}

function identity(entry: ProviderProcess): string {
  return `${entry.pid}:${entry.startTicks}`;
}

/** A Claude Code Bash-tool shell (as `background-busy` recognizes them); MCP servers and hooks aren't. */
const BASH_TOOL_SHELL = /^\/bin\/(?:ba|z)?sh -c source \S*shell-snapshots\/snapshot-/;

/**
 * Bash-tool shells running under the agent's newest provider process. On an agent between turns each
 * one is a background job a reload would kill. Read-only; 0 off Linux or when nothing can be read.
 */
export async function backgroundShells(agentId: string, procRoot = "/proc"): Promise<number> {
  if (process.platform !== "linux" && procRoot === "/proc") return 0;
  const own = (await scanProviderProcesses(procRoot)).filter((entry) => entry.agentId === agentId);
  const newest = own.sort((a, b) => a.startTicks - b.startTicks || a.pid - b.pid).at(-1);
  if (!newest) return 0;
  let shells = 0;
  for (const name of await readdir(procRoot).catch(() => [] as string[])) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = await readFile(join(procRoot, name, "stat"), "utf8");
      if (Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]) !== newest.pid) continue;
      const argv = (await readFile(join(procRoot, name, "cmdline"), "utf8")).split("\0").filter(Boolean);
      if (BASH_TOOL_SHELL.test(argv.join(" "))) shells += 1;
    } catch {
      // Gone: not a job any more.
    }
  }
  return shells;
}

/**
 * Whether the agent's newest provider process is stopped (state T): Smart Session's Session Guard
 * holds a session at a limit with SIGSTOP. A reload can't close a stopped process, so a move waits.
 * Read-only; false off Linux or when nothing can be read.
 */
export async function providerStopped(agentId: string, procRoot = "/proc"): Promise<boolean> {
  if (process.platform !== "linux" && procRoot === "/proc") return false;
  const own = (await scanProviderProcesses(procRoot)).filter((entry) => entry.agentId === agentId);
  const newest = own.sort((a, b) => a.startTicks - b.startTicks || a.pid - b.pid).at(-1);
  if (!newest) return false;
  try {
    const stat = await readFile(join(procRoot, String(newest.pid), "stat"), "utf8");
    return /^[Tt]$/.test(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] ?? "");
  } catch {
    return false;
  }
}
