# tfm user manual

A beginner-friendly guide to tfm (terminal file manager): every feature and
every default keybinding. New here? Start with the cheat sheet, then read the
section you need.

## Quick start: the ten keys you need

| Key | What it does |
|---|---|
| `enter` | Open the focused file or folder |
| `up` / `down` | Move the selection |
| `backspace` | Go up one folder |
| `f2` | Rename the selection |
| `ctrl+c`, `ctrl+x`, `ctrl+v` | Copy, cut, paste |
| `delete` | Move to trash |
| `ctrl+z` | Undo the last file change |
| `f3` | Toggle the preview pane |
| `ctrl+g` | Cycle the view (grid / list / columns) |
| `escape` | Open the menu (settings, plugins, help) |

Press `f1` any time to show the full shortcut sheet in the app.

## What tfm is

tfm is a terminal file manager for Linux and macOS. It runs in any terminal
and shows your files in a grid, a compact list, or Finder-style columns. It
does the usual file work — open, copy, move, rename, delete, preview, search —
plus an embedded terminal, an optional second pane with sync browsing, and a
plugin system.

## Install and run

Install the released build:

```bash
curl -fsSL https://raw.githubusercontent.com/clarkarch/tfm-tui/main/install.sh | bash
```

Build from source (needs git and Bun 1.4 or newer):

```bash
git clone https://github.com/clarkarch/tfm-tui.git
cd tfm-tui
bun install --frozen-lockfile
bun run check && bun test
bun run compile && cp dist/tfm ~/.local/bin/
```

Run the compiled `tfm`, or run straight from source without compiling:

```bash
bun run dev          # watch mode
bun src/index.ts     # one-off run
```

### Command line

```
Usage: tfm [OPTIONS] [PATH]

  PATH               directory to open (default: current dir). A file opens
                     its parent folder and selects that file.

Options:
  -h, --help         show this help and exit
  -v, --version      print version and exit
  -d, --debug        write a verbose event log (for bug reports)
  -c, --config FILE  use FILE instead of ~/.config/tfm/config.toml
  -C, --cwd DIR      change to DIR before starting
  --no-restore       do not restore session state on boot
  --restore          force session state restore
  --view=MODE        start active pane in MODE (grid | list | columns)
  --preview          start with preview pane open
  --info             start with info sidebar open
  --terminal         start with terminal open
  --                 treat the rest as PATH (names that start with '-')

Commands:
  plugins [list|search|add|remove|update|new]   manage plugins
```

There is no `bun run start` script; use `bun run dev` or `bun src/index.ts`.

### Optional tools

Everything here is optional. tfm degrades gracefully without them.

- Linux: `xdg-open` (open files), `gio` (starred files and servers),
  `udisksctl` (USB drives), `wl-clipboard` / `xclip` (clipboard sharing).
  macOS uses built-in `open`, `diskutil`, `pbcopy` / `pbpaste`.
- `magick` (extra photo thumbnails), `tag` (macOS Finder tags), `fd` (fast
  recursive search), `ffmpeg` (macOS video thumbnails), and `tar` / `unzip` /
  `zip` / `7z` (archives).

## Navigating

The file list has a focused row (your cursor) and one or more selected rows.
Moving the cursor does not change the selection; opening or acting on the
focused row does.

| Key | What it does |
|---|---|
| `up` / `down` | Move the cursor one row |
| `left` / `right` | Move one column (grid) or switch column (columns view) |
| `pageup` / `pagedown` | Move one screen |
| `home` / `end` | Jump to the first or last item |
| `enter` | Open the focused file/folder |
| `backspace` or `alt+up` | Go up one folder |
| `alt+left` / `alt+right` | History back / forward |
| `alt+home` | Go to your home folder |
| `ctrl+l` | Edit the path bar and type a path to jump to |
| `shift+cmd+g` | Go to Folder popup (see below) |

## Default keybindings

Every action below is remappable: `escape` → **Settings** → **keys**. The
`[keys]` table in `config.toml` carries the same actions in kebab-case.

Two actions ship with **no default bind** — bind them yourself if you want
them:

