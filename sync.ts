// Mirrors Shepherdr's agents from herdr-core into herdr: one workspace per space, a
// tab for its coordinator and one per task, each pane running `hc attach <address>`.
// One long-lived process per herdr server; it exits with that server, or when the
// plugin is unlinked or disabled.
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

const HERDR = process.env.HERDR_BIN_PATH ?? "herdr";
const HC = process.env.SHEPHERDR_HC ?? "hc";
const PLUGIN = process.env.HERDR_PLUGIN_ID ?? "shepherdr";
// Shepherdr runs its agents in herdr-core's "shepherdr" session. Drop any hc identity
// herdr inherited (say, when it was started inside a core terminal) so hc talks to that
// session as the human, and the panes we start do the same.
const SESSION = process.env.SHEPHERDR_HC_SESSION ?? "shepherdr";
const HC_IDENTITY = ["HC_SOCKET", "HC_SCOPE", "HC_TERMINAL_ID", "HC_TERMINAL_SOCKET"];
for (const name of HC_IDENTITY) delete process.env[name];
process.env.HC_SESSION = SESSION;
const SOURCE = "shepherdr"; // workspace metadata source; its `space` token marks our workspaces
const TICK_MS = 15_000; // also catches tabs the human closed, which hc events can't see
const REOPEN_MS = 30_000; // an attach that keeps failing can't spin
const GONE_MS = 10_000; // a restarting coordinator leaves its space empty for a moment

type Terminal = {
  address: string;
  name?: string;
  argv?: string[];
  state: string;
  created_ms: number;
  title?: string;
  labels?: Record<string, string>;
};
type Agent = { key: string; label: string; address: string };
type Space = { id: string; label: string; agents: Agent[] };
type Machines = Map<string, { name: string; connected: boolean }>;

// One sync per herdr server, keyed by its socket: a pid file, a state file and a log.
const stateDir = process.env.HERDR_PLUGIN_STATE_DIR ?? join(homedir(), ".local/state/herdr-shepherdr");
mkdirSync(stateDir, { recursive: true });
const serverId = createHash("sha256").update(process.env.HERDR_SOCKET_PATH ?? "default").digest("hex").slice(0, 12);
const pidFile = join(stateDir, `sync-${serverId}.pid`);
const stateFile = join(stateDir, `spaces-${serverId}.json`);
const logFile = join(stateDir, `sync-${serverId}.log`);

function log(...args: unknown[]) {
  const line = [new Date().toISOString(), ...args].join(" ");
  console.error(line);
  try {
    appendFileSync(logFile, line + "\n");
  } catch {}
}

function run(cmd: string[]): { ok: boolean; out: string; err: string } {
  const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env } });
  return { ok: p.exitCode === 0, out: p.stdout.toString(), err: p.stderr.toString() };
}

function herdr(...args: string[]): any {
  const r = run([HERDR, ...args]);
  if (!r.ok) throw new Error(`herdr ${args.join(" ")}: ${r.err.trim()}`);
  return r.out.trim() ? JSON.parse(r.out).result : null;
}

// The first line of `hc events` is a snapshot of every terminal on every machine, labels included.
async function snapshot(): Promise<Terminal[]> {
  const p = Bun.spawn([HC, "events", "--json"], { stdout: "pipe", stderr: "ignore", stdin: "ignore", env: { ...process.env } });
  const decoder = new TextDecoder();
  const timeout = setTimeout(() => p.kill(), 10_000);
  let buf = "";
  try {
    for await (const chunk of p.stdout) {
      buf += decoder.decode(chunk, { stream: true });
      if (buf.includes("\n")) break;
    }
  } finally {
    clearTimeout(timeout);
    p.kill();
  }
  const line = buf.split("\n")[0];
  if (!line) throw new Error("hc events gave no snapshot");
  return JSON.parse(line).terminals ?? [];
}

function machines(): Machines {
  const r = run([HC, "machine", "ls", "--json"]);
  if (!r.ok) throw new Error(`hc machine ls: ${r.err.trim()}`);
  const map: Machines = new Map();
  for (const m of JSON.parse(r.out).machines ?? []) map.set(m.id, { name: m.name, connected: m.state === "connected" });
  return map;
}

