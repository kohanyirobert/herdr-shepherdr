// Mirrors Shepherdr's agents from herdr-core into herdr: one workspace per space, a
// tab for its coordinator and one per task, each pane running `hc attach <address>`.
// One long-lived process per herdr server; it exits when that server goes away.
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

const HERDR = process.env.HERDR_BIN_PATH ?? "herdr";
const HC = process.env.SHEPHERDR_HC ?? "hc";
// Shepherdr runs its agents in herdr-core's "shepherdr" session. Drop any hc identity
// herdr inherited (say, when it was started inside a core terminal) so hc talks to that
// session as the human, and the panes we start do the same.
const SESSION = process.env.SHEPHERDR_HC_SESSION ?? "shepherdr";
const HC_IDENTITY = ["HC_SOCKET", "HC_SCOPE", "HC_TERMINAL_ID", "HC_TERMINAL_SOCKET"];
for (const name of HC_IDENTITY) delete process.env[name];
process.env.HC_SESSION = SESSION;
const SOURCE = "shepherdr"; // workspace metadata source; its `space` token marks our workspaces
const TICK_MS = 15_000; // also catches tabs the human closed, which hc events can't see

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

function log(...args: unknown[]) {
  console.error(new Date().toISOString(), ...args);
}

function run(cmd: string[]): { ok: boolean; out: string; err: string } {
  const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env } });
  return { ok: p.exitCode === 0, out: p.stdout.toString(), err: p.stderr.toString() };
}

class HerdrGone extends Error {}

function herdr(...args: string[]): any {
  const r = run([HERDR, ...args]);
  if (!r.ok) {
    if (/connect|No such file|refused|not running/i.test(r.err)) throw new HerdrGone(r.err.trim());
    throw new Error(`herdr ${args.join(" ")}: ${r.err.trim()}`);
  }
  return r.out.trim() ? JSON.parse(r.out).result : null;
}

// The first line of `hc events` is a snapshot of every terminal on every machine, labels included.
async function snapshot(): Promise<Terminal[]> {
  const p = Bun.spawn([HC, "events", "--json"], { stdout: "pipe", stderr: "ignore", stdin: "ignore", env: { ...process.env } });
  const reader = p.stdout.getReader();
  let buf = "";
  try {
    while (!buf.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += new TextDecoder().decode(value);
    }
  } finally {
    p.kill();
  }
  const line = buf.split("\n")[0];
  if (!line) throw new Error("hc events gave no snapshot");
  return JSON.parse(line).terminals ?? [];
}

function machines(): Map<string, { name: string; connected: boolean }> {
  const r = run([HC, "machine", "ls", "--json"]);
  const map = new Map<string, { name: string; connected: boolean }>();
  if (r.ok) for (const m of JSON.parse(r.out).machines ?? []) map.set(m.id, { name: m.name, connected: m.state === "connected" });
  return map;
}

function short(text: string, max = 28): string {
  return text.length > max ? text.slice(0, max - 1).trimEnd() + "…" : text;
}

