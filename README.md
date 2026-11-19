# Fallow for Orca

A sidebar panel for [Orca](https://www.onorca.dev) that runs [Fallow](https://fallow.tools) on the
focused JavaScript or TypeScript workspace, inspired by the
[Fallow extension for VS Code](https://marketplace.visualstudio.com/items?itemName=fallow-rs.fallow-vscode).

- **Findings** by category: unused files, exports, types and dependencies, unresolved imports,
  unlisted dependencies, circular dependencies, duplication and complexity, with severity tabs
  and a search. Clones expand to every copy, as `card.svelte:53-63`, each one openable.
- **Fixes**, as Fallow's quick fixes: preview `fallow fix` for a file or the whole project, then
  apply; delete an unused file; add Fallow's own ignore comment. Each asks first, and only touches
  files Git can restore.
- **Health**: the score with the points each factor takes off, 23 vital signs, refactoring and
  hotspot candidates, hidden change coupling and the least maintainable files.
- **Agents**: "Fix with agent" on any finding or Health row, or one agent for a whole list. The
  agent runs the Fallow command for it, works through every item, runs your type check and tests,
  and does not commit.
- **Status bar**: grade and issue count; press to run again.

## Install

```sh
orca plugin install Sotoru/orca-fallow
```

Orca asks you to approve it first. It needs:

- **Its own Node.js process** (`trusted-worker`): to run Fallow, edit files and talk to Git.
- **`workspace:read` / `workspace:write`**: to find the focused workspace, open files, focus a tab.
- **`agent:launch`**, **`terminal:read`**, **`terminal:send`**: only for the agent buttons. Orca can
  drop a launch prompt before the agent is ready, so the plugin waits for the agent's input box
  and types the prompt itself.
- **`storage:own`**, **`settings:own`**: the last run, and which agent to start.

## How it runs Fallow

The project's own `node_modules/.bin/fallow` when there is one, with its version and config;
otherwise `npx fallow@3.44.0`, which downloads it once. One `fallow --score --format json` gives
every finding and the health score. Fallow runs on your machine; nothing is sent elsewhere.

## Limits

- Local workspaces only: a workspace on an SSH host is not analysed.
- Orca opens a file but cannot jump to a line: the line is shown in the panel.
- Plugins cannot write the clipboard: a finding id sits in a field to select and copy.
- Fallow cannot extract duplicates or refactor by itself; the agent buttons do that work.

## Develop

```sh
orca plugin dev watch . --check --json
orca plugin test . --json
orca plugin check . --json
```
