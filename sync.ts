// Mirrors Shepherdr's agents from herdr-core into herdr: one workspace per space with a
// tab for its coordinator, and each task in a linked worktree workspace nested under it,
// each pane running `hc attach <address>`.
// One long-lived process per herdr server; it exits with that server, or when the
// plugin is unlinked or disabled.
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, join } from "node:path";

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
  cwd?: string;
  argv?: string[];
  state: string;
  created_ms: number;
  title?: string;
  labels?: Record<string, string>;
};
type Agent = { key: string; label: string; address: string; cwd?: string; task: boolean };
type Space = { id: string; label: string; folder: string; agents: Agent[] };
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
  if (address.startsWith(LOOP)) {
    const machine = ms.get(spaceMachine(address.slice(LOOP.length)));
    return !!machine && !machine.connected;
  }
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
    if (!space) spaces.set(id, (space = { id, label: machine ? `${machine}/${name}` : name, folder: name, agents: [] }));
    const coordinator = t.labels!["shepherdr.role"] === "coordinator";
    const task = t.labels!["shepherdr.task"];
    if (!coordinator && !task) continue;
    const key = coordinator ? "coordinator" : task!.replace(/^.*\//, "");
    const label = coordinator ? "coordinator" : t.title ? `${key} ${short(t.title)}` : key;
    // A restarted coordinator briefly overlaps its successor: the newest one wins.
    space.agents = space.agents.filter((a) => a.key !== key);
    const agent = { key, label, address: t.address, cwd: t.cwd, task: !coordinator };
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

// A coordinator's tab runs attach-coordinator.sh, which attaches to whatever address the
// sync writes to its space's file; it stands in the attached map as "loop:<space>".
const LOOP = "loop:";
const SCRIPT = "attach-coordinator.sh";
const coordinatorsDir = join(stateDir, "coordinators");
mkdirSync(coordinatorsDir, { recursive: true });
const coordinatorFile = (space: string) => join(coordinatorsDir, encodeURIComponent(space));
// A copy in the state directory, so coordinator tabs keep working whichever checkout of
// the plugin started them, and after that checkout is gone.
const script = join(stateDir, SCRIPT);
writeFileSync(script, readFileSync(join(import.meta.dir, SCRIPT)));
const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

// The address the `hc attach` in this pane is on, or the coordinator loop running there.
function attachedTo(paneId: string): string | undefined {
  const info = run([HERDR, "pane", "process-info", "--pane", paneId]);
  if (!info.ok) return undefined;
  const fg: any[] = JSON.parse(info.out).result.process_info.foreground_processes ?? [];
  for (const p of fg) {
    const i = p.argv?.findIndex((a: string) => basename(a) === SCRIPT) ?? -1;
    if (i >= 0 && p.argv[i + 1]) return LOOP + decodeURIComponent(basename(p.argv[i + 1]));
  }
  for (const p of fg) {
    const i = p.argv?.indexOf("attach") ?? -1;
    if (i > 0 && /(^|\/)hc$/.test(p.argv[i - 1]) && p.argv[i + 1]) return p.argv[i + 1];
  }
}

const SHELL = /(^|\/)-?(ba|z|fi|k|mk|da|tc|c|y)?sh$|(^|\/)nu$/;

// Whether a pane is a shell at its prompt, with nothing of the human's running in it.
function idleShell(paneId: string): boolean {
  const info = run([HERDR, "pane", "process-info", "--pane", paneId]);
  if (!info.ok) return false;
  const p = JSON.parse(info.out).result.process_info;
  // An `exec hc attach` keeps the shell's pid, so the pid alone can't tell: the only
  // thing in the foreground must be the shell program itself. Typing into anything
  // else (an attach above all) would reach the agent as a message.
  const fg: any[] = p.foreground_processes ?? [];
  return (
    p.shell_pid === p.foreground_process_group_id &&
    fg.length > 0 &&
    fg.every((f) => f.pid === p.shell_pid && SHELL.test(f.argv?.[0] ?? ""))
  );
}

function adopt(workspaceId: string) {
  const ours = new Set(tabsOf(workspaceId).filter((t) => looksOurs(t.label)).map((t) => t.tab_id));
  const panes = run([HERDR, "pane", "list", "--workspace", workspaceId]);
  for (const pane of panes.ok ? (JSON.parse(panes.out).result.panes ?? []) : []) {
    if (attached.has(pane.tab_id) || !ours.has(pane.tab_id)) continue;
    const address = attachedTo(pane.pane_id);
    if (address) attached.set(pane.tab_id, address);
  }
}

function firstPane(workspaceId: string, tabId: string): string | undefined {
  return (herdr("pane", "list", "--workspace", workspaceId).panes ?? []).find((p: any) => p.tab_id === tabId)?.pane_id;
}

// Only ever into a pane we just opened, or an idle shell of ours: typed into anything
// else (an attach above all) it would reach an agent as a message. A task's attach takes
// its tab (and so its workspace) along when it ends. The coordinator's loop stays, so
// the space's workspace, which its tasks nest under, stays in place while the
// coordinator restarts.
function attach(paneId: string, address: string) {
  const unset = HC_IDENTITY.map((name) => `-u ${name}`).join(" ");
  const what = address.startsWith(LOOP)
    ? `HC=${quote(HC)} sh ${quote(script)} ${quote(coordinatorFile(address.slice(LOOP.length)))}`
    : `${HC} attach ${address}`;
  herdr("pane", "run", paneId, `exec env ${unset} HC_SESSION=${SESSION} ${what}`);
  opened.set(address, Date.now());
}

// Our tabs are labelled "coordinator" or "<task id> <title>"; the key is the first word.
const keyOf = (label: string) => label.split(" ")[0];
const looksOurs = (label: string) => /^(coordinator|[A-Z][A-Z0-9]*-\d+)$/.test(keyOf(label));

// A workspace may close under us (its last attach ended): it then has no tabs.
function tabsOf(workspaceId: string): any[] {
  const r = run([HERDR, "tab", "list", "--workspace", workspaceId]);
  return r.ok ? (JSON.parse(r.out).result.tabs ?? []) : [];
}

// herdr nests a linked Git worktree workspace under the workspace of its repo's main
// checkout. A local space whose coordinator runs in a repo's main checkout is that
// repo, and its tasks in their own linked worktrees nest under it for real. A space on
// another machine, or not in a repo (home), gets a stand-in: an empty repo in the
// state directory with an empty linked worktree per task, which only exists so herdr
// nests them. Nothing here ever removes a worktree.
type Base = { root: string; linked?: Set<string> };

function git(dir: string, ...args: string[]) {
  const config = ["user.name=shepherdr", "user.email=shepherdr@localhost", "commit.gpgsign=false", "core.hooksPath=/dev/null"];
  return run(["git", "-C", dir, ...config.flatMap((c) => ["-c", c]), ...args]);
}

function baseOf(space: Space): Base {
  const local = space.agents.every((a) => !a.address.includes("/"));
  // A restarting coordinator is away for a moment: its tasks know the repo too.
  const coordinator = space.agents.find((a) => !a.task);
  const from = coordinator?.cwd ?? space.agents[0]?.cwd;
  if (local && from && existsSync(join(from, ".git"))) {
    const r = git(from, "worktree", "list", "--porcelain");
    // Git refusing the repo (another owner, say) leaves the space with a stand-in.
    const paths = r.ok ? [...r.out.matchAll(/^worktree (.*)$/gm)].map((m) => m[1]) : [];
    if (paths[0] && (!coordinator || paths[0] === from)) return { root: paths[0], linked: new Set(paths.slice(1)) };
  }
  const dir = join(stateDir, "stand-ins", createHash("sha256").update(space.id).digest("hex").slice(0, 12));
  const root = join(dir, space.folder.replace(/[^\w.-]+/g, "-"));
  if (!existsSync(join(root, ".git"))) {
    mkdirSync(root, { recursive: true });
    if (!git(root, "init", "-q").ok || !git(root, "commit", "-q", "--allow-empty", "-m", "stand-in").ok) {
      throw new Error(`can't make the stand-in repo ${root}`);
    }
  }
  return { root: realpathSync(root) };
}

// Where a task's workspace opens: its own linked worktree, or its stand-in.
function checkoutOf(base: Base, agent: Agent): string | undefined {
  if (base.linked) return agent.cwd && base.linked.has(agent.cwd) ? agent.cwd : undefined;
  const path = join(base.root, "..", "tasks", agent.key);
  if (!existsSync(path) && !git(base.root, "worktree", "add", "-q", "--detach", path).ok) return undefined;
  return path;
}

// Workspace tokens don't survive a herdr restart, so the state file remembers the label
// each of our workspaces had, with its space and task. A restored workspace is
// ours again only if its label is one of those and a tab in it looks like ours, so the
// human's own workspace of the same name is never taken. Their tabs in ours stay theirs
// either way.
type Owned = { space: string; task?: string; label: string; nested?: boolean };
function readOwned(): Owned[] {
  try {
    const saved = JSON.parse(readFileSync(stateFile, "utf8"));
    // Before tasks nested it was { space: label }.
    return Array.isArray(saved) ? saved : Object.entries(saved).map(([space, label]) => ({ space, label: String(label) }));
  } catch {
    return [];
  }
}
// Spaces whose workspace is from before tasks nested: it opened in the home folder, where
// nothing can nest, so it is replaced once, when its space is next synced.
const legacy = new Set(readOwned().filter((o) => !o.task && !o.nested).map((o) => o.space));

function claimRestored(workspaces: any[]) {
  for (const { space, task, label } of readOwned()) {
    if (workspaces.some((w) => w.tokens?.space === space && w.tokens?.task === task)) continue;
    const ws = workspaces.find((w) => !w.tokens?.space && w.label === label && tabsOf(w.workspace_id).some((t) => looksOurs(t.label)));
    if (ws) ws.tokens = { ...ws.tokens, space, ...(task ? { task } : {}) };
  }
}

function tag(ws: any, space: string, task?: string) {
  const tokens = ["--token", `space=${space}`, ...(task ? ["--token", `task=${task}`] : [])];
  // It may have closed with its last tab since the workspace list.
  if (!run([HERDR, "workspace", "report-metadata", ws.workspace_id, "--source", SOURCE, ...tokens]).ok) return;
  ws.tokens = { ...ws.tokens, space, ...(task ? { task } : {}) };
}

// A workspace of ours left with only the human's tabs becomes theirs; false while a tab
// of ours is still in it.
function release(ws: any): boolean {
  const tabs = tabsOf(ws.workspace_id);
  if (tabs.some((t) => looksOurs(t.label))) return false;
  if (!tabs.length) return true; // closed with its last tab
  run([HERDR, "workspace", "report-metadata", ws.workspace_id, "--source", SOURCE, "--clear-token", "space", "--clear-token", "task"]);
  if (ws.tokens?.task) run([HERDR, "workspace", "rename", ws.workspace_id, `ended ${ws.label}`]);
  log(`left workspace ${ws.label} to the human`);
  return true;
}

function reconcile(spaces: Map<string, Space>, ms: Machines) {
  let workspaces: any[] = herdr("workspace", "list").workspaces ?? [];
  claimRestored(workspaces);
  const live = new Set<string>();
  const next = new Map<any, Owned>(); // workspace -> what the state file keeps of it
  const keep = (ws: any) =>
    next.set(ws.workspace_id, { space: ws.tokens.space, task: ws.tokens.task, label: ws.label, nested: !legacy.has(ws.tokens.space) });
  // A task's workspace first: closing the main one first would leave them unnested.
  const ofSpace = (id: string) =>
    workspaces.filter((w) => w.tokens?.space === id).sort((a, b) => (b.tokens?.task ? 1 : 0) - (a.tokens?.task ? 1 : 0));
  const tabsIn = (wss: any[]) => wss.flatMap((w) => (adopt(w.workspace_id), tabsOf(w.workspace_id)));

  for (const space of spaces.values()) {
    gone.delete(space.id);
    try {
      syncSpace(space);
    } catch (e) {
      log(`sync of ${space.label} failed:`, (e as Error).message);
      for (const ws of ofSpace(space.id)) keep(ws);
    }
  }

  function syncSpace(space: Space) {
    const base = baseOf(space);
    let main = workspaces.find((w) => w.tokens?.space === space.id && !w.tokens?.task);
    if (legacy.has(space.id)) {
      if (main) {
        log(`replacing workspace ${main.label}, its tasks can't nest under it`);
        closeEnded(main.label, tabsIn([main]), live, ms);
        release(main);
        workspaces = workspaces.filter((w) => w !== main);
        main = undefined;
      }
      legacy.delete(space.id);
    }
    let tabs = tabsIn(ofSpace(space.id));

    // Its first tab is the coordinator's; opened for a task, it waits there as a plain shell.
    const openMain = () => {
      const r = herdr("workspace", "create", "--label", space.label, "--cwd", base.root, "--no-focus");
      main = r.workspace;
      workspaces.push(main);
      tag(main, space.id);
      herdr("tab", "rename", r.tab.tab_id, "coordinator");
      log(`workspace ${space.label}`);
      return { tabId: r.tab.tab_id, paneId: r.root_pane.pane_id };
    };

    // The coordinator loop follows this file, so its tab stays across restarts.
    const coordinator = space.agents.find((a) => !a.task)?.address ?? "";
    const file = coordinatorFile(space.id);
    if ((existsSync(file) ? readFileSync(file, "utf8") : "") !== coordinator) writeFileSync(file, coordinator);

    for (const agent of space.agents) {
      const address = agent.task ? agent.address : LOOP + space.id;
      let tab = tabs.find((t) => attached.get(t.tab_id) === address);
      if (!tab) {
        // A tab herdr restored as a plain shell after a restart: put the agent back in it.
        tab = tabs.find((t) => !attached.has(t.tab_id) && !live.has(t.tab_id) && keyOf(t.label) === agent.key);
        const paneId = tab && firstPane(tab.workspace_id, tab.tab_id);
        if (paneId && tab.pane_count === 1 && idleShell(paneId)) {
          attached.set(tab.tab_id, address);
          attach(paneId, address);
          log(`reattached ${space.label} ${agent.label} -> ${agent.address}`);
        } else tab = undefined;
      }
      if (tab) {
        live.add(tab.tab_id);
        if (tab.label !== agent.label) herdr("tab", "rename", tab.tab_id, agent.label);
        const ws = workspaces.find((w) => w.workspace_id === tab.workspace_id);
        if (agent.task && ws?.tokens?.task === agent.key && ws.label !== agent.label) {
          herdr("workspace", "rename", ws.workspace_id, agent.label);
        }
        continue;
      }
      if (Date.now() - (opened.get(address) ?? 0) < REOPEN_MS) continue;

      let where: { tabId: string; paneId: string } | undefined;
      if (!main) {
        const first = openMain();
        if (!agent.task) where = first;
      }
      if (agent.task) {
        // Its workspace from before, kept open by a tab of the human's.
        const own = workspaces.find((w) => w.tokens?.space === space.id && w.tokens?.task === agent.key);
        const path = own ? undefined : checkoutOf(base, agent);
        // A workspace the human opened on that checkout stays theirs: herdr would relabel it.
        const other = path && workspaces.some((w) => w.worktree?.checkout_path === path);
        if (own) {
          const r = herdr("tab", "create", "--workspace", own.workspace_id, "--label", agent.label, "--no-focus");
          where = { tabId: r.tab.tab_id, paneId: r.root_pane.pane_id };
        } else if (path && !other) {
          const r = run([HERDR, "worktree", "open", "--workspace", main.workspace_id, "--path", path, "--label", agent.label, "--no-focus"]);
          const res = r.ok ? JSON.parse(r.out).result : undefined;
          if (res?.already_open) {
            // Not a fresh pane: someone's workspace is on it already. Never type into it.
            log(`not nesting ${agent.label}: ${res.workspace.label} is already open on ${path}`);
          } else if (res) {
            workspaces.push(res.workspace);
            tag(res.workspace, space.id, agent.key);
            herdr("tab", "rename", res.tab.tab_id, agent.label);
            where = { tabId: res.tab.tab_id, paneId: res.root_pane.pane_id };
          } else log(`can't nest ${agent.label} under ${space.label}: ${r.err.trim()}`);
        }
      }
      if (!where) {
        // A task that can't nest (no linked worktree of its own here) gets a tab, like the coordinator.
        const r = herdr("tab", "create", "--workspace", main.workspace_id, "--label", agent.label, "--cwd", base.root, "--no-focus");
        where = { tabId: r.tab.tab_id, paneId: r.root_pane.pane_id };
      }
      attached.set(where.tabId, address);
      live.add(where.tabId);
      attach(where.paneId, address);
      log(`tab ${space.label} ${agent.label} -> ${agent.address}`);
    }

    // A main workspace opened again (its coordinator's tab closed with the last attach)
    // isn't linked to the task workspaces still open: opening them again links them.
    if (main && !main.worktree) {
      for (const ws of ofSpace(space.id)) {
        if (!ws.tokens.task || ws.worktree?.repo_root !== base.root) continue;
        const r = run([HERDR, "worktree", "open", "--workspace", main.workspace_id, "--path", ws.worktree.checkout_path, "--label", ws.label, "--no-focus"]);
        if (r.ok) main.worktree = { repo_root: base.root };
      }
    }

    tabs = tabsIn(ofSpace(space.id));
    for (const ws of ofSpace(space.id)) {
      keep(ws);
      if (!ws.tokens.task) tag(ws, space.id);
      else if (space.agents.some((a) => a.key === ws.tokens.task)) tag(ws, space.id, ws.tokens.task);
    }
    // While its coordinator is away the main workspace's tabs stay, the waiting shell too.
    const hasCoordinator = space.agents.some((a) => !a.task);
    const ending = tabs.filter((t) => hasCoordinator || t.workspace_id !== main?.workspace_id);
    closeEnded(space.label, ending, live, ms);
    for (const ws of ofSpace(space.id)) {
      if (ws.tokens.task && !space.agents.some((a) => a.key === ws.tokens.task) && release(ws)) {
        next.delete(ws.workspace_id);
      }
    }
  }

  // Spaces with no agents left lose our tabs; closing the last tab closes the workspace,
  // so one where the human opened tabs of their own stays with those.
  const ended = new Set(workspaces.map((w) => w.tokens?.space).filter((id) => id && !spaces.has(id)));
  for (const id of ended) {
    const wss = ofSpace(id);
    for (const ws of wss) keep(ws);
    const machine = ms.get(spaceMachine(id));
    if (machine && !machine.connected) continue;
    if (!gone.has(id)) gone.set(id, Date.now());
    if (Date.now() - gone.get(id)! < GONE_MS) continue;
    writeFileSync(coordinatorFile(id), ""); // a coordinator tab that can't close waits idle
    for (const ws of wss) {
      closeEnded(ws.label, tabsIn([ws]), live, ms);
      if (ws.tokens.task) release(ws);
      next.delete(ws.workspace_id);
    }
    gone.delete(id);
  }
  for (const [tabId, address] of attached) if (!live.has(tabId) && !offline(address, ms)) attached.delete(tabId);
  writeFileSync(stateFile, JSON.stringify([...next.values()], null, 2));
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
    if (paneId && ((address && attachedTo(paneId)) || idleShell(paneId))) {
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