- **Filter folder while typing** (`start-search`): re-arms type-to-search
  after it has been switched off. No default key.
- **Invert selection** (`invert-selection`): swaps selected with unselected.
  No default key.

### App

| Action | Default key(s) | What it does |
|---|---|---|
| quit | `ctrl+q` | Leave the file manager |
| restart | `ctrl+alt+r` | Reload the app in place |
| open menu | `escape` | Open settings, plugins and help |
| toggle help | `f1` | Show or hide the shortcut sheet |

### Tabs

| Action | Default key(s) | What it does |
|---|---|---|
| new tab | `ctrl+t` | Open a fresh tab here |
| close tab | `ctrl+w` | Close the current tab |
| next tab | `ctrl+tab` | Jump to the next tab |
| previous tab | `ctrl+shift+tab` | Jump back to the prior tab |

### Files

| Action | Default key(s) | What it does |
|---|---|---|
| select all | `ctrl+a` | Select every file shown |
| trash selection | `delete` | Move to trash, or erase forever inside trash |
| rename | `f2` | Rename files, or restore inside trash |
| copy selection | `ctrl+c` | Mark files to copy elsewhere |
| cut selection | `ctrl+x` | Mark files to move elsewhere |
| duplicate | `ctrl+d` | Copy files beside their sources |
| paste here | `ctrl+v` | Drop copied files here |
| undo | `ctrl+z` | Walk back the last file change |
| redo | `ctrl+y` or `ctrl+shift+z` | Walk forward after an undo |
| properties | `alt+enter` | Show details for the selection |
| new folder | `ctrl+shift+n` | Create a folder here |
| new file | `ctrl+alt+n` | Create an empty file here |

### Navigation

| Action | Default key(s) | What it does |
|---|---|---|
| go to parent directory | `backspace` or `alt+up` | Climb one folder up |
| back in history | `alt+left` | Step back through visited folders |
| forward in history | `alt+right` | Step ahead through visited folders |
| go home | `alt+home` | Jump to your home folder |
| edit the path bar | `ctrl+l` | Type a path to jump to it |
| go to folder | `shift+cmd+g` | Jump to a folder by path |
| connect to server | `ctrl+shift+s` | Mount a folder shared on the network |
| move up | `up` | Step to the row above |
| move down | `down` | Step to the row below |
| move left | `left` | Step one column left |
| move right | `right` | Step one column right |
| open | `return` | Open the focused file or folder |
| page up | `pageup` | Scroll one screen up |
| page down | `pagedown` | Scroll one screen down |
| first item | `home` | Jump to the top of the list |
| last item | `end` | Jump to the bottom of the list |
| filter folder | *(no default bind)* | Filter the folder while typing |

### Selection

| Action | Default key(s) | What it does |
|---|---|---|
| extend selection up | `shift+up` | Grow the selection upward |
| extend selection down | `shift+down` | Grow the selection downward |
| extend selection left | `shift+left` | Stretch the selection left |
| extend selection right | `shift+right` | Stretch the selection right |
| toggle focused file | `space` | Flip selection on the focused file |
| invert selection | *(no default bind)* | Swap selected with unselected |

### View

| Action | Default key(s) | What it does |
|---|---|---|
| toggle hidden files | `ctrl+h` | Show files starting with a dot |
| reload sidebar places | `ctrl+r` | Refresh drives and bookmarks |
| toggle sidebar | `ctrl+b` | Show or hide the places sidebar |
| toggle preview pane | `f3` | Show or hide the file preview |
| toggle info sidebar | `f7` | Show or hide the file info sidebar |
| toggle quicklook | `f8` | Show or hide the quicklook preview float |
| toggle view | `ctrl+g` | Cycle grid, list and columns |
| next theme | `alt+t` | Step through the color themes |
| next keymap | `alt+shift+t` | Step through the keymap presets (tfm / yazi) |
| cycle sort | `alt+s` | Name, size, date, then type |
| reverse sort | `alt+shift+s` | Flip the sort direction |
| zoom in | `ctrl+=` | Grow tiles and icons a step |
| zoom out | `ctrl+-` | Shrink tiles and icons a step |