// An address on a machine that isn't connected right now ("zephyrus/t15" while zephyrus is away).
function offline(address: string, ms: Machines): boolean {
  if (!address.includes("/")) return false;
  const name = address.split("/")[0];
  return ![...ms.values()].some((m) => m.name === name && m.connected);
}

const spaceMachine = (id: string) => id.match(/^p:([^:]*):/)?.[1] ?? "";

function short(text: string, max = 28): string {
  return text.length > max ? text.slice(0, max - 1).trimEnd() + "…" : text;
}

function desiredSpaces(terminals: Terminal[], ms: Machines): Map<string, Space> {
  const spaces = new Map<string, Space>();
  const agents = terminals
    .filter((t) => t.state === "live" && !offline(t.address, ms))
    .filter((t) => ["coordinator", "task"].includes(t.labels?.["shepherdr.role"] ?? ""))
    .filter((t) => !t.name?.startsWith("sb-") && t.argv?.[0] !== "sh")
    .sort((a, b) => a.created_ms - b.created_ms);
  for (const t of agents) {
    const id = t.labels!["shepherdr.space"];
    if (!id) continue;
    const folder = id.match(/^p:[^:]*:(.*)$/)?.[1] ?? id;
    const name = folder === "~" ? "home" : folder; // Shepherdr calls the home folder's space "home"
    const machine = ms.get(spaceMachine(id))?.name;
    let space = spaces.get(id);
    if (!space) spaces.set(id, (space = { id, label: machine ? `${machine}/${name}` : name, agents: [] }));
    const coordinator = t.labels!["shepherdr.role"] === "coordinator";
    const task = t.labels!["shepherdr.task"];
    if (!coordinator && !task) continue;
    const key = coordinator ? "coordinator" : task!.replace(/^.*\//, "");
    const label = coordinator ? "coordinator" : t.title ? `${key} ${short(t.title)}` : key;
    // A restarted coordinator briefly overlaps its successor: the newest one wins.
    space.agents = space.agents.filter((a) => a.key !== key);
    const agent = { key, label, address: t.address };
    if (coordinator) space.agents.unshift(agent);
    else space.agents.push(agent);
  }
  return spaces;
}

// tab id -> the core address its pane is attached to. Filled when we open a tab, and
// from the pane's process otherwise, so a restarted sync adopts the tabs it left.
const attached = new Map<string, string>();
const opened = new Map<string, number>(); // address -> when we last opened a tab on it
const gone = new Map<string, number>(); // space id -> since when it has no agents

// The address the `hc attach` in this pane is on, if one runs there.
function attachedTo(paneId: string): string | undefined {
  const info = run([HERDR, "pane", "process-info", "--pane", paneId]);
  if (!info.ok) return undefined;
  for (const p of JSON.parse(info.out).result.process_info.foreground_processes ?? []) {
    const i = p.argv?.indexOf("attach") ?? -1;
    if (i > 0 && /(^|\/)hc$/.test(p.argv[i - 1]) && p.argv[i + 1]) return p.argv[i + 1];
  }
}

// Whether a pane is a shell at its prompt, with nothing of the human's running in it.
function idleShell(paneId: string): boolean {
  const info = run([HERDR, "pane", "process-info", "--pane", paneId]);
  if (!info.ok) return false;
  const p = JSON.parse(info.out).result.process_info;
  return p.shell_pid === p.foreground_process_group_id;
}

function adopt(workspaceId: string) {
  const ours = new Set(tabsOf(workspaceId).filter((t) => looksOurs(t.label)).map((t) => t.tab_id));
  for (const pane of herdr("pane", "list", "--workspace", workspaceId).panes ?? []) {
    if (attached.has(pane.tab_id) || !ours.has(pane.tab_id)) continue;
    const address = attachedTo(pane.pane_id);
    if (address) attached.set(pane.tab_id, address);
  }
}

function firstPane(workspaceId: string, tabId: string): string | undefined {
  return (herdr("pane", "list", "--workspace", workspaceId).panes ?? []).find((p: any) => p.tab_id === tabId)?.pane_id;
}

function attach(paneId: string, address: string) {
  const unset = HC_IDENTITY.map((name) => `-u ${name}`).join(" ");
  herdr("pane", "run", paneId, `exec env ${unset} HC_SESSION=${SESSION} ${HC} attach ${address}`);
  opened.set(address, Date.now());
}

// Our tabs are labelled "coordinator" or "<task id> <title>"; the key is the first word.
const keyOf = (label: string) => label.split(" ")[0];
const looksOurs = (label: string) => /^(coordinator|[A-Z][A-Z0-9]*-\d+)$/.test(keyOf(label));

function tabsOf(workspaceId: string): any[] {
  return herdr("tab", "list", "--workspace", workspaceId).tabs ?? [];
}

// Workspace tokens don't survive a herdr restart, so the state file remembers the label
// each of our workspaces had. A restored workspace is ours again only if its label is
// one of those and a tab in it looks like ours, so the human's own workspace of the same
// name is never taken. Their tabs in ours stay theirs either way.
function claimRestored(workspaces: any[]) {
  let owned: Record<string, string> = {};
  try {
    owned = JSON.parse(readFileSync(stateFile, "utf8"));
  } catch {}
  for (const [id, label] of Object.entries(owned)) {
    if (workspaces.some((w) => w.tokens?.space === id)) continue;
    const ws = workspaces.find((w) => !w.tokens?.space && w.label === label && tabsOf(w.workspace_id).some((t) => looksOurs(t.label)));
    if (ws) ws.tokens = { ...ws.tokens, space: id };
  }
}

function reconcile(spaces: Map<string, Space>, ms: Machines) {
  const workspaces: any[] = herdr("workspace", "list").workspaces ?? [];
  claimRestored(workspaces);
  const live = new Set<string>();
  const next: Record<string, string> = {};

  for (const space of spaces.values()) {
    gone.delete(space.id);
    let ws = workspaces.find((w) => w.tokens?.space === space.id);
    let tabs: any[] = [];
    if (ws) {
      adopt(ws.workspace_id);
      tabs = tabsOf(ws.workspace_id);
    }
    for (const agent of space.agents) {
      let tab = tabs.find((t) => attached.get(t.tab_id) === agent.address);
      if (!tab) {
        // A tab herdr restored as a plain shell after a restart: put the agent back in it.
        tab = tabs.find((t) => !attached.has(t.tab_id) && !live.has(t.tab_id) && keyOf(t.label) === agent.key);
        const paneId = tab && firstPane(ws.workspace_id, tab.tab_id);
        if (paneId && tab.pane_count === 1 && idleShell(paneId)) {
          attached.set(tab.tab_id, agent.address);
          attach(paneId, agent.address);
          log(`reattached ${space.label} ${agent.label} -> ${agent.address}`);
        } else tab = undefined;
      }
      if (tab) {
        live.add(tab.tab_id);
        if (tab.label !== agent.label) herdr("tab", "rename", tab.tab_id, agent.label);
        continue;
      }
      if (Date.now() - (opened.get(agent.address) ?? 0) < REOPEN_MS) continue;
      let tabId: string, paneId: string;
      if (!ws) {
        const r = herdr("workspace", "create", "--label", space.label, "--cwd", homedir(), "--no-focus");
        ws = r.workspace;
        tabId = r.tab.tab_id;
        paneId = r.root_pane.pane_id;
        herdr("tab", "rename", tabId, agent.label);
        log(`workspace ${space.label}`);
      } else {
        const r = herdr("tab", "create", "--workspace", ws.workspace_id, "--label", agent.label, "--cwd", homedir(), "--no-focus");
        tabId = r.tab.tab_id;
        paneId = r.root_pane.pane_id;
      }
      attached.set(tabId, agent.address);
      live.add(tabId);
      attach(paneId, agent.address);
      log(`tab ${space.label} ${agent.label} -> ${agent.address}`);
    }
    if (!ws) continue;
    herdr("workspace", "report-metadata", ws.workspace_id, "--source", SOURCE, "--token", `space=${space.id}`);
    next[space.id] = ws.label;
    closeEnded(space.label, tabs, live, ms);
  }

  // Spaces with no agents left lose our tabs; closing the last tab closes the workspace,
  // so one where the human opened tabs of their own stays with those.
  for (const ws of workspaces) {
    const id = ws.tokens?.space;
    if (!id || spaces.has(id)) continue;
    next[id] = ws.label;
    const machine = ms.get(spaceMachine(id));
    if (machine && !machine.connected) continue;
    if (!gone.has(id)) gone.set(id, Date.now());
    if (Date.now() - gone.get(id)! < GONE_MS) continue;
    adopt(ws.workspace_id);
    closeEnded(ws.label, tabsOf(ws.workspace_id), live, ms);
    gone.delete(id);
    delete next[id];
  }
  for (const [tabId, address] of attached) if (!live.has(tabId) && !offline(address, ms)) attached.delete(tabId);
  writeFileSync(stateFile, JSON.stringify(next, null, 2));
}

// Closes the tabs on agents that ended, and our tabs restored from before a restart that
// no agent claimed, when nothing else runs in them. One where the human split off a pane
// or started something of their own becomes theirs: renamed so it no longer looks ours.
function closeEnded(where: string, tabs: any[], live: Set<string>, ms: Machines) {
  for (const tab of tabs) {
    if (live.has(tab.tab_id)) continue;
    const address = attached.get(tab.tab_id);
    if (address ? offline(address, ms) : !looksOurs(tab.label)) continue;
    attached.delete(tab.tab_id);
    const paneId = tab.pane_count === 1 ? firstPane(tab.workspace_id, tab.tab_id) : undefined;
    if (paneId && (address ? attachedTo(paneId) : idleShell(paneId))) {
      // The attach usually ends by itself and takes its tab along; it may beat us to it.
      if (run([HERDR, "tab", "close", tab.tab_id]).ok) log(`closed tab ${where} ${tab.label}`);
    } else if (run([HERDR, "tab", "rename", tab.tab_id, `ended ${tab.label}`]).ok) {
      log(`left tab ${where} ${tab.label} to the human`);
    }
  }
}

function stillLinked(): boolean {
  const plugins = herdr("plugin", "list", "--json").plugins ?? [];
  return plugins.some((p: any) => p.plugin_id === PLUGIN && p.enabled);
}

const syncAlive = (pid: number) => {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("sync.ts");
  } catch {
    return false;
  }
};

