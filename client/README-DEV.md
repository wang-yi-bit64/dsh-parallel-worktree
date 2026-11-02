# client/ developer notes (dsh-parallel-worktree)

Web-side half of the plugin: a composer-dock badge that shows the worktree the
current conversation lives in, plus a click-open panel listing every worktree of
the repository with a per-row "copy path" action.

## Files

- `client/client.js` — the only client artifact. Hand-written classic-script
  bundle in the official `window.__ModuleLoader__.load({ id, factory })` shape.
  No build step, no ESM, no extra chunk. Its only `require()` is `react`; JSX is
  not used (plain `React.createElement`), so `react/jsx-runtime` is not requested.
- `client/README-DEV.md` — this file.

## What the component does

Plugin export: `{ name: 'parallel-worktree-client', inject: [...], apply(ctx) }`.

- Registers locale dictionaries (zh + en, in code, namespace `parallel-worktree`)
  inside `ctx.effect(...)`.
- Registers one slot entry:
  `ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({ name, id: 'parallel-worktree-badge', order: 5, locale }, Badge))`.
- On mount only: `ctx.remote.commands.execute(sessionId, '/worktree status --json', [])`.
  The chip appears only when the payload has `inWorktree === true` and a
  `worktree` object; otherwise the component returns `null` (renders nothing).
  The chip text is `⛛ <name> <branch>`.
- On chip click: toggle the panel and (first open only) run
  `/worktree list --json`. The panel renders one row per `worktrees[]` entry:
  name, branch, state, "modified" when `dirty`, "current" when the row path equals
  the current worktree path, and the absolute path with a copy button.
  "Refresh" re-runs the list command; "Close" closes the panel.
- Session id resolution: `props.sessionId` (the slot kit always injects it for
  session-scoped slots), else `ctx.sessions.list.getSnapshot().current`.
- No `setInterval`/`setTimeout`, no polling: each `execute()` appends a
  command/run + command/done pair to the session transcript, so host calls are
  strictly mount / open / refresh triggered.
- Deliberately no create / remove / switch actions — the write surface stays on
  the `/worktree` slash command.

Failure posture (all verified by the self-test):

- `ctx.remote.commands.execute` missing → component renders `null`, nothing thrown.
- Command unknown (execute resolves with `value === undefined`) → `null`.
- Host error payload or transport error (`ok: false`) → a small inline error line
  (`role="alert"`, `payload.message` + `hint`), never a throw.
- Not inside a worktree → `null`.

Styling: inline style objects only, no CSS file and no `document.head/body`
writes (a hand-written bundle has no CSS injection step). Colors are theme tokens
with hex fallbacks: `var(--dsw-alias-bg-base, #ffffff)`,
`var(--dsw-alias-border-l1/l2)`, `var(--dsw-alias-label-primary/secondary/caption)`,
`var(--dsw-alias-state-business-primary)`, `var(--dsw-alias-state-error)`.
The popover opens upward (`bottom: calc(100% + 6px)`) because the composer dock
sits below the composer card.

## Verified (evidence in this repo)

1. `node --check client/client.js` → exit 0 (`NODE_CHECK_OK`).
   Node: any Node 22+ on `PATH` (`node --check`).
2. Stub-based bundle self-test: `research/ui-client-selftest.mjs`, **35/35 checks
   pass** (`exit 0`). It evaluates the real bundle in a `node:vm` context with a
   fake `window.__ModuleLoader__`, a fake React hook engine (re-render capable),
   a fake React `createElement`, and a fake client ctx
   (`effect`, `locale.register`/`bind`, `slots.inject`/`register`,
   `sessions.list.getSnapshot`, `remote.commands.execute`). It asserts: only
   `react` is required; `inject` array; slot name/id/order/locale; one status read
   on mount with the slot sessionId; chip text; null render outside a worktree;
   one list read on open; row contents (name/branch/state/dirty/current/path);
   copy-path writes the exact row path into `navigator.clipboard`;
   copy feedback; refresh re-reads once; no timers; no `document.body/head`;
   and the four degrade paths above.