### Split panes and terminal

| Action | Default key(s) | What it does |
|---|---|---|
| toggle dual pane | `ctrl+shift+d` | Split into side-by-side panes |
| toggle sync browsing | `ctrl+shift+b` | Open a folder in both panes at once |
| split pane left/right | `ctrl+shift+h` | Split the focused pane side by side |
| split pane top/bottom | `ctrl+shift+v` | Split the focused pane top and bottom |
| close pane | `ctrl+shift+w` | Close the focused pane |
| switch pane | `tab` | Hop between the panes |
| copy to other pane | `f5` | Copy the selection across panes |
| move to other pane | `f6` | Move the selection across panes |
| open terminal here | ``ctrl+` `` or `f4` | Drop to a shell in this folder |

## Features

### Panes

tfm starts with a single pane. **Dual pane** (`ctrl+shift+d`) gives you two
independent panes side by side; `tab` moves focus between them, and `f5` / `f6`
copy or move the selection from one pane into the other. This is the classic
two-pane file manager workflow.

Panes are not limited to two. `ctrl+shift+h` splits the focused pane into a
left/right pair, `ctrl+shift+v` splits it into a top/bottom pair, and
`ctrl+shift+w` closes the focused pane (a no-op when only one is left). You can
mix directions to build any layout. The pane tree is in-memory only: it is not
saved in config or restored on the next launch.

### View modes

`ctrl+g` cycles the **active pane** through three views:

- **grid** — icon tiles (the default).
- **list** — compact rows with size and modified columns.
- **columns** — narrow left column, Finder/Miller style; selecting an entry
  opens the next column with its contents.

`zoom in` / `zoom out` (`ctrl+=` / `ctrl+-`) resize tiles and icons. The
default view comes from `[ui] view-mode`. The Linux text console cannot paint
raster grids, so it falls back to list.

### Preview pane and info sidebar

`f3` toggles the **preview pane** on the right. It previews text and code (with
syntax colors), images (including animated GIFs), audio files, videos, and
folder summaries.

- **Audio**: shows name, type, size, and duration (if `ffprobe` is available).
- **GIFs**: shows first frame and frame count; true animation on kitty
  terminals.
- **Archives**: shows a read-only entry list (name and size rows).

`f7` toggles the **info sidebar**, which lists details for the current
selection. Both share the same right-hand width (`[ui] preview-width`); when
both are on, the info sidebar wins. Both start off by default.

### Quicklook

`f8` toggles **quicklook**, a floating preview pane. It shows the current
selection's preview even when the preview pane and info sidebar are hidden. It
is non-modal, so you can keep it open while navigating. Press `escape` to
dismiss it. It supports scrolling but not focus.

### Integrated terminal

``ctrl+` `` or `f4` opens an embedded shell in the current folder. Drag a file
onto it to paste its path. Its height (`[ui] terminal-height`) is configurable,
and `[ui] terminal-auto-hide` can collapse it to a header until the mouse nears
the bottom edge.

### Sync browsing

`ctrl+shift+b` toggles **sync browsing** (off by default). While it is on,
entering a directory in the active pane also opens that directory in the other
pane, Finder-style. Only the pane you acted on drives the other, so it never
recurses.

### Path bar

The path bar at the top of each pane shows your current location.
`[ui] pathbar-position` sets its placement: `top` (default), `bottom`, or
`hidden`. `ctrl+l` focuses the path bar for typing.

### Go to Folder popup

`shift+cmd+g` opens the **Go to Folder** popup — type any path to jump there.
(`cmd` is the macOS Command key; on other keyboards it matches the `super`
modifier only.)

### Tabs

`ctrl+t` opens a new tab in the current folder, `ctrl+w` closes it, and
`ctrl+tab` / `ctrl+shift+tab` switch between tabs (per pane). The tab strip
shows automatically once you have two or more tabs; `[ui] tab-bar` can pin it
open always.

### Search and type-to-search

With `[ui] type-to-search` on (the default), just start typing: the folder
filters as you type, and `escape` clears it. `[ui] recursive-search` extends
the filter into subfolders (`fd` when installed, a built-in walk otherwise).
The `start-search` action (`/` in the yazi keymap preset) re-arms
type-to-search after it has been switched off.