// Waits a little for an old holder: on a live handoff the new server starts its hook
// before the old server's sync has noticed and left.
async function lock(): Promise<boolean> {
  for (let i = 0; i < 30; i++) {
    try {
      const fd = openSync(pidFile, "wx");
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      process.on("exit", () => {
        try {
          if (readFileSync(pidFile, "utf8") === String(process.pid)) unlinkSync(pidFile);
        } catch {}
      });
      for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => process.exit(0));
      return true;
    } catch {
      let pid = 0;
      try {
        pid = Number(readFileSync(pidFile, "utf8"));
      } catch {}
      if (!pid || !syncAlive(pid)) {
        try {
          unlinkSync(pidFile); // left by a sync that died
        } catch {}
        continue;
      }
      await Bun.sleep(1_000);
    }
  }
  return false;
}

let running = false;
let again = false;
async function sync() {
  if (running) return void (again = true);
  running = true;
  try {
    if (!stillLinked()) {
      log("plugin unlinked or disabled, exiting");
      process.exit(0);
    }
    do {
      again = false;
      const ms = machines();
      reconcile(desiredSpaces(await snapshot(), ms), ms);
    } while (again);
  } catch (e) {
    log("sync failed:", (e as Error).message);
  } finally {
    running = false;
  }
}

let timer: Timer | undefined;
function soon() {
  clearTimeout(timer);
  timer = setTimeout(sync, 500);
}

// Every change in herdr-core (a terminal started, ended or relabelled) triggers a sync.
async function follow() {
  for (;;) {
    const p = Bun.spawn([HC, "events", "--json"], { stdout: "pipe", stderr: "ignore", stdin: "ignore", env: { ...process.env } });
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of p.stdout) {
      const lines = (buf + decoder.decode(chunk, { stream: true })).split("\n");
      buf = lines.pop()!;
      if (lines.some((line) => line && !line.includes('"method":"heartbeat"'))) soon();
    }
    log("hc events ended, following again");
    await Bun.sleep(5_000);
  }
}

if (!(await lock())) {
  console.error("a sync already runs for this herdr server");
  process.exit(0);
}
log("sync started");
// herdr leaves its plugin commands running when its server stops; leave with the server.
const server = process.ppid;
setInterval(() => {
  if (process.ppid !== server) {
    log("herdr server gone, exiting");
    process.exit(0);
  }
}, 2_000);
await sync();
setInterval(sync, TICK_MS);
follow();
