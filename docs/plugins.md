# Plugins

tfm plugins are small TypeScript files, loaded with **full trust** (like vim
plugins). They run in the same process, so a plugin can touch `node:fs`,
`node:child_process`, the network, anything Bun can. **Only install plugins you
trust.**

## Trust boundary

A plugin is imported in-process with the full Node.js/Bun runtime: it can read
or write any file the user can reach, spawn children, open sockets, and hold
arbitrary state for the lifetime of tfm. There is no sandbox, no seccomp, no
separate user — this is a deliberate design choice (vim-style, not a browser
extension model).

What isolation exists is narrow and defense-in-depth only:

- **Namespaced stores** — `api.store(name)` always returns the plugin's own
  store, whatever name it passes. Cross-plugin reads warn and return the
  caller's own store.
- **Name validation** — `PLUGIN_NAME_RE` (`[a-z0-9_-]`) gates the folder name
  and rejects unsafe plugin names before activation.
- **Symlink stripping** — staged plugin copies have symlinks stripped, so a
  malicious source tree cannot escape the plugin directory via a link.
- **Per-plugin error isolation** — a throwing `activate`, a rejected renderer,
  or a failed command surfaces as a toast or log line; it never takes tfm
  down. One bad plugin cannot crash another.

Install from a git URL, the bundled index, or `tfm plugins new` — all of which
are **your** sources. The bundled index is curated but not audited; treat every
plugin as code that runs with your user's privileges.

## Layout

One folder per plugin:

```
~/.config/tfm/plugins/<name>/<name>.ts   # the entry file
~/.config/tfm/plugins/<name>/state.json  # the plugin's own key/value store
~/.config/tfm/plugins/<name>/.tfm-source.json  # written by the installer
```

`$XDG_CONFIG_HOME` is honored. A legacy flat `<name>.ts` is migrated into the
folder layout on first scan.

## Install

In tfm: `esc` → Plugins → **Add from git URL…**.

CLI:

```
tfm plugins list              # installed plugins
tfm plugins search [query]    # search the index
tfm plugins add <url|id>      # install (or an index id, see docs/plugins.json)
tfm plugins remove <name>
tfm plugins update [name]     # one, or all
tfm plugins new <name>        # scaffold a starter plugin
```

Install accepts any git URL (`https://`, `ssh://`, `git://`, `git@host:repo`),
optionally `URL#ref subdir`. Edits hot-reload on the next esc-menu open.

## Writing one

```ts
export default {
  name: "hello",
  version: "1.0.0",
  author: "you",
  description: "example",
  apiVersion: 4,
  activate(api) {
    const off = api.events.on("navigate", ({ dir }) => api.log(`-> ${dir}`));
    return {
      rows: [{ kind: "action", label: "Say hi", run: () => api.notify("hi") }],
      fileMenu: (sel) => [{ label: `Hi ${sel.paths.length}`, run: (paths) => api.notify(paths.join("\n")) }],
      commands: [{ id: "hello:hi", title: "Hello: hi", defaultBinds: ["ctrl+j"], run: () => api.notify("hi") }],
      deactivate: () => off(),
    };
  },
};
```