### Sorting

`alt+s` cycles the sort mode: name, size, date, then type. `alt+shift+s`
reverses the direction. The starting mode comes from `[ui] sort-mode`
(`name`, `size`, `mtime`, or `type`; folders always sort first).

### Hidden files

`ctrl+h` toggles hidden files (names starting with a dot). `[ui] show-hidden`
sets the starting state.

### Selection

`ctrl+a` selects everything, `space` toggles the focused file, and
`shift+arrow` extends the selection. Click, rubber-band drag, and right-click
menus work with the mouse. `invert-selection` ships unbound.

### File operations

- **Copy / cut / paste**: `ctrl+c`, `ctrl+x`, `ctrl+v`. Paste drops the marked
  files in the current folder.
- **Duplicate**: `ctrl+d` copies files beside their sources.
- **Rename**: `f2` renames inline. Select many and use the context menu's
  **Rename N items…** for bulk rename.
- **New**: `ctrl+shift+n` makes a folder, `ctrl+alt+n` makes an empty file.
  Both are created inline.
- **Trash**: `delete` moves the selection to the trash. Inside the trash view,
  `delete` erases forever (with a confirmation), and `f2` restores. **Empty
  Trash** is on the trash page's context menu.
- **Undo / redo**: `ctrl+z` walks back the last file changes, `ctrl+y` (or
  `ctrl+shift+z`) walks forward. `[ui] persist-undo` keeps the undo history
  across restarts.

### Archives

tfm extracts and creates multi-entry archives. Use the right-click (context)
menu on a file:

- **Extract Here** — shown when the file's format can be extracted.
- **Compress to…** — opens a format picker for the current selection.

Supported formats: `.tar`, `.tar.gz`, `.tar.bz2`, `.tar.xz`, `.tar.lzma`,
`.tar.zst`, `.tar.lz4`, `.tar.br`, `.tar.lz`, `.tar.lzo`, `.tar.Z`, `.zip`,
and `.7z`. tgz/tbz2/txz/tzst are recognized as aliases. `tar` / `unzip` / `zip`
/ `7z` do the work; `tar`, `.tar.gz`, and `.zip` also have a built-in fallback
so they work with no external tools installed.

**Archive browsing**: opening an archive shows a virtual folder listing its
entries. You can descend into nested folders inside the archive, navigate back
out, and the breadcrumb shows the inner path. Supported formats include tar,
tar.gz, tar.bz2, tar.xz, zip, 7z and more (same formats as extraction).

### Mouse

Click to focus, drag to rubber-band select, right-click for context menus.
Drag and drop works inside any terminal (OSC 72 on kitty; a press-hold
fallback elsewhere) and from other apps on kitty.

Drag-resize is opt-in, and each target is off by default:

- `[ui] mouse-resize-sidebar` — drag the sidebar's right edge.
- `[ui] mouse-resize-preview` — drag the right panel's left edge.
- `[ui] mouse-resize-split` — drag the divider between panes.

### Exit directory

`[ui] exit-cwd` sets which directory you land in when tfm exits:
- `default` (default) — the directory where you launched tfm.
- `active-pane` — the current directory of the active pane.

To use this, set the `TFM_CWD_FILE` environment variable to a file path and
wrap your shell launch. On exit, tfm writes the chosen directory to that file.

Example bash/zsh wrapper:
```bash
tfm() {
  local tmp="$(mktemp)"
  TFM_CWD_FILE="$tmp" command tfm "$@"
  if [ -f "$tmp" ]; then
    local dir="$(cat "$tmp")"
    rm -f "$tmp"
    [ -d "$dir" ] && [ "$dir" != "$PWD" ] && cd "$dir"
  fi
}
```

On the Linux text console, mouse needs `gpm` running.

### Settings panel

`escape` opens the menu; pick **Settings** for the in-app GUI.

- Rows come from the same `[ui]` schema as `config.toml`, grouped by category.
- **keys** rows capture a new binding on `enter` and reject conflicts.
- **reset to defaults** puts every setting back.
- **edit config.toml…** opens the file in your editor.