function desiredSpaces(terminals: Terminal[], ms: ReturnType<typeof machines>): Map<string, Space> {
  const spaces = new Map<string, Space>();
  const agents = terminals
    .filter((t) => t.state === "live")
    .filter((t) => ["coordinator", "task"].includes(t.labels?.["shepherdr.role"] ?? ""))
    .filter((t) => !t.name?.startsWith("sb-") && t.argv?.[0] !== "sh")
    .sort((a, b) => a.created_ms - b.created_ms);
  for (const t of agents) {
    const id = t.labels!["shepherdr.space"];
    if (!id) continue;
    const [, machineId = "", folder = id] = id.match(/^p:([^:]*):(.*)$/) ?? [];
    const name = folder === "~" ? "home" : folder; // Shepherdr calls the home folder's space "home"
    const machine = ms.get(machineId)?.name ?? null;
    let space = spaces.get(id);
    if (!space) spaces.set(id, (space = { id, label: machine ? `${machine}/${name}` : name, agents: [] }));
    const coordinator = t.labels!["shepherdr.role"] === "coordinator";
    const key = coordinator ? "coordinator" : (t.labels!["shepherdr.task"] ?? t.address).replace(/^.*\//, "");
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
// address -> when we last opened a tab on it, so an attach that keeps failing can't spin.
const opened = new Map<string, number>();
const REOPEN_MS = 30_000;

function adopt(workspaceId: string) {
  for (const pane of herdr("pane", "list", "--workspace", workspaceId).panes ?? []) {
    if (attached.has(pane.tab_id)) continue;
    const info = herdr("pane", "process-info", "--pane", pane.pane_id).process_info;
    for (const p of info.foreground_processes ?? []) {
      const i = p.argv?.indexOf("attach") ?? -1;
      if (i > 0 && /(^|\/)hc$/.test(p.argv[i - 1]) && p.argv[i + 1]) attached.set(pane.tab_id, p.argv[i + 1]);
    }
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

// Workspace tokens don't survive a herdr restart, so remember which workspaces are ours.
let stateFile = "";
function loadOwned(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(stateFile, "utf8"));
  } catch {
    return {};
  }
}

function reconcile(spaces: Map<string, Space>, ms: ReturnType<typeof machines>) {
  const offline = (address: string) => {
    const m = address.includes("/") ? address.split("/")[0] : null;
    return m !== null && ![...ms.values()].some((x) => x.name === m && x.connected);
  };
  const owned = loadOwned(); // space id -> workspace label
  const workspaces: any[] = herdr("workspace", "list").workspaces ?? [];
  for (const ws of workspaces) {
    if (ws.tokens?.space) continue;
    const id = Object.keys(owned).find((id) => owned[id] === ws.label);
    if (id && !workspaces.some((w) => w.tokens?.space === id)) ws.tokens = { ...ws.tokens, space: id };
  }
  const live = new Set<string>();
  const next: Record<string, string> = {};

  for (const space of spaces.values()) {
    let ws = workspaces.find((w) => w.tokens?.space === space.id);
    let tabs: any[] = [];
    if (ws) {
      adopt(ws.workspace_id);
      tabs = herdr("tab", "list", "--workspace", ws.workspace_id).tabs ?? [];
    }
    for (const agent of space.agents) {
      let tab = tabs.find((t) => attached.get(t.tab_id) === agent.address);
      if (!tab) {
        // A tab herdr restored as a plain shell after a restart: put the agent back in it.
        tab = tabs.find((t) => !attached.has(t.tab_id) && !live.has(t.tab_id) && keyOf(t.label) === agent.key);
        const paneId = tab && firstPane(ws.workspace_id, tab.tab_id);
        if (paneId) {
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
    // Tabs on agents that ended, and our tabs restored from before a restart that no agent
    // claimed. Other tabs the human opened here stay.
    for (const tab of tabs) {
      if (live.has(tab.tab_id)) continue;
      const address = attached.get(tab.tab_id);
      if (address ? offline(address) : !looksOurs(tab.label)) continue;
      herdr("tab", "close", tab.tab_id);
      attached.delete(tab.tab_id);
      log(`closed tab ${space.label} ${tab.label}`);
    }
  }

  // Spaces with no agents left.
  for (const ws of workspaces) {
    const id = ws.tokens?.space;
    if (!id || spaces.has(id)) continue;
    const [, machineId = ""] = id.match(/^p:([^:]*):/) ?? [];
    const machine = ms.get(machineId);
    if (machine && !machine.connected) {
      next[id] = ws.label;
      continue;
    }
    herdr("workspace", "close", ws.workspace_id);
    log(`closed workspace ${ws.label}`);
  }
  for (const tabId of attached.keys()) if (!live.has(tabId) && !offline(attached.get(tabId)!)) attached.delete(tabId);
  writeFileSync(stateFile, JSON.stringify(next, null, 2));
}

// One sync per herdr server: a pid file keyed by its socket (and its state file beside it).
function lock(): boolean {
  const dir = process.env.HERDR_PLUGIN_STATE_DIR ?? join(homedir(), ".local/state/herdr-shepherdr");
  mkdirSync(dir, { recursive: true });
  const socket = process.env.HERDR_SOCKET_PATH ?? "default";
  const id = createHash("sha256").update(socket).digest("hex").slice(0, 12);
  const file = join(dir, `sync-${id}.pid`);
  stateFile = join(dir, `spaces-${id}.json`);
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(file, "wx");
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      const release = () => {
        try {
          if (readFileSync(file, "utf8") === String(process.pid)) unlinkSync(file);
        } catch {}
      };
      process.on("exit", release);
      for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => process.exit(0));
      return true;
    } catch {
      const pid = Number(readFileSync(file, "utf8"));
      let alive = false;
      try {
        alive = readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("sync.ts");
      } catch {}
      if (alive) return false;
      unlinkSync(file); // left by a sync that died
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
    do {
      again = false;
      const ms = machines();
      reconcile(desiredSpaces(await snapshot(), ms), ms);
    } while (again);
  } catch (e) {
    if (e instanceof HerdrGone) {
      log("herdr server gone, exiting");
      process.exit(0);
    }
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
    for await (const chunk of p.stdout) {
      if (!decoder.decode(chunk).includes('"heartbeat"')) soon();
    }
    log("hc events ended, following again");
    await Bun.sleep(5_000);
  }
}

if (!lock()) {
  log("a sync already runs for this herdr server");
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