`activate` may be async (10s cap). `deactivate` (or the returned one) runs on
remove and reload. **On quit** every `deactivate` is called synchronously, but
its returned promise is **not awaited** (quit is synchronous, so do sync cleanup
in `deactivate`, and anything async in an `api.events.on("quit")` listener
(listeners must be synchronous too).

## Manifest

| field | meaning |
|---|---|
| `name` | required, `[a-z0-9_-]`, becomes the folder name |
| `version` / `author` / `description` | optional, shown in the Plugins view |
| `apiVersion` | warn+load when it differs from core (currently `4`) |
| `minApiVersion` | higher than core → the plugin is rejected |

## API

`api` is the only surface. Add capabilities only by extending core.

- **Output**: `notify(msg, title?)`, `setStatusMsg(msg)`, `log(msg)`.
- **Context (read)**: `selection()`, `cwd()`.
- **Actions**: `navigate(dir)`, `open(path)`, `reveal(path)`, `select(paths)`.
- **Commands**: `commands()` (core + every plugin, for palettes).
- **UI**: `ui.pick({title, items})`, `ui.confirm({title, body?, danger?})`,
  `ui.prompt({title, value?, placeholder?, okLabel?})`,
  `ui.notifySticky(msg, title?) → close`.
- **State**: `store(name)` → `{ get(key, fallback), set(key, value) }`. Always
  returns your own store, whatever name you pass.
- **Events (observe)**: `events.on(evt, cb) → unsubscribe`. Events: `navigate`,
  `selection`, `file-op`, `trash`, `undo`, `theme`, `quit`, `boot`.
- **Hooks (intercept)**: `hooks.beforeFileOp(fn) → unsubscribe`. Return
  `{ skip: true, reason? }` to veto a `copy|move|rename|duplicate|extract|compress|trash|restore|delete-forever|empty`
  before core starts it. Sync-only, first skip wins.
- **Custom views**: `views.register({ id, label, render(ctx) }) → unsubscribe`.
  See [Custom views](#custom-views).
- **FS operations**: `operations.register({ id, title, run(paths) }) → unsubscribe`.
  See [Custom FS operations](#custom-fs-operations).

Subscribe in `activate` and unsubscribe in `deactivate`, or listeners leak
across reloads.

## Custom views

A plugin can add a **view mode** to the pane next to `grid | list | columns`.
`toggleView` (`ctrl+g`) cycles through it too. The renderer receives the pane's
current listing plus its selection and returns one OpenTUI renderable, which tfm
mounts in the pane instead of the grid.

`ctx` is stable data plus live getters:

| field | meaning |
|---|---|
| `entries` | the pane's listing: `[{ name, path, isDir, size? }]`, `path` absolute |
| `selection` | selected absolute paths in that pane |
| `cwd` | the pane's directory |
| `pane` | the pane id (`p0`, `p1`, …) |
| `renderer()` | the host `CliRenderer` — build your nodes with it |
| `colors()` | live theme colors (read inside the renderer: a theme flip repaints) |
| `app` / `version` | `"tfm"` and the tfm version |

Copy-pasteable renderer: one row of names, the focused ones highlighted.

```ts
import { Box, TextRenderable } from "@opentui/core";

export default {
  name: "trees",
  apiVersion: 4,
  activate(api) {
    api.views.register({
      id: "trees:flat",
      label: "Flat list",
      render(ctx) {
        const selected = new Set(ctx.selection);
        const box = new Box({ id: "trees-flat", flexDirection: "column", width: "100%" });
        for (const e of ctx.entries.slice(0, 200)) {
          box.add(
            new TextRenderable(ctx.renderer(), {
              id: `trees-flat-${e.path}`,
              content: `${e.isDir ? "dir " : "    "}${e.name}`,
              fg: selected.has(e.path) ? ctx.colors().accent : ctx.colors().foreground,
            }),
          );
        }
        return box;
      },
    });
    return {};
  },
};
```

Rules:

- **One renderer is returned, synchronously.** A throw (or returning nothing)
  renders that pane empty — it never takes tfm down.
- The renderer is called again on every repaint (navigate, selection, resize),
  so read `ctx.cwd`/`ctx.entries` fresh instead of caching them.
- Plugin views are **not available on the tty console** (like `grid`): an
  arbitrary renderable can't be proven safe there.
- Registrations are validated: a missing `id`/`label`/`render`, a duplicate id
  or an id over 64 chars is logged and dropped. First registration wins.
- Views are per pane: each pane remembers its own selected view.

## Custom FS operations

`operations.register({ id, title, run(paths) })` adds one entry to **both** the
command palette and the file context menu. `run` receives the selected absolute
paths — the right-click target (or the whole selection when the clicked tile is
part of it) from the menu, the live selection from the palette — and runs in
plugin context.

```ts
import { $ } from "bun";

export default {
  name: "unzip-here",
  apiVersion: 4,
  activate(api) {
    api.operations.register({
      id: "unzip-here:extract",
      title: "Unzip: extract here",
      async run(paths) {
        for (const p of paths.filter((x) => x.endsWith(".zip"))) {
          await $`unzip -o ${p} -d ${p.slice(0, -4)}`.quiet();
        }
        api.notify(`extracted ${paths.length}`, "unzip"); // errors become toasts
        api.navigate(paths[0] ?? api.cwd());
      },
    });
    return {};
  },
};
```

- A throw (or a rejected promise) surfaces as a toast, not a crash.
- Same validation as views: bad shapes and duplicate ids are logged and dropped.
- Registrations live with the plugin: unload/reload/remove takes them off the
  palette and the menu. Disabling the plugin in the Plugins view hides them
  without a restart.


## UI slots

`activate` can also return `slots`: real OpenTUI renderables painted into
tfm's layout. tfm mounts them at boot and refreshes them on every render, so
they see fresh `cwd`/`selection`.

Slot names:

- `statusbar`: a 1-row segment row (after the status label).
- `sidebar-footer`: a full-width stack under the places list.

The contribution gets `(ctx, data)`:

```ts
import { TextRenderable } from "@opentui/core";

export default {
  name: "clock",
  apiVersion: 4,
  activate(api) {
    return {
      slots: {
        statusbar(ctx, data) {
          return new TextRenderable(ctx.renderer(), {
            content: ` ${data.cwd} `,
            fg: ctx.colors().accent,
          });
        },
      },
    };
  },
};
```

`ctx` is `{ app, version, renderer(), colors(), cwd(), selection() }` (stable
ref, live getters). Plugin files may `import "@opentui/core"`, tfm installs
OpenTUI's runtime module support before loading plugins, so you get the host's
singleton (no second renderer). Read colors from `ctx.colors()` inside the
contribution so a theme flip repaints; baked hex looks stale after a theme
change.

A contribution must return one synchronous renderable. A throw (or returning
nothing) is contained per contribution (it renders as empty).

## Contributing points

`activate` can return: `rows` (extra rows in your Plugins-view category),
`fileMenu(sel)`, `sidebarMenu(place)`, `emptyAreaMenu({cwd})`, `commands`,
`preview` (`[{ exts, render(path) }]`, text only), `slots` (OpenTUI UI
contributions, see above), and `deactivate`.

## Not available

Toolbar buttons, sidebar sections, sort providers and custom
floating layers are core-only by design. Plugins can't rewrite an operation,
only veto it. (Statusbar / sidebar-footer UI is available via `slots`.)

## Types

`plugins-sample/tfm-api.d.ts` has the API types for editor autocomplete:

```ts
/// <reference path="./tfm-api.d.ts" />
export default { name: "x", apiVersion: 4, activate(api: TfmApi) { /* … */ } };
```
