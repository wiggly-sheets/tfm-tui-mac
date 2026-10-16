// --- tfm — composition root. All logic lives in the ./modules it wires; this
// file (plus ./wiring/*) only instantiates them, in one load-bearing order.
// Cross-cluster references that point backwards in that order are TDZ arrows
// (the wiring modules receive them as getters) — the same seam rule the
// widget factories use internally. Order:
//   core → nav → chrome (renderer boots here) → grid foundation → fileops →
//   plugins → grid → settings → watcher → hover drawer → boot → retheme →
//   dnd → resize → keymap ---
//
// The app graph loads LAZILY (dynamic imports below): --version must answer
// in milliseconds, not after OpenTUI natives + the whole graph load (~250ms).

import pkg from "../package.json";
import path from "node:path";
import { statSync, type Stats } from "node:fs";
import { parseArgs, usageText } from "./app/cli";
// type-only: erased at load, so it does not pull the graph into --version
import type { MouseResizeWiring } from "./wiring/mouse-resize";

// --- CLI: one parse for the whole process. --help/--version and parse errors
// answer BEFORE the lazy app graph loads, so they stay instant. ---
const cli = parseArgs(process.argv);
// help/version win over a parse error (GNU behavior: `tfm --help --bogus` helps)
if (cli.help) {
  console.log(usageText());
  process.exit(0);
}
if (cli.version) {
  console.log(`tfm ${pkg.version}`);
  process.exit(0);
}
if (cli.error) {
  console.error(`tfm: ${cli.error}`);
  console.error("try 'tfm --help'");
  process.exit(2);
}
if (cli.config) process.env.TFM_CONFIG = path.resolve(cli.config);

// headless subcommand (`tfm plugins …`) — answers before the TUI graph loads
if (cli.command?.name === "plugins") {
  const { runPluginsCli } = await import("./app/plugins-cli");
  process.exit(await runPluginsCli(cli.command.args));
}

// launch PATH (`tfm ~/some/path`): chdir before anything resolves the cwd, so
// tabs/history/session all start there. A FILE opens its parent and is then
// selected by the grid. An invalid explicit path is a HARD ERROR (exit 1, no
// boot): the message must stay visible instead of being wiped by the alternate
// screen, and a wrong path is a typo, not "open wherever I happen to be".
// An explicit path also suppresses session restore — the user asked for a
// location, the saved session must not silently win.
const fail = (msg: string): never => {
  console.error(msg);
  process.exit(1);
};
let pendingSelect: string | null = null;
let explicitPath = false;
// [ui] exit-cwd "default": the launch directory, captured before the PATH
// chdir below (by quit time process.cwd() is whatever the panes browsed to).
const launchCwd = process.cwd();
const target = cli.paths[0];
if (cli.paths.length > 1) console.error(`tfm: only the first path is used: ${target}`);
if (target === "") fail("tfm: empty path");
if (target) {
  const abs = path.resolve(target);
  let st: Stats | null = null;
  try {
    st = statSync(abs);
  } catch {}
  if (st === null) {
    console.error(`tfm: ${target}: no such file or directory`);
    process.exit(1);
  }
  const why = (err: unknown): string => `tfm: ${target}: ${err instanceof Error ? err.message : String(err)}`;
  if (st.isDirectory()) {
    try {
      process.chdir(abs);
    } catch (err) {
      fail(why(err));
    }
    explicitPath = true;
  } else if (st.isFile()) {
    try {
      process.chdir(path.dirname(abs));
    } catch (err) {
      fail(why(err));
    }
    // canonicalize via cwd: chdir resolves symlinks, so a symlinked launch dir
    // would otherwise set pendingSelect to a path the grid never uses as a key
    pendingSelect = path.join(process.cwd(), path.basename(abs));
    explicitPath = true;
  } else {
    fail(`tfm: ${target}: not a directory`);
  }
}

// wall-clock start precedes the graph load so the launch toast tells the
// truth about startup (imports were ~200ms of it, silently uncounted before)
const bootStart = performance.now();

const { appendLog, isDebug } = await import("./app/log");
const { wireCore } = await import("./wiring/core");
const { wireNav } = await import("./wiring/nav");
const { wireChrome } = await import("./wiring/chrome");
const { wireGridFoundation } = await import("./wiring/grid-foundation");
const { wireFileops } = await import("./wiring/fileops");
const { wireGrid } = await import("./wiring/grid");
const { wirePanes } = await import("./wiring/panes");
const { wirePlugins } = await import("./wiring/plugins");
const { wireSettings, wireRetheme } = await import("./wiring/settings");
const { wireWatcher, wireBoot, wireDnd, wireResize, wireHoverDrawer } = await import("./wiring/io");
const { wireMouseResize } = await import("./wiring/mouse-resize");
const { wireKeymap } = await import("./wiring/keymap");