### Command palette

A command palette ships as a sample plugin (`plugins-sample/palette.ts`). It
opens the pick overlay and lists every core command plus every plugin command;
selecting one runs it. Copy it into `~/.config/tfm/plugins/palette/palette.ts`
to enable it — it then appears from its Plugins-view row and the file menu.
The same pick overlay backs **Open With…**, **Compress to…**, and the
executable **Run** prompt.

### Themes

`alt+t` steps through the color-theme presets. Settings also has a **theme**
row, which leads with **System** (derived from your terminal's colors via
`[ui] follow-terminal`) and then the built-in presets: Tokyo Night (the
default), OpenCode, Aura, Ayu, Carbon Fox, Catppuccin, Cobalt 2, Cursor,
Dracula, Everforest, Flexoki, Frappe, GitHub, Gruvbox, Kanagawa, Macchiato,
Material, Matrix, Mercury, Monokai, Night Owl, Nord, One Dark, Orng, Osaka
Jade, Palenight, Rose Pine, Solarized, Synth '84, Vercel, Vesper, and Zenburn.
Individual colors live in the `[theme]` table.

### Custom themes

Port another color scheme by dropping a `.toml` file into the themes folder:

```
~/.config/tfm/themes/
```

Each file is one `[theme]` section named after the file — every one of the 27
keys must be a `#rrggbb` hex or the file is skipped on load. Built-in presets
load first, then user files in alphabetical order, so the cycle row and `alt+t`
step through all of them. On first run tfm drops a `sample.toml` template there;
copy it, rename it, and paste your colors. Editing a theme file while it is
selected needs a re-select — `config.toml` live-reloads, the themes folder does
not (the app commits a theme's values, not a path).

## Configuration

tfm reads its config from:

```
~/.config/tfm/config.toml
```

or `$XDG_CONFIG_HOME/tfm/config.toml` when that variable is set. The XDG
conventions apply on macOS too (state and cache land under the same roots).

You can override the path two ways:

- Environment: `TFM_CONFIG=/custom/path/config.toml tfm`
- Flag: `tfm --config /custom/path/config.toml` (also `-c FILE`)

A missing file means all defaults. Invalid values are ignored per key, so a
typo never makes tfm fail to start. See [config.example.toml](../config.example.toml)
for the full key list. It has three sections:

- `[ui]` — view mode, sidebar and preview options, terminal height, dual pane,
  sync browsing, search, sorting, animations, mouse resize, and so on. This is
  the largest section.
- `[keys]` — one row per action from the keybinding tables above, in kebab-case
  (for example `toggle-preview = ["f3"]`). Each action can carry several binds.
- `[theme]` — the individual theme colors (`bg`, `accent`, syntax colors, the
  16 ANSI terminal colors).

Some keys only take effect on the next start; the settings GUI badges those
rows with **needs restart**. The **edit config.toml…** Settings row opens the
file in your editor.

## Plugins

Plugins are small TypeScript files that extend tfm. They run with full trust in
the same process, so only install plugins you trust.

In tfm: `escape` → **Plugins** → **Add from git URL…**. From the CLI:

```
tfm plugins list              # installed plugins
tfm plugins search [query]    # search the index
tfm plugins add <url|id>      # install
tfm plugins remove <name>
tfm plugins update [name]     # one, or all
tfm plugins new <name>        # scaffold a starter plugin
```

The plugin API is v4. Two new seams ship:

- `api.views.register` — custom view modes join the `ctrl+g` cycle.
- `api.operations.register` — custom file system operations join the command
  palette and the file context menu.

Plugins can also add menu rows, file-menu entries, commands (shown in the
palette and bindable in Settings), previews, and UI slots, and can veto file
operations before they start. See [plugins.md](plugins.md) for full details.

## Where to go next

- [README](../README.md) — features, requirements, install options.
- [config.example.toml](../config.example.toml) — every setting with comments.
- [plugins.md](plugins.md) — write and install plugins.
- In the app: `f1` for the shortcut sheet, `escape` for settings and help.
