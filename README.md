# herdr-shepherdr

A herdr plugin that shows Shepherdr spaces, coordinators and tasks in herdr.

Shepherdr 2.1 runs its agents in herdr-core, not in herdr, so herdr doesn't show them. With this plugin linked,
open herdr and they are there:

- one workspace per Shepherdr space: `herdr-shepherdr`, `home` (the `~` space), and `zephyrus/four-eyes` for a
  space on another machine, with a `coordinator` tab;
- each task nested under its space in herdr's sidebar, as its own workspace (`FOUR-4 Four Eyes layered restructu…`):

  ```
   · zephyrus/four-eyes
     ├─ · FOUR-2 Four Eyes app extension
     └─ · FOUR-4 Four Eyes layered restructu…
   · herdr-shepherdr
     └─ · HERD-2 Herdr plugin nested task wo…
  ```

- each runs `hc attach <address>` (`t72`, `zephyrus/t15`), so it is the live agent: type in the coordinator's
  tab to talk to Shepherdr, in a task's to talk to that task. What you type there shows up in the Shepherdr
  chat like a message from you.

It stays in sync while herdr runs: a new task gets its nested workspace, a task that ends loses it, and a space with
no agents left loses its workspace. Tabs you open yourself in those workspaces are left alone (a workspace with one of
yours stays open: a task's is renamed `ended …` and becomes yours), unless you name them like ours (`coordinator`,
`FOUR-4`). A tab of ours where you split off a pane of your own becomes yours when its agent ends: it is renamed
`ended …` and kept. Browser and helper shells are not shown.

### How tasks nest

herdr nests a workspace only as a linked Git worktree of the repo its parent workspace is the main checkout of, so:

- a space on this machine whose coordinator runs in a repo's main checkout (`~/Work/herdr-shepherdr`) is that repo:
  its workspace opens there, and each task opens on its own worktree (`~/.shepherdr/worktrees/…`), the same as
  `herdr worktree open`. A new tab in a task's workspace starts in its checkout;
- a space on another machine, or one not in a repo (`home`), has no checkout here. It gets a stand-in instead: an
  empty repo in the plugin's state directory (`stand-ins/`) with an empty linked worktree per task, which only
  exists so herdr nests them (they are small and kept; delete `stand-ins/` with the plugin unlinked to clear them).
  New tabs in those workspaces start in that empty folder, not in `~` or the task's checkout on the other machine;
- a task with no linked worktree of the space's repo here, or whose checkout already has a workspace open on it (one
  of yours, or an `ended …` one the sync left you), gets a tab in its space's workspace, as all tasks did before.

Closing a nested workspace never deletes files: the sync only closes tabs, and never runs `herdr worktree remove`
or closes a workspace group. herdr groups by repo, so a workspace you open yourself on the same repo's main
checkout shares the same nest.

## Install

Needs Linux, herdr 0.9.5 or later, `bun` and `hc` on `PATH`.

```sh
gh repo clone kohanyirobert/herdr-shepherdr ~/Work/herdr-shepherdr
herdr plugin link ~/Work/herdr-shepherdr
```

The sync starts with the herdr server. If herdr is already running, start it once by hand (or restart herdr):

```sh
herdr plugin action invoke sync --plugin shepherdr
```

Remove it with `herdr plugin unlink shepherdr`: the sync stops within half a minute, then close its workspaces
yourself, the nested ones first (or `herdr workspace close <space's workspace> --group`, which closes them together
and deletes no files). The first sync after updating from the tab layout replaces each space's old workspace (opened
in the home folder, where nothing can nest) with one that tasks nest under.

## How it works

`sync.ts` is a `[[startup]]` hook that keeps running for as long as its herdr server does (one per server). It
follows `hc events`, and on every change, and every 15 seconds, it reads all terminals from herdr-core (the
first line of `hc events` is a snapshot with labels, both machines included) and makes herdr match:

- agents are the live terminals labelled `shepherdr.role` `coordinator` or `task`, grouped by `shepherdr.space`;
  a terminal's `cwd` says which repo and worktree it is in;
- a workspace is ours by its `space` metadata token, a task's also by its `task` token. A herdr restart forgets
  tokens and brings tabs back as plain shells, so the plugin's state directory keeps each workspace's label: a
  restored workspace with that label with a tab that looks like ours (`coordinator`, `FOUR-4 …`) is taken back and
  its tabs get their agents again;
- the sync closes nothing of a machine that is disconnected (an attach may still end by itself); its agents come
  back when it reconnects.

hc talks to herdr-core's `shepherdr` session (set `SHEPHERDR_HC_SESSION` in herdr's environment for another).
Its log is `sync-*.log` in `~/.local/state/herdr/plugins/shepherdr/` (one per herdr server).

## Good to know

- `hc attach` resizes the agent's terminal to the herdr pane (a 200×120 agent became 119×40). Whoever resizes
  last wins, and the agent keeps that size after you leave: the web UI shows it at that size, and while attached
  it was resized again by another viewer (119 to 80 columns, likely the web UI on a phone).
- Detaching with `ctrl+\` from a task ends the tab's command and closes it (and the task's workspace with it); the
  sync opens it again within a minute, as it does for a tab or workspace you close. The coordinator's tab goes back
  to its shell instead and is attached again within a minute, and a restarting coordinator comes back in the same
  tab, so the space's workspace stays where it is with its tasks nested under it. Unlink the plugin to stop seeing them.
- Two herdr servers with the plugin (say a named session) both attach, with the same resize rule.