if (isDebug) appendLog(`tfm starting pid=${process.pid} argv=[${process.argv.slice(1).join(" ")}]`);

// --- core: config, theme, lookup, icon slots, floats, app state, geometry ---
const core = wireCore({
  renderer: () => chrome.renderer,
  clipboard: () => fileops.fileops.clipboard(),
  pendingSelect,
});

// --- CLI overrides: applied on the live config/state before the widgets that
// read them are built. They ride the same live config the f3/f7 toggles and the
// settings rows write (no second override channel), so a later save persists
// them exactly like a toggle would shown in the GUI.
// --view: the active pane's initial mode (per-pane state, not [ui] view-mode).
if (cli.view) core.state.viewMode = cli.view;
// --restore must clear BOTH gates: the explicit-PATH rule below and the
// [ui] restore-session switch, which is off by default.
if (cli.restore === true) core.config.ui.restoreSession = true;
// --preview/--info: the same flags f3/f7 flip; wireChrome reads them once when
// it builds the right-hand panes, so seed them before that. geometry mirrors
// the config here (its boot value was computed inside wireCore).
if (cli.preview) core.config.ui.previewEnabled = true;
if (cli.info) core.config.ui.infoSidebar = true;
if (cli.preview || cli.info) core.geometry.previewEff = core.config.ui.previewWidth;

// --- nav: renderAll, quit, status, history, tabs, session, type-to-search ---
const nav = wireNav({
  core,
  launchCwd,
  getChrome: () => chrome,
  getDnd: () => dnd,
  getGridFoundation: () => gridFoundation,
  getGrid: () => grid,
  getTermHasFocus: () => fileops.terminal.termHasFocus(),
  getTerm: () => fileops.terminal,
  getWatcher: () => watcher,
  getPlugins: () => plugins,
});

// --- chrome: file menu, sidebar, toolbar, renderer boot, notify, dialogs ---
// drag-resize wires after the renderer exists, so the sidebar's press guard
// reads it lazily (null until then = every press is a plain navigation)
let mouseResize: MouseResizeWiring | null = null;
const chrome = await wireChrome({
  core,
  nav,
  getGrid: () => grid,
  getFileops: () => fileops,
  getKeyRouter: () => keymap.keyRouter,
  // network "Connect to Server…" prompt — keymap wires LAST (TDZ seam, same
  // as the getGrid/getFileops getters above)
  getPrompt: () => keymap.prompt,
  finishDrag: () => grid.finishDrag(),
  resizePress: (x) => mouseResize?.edgePress("sidebar", x) ?? false,
});

