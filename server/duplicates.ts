import { createReadStream, existsSync } from "node:fs";
import { mkdir, open, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { dataDir, paseoHome } from "./paths";

/**
 * Read-only watch for agents with more than one provider process: an orphaned process keeps writing
 * the same transcript and holds memory. Exists to catch the next occurrence while the daemon's logs
 * still cover it.
 *
 * It never kills or signals anything. It reads a process's environment only after its command line
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
      found.push({
        pid: Number(name),
        ppid: Number(fields[1]),
        agentId: env.PASEO_AGENT_ID,
        home: env.CLAUDE_CONFIG_DIR ? basename(env.CLAUDE_CONFIG_DIR) : null,
        resume: resumeOf(argv),
        startedAt: boot !== null && Number.isFinite(ticks) ? new Date(boot + (ticks / CLOCK_TICKS) * 1000).toISOString() : null,
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
      processes: [...list].sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? "") || a.pid - b.pid),
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

export interface DuplicateWatchOptions {
  procRoot?: string;
  everyMs?: number;
  capture?: (duplicate: Duplicate, detectedAt: string) => Promise<string>;
  log?: (line: string) => void;
  now?: () => number;
}

/** Checks at most once a `everyMs`; logs and captures each new set of duplicate processes once. */
export class DuplicateWatch {
  private lastAt = Number.NEGATIVE_INFINITY;
  private seen = new Map<string, string>();
  private current: Array<Duplicate & { since: string }> = [];

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
    const found = findDuplicates(await scanProviderProcesses(this.options.procRoot));
    const log = this.options.log ?? ((line: string) => console.log(line));
    const next = new Map<string, string>();
    this.current = [];
    for (const duplicate of found) {
      const key = `${duplicate.agentId}:${duplicate.processes.map((entry) => entry.pid).join(",")}`;
      const since = this.seen.get(key) ?? new Date(now).toISOString();
      next.set(key, since);
      this.current.push({ ...duplicate, since });
      if (this.seen.has(key)) continue;
      const capture = this.options.capture ?? ((dup, at) => captureDaemonLogs(dup, at));
      const saved = await capture(duplicate, since).then((path) => `log copy in ${path}`, (error: unknown) => `log copy failed: ${String(error)}`);
      log(`[ZeroSub] agent ${duplicate.agentId} has ${duplicate.processes.length} provider processes: ${duplicate.processes.map(describeProcess).join("; ")}. Nothing was stopped; ${saved}`);
    }
    this.seen = next;
  }
}
