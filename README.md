# herdr-shepherdr

A herdr plugin that shows Shepherdr spaces, coordinators and tasks in herdr.

Shepherdr 2.1 runs its agents in herdr-core, not in herdr, so herdr doesn't show them. With this plugin linked,
open herdr and they are there:

- one workspace per Shepherdr space: `herdr-shepherdr`, `home` (the `~` space), and `zephyrus/four-eyes` for a
  space on another machine;
- in it a `coordinator` tab and one tab per task (`FOUR-4 Four Eyes layered restructu…`);
- each tab runs `hc attach <address>` (`t72`, `zephyrus/t15`), so it is the live agent: type in the coordinator's
  tab to talk to Shepherdr, in a task's tab to talk to that task. What you type there shows up in the Shepherdr
  chat like a message from you.

It stays in sync while herdr runs: a new task gets a tab, a task that ends loses its tab, and a space with no agents
left loses its workspace. Tabs you open yourself in those workspaces are left alone (a workspace with one of yours
stays open), unless you name them like ours (`coordinator`, `FOUR-4`). A tab of ours where you split off a pane of
your own becomes yours when its agent ends: it is renamed `ended …` and kept. Browser and helper shells are not shown.

## Install

Needs Linux, herdr 0.9.5 or later, `bun` and `hc` on `PATH`.

```sh
gh repo clone kohanyirobert/herdr-shepherdr ~/Work/herdr-shepherdr
herdr plugin link ~/Work/herdr-shepherdr
```

The sync starts with the herdr server. If herdr is already running, start it once by hand (or restart herdr):

```sh
herdr plugin action invoke shepherdr.sync
```

Remove it with `herdr plugin unlink shepherdr`: the sync stops within half a minute, then close its workspaces
yourself.

## How it works

`sync.ts` is a `[[startup]]` hook that keeps running for as long as its herdr server does (one per server). It
follows `hc events`, and on every change, and every 15 seconds, it reads all terminals from herdr-core (the
first line of `hc events` is a snapshot with labels, both machines included) and makes herdr match:

- agents are the live terminals labelled `shepherdr.role` `coordinator` or `task`, grouped by `shepherdr.space`;
- a workspace is ours by its `space` metadata token. A herdr restart forgets tokens and brings tabs back as
  plain shells, so the plugin's state directory keeps each workspace's label: a restored workspace with that label
  with a tab that looks like ours (`coordinator`, `FOUR-4 …`) is taken back and its tabs get their agents again;
- the sync closes nothing of a machine that is disconnected (an attach may still end by itself); its agents come
  back when it reconnects.

hc talks to herdr-core's `shepherdr` session (set `SHEPHERDR_HC_SESSION` in herdr's environment for another).
Its log is `sync-*.log` in `~/.local/state/herdr/plugins/shepherdr/` (one per herdr server).

## Good to know

- `hc attach` resizes the agent's terminal to the herdr pane (a 200×120 agent became 119×40). Whoever resizes
  last wins, and the agent keeps that size after you leave: the web UI shows it at that size, and while attached
  it was resized again by another viewer (119 to 80 columns, likely the web UI on a phone).
- Detaching with `ctrl+\` ends the tab's command and closes the tab; the sync opens it again within a
  minute, as it does for a tab or workspace you close. Unlink the plugin to stop seeing them.
- Two herdr servers with the plugin (say a named session) both attach, with the same resize rule.