3. Manifest / loader / slot rules read from the shipped Harness bundles extracted
   from `D:/Program Files/Deepseek-harness/resources/app.asar`
   (`@deepseek-ai/dsh-client-modules`, `...-ui-renderer`, `...-ui-conversation`,
   `...-api-session-controller`, `...-client-locale`):
   - `dsh.client` is validated as: object with required string `platform`,
     optional `inject: string[]`, `external: string[]`, `immediately: boolean`.
   - bundles are classic scripts: `__ModuleLoader__.load` only registers the
     factory; `factory(require)` runs at materialization.
   - `conversation.composer.dock` is `{ kind: 'list', scope: 'session' }` and its
     outlet is `renderSlot('conversation.composer.dock', {})` —
     components get no owner props; the renderer supplies `props.sessionId` and,
     with `locale` in the entry, a `props.t` seat.
   - `remote.commands.execute(sessionId, line, []) → { ok, value?: { commandId, result: { kind, text } } | undefined, error? }`;
     host success text is `JSON.stringify({ ok: true, ...payload })`.
   - host payloads: `status` has `inWorktree`, `worktree|null`;
     `list` has `worktrees[{ name, branch, path, state, dirty, ... }]`, `baseBranch`.

## Guessed / unverified (needs the Lead's real-machine check)

- **Live rendering is not visually verified.** No separate browser was started,
  no screenshots, no token hunting (per verification.md). The slot is validated
  statically + by the stub harness, not in a running Web UI.
- `dsh.client.immediately: true` is *assumed required* for slot contributions to
  appear without another module requiring this bundle (the official decoration
  template sets it). If the badge does not show up after the package.json change,
  this flag (and the `inject` ids below) is the first thing to check.
- The runtime service names in `inject` are taken from real bundles' cordis
  service names (`slots`, `locale`, `sessions`, `remote.commands`), not from a
  typed contract, because the type definitions live in the asar.
- `props.sessionId` is expected from the renderer kit for session-scoped slots;
  the fallback to `ctx.sessions.list.getSnapshot().current` covers a missing prop.

## package.json changes for the Lead (do not apply from this file)

```jsonc
"exports": {
  ".": "./lib/index.js",
  "./lib/*": "./lib/*",
  "./client": "./client/client.js",   // + this line
  "./package.json": "./package.json",
  "./locale/*.json": "./locale/*.json",
  "./icon": "./icon.svg"
},
"files": ["lib", "client", "cordis.patch.yml", "README.md", "README.zh.md", "locale", "icon.svg", "install.mjs", "uninstall.mjs", "LICENSE"],
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": {                          // + this whole object
    "platform": "web",
    "immediately": true,
    "inject": [
      "@deepseek-ai/dsh-client-locale",
      "@deepseek-ai/dsh-client-ui-layout",
      "@deepseek-ai/dsh-client-ui-conversation",
      "@deepseek-ai/dsh-api-remotes",
      "@deepseek-ai/dsh-api-session-controller"
    ]
  }
}
```

All five inject ids were confirmed present in the real `__DSH_BOOT__` module list
(70 entries) of the running install. Do **not** add
`@deepseek-ai/dsh-client-ui-primitives` — it is not in that list, and the bundle
does not require it.

## Collision note

The profile also contains `dsh-task-worktree` (slot
`conversation.input.dock`, id `worktree`, plus
`conversation.session.header.actions` id `worktree-badge`) and
`@cerbur/clutch-dsh-worktree`. This plugin deliberately differs:

- different slot: `conversation.composer.dock` (below the composer), id
  `parallel-worktree-badge`, order 5 — not the input dock or the session header;
- distinct marker attributes `data-plugin="parallel-worktree"` and
  `data-dsh-parallel-worktree` / `data-dsh-parallel-worktree-panel` for DOM
  selection in future tests;
- the glyph `⛛` plus the plugin-specific aria label
  (`Parallel worktree: <name>. Click to list worktrees.`) give screen readers and
  humans a different signature from "worktree-badge";
- it never reads another plugin's DOM and never replaces app root.
