<h1 align="center">
  <img src="assets/icons/tfm.svg" width="192" alt="tfm logo"><br>
  tfm (terminal file manager)<br>
  <img src="https://img.shields.io/badge/status-stable-brightgreen?style=flat-square" alt="stable"> <a href="https://wiggly-sheets.github.io/tfm-tui-mac/"><img src="https://img.shields.io/badge/website-tfm--tui-mac-blue?style=flat-square&logo=githubpages&logoColor=white" alt="website"></a>
</h1>

![tfm](screenshot.png)

## Showcase



https://github.com/user-attachments/assets/29c1e441-d871-4008-922f-47d0c1bc554f



### Embedded terminal



https://github.com/user-attachments/assets/06b395db-8a91-4402-9ad7-158a5f77ccfe



### Preview pane



https://github.com/user-attachments/assets/f0007e09-c273-4f77-9f9a-d3e7187405c0



### Animations


https://github.com/user-attachments/assets/b47c7136-642c-4c85-8b2a-dcab1bd0b37b

## Features

- Mouse: click, rubber-band select, right-click menus, drag and drop.
- Browse files in grid, list or Miller (Finder-style) columns view.
- Sidebar with places, bookmarks, drives, trash, recent, starred.
- Toggleable right-hand info sidebar with details for the current selection.
- Go to Folder quick jump, plus Cmd/Super key bindings.
- Search as you type, including inside subfolders.
- Sort by name, size, date.
- Copy, move, paste, duplicate, rename.
- Bulk rename multiple files at once.
- New file / new folder inline.
- Drag and drop inside any terminal (OSC 72 on kitty, press-hold fallback elsewhere) and from other apps.
- Trash, restore, delete forever, empty trash.
- Undo / redo file operations.
- Preview text, code, images, videos, folders.
- Open files + Open With app picker.
- Properties dialog with permissions editing.
- Tabs + panes: dual pane with sync browsing, and a mixed vertical/horizontal
  split tree.
- Optional mouse drag-resize for the sidebar, pane split and preview.
- Connect to network servers.
- Extract and compress archives.
- Embedded terminal.
- Clipboard copy/paste with other apps.
- Open privileged files with sudo prompt.
- Customizable themes, settings GUI, keybinds.
- Plugin support with hot reload.
- …and many more.

## Requirements

- Linux (x86_64 / arm64) or macOS (Intel / Apple Silicon; a lipo universal
  binary is released too).
- Any terminal (need image support for the full experience).
- Everything below is optional.
  - Linux: `xdg-open` (opening files) · `gio` (starred files and servers) · `udisksctl` (USB drives) · `wl-clipboard` / `xclip` (copy and paste with other apps). macOS covers those with built-in `open`, `diskutil`, `pbcopy` / `pbpaste`.
  - `magick` (extra photo thumbnails; `brew install imagemagick` on macOS)
  - `tag` (macOS Finder tags for starred files; `brew install tag`)
  - `fd` (fast recursive search; `brew install fd` on macOS)
  - `ffmpeg` (macOS video thumbnails without the sidecar; `brew install ffmpeg`)
  - `tar` / `unzip` / `zip` / `7z` (zip files and archives)

## Icons and terminal support

Icons are Material Design Icons SVGs bundled with tfm. Where the terminal can
draw images, tfm rasterizes the SVG in-process (resvg) and sends a color raster
over the terminal's image protocol. Where it cannot, tfm draws a Nerd Font glyph
in the icon's place.

The fallback order:

- kitty, WezTerm, Ghostty → kitty graphics protocol (color rasters).
- iTerm2 → sixel, but only when the terminal reports pixel dimensions. Stable
  iTerm2 does not report them, so tfm keeps the glyph there instead of reserving
  cells for a placement that would render blank.
- tmux and terminals with no graphics protocol → Nerd Font glyphs.
- Linux text console and dumb terminals (`TERM` of `linux*`, `vt*`, `dumb`) →
  ASCII glyphs and a fixed 16-color palette, no rasters.

The Nerd Font glyph fallback needs a Nerd Font installed and selected as the
terminal font (for example `MesloLGLDZ Nerd Font Mono`). Without one the glyphs
show as tofu boxes.