// graceful shutdown on SIGTERM/SIGINT (e.g. terminal close, system shutdown)
const { saveConfig } = await import("./config/config");
const { awaitXattrQueue } = await import("./fs/fsutil");
const shutdown = async (signal: string) => {
  if (isDebug) appendLog(`shutdown: ${signal}`);
  try {
    await saveConfig(core.config);
  } catch {}
  try {
    chrome.stopChromeTimers?.();
  } catch {}
  try {
    chrome.stopGpm?.();
  } catch {}
  try {
    // bounded drain: a copy that just landed still has resource-fork/tag/
    // quarantine xattrs queued on the background lane, and process.exit would
    // drop them. A stuck xattr spawn must not block quit, so cap the wait.
    await Promise.race([awaitXattrQueue(), new Promise((r) => setTimeout(r, 2000))]);
  } catch {}
  process.exit(signal === "SIGTERM" ? 143 : 130);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

// --- grid foundation: selection + inline rename (before fileops — its ctx
// takes refreshCutVisuals directly) ---
const gridFoundation = wireGridFoundation({
  core,
  nav,
  chrome,
  getGrid: () => grid,
  getFileops: () => fileops,
});

// --- fileops: undo, conflict, progress, copy/move/paste, terminal, trash ---
const fileops = wireFileops({
  core,
  nav,
  chrome,
  gridFoundation,
  finishDrag: () => grid.finishDrag(),
  getPrompt: () => keymap.prompt,
});

// --- plugins: user extensions (after fileops — api context needs selection
// + nav/chrome sinks; before grid — menu entries merge plugin sections;
// before settings — aggregated rows feed the settings model) ---
// getKeymap/getPick close over `keymap`, which wires LAST — wirePlugins
// degrades both via tdzSafe until the keymap exists, so an eager plugin
// calling api.commands()/ui.pick at activate top level gets []/noop instead
// of a TDZ throw (lazy post-boot calls see the full table).
const plugins = await wirePlugins({
  core,
  nav,
  chrome,
  gridFoundation,
  getKeymap: () => ({ commands: () => keymap.keyRouter.commands() }),
  getPick: () => keymap.pick,
  getConfirm: () => fileops.yesNo,
  getPrompt: () => keymap.prompt,
});

// --- grid: preview, mouse pipeline, grid renderer, props, menu entries ---
// grid wires BEFORE dnd (the dnd wiring owns the terminal-capability
// decision), so the fallback-drag seam is a lazy getter over `dnd` — the
// same TDZ pattern as getPick/getRetheme below.
const grid = wireGrid({
  core,
  nav,
  chrome,
  gridFoundation,
  fileops,
  plugins,
  // getPick closes over `keymap` (wires last) — only called from the
  // "Compress to…" action at interaction time, so the TDZ is long settled
  getPick: () => keymap.pick,
  // retheme wires after grid — only called from "Open in New Pane" at
  // interaction time, same settled-TDZ seam
  getRetheme: () => retheme,
  // fallback drag (no-mouse terminals): a long-press picks up the selection
  // and arms the EXISTING drop pipeline, so the next folder click moves it.
  // Built in wireDnd (which owns the capability decision) and read here at
  // press time — null = today's behavior unchanged on SGR/OSC-72 terminals.
  // call it (not return the function): the grid invokes ctx.fallbackDrag?.()
  // at press time, so this getter must yield the resolved fallback object
  getFallbackDrag: () => dnd.fallbackDrag(),
});

// --- panes: layout-tree DOM + per-leaf grid scrollers (wires AFTER grid so
// every per-leaf widget exists before a new column is built) ---
const panes = wirePanes({
  core,
  nav,
  chrome,
  gridFoundation,
  grid,
  fileops,
});

// --- settings: settings model + esc menu ---
// getPrompt closes over `keymap`, which wires LAST — only called from
// post-boot installer rows, so the TDZ is settled by first use (same seam
// as wirePlugins' getKeymap/getPick above).
const settings = wireSettings({
  core,
  nav,
  chrome,
  grid,
  plugins,
  getRetheme: () => retheme,
  getPrompt: () => keymap.prompt,
});

// --- watcher → boot → retheme: the boot sequence starts between the esc-menu
// and the retheme wiring, exactly like the old flat wiring ---
const watcher = wireWatcher({
  core,
  getGridFoundation: () => gridFoundation,
  getGrid: () => grid,
});

// hover drawer BEFORE boot: it collapses panels at construction and publishes
// the collapsed effective widths, so the boot sequence's first renderAll and
// the first grid build already use them
const hover = wireHoverDrawer({
  core,
  chrome,
  fileops,
  gridFoundation,
  grid,
  resizing: () => mouseResize?.active() ?? false,
});

wireBoot({
  core,
  nav,
  chrome,
  gridFoundation,
  grid,
  fileops,
  bootStart,
  // an explicit PATH suppresses session restore (the user asked for a location);
  // --restore/--no-restore override that rule both ways
  skipSessionRestore: cli.restore === null ? explicitPath : !cli.restore,
  mountSlots: () => plugins.mountSlots(),
  afterLayout: () => {
    hover.refresh();
    // --terminal: the boot layout owns the pane host, so open it once the
    // layout is mounted (openTerminalHere no-ops on a missing host)
    if (cli.terminal) fileops.terminal.openTerminalHere();
  },
  playSidebarIntro: () => chrome.sidebarIntro.play(),
  playTopbarIntro: () => chrome.topbarIntro.play(),
  // system theme: terminal colors land before the first layout bakes them in
  applyBootSystemTheme: () => settings.systemTheme.applyBootSystemTheme(),
});

const retheme = wireRetheme({
  core,
  nav,
  chrome,
  fileops,
  settings,
  getHover: () => hover,
  getPanes: () => panes,
  // keymap wires last — deferred like every other backward reference
  getKeymap: () => keymap,
  getGrid: () => grid,
  getGridFoundation: () => gridFoundation,
});

// --- dnd (OSC 72) + resize + keyboard router ---
const dnd = wireDnd({
  core,
  nav,
  chrome,
  gridFoundation,
  grid,
  fileops,
});

wireResize({
  core,
  nav,
  chrome,
});

// drag-resize (opt-in per target): one gesture machine on the renderer root,
// built after the renderer (chrome) and the drawer it must not fight
mouseResize = wireMouseResize({
  core,
  chrome,
  gridFoundation,
  grid,
  getRetheme: () => retheme,
});

const keymap = wireKeymap({
  core,
  nav,
  chrome,
  gridFoundation,
  grid,
  fileops,
  settings,
  plugins,
  getRetheme: () => retheme,
});

// system theme live-follow: terminal palette switches (kitty theme change)
// re-derive through applyConfig — a no-op unless [ui] follow-terminal is on
settings.systemTheme.followSystemTheme();
