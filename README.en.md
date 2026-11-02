# dsh-parallel-worktree

[![CI](https://github.com/wang-yi-bit64/dsh-parallel-worktree/actions/workflows/ci.yml/badge.svg)](https://github.com/wang-yi-bit64/dsh-parallel-worktree/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/dsh-parallel-worktree.svg)](https://www.npmjs.com/package/dsh-parallel-worktree)

Parallel development for a single repository on DSH: open one isolated git worktree per task so several agents or terminals can work at once without stepping on each other.

It is the engineering layer on top of DSH's built-in `create_worktree`: the built-in tool creates one checkout and stops there, while this plugin adds a **registry, layout conventions, environment bootstrapping, and a sync/merge/cleanup closing loop**, plus a `/worktree` command for humans.

> English documentation (this file). The Chinese main document is [README.md](./README.md).

---

## What you see in DSH

After installing and restarting DSH Desktop, open **Settings → Plugins**. The plugin appears as a card with:

- a **title** — `Parallel Worktrees` in English UIs, 「并行 Worktree（多分支并行开发）」 in Chinese UIs;
- a **one-line description** of what it does (also localised);
- an **icon** — the bundled original `icon.svg` (one base line, three parallel checkouts), drawn with `currentColor` so it reads in both light and dark themes.

All three come from `locale/en.json`, `locale/zh.json` and `icon.svg` inside the package. DSH reads them **without activating the plugin**, so the plugin list stays recognisable even when it is disabled. A missing field falls back to the package's `name` / `description`; malformed metadata shows a diagnostic on the card instead of making it disappear.

The client half (the `client` part of the same package) contributes two pieces of session UI:

- a **Dock badge** in the **composer dock below the session input**; it renders `⛛ <name> <branch>` only when `/worktree status --json` reports `inWorktree: true`, and renders nothing otherwise;
- a **worktree panel** that pops upward when the badge is opened, listing every worktree of the repository. Each row shows name / branch / state / dirty / **ahead (↑n) / behind (↓n)** / whether it is "current" / the full path, with a **copy path** button; the header has only **refresh** and **close**.

The panel is **read-only**: its data comes only from `/worktree status --json` (once on mount) and `/worktree list --json` (once when opened, once per refresh), with no polling; there is no create, remove or merge entry point, because those writes stay on the `/worktree` command and the model tools by design (so a UI misclick can never discard uncommitted work). The panel, the commands and the tools read the same manager and the same `registry.json`, so they always show one set of data.

## Why it exists

The built-in `create_worktree` puts checkouts under `.agents/worktrees/<name>` inside the repository and only performs the create step. In real parallel work you keep hitting the same problems:

- checkouts pollute the repository, `git status` gets noisy and `.gitignore` needs hand maintenance;
- there is no overview of which branches are open, which are dirty, and how far behind the base they are;
- a fresh worktree has no `.env` and needs its `node_modules` reinstalled;
- uncommitted work in the main checkout does not come along, so you stash and patch by hand;
- finishing means merging, deleting the directory and deleting the branch in the right order — get it wrong and you leave a mess.

This plugin turns all of that into queryable, repeatable operations.

## Features

- **Create**: the `worktree_create` tool and `/worktree create` run `git worktree add`, create the branch and write the registry.
- **Layout**: worktrees live **outside** the repository by default, in a sibling directory `<repo>.wt/`, so the main checkout stays clean; `inside` (`<repo>/.worktrees/`) is also supported and keeps `.gitignore` up to date automatically.
- **Environment bootstrapping**: optionally carry the main checkout's uncommitted changes (`git diff --binary` + `apply --3way`) and untracked files into the new worktree, copy `.env` / `.env.local`, and reuse `node_modules` through a junction or symlink (a junction on Windows needs no administrator rights).
- **Visibility**: `worktree_list` returns one table — branch, path, whether it still exists, dirty state, HEAD, commits ahead of / behind the base.
- **Sync**: `/worktree sync` merges the base into the worktree (default `rebase --autostash`, `merge` on request); conflicts abort automatically and report `MERGE_CONFLICT`.
- **Merge and finish**: `/worktree merge` runs `merge --no-ff` in the main checkout, optionally removing the checkout (`--remove`) and deleting the branch (`--delete-branch`); a dirty main checkout or a detached HEAD is refused up front.
- **Cleanup**: `/worktree remove` (a dirty worktree needs `--force`) and `/worktree prune` (drops registry entries whose directory is gone).
- **Concurrency safety**: registry writes are atomic (`tmp` + rename) and serialised across processes by a `registry.lock` file; `batch` creates several worktrees under the same lock.

## Install

The plugin has to be composed into a DSH profile — that is how DSH plugins activate: `dsh.profile.bundles` lists package names, and DSH reads each package's `cordis.patch.yml` at start-up to inject the plugin row.

```powershell
# run from the repository root (the plugin directory)
node install.mjs                    # into %USERPROFILE%\.dsh\profiles\desktop
node install.mjs --dry-run          # show the plan, write nothing
node install.mjs --profile <dir>    # a different profile
```

The script does two things:

1. preflight — checks the package can be loaded as a bundle (`dsh.bundle.patch` must point at an existing `cordis.patch.yml` inside the package);
2. copy the package files to **`<DSH_HOME>/node_modules/dsh-parallel-worktree`** (by default `%USERPROFILE%\.dsh\node_modules\`) and append `dsh-parallel-worktree` to `dsh.profile.bundles`.

**Why `~/.dsh/node_modules` and not the profile?** A profile directory is itself a pnpm project (`pnpm-lock.yaml`, `node_modules/.modules.yaml`), and the DSH plugin manager runs `pnpm install` there: **any directory that is not declared in `dependencies` is treated as extraneous and deleted**. Once that happens, start-up fails with:

```text
dsh: cannot resolve profile bundle "dsh-parallel-worktree" from the dsh installation or <profile>; run 'dsh plugin --profile <name> install' if its dependency is not installed
```

`~\.dsh\node_modules` is an ancestor of the profile in Node's `node_modules` lookup, and DSH's `app-boot` resolves bundles with `require.resolve.paths()`, so the package is found there just the same — while pnpm never manages that directory. In-app plugin updates and any number of `pnpm install` runs leave it alone.

It backs up `package.json` to `package.json.bak-<timestamp>` before editing and rolls back on failure. `--no-bundles` copies files without touching bundles; `--force` skips the same-version notice. The copy includes `locale/`, `icon.svg` and every runtime file — the plugin card depends on them, and a missing piece degrades the card to the bare package name. The script also removes a stale copy that older versions left in `<profile>/node_modules`.

**Do not add the package to `dependencies` by hand.** Activation only looks at three things: the package declares `dsh.bundle`, its name is in `dsh.profile.bundles`, and its files resolve from `node_modules` (or the host install directory). Declaring `dependencies` without running the package manager leaves `pnpm-lock.yaml` inconsistent. If you want the normal npm flow, install with your package manager and make sure it is in `bundles` afterwards.

**Fully quit and restart DSH Desktop** afterwards (closing the window is not enough) — profiles are composed at start-up, and the profile directory is locked while the desktop is running, so `install.mjs` should run with the app closed.

To verify: run `/worktree help` in any session inside a git repository — the subcommand list appearing means registration succeeded (`/worktree help` does not need git state; `/worktree list` does). If the command is missing, check the newest log under `<profile>/.plugin-manager/logs`. The two common failures are `ERR_MODULE_NOT_FOUND ... imported from <profile>/` (package files not copied) and `declares no dsh.bundle` (missing `dsh.bundle.patch`).

## Quick start

Pick one of the two paths.

### A. Use the slash command

Inside a repository (the main checkout or an existing worktree), in any session:

```text
/worktree create feature/login
/worktree list
/worktree path feature/login
```

Typical `create` output:

```text
✓ 已创建 worktree feature/login
  分支   wt/feature/login
  路径   D:\code\portal.wt\feature\login
  起点   main @ 4f3c9a1b
  注册表 D:\code\portal.wt\registry.json

在终端 cd 到上面的路径，或在新会话里把它设为工作目录；该目录的改动与主工作区隔离。
```

(Command output is Chinese in this release. It says: created the worktree, here is the branch, the path, the base `<ref> @ <sha>`, and the registry file; then: `cd` there in a terminal, or point a new session at that directory — changes are isolated from the main checkout.)

`list` prints the overview table and `path` prints only the directory, handy for copying.

### B. Ask the agent

Express the same thing in chat (copy-pasteable):

```text
Create an isolated worktree for the login-page revamp: branch off main, name it feature/login,
and carry the uncommitted changes from the main checkout. From now on only touch files in that directory.
```

The agent calls `worktree_create`:

```json
{ "name": "feature/login", "base": "main", "carryUncommitted": true }
```

and receives (abridged; the real value is JSON text):

```json
{
  "name": "feature/login",
  "branch": "wt/feature/login",
  "path": "D:\\code\\portal.wt\\feature\\login",
  "repoRoot": "D:\\code\\portal",
  "baseCommit": "4f3c9a1b...",
  "createdAt": "2026-11-03T06:12:40.000Z",
  "manifestPath": "D:\\code\\portal.wt\\registry.json",
  "warnings": []
}
```

The agent then switches its working directory to `path` and works there. The switch is the session's own action — this plugin never touches the session working directory.

## Five real scenarios

Each one reads as: what you tell the agent → what it calls → what you get. Merge and removal have no model tools; you run those commands yourself.

### 1. Open a new task

```text
You: Open a worktree for the payment-retry work, name feature/pay-retry, use release/1.8 as the base,
     and reuse the main checkout's node_modules instead of reinstalling.
Agent: worktree_create({ name: "feature/pay-retry", base: "release/1.8", linkNodeModules: true })
```

Result: a checkout at `<repo>.wt/feature/pay-retry`, branch `wt/feature/pay-retry`, based on the commit `release/1.8` points at; `node_modules` is junctioned to the main checkout and usable immediately.

### 2. List every worktree

```text
You: Which worktrees exist for this repo? Which are dirty, which are behind main?
Agent: worktree_list({})
```

The response's `worktrees` array carries `name` / `branch` / `path` / `state` / `exists` / `dirty` / `head` / `ahead` / `behind`. `ahead` and `behind` are commit counts relative to the base. `state` is `active`, `merged`, or `missing` (directory gone — clean it with `/worktree prune`).

### 3. Move into a worktree

```text
You: I want to edit the feature/login checkout — point the session's working directory at it.
Agent: worktree_status({ name: "feature/login" })  → path
Agent: (after switching) I'm in that directory now; clean, 2 ahead / 0 behind.
```

If opening a new session is overkill, `/worktree path feature/login` gives you the path to `cd` into.

### 4. Sync with the base

```text
You: feature/login is behind main — bring it up to date, and stop if there are conflicts.
(human command; the agent cannot run it)
/worktree sync feature/login --base main
```

Output: `✓ 已把 main 同步进 worktree feature/login（rebase）` plus `BASE 4f3c9a1b` / `HEAD 9a12e77c`; if there were uncommitted changes, an extra `注意：同步前存在未提交改动（rebase 已自动 autostash）` line. A real conflict aborts automatically and reports `MERGE_CONFLICT`; the worktree is left at its pre-sync state.

### 5. Merge and clean up

```text
You: feature/login is tested — merge it into main, then drop both the checkout and the branch.
/worktree merge feature/login --base main --remove --delete-branch
```

Output: `✓ 已把 wt/feature/login 合并进 main`, the merge commit SHA, `checkout  已移除`, `分支      已删除`; if the main checkout was on another branch, an extra `主工作区已从 <branch> 切换到 main`. Afterwards `/worktree list` no longer shows it.

## Command reference

### `/worktree` subcommands

| Subcommand | Alias | Arguments | What it does | Output notes |
| --- | --- | --- | --- | --- |
| `create` | `new` | `<name> [--base <ref>] [--carry] [--link] [--no-env]` | new checkout + branch + registry entry | `✓ 已创建 worktree <name>`, branch, path, base `<ref> @ <sha8>`, registry path; warnings under `警告：` |
| `batch` | — | `<name1> <name2> ... [--base <ref>]` | create sequentially, collect failures | `批量创建：成功 N，失败 M`; per item `✓ name → branch  path` or `✗ name [CODE] message`; returns an error if anything failed |
| `list` | `ls` | — | table of all worktrees | columns `# 名字 分支 状态 脏 HEAD 领先/落后 路径`; first run says no worktrees are registered yet |
| `status` | `st` | `[name]` | inspect one worktree or the current one | `worktree <name>` + branch / path / state / dirty / HEAD / ahead-behind / created; outside a managed checkout it prints the repo and root |
| `path` | — | `<name>` | print only the checkout directory | one absolute path |
| `sync` | — | `<name> [--base <ref>] [--merge\|--rebase]` | merge the base into the worktree | `✓ 已把 <base> 同步进 worktree <name>（<mode>）` + BASE/HEAD; conflicts auto-abort |
| `merge` | — | `<name> [--base <ref>] [--message <msg>] [--remove] [--delete-branch]` | `merge --no-ff` in the main checkout | merge commit SHA + whether the main checkout switched + checkout/branch disposition; both are kept by default |
| `remove` | `rm` | `<name> [--force\|-f] [--delete-branch]` | remove the checkout (optionally the branch) | path + branch disposition; a dirty worktree is refused without `--force` |
| `prune` | — | — | drop registry entries whose directory is gone | `✓ 没有需要清理的注册项（保留 N 个）`, or one line per removed entry |
| `help` | — | — (also empty input, `-h`, `--help`) | help | subcommand cheat-sheet |

Options accept all three shapes: `--base main`, `--base=main`, short `-f`. Arguments are split on whitespace, so quote values containing spaces (`--message "fix: login redirect"`).

`merge` **keeps** both the checkout and the branch by default (verify first, delete later); pass `--remove --delete-branch` to finish in one step.

### `--json`: structured output

Every subcommand accepts `--json` (shorthand `-j`), which returns the result as a single JSON text line for panels and scripts. It only changes the output format, never the behaviour or the permissions.

Success is always `{ "ok": true, "action": "<subcommand>", ... }`. Fields per action:

| action | Fields |
| --- | --- |
| `create` | `name`, `branch`, `path`, `baseRef`, `baseCommit`, `repoRoot`, `wtRoot`, `manifestPath`, `warnings[]` |
| `batch` | `created[]` (`name` / `branch` / `path`), `failed[]` (`name` / `code` / `message`) |
| `list` | `repoRoot`, `wtRoot`, `layout`, `baseBranch` (`null` when it cannot be detected), `registry`, `worktrees[]` (same fields as the `worktree_list` tool) |
| `status` | `repoRoot`, `wtRoot`, `layout`, `baseBranch` (`null` when it cannot be detected), `inWorktree`, `worktree` (`null` outside a managed checkout) |
| `path` | `name`, `path` |
| `sync` | `name`, `branch`, `path`, `base`, `baseCommit`, `head`, `mode`, `dirtyBefore` |
| `merge` | `name`, `branch`, `base`, `mergeCommit`, `switchedFrom`, `removed`, `branchDeleted`, `note` |
| `remove` | `name`, `path`, `branch`, `deletedBranch`, `dirty` |
| `prune` | `pruned[]` (`name` / `path`), `kept` |

For `status`, `inWorktree=true` means the session working directory lies inside a managed worktree (the client Dock badge keys off it); `worktree` then holds that entry's details and is `null` in the main checkout or any unregistered directory.

Failures come back with `kind: error` and the text `{"ok":false,"code":"...","message":"...","hint":"..." or null}`: `code` follows the error-code table (`NOT_GIT_REPO`, `WORKTREE_NOT_FOUND`, `NAME_REQUIRED`, ...); an unknown subcommand is `UNKNOWN_SUBCOMMAND`. A partially failed `batch` still returns `ok: true`, with the failures listed in `failed[]`.

Two caveats: `/worktree` is the human command surface and models cannot call it — `--json` only changes the output format and does not open that surface to models; and the JSON still travels on the ordinary text channel (`kind` stays `success` / `error`), so older hosts and existing parsers keep working.

### The three model tools

| Tool | Parameters | Purpose |
| --- | --- | --- |
| `worktree_create` | `name` (required), `base`, `carryUncommitted`, `linkNodeModules`, `copyEnv` | create a worktree, return its details and warnings |
| `worktree_list` | none | list every worktree of the current repository |
| `worktree_status` | `name` (optional) | inspect the current or a named worktree; `inWorktree` is `false` outside managed checkouts |

Parameter details:

| Parameter | Type | Default | Meaning |
| --- | --- | --- | --- |
| `name` | string, required | — | worktree name, also used for the path and the branch (default branch `wt/<name>`). May contain `/` for nesting (`feature/login`); each segment is letters/digits/`. _ -`, starting with a letter or digit; `..`, backslashes, spaces and `~ ^ : ? * [ ] @ { }` are rejected; total length <= 100 |
| `base` | string | the main checkout's current branch (or the configured `baseBranch`) | base ref: branch, commit or tag |
| `carryUncommitted` | boolean | `false` | copy the main checkout's uncommitted changes (`git diff --binary` then `apply --3way`) and untracked files into the new worktree; `node_modules/` and `.git/` are skipped |
| `linkNodeModules` | boolean | plugin config (default `false`) | link the main `node_modules` into the new worktree (junction on Windows, no admin rights needed) |
| `copyEnv` | boolean | `true` | copy the plugin's configured env files (default `.env`, `.env.local`) |

`worktree_create` returns:

| Field | Meaning |
| --- | --- |
| `name` / `branch` / `path` | worktree name / new branch (`wt/<name>`) / absolute checkout directory |
| `repoRoot` | main repository root |
| `baseCommit` | full SHA of the base commit |
| `createdAt` | creation time (ISO 8601) |
| `manifestPath` | path of `registry.json` |
| `warnings` | array of warnings (e.g. a failed `--link` degrades to a warning instead of failing the create) |

`worktree_list` returns `repoRoot`, `wtRoot` (the worktree root), `layout` (`sibling`/`inside`), possibly `baseBranch`, `registry` (registry path) and `worktrees[]` where each entry has:

| Field | Meaning |
| --- | --- |
| `name` / `branch` / `path` | name / branch / checkout directory |
| `state` | `active` \| `merged` \| `missing` |
| `exists` | whether the directory still exists |
| `dirty` | whether there are uncommitted changes |
| `head` | current HEAD short SHA (may be absent) |
| `ahead` / `behind` | commits ahead of / behind the base |
| `baseCommit` / `createdAt` / `lastSyncAt` | base commit at creation, creation time, last sync time (may be absent) |

`worktree_status` returns `repoRoot`, `layout`, `inWorktree` (boolean) and an optional `worktree` with `name` / `branch` / `path` / `state` / `exists` / `dirty` / `head` / `ahead` / `behind` / `baseCommit`. A missing `worktree` means the session is in the main checkout or in an unregistered directory.

All three render as raw JSON in a single text block — the field names themselves are the contract.

## A typical parallel rhythm

```text
/worktree create feature/auth
/worktree create feature/pay
/worktree list                     # who is dirty, who is behind
/worktree sync feature/auth --base main
/worktree merge feature/auth --remove --delete-branch
```

With Agent Teams: give each teammate its own `/worktree create` directory and let them edit there; merge in order yourself. Because the directories are disjoint, no two agents ever write the same working tree.

## Configuration

Configuration comes from the plugin row's `config` in `cordis.patch.yml` (or an id-targeted override in the profile patch):

```yaml
- id: parallel-worktree
  name: dsh-parallel-worktree
  config:
    layout: sibling          # sibling (<repo>.wt/ next to the repo) | inside (<repo>/.worktrees/)
    dirName: .worktrees      # directory name when layout=inside
    siblingSuffix: .wt       # suffix of the sibling directory when layout=sibling
    branchPrefix: "wt/"      # prefix for created branches
    baseBranch: main         # default base when --base is omitted; unset = probe the main checkout
    syncMode: rebase         # rebase | merge
    copyEnv: [".env", ".env.local"]
    linkNodeModules: false
    enabled: true
```

The plugin row itself (`cordis.patch.yml`):

```yaml
- insert:
    - id: parallel-worktree
      name: dsh-parallel-worktree
```

With `enabled: false` the plugin is skipped entirely — no tools, no command — while its plugin card stays visible (metadata is read statically).

## Directories and registry

### Three placements

| Layout | Trigger | Checkout root | `.gitignore` |
| --- | --- | --- | --- |
| Sibling (default) | `layout: sibling` (default) | `<repo>.wt\` next to the repository, e.g. `D:\code\portal` → `D:\code\portal.wt\` | not needed, it lives outside the repo |
| Inside | `layout: inside` | `<repo>\.worktrees\` (`dirName` configurable) | the plugin appends `# dsh-parallel-worktree` and `/.worktrees/` to the repo-root `.gitignore` on first create |
| Custom suffix / directory name | change `siblingSuffix` or `dirName` | derived by the two rules above | same as the matching row |

To move the placement: change `layout` (or `siblingSuffix` / `dirName`) and **delete the old registry before recreating**. The registry records the `layout` it was created with; a mismatch raises `LAYOUT_MISMATCH`, whose hint names the registry file and gives both fixes (switch back, or delete the registry). One repository has exactly one registry, so it has exactly one layout.

```text
D:\code\portal               # main repository
D:\code\portal.wt\            # default wtRoot (outside the repo, not in git)
  registry.json               # registry v1: name/branch/path/base/timestamps
  registry.lock               # cross-process write lock (short-lived)
  feature\login\              # worktree checkout
  fix\header\
```

`/` in a name maps to nested directories, so `feature/login` → `feature\login`. The registry stores the base commit, creation time and most recent sync/merge information; `prune` only drops entries whose directory is gone and never touches live worktrees.

With `layout: inside` the registry lives at `<repo>\.worktrees\registry.json` and travels with the repository; the trade-off is that it is part of the working tree, so make sure the `.gitignore` line is committed when you share the repo.

## Living with other worktree tooling

Several worktree capabilities can be installed at once. They occupy different layers:

| Capability | Provider | Exposes | Checkout directory | Changes session cwd | Registry |
| --- | --- | --- | --- | --- | --- |
| This plugin | `dsh-parallel-worktree` | tools `worktree_create` / `worktree_list` / `worktree_status`, command `/worktree` | `<repo>.wt\` outside the repo by default, `inside` on request | no | `registry.json` |
| Built-in | `@deepseek-ai/dsh-experimental-tool-worktree` (ships with DSH) | only the `create_worktree` tool | `.agents/worktrees\<name>` inside the repo | yes (switches the session cwd after creating) | none |
| Task-scoped | `dsh-task-worktree` (third party) | also registers `/worktree` (`mode-on` / `mode-off` / `create` / `list` / `status` / `finish` / `bring-back` / `remove` / `prune`) | its own convention | no | per-repo manifest |
| View | `@cerbur/clutch-dsh-worktree` (third party) | adds a Worktree view that groups sessions by git worktree | creates nothing | no | none |

**With the built-in `create_worktree`: no conflict, both can be installed.** The tool names differ (`create_worktree` vs `worktree_create`). The built-in one switches the session's working directory right after creating and keeps checkouts inside the repo with no registry; this plugin leaves the session directory alone and gives you the registry, the outside-repo layout, environment bootstrapping and the closing loop. Use the built-in one for a quick throwaway checkout and this one for longer-lived parallel tasks.

**With `@cerbur/clutch-dsh-worktree`: no conflict.** It is a presentation layer (group sessions by worktree); it neither creates nor modifies worktrees and has no command. This plugin is the operation layer — the view will show the checkouts you create here.

**With `dsh-task-worktree`: conflict.** It also registers a slash command named `worktree`, and command names are globally unique in DSH. When both plugins load, the later registration throws and that plugin fails to load:

```text
command "worktree" is already registered (for a per-agent variant, mount a command-injected plugin under that agent's `agent.ctx`)
```

Symptom: `/worktree` still works, but its subcommands do not match this document — you see `mode-on`, `finish`, `bring-back` and friends. Triage:

1. open **Settings → Plugins** and look for a load-failure diagnostic;
2. check the order in `<profile>/package.json`'s `dsh.profile.bundles` — whichever comes first registers first;
3. keep one: remove the other from `bundles` (or uninstall it) and restart.

On this machine `dsh-task-worktree` is listed in `dependencies` but **not** in `dsh.profile.bundles`, so it is not loaded and `/worktree` belongs to this plugin.

## FAQ

### Start-up fails with `cannot resolve profile bundle "dsh-parallel-worktree"` — what now?

The package files were deleted by pnpm as an extraneous directory. A profile is a pnpm project: when the plugin manager runs `pnpm install`, anything not declared in `dependencies` is pruned. Older versions of this installer put the package in `<profile>/node_modules`, so it was pruned.

Just re-run the installer — it now installs into `<DSH_HOME>/node_modules`, which pnpm never manages:

```powershell
node install.mjs --profile desktop --force
```

Then **fully quit and restart** DSH Desktop. To confirm the files are in place:

```powershell
Test-Path "$env:USERPROFILE\.dsh\node_modules\dsh-parallel-worktree\package.json"   # must be True
```

If you prefer the normal npm flow, publish or install the package as a real dependency (add it to `dependencies` and run `dsh plugin --profile <name> install`) so pnpm treats it as its own.


### 1. How is this different from DSH's built-in `create_worktree`? Do they clash?

They do not clash — the tool names differ. The built-in tool only creates a checkout, switches the session directory to it, keeps it inside the repo under `.agents/worktrees/`, and has no registry. This plugin creates the checkout + branch + registry entry, keeps checkouts outside the repo by default, and never touches the session directory. A throwaway checkout: built-in. Three or four tasks at once, wanting to know who is dirty and merge them back: this plugin.

### 2. `/worktree` subcommands do not match — another worktree plugin is installed?

See the previous section: when several plugins register the same `worktree` command, only one wins. Run `/worktree help` to see whose subcommand set is active, then keep a single plugin and restart.

### 3. The directory is not a git repository, or I am in a subdirectory

The plugin locates the repository through git, so you must be inside a git working tree. Otherwise you get `NOT_GIT_REPO` (hint: `git init` or enter an existing repository). Running from any subdirectory is fine — it uses `git rev-parse --git-common-dir` to find the main root. Running inside an existing worktree works too, and the registry is always the main repository's: there is never one registry per worktree.

### 4. Can the same branch have two worktrees?

No — git itself forbids one branch being checked out twice. The three related codes:

- `BRANCH_EXISTS`: the branch already exists — rename, or `git branch -D` it first;
- `PATH_EXISTS`: the target directory already exists — rename, or delete the directory;
- `NAME_EXISTS`: the registry already has that name — `/worktree remove <name>` first.

### 5. Paths with spaces, non-ASCII characters, or another drive?

All fine. Every git call goes through an argv array (no shell concatenation), so spaces and non-ASCII characters survive. Quote the value in slash commands when it contains spaces (`--message "fix: login redirect"`). Checkouts can live on another drive; the `node_modules` link depends on volume/filesystem capability, so it may fail on non-NTFS or network paths — that only lands in `warnings` and does not block creation.

### 6. Windows long paths (> 260 characters)

Both git and Node are bounded by the legacy Windows `MAX_PATH`; the symptom is `GIT_FAILED` with a path-not-found/creation error underneath. Two fixes:

- keep the checkout root short — the default sibling `<repo>.wt` inherits the repository name, so deep repositories overflow; change `siblingSuffix` / `dirName`, or keep repositories shallow (e.g. `D:\code\portal`);
- enable long paths: *Computer Configuration → Administrative Templates → System → Filesystem → Enable Win32 long paths*, or set `HKLM\SYSTEM\CurrentControlSet\Control\FileSystem\LongPathsEnabled = 1`, and keep git reasonably recent.

### 7. Pitfalls of sharing `node_modules` with the link

`linkNodeModules` links the main `node_modules` into the new checkout (a junction on Windows, no admin rights needed), which makes it usable immediately. Three pitfalls:

- **shared state**: running `npm install` or bumping a version on either side changes both, which easily produces "works in the main checkout, fails in the worktree";
- **tool compatibility**: incremental builds, file watchers and some pnpm setups react slowly to junctions or report duplicate modules;
- **deletion order**: remove the link before removing the checkout (`cmd /c rmdir <checkout>\node_modules` deletes only the link, not its contents; avoid recursive delete tools), so a delete never follows the link into the main repository.

If you need independent dependencies, skip the link and install inside the worktree (copying the main lockfile first is a good start).

### 8. Do I have to edit `.gitignore` myself?

Not for the default `sibling` layout — checkouts live outside the repository. Only `layout: inside` needs it, and the plugin appends the lines to the repository-root `.gitignore` on first create:

```text
# dsh-parallel-worktree
/.worktrees/
```

Commit that line when you share the repository, otherwise teammates see the checkout directories as untracked files.

### 9. Can the profile directory be moved or renamed?

Not directly. DSH resolves plugins by package name under the profile's `node_modules`; after a move, start-up fails with `ERR_MODULE_NOT_FOUND`. Uninstall and reinstall instead — worktree data is untouched (it lives in and around your repositories, not in the profile).

### 10. Does uninstalling delete my worktrees?

No. Uninstalling removes `<profile>/node_modules/dsh-parallel-worktree` and one line from `bundles`. Worktree directories, branches and `registry.json` all remain — clean them up with `/worktree remove` / `prune` or by hand. After uninstalling those directories are still ordinary git checkouts, and the branches still exist.

### 11. Why can't the agent merge or remove?

A deliberate trade-off: `merge` rewrites the main branch, `remove` can discard uncommitted work, and `prune` edits the registry — all irreversible or wide-reaching, so they live on the human-only command. The model surface is limited to create/list/status, which keeps an agent from "helpfully" deleting your branch. Ask it to prepare the command; you run it.

### 12. Why didn't the session working directory change after creating?

By design (the built-in `create_worktree` does change it). Use the `path` returned by `worktree_create`, or `/worktree path <name>` and `cd` yourself.

### 13. Can I edit `registry.json` by hand?

Not advisable. Writes are atomic replacements under a file lock, and manual edits drift from actual git state (a deleted directory still in the registry shows as `state: missing`; fix with `/worktree prune`). Broken JSON raises `MANIFEST_CORRUPT`; the fix is deleting the registry and letting it rebuild (history is lost, the worktree directories are not affected).

### 14. How many worktrees can one repository have?

Practically unlimited for git; the constraint is disk and dependencies — each checkout is a full file tree, so avoid copying `node_modules` (use the link, or install only where needed).

## Error codes

Failures print `✗ <message>`, and `WorktreeError`s add a `→ suggestion` line. By scenario:

| Code | Meaning | Usual fix |
| --- | --- | --- |
| `NO_CWD` | session working directory unknown | reopen the session inside a directory |
| `NOT_GIT_REPO` | not inside a git working tree | `git init` or enter an existing repository |
| `LAYOUT_MISMATCH` | registry layout differs from the current config | restore the old `layout`, or delete the registry |
| `NO_REGISTRY` | this repository has no registry yet | `/worktree create <name>` first |
| `NAME_REQUIRED` | `name` missing | pass a name |
| `INVALID_NAME` | illegal name (`..`, spaces, backslashes, too long) | rename per the rules |
| `INVALID_BRANCH` | illegal branch name | check `branchPrefix` |
| `NAME_EXISTS` | registry already has that name | `remove` it first, or rename |
| `PATH_EXISTS` | target directory exists | rename, or delete the directory |
| `BRANCH_EXISTS` | branch already exists | rename, or `git branch -D` |
| `BASE_NOT_RESOLVED` | base ref cannot be resolved | check the ref, `git fetch` if needed |
| `GIT_FAILED` | `git worktree add` failed | read the stderr in the message (long paths / permissions) |
| `WORKTREE_MISSING` | registry entry exists, directory gone | `/worktree prune` |
| `WORKTREE_NOT_FOUND` | name is not registered | `/worktree list` to see the names |
| `BASE_REQUIRED` | sync/merge without a base | `--base <ref>` or configure `baseBranch` |
| `BASE_NOT_CHECKED_OUT` | main checkout cannot switch to the base | `git switch <base>` manually and retry |
| `BRANCH_MISSING` | the worktree's branch is gone | `/worktree prune` |
| `DIRTY_MAIN` | main checkout has uncommitted changes | commit or stash first |
| `DIRTY_WORKTREE` | the worktree has uncommitted changes | `remove --force` (discards them), or commit/stash before a merge-mode sync |
| `DETACHED_MAIN` | main checkout is on a detached HEAD | `git switch <base>` first |
| `MERGE_CONFLICT` | rebase/merge conflict, aborted automatically | resolve by hand with rebase/merge in that directory |
| `MANIFEST_CORRUPT` | `registry.json` is broken | delete and rebuild it |
| `LOCK_TIMEOUT` | another process held the registry lock | wait for the other operation, then retry |

## Development and tests

```powershell
node install.mjs --dry-run      # preflight + print the install plan
node --test test/manager.test.mjs test/schema.test.mjs test/tools.test.mjs test/cwd.test.mjs test/commands-json.test.mjs
```

Currently 29 tests: 27 pass, 0 fail, 2 skipped (platform/host-dependent cases), about 110 seconds. They need no DSH desktop process — plain Node plus your local git — and create temporary repositories they clean up afterwards. When the host `@deepseek-ai/dsh-tools` cannot be resolved, tool definitions fall back to the local equivalent in `lib/schema.js` (same validation rules, covered by `schema.test.mjs`).

After editing code, re-validate the locale and icon too: `locale/*.json` must be valid JSON with non-empty `meta.title` and `meta.description` (an empty string is treated as malformed and collapses the whole card into a diagnostic).

## Uninstall

```powershell
node uninstall.mjs                  # from the default profile
node uninstall.mjs --profile <dir>  # a specific profile
node uninstall.mjs --dry-run        # show the plan only
```

It removes `dsh-parallel-worktree` from `dsh.profile.bundles` (and from `dependencies` if present) and deletes `<profile>/node_modules/dsh-parallel-worktree`; `package.json` is backed up first. **Restart DSH afterwards.** No worktree data is touched.

## Design trade-offs

- **Humans own the closing actions.** The model surface is create/list/status only; merge/remove/prune stay in `/worktree`. Irreversible operations need a human confirmation.
- **Checkouts live outside the repository by default.** The main checkout stays clean, `.gitignore` needs no maintenance, `git status` is unpolluted. The cost is that checkouts are not inside the repo tree (an IDE must open them separately) — `layout: inside` buys that back.
- **The registry is ours, not git's.** It can store the base commit, creation time and last sync, and it can prune; the cost is possible short-term drift from actual git state, so `list`/`status` probe `exists` / `dirty` / `ahead` / `behind` live on every call.
- **Conflicts always abort.** Commands must be predictable unattended; conflict resolution is left to a human.
- **The session working directory is never changed.** The plugin stays a pure tool; the directory choice belongs to the user or the agent.