Rasterizing uses the resvg addon embedded in released binaries, so packaged
builds draw icons out of the box. A source install without `devDependencies` has
no addon and falls back to glyphs.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/wiggly-sheets/tfm-tui-mac/main/install.sh | bash
```

### dev build

Latest dev branch, needs git and Bun 1.4 or newer:

```bash
curl -fsSL https://raw.githubusercontent.com/wiggly-sheets/tfm-tui-mac/dev/source.sh | bash
```

Or manually build from source:

```bash
git clone https://github.com/wiggly-sheets/tfm-tui-mac.git
cd tfm-tui-mac
bun install --frozen-lockfile
make test
cp dist/tfm ~/.local/bin/
```

Cross-compile release-target binaries from one host:

```bash
bun run scripts/build.ts linux-x64 mac-arm64   # any subset
bun run scripts/build.ts all                   # full matrix
```

Targets: `linux-x64`, `linux-arm64`, `mac-x64`, `mac-arm64`, `mac-universal`
(`mac-universal` lipos both darwin slices into `dist/tfm-universal-macos` and
needs a macOS host). The same targets are wired as `bun run build:<target>`
scripts in `package.json`.

## Build targets

`make` prints the list of targets. The names are the same in every repository
of the estate.

- `make help` — list every target (the default).
- `make build` — compile the binary into `dist/tfm`.
- `make test` — run the checks, the test suite and the version smoke test.
- `make release-artifacts` — build the universal macOS binary and write the
  checksum file next to it.
- `make release VERSION=1.2.3` — build the artifacts, tag `v1.2.3` locally and
  print the command that pushes it. It never pushes by itself.
- `make clean` — remove the build output.

The release publishes `tfm-universal-macos.gz` and the sidecar
`tfm-universal-macos.gz.sha256`. The Homebrew tap matches those two names, so
they never change.

## Updating

Install.sh installs can update themselves; everything else must be updated the
way it was installed.

```bash
tfm --update
```

`tfm --update` checks the latest release on `wiggly-sheets/tfm-tui-mac`, downloads the
binary for your platform, verifies its `sha256` against the published checksum,
smoke-tests the staged build, and atomically replaces the installed `tfm`. It
also refreshes the `terminal-file-manager` second name and the bundled
`tfm-ffmpeg` sidecar when those already exist. Restart tfm to use the new
build.

It only updates copies install.sh installed. It refuses with a short message
otherwise:

- not a compiled binary (a `bun run` dev checkout) — rebuild or re-run install.sh
- not installed by install.sh — re-run install.sh
- not from `wiggly-sheets/tfm-tui-mac` — re-run install.sh
- managed by a package manager — update it with that package manager
- not the install.sh install directory — re-run install.sh
- no prebuilt binary for this platform — re-run install.sh to build from source

A background check runs at most once a day and toasts when a newer release
exists. Turn it off with `[update] check = false` in `config.toml`.

## Keys

- `enter` open · `f2` rename · `backspace`/`alt+up` up · `alt+home` home · `escape` menu · `f1` help
- `ctrl+c/x/v/d` copy/cut/paste/duplicate · `ctrl+z/y` undo/redo
- `tab` switch focused pane · `f5`/`f6` copy/move to the other pane (dual pane)
- `ctrl+shift+h`/`ctrl+shift+v` split pane right/below · `ctrl+shift+w` close pane
- `ctrl+t/w` new/close tab · `ctrl+tab` switch tab (per pane)
- `delete` trash · `alt+enter` properties · `ctrl+q` quit
- `ctrl+a` select all · `space` toggle · `shift+arrows` extend selection
- `alt+left/right` history back/forward · `ctrl+shift+n` / `ctrl+alt+n` new folder/file
- `ctrl+shift+d` dual pane · `ctrl+shift+b` sync browsing · `ctrl+=/-` zoom · `ctrl+r` reload places · `ctrl+alt+r` restart
- `ctrl+h` hidden · `ctrl+l` path bar · `ctrl+b` sidebar · `shift+cmd+g` go to folder
- `ctrl+g` cycle view (grid/list/columns) · `f3` preview · `f7` info sidebar · `alt+t` next theme
- `alt+s` cycle sort · `alt+shift+s` reverse sort · `ctrl+\``/`f4` terminal · `ctrl+shift+s` connect to server
- `arrows` move · `pageup`/`pagedown` page · `home`/`end` first/last

Everything is remappable: `esc` → Settings → keys.

## Config

`esc` → Settings or:

```bash
TFM_CONFIG=/custom/path/config.toml tfm
```
See [config.example.toml](config.example.toml).

Config and cache/state directories follow the XDG conventions on macOS too
(`~/.config/tfm`, `~/.cache`).

## Settings

`escape` opens the menu; pick **Settings** for the in-app GUI. The root menu
also lists Plugins (once a plugin contributes rows), Help and About.

- Rows come from the same `[ui]` schema as `config.toml`, grouped by category:
  step numbers, toggle booleans, pick enums, choose a theme preset.
- **keys** rows capture a new binding on `enter`, and reject a conflicting one.
- **reset to defaults** puts every setting back.
- **edit config.toml…** opens the file in your editor, not an in-app editor.

## Plugins

`esc` → Plugins or:

```bash
tfm plugins search
tfm plugins add <url|id>
tfm plugins new my-plugin
```
See [docs/plugins.md](docs/plugins.md).

## Notes

- Cross-app drag & drop is kitty-only; internal drag works on every terminal
  (OSC 72 on kitty, press-hold fallback elsewhere).
- Mouse on the Linux console (TTY) needs `gpm` running.
- macOS ships for Intel, Apple Silicon and a universal binary: trash, servers,
  tags and file opens integrate with Finder natively (`trash`, `open`,
  `diskutil`); `tty-mode` has no Linux console there, so `auto` only fires for
  dumb/vt terms.
- Mouse drag-resize of the sidebar, pane split and preview is opt-in
  (`[ui] mouse-resize-*`, all off by default).
- Icons can show a black box behind open menus or while rubber-band selecting.
- Custom kitty themes can misbehave.

## License

[MIT](LICENSE)
