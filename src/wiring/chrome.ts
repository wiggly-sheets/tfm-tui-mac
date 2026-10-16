// --- Chrome wiring: file context menu, places sidebar + tab strip, toolbar,
// the renderer boot itself, notifications, recent-open and dialogs. The three
// widget factories are created BEFORE the renderer (their ctx fields defer
// renderer access through arrows — the renderer const further down this same
// function is the TDZ seam). Async: index awaits it, everything downstream
// gets a booted renderer. ---

import { createCliRenderer } from "@opentui/core";
import path from "node:path";
import { PassThrough } from "node:stream";
import { startGpmInput } from "../fs/gpm";
import { readdir } from "node:fs/promises";
import { spawnSafe } from "../fs/spawn-safe";
import { loadSystemPlaces } from "../fs/places";
import { buildMountArgs, buildUnmountArgs, gvfsRoot, takeGioPrompt, type GioPrompt } from "../fs/network";
import { diskutilBin, diskutilUnmountArgv, isDarwin, parseMountTable, parseSmbMounts } from "../fs/darwin";
import { spawnOpenTarget } from "../fs/open-url";
import { makeNetworkActions, type GioResult } from "../fs/netmount";
import { makeMenu, MENU_W } from "../ui/ui-menu";
import { makeChrome } from "../ui/ui-chrome";
import { makeToolbar, toolbarItemIds, crumbItemIds } from "../ui/ui-toolbar";
import { getMap, makeLeafRegistry, type PaneId } from "../app/panes";
import { leafRectsOf } from "../app/layout";
import { buildAppContainer, buildTitle, setPathbarPosition } from "../ui/ui-boot-layout";
import { warmEmbeddedIcons } from "../ui/icons";
import type { NodeLike } from "../lib/node-like";
import { makeNotify } from "../ui/notify";
import { rasterSigOf } from "../ui/tty";
import { makeSidebarAnim, makeTopbarAnim } from "../ui/ui-sidebar-anim";
import { makeSidebarHover } from "../ui/ui-sidebar-hover";
import type { SidebarHoverDirection } from "../config/config-schema";
import type { EaseKey, SlideDir } from "../ui/ui-grid-anim";
import { makeRecentOpen } from "../fs/recent-open";
import { classifyPath } from "../fs/executable";
import { makeEnsureSudo } from "../fs/elevate";
import { upsertRecentXbel } from "../fs/recent";
import { appForFile, makeLaunchAppAsRoot, makeOpenAsRoot } from "../fs/apps";
import { makeDialogs } from "../ui/ui-dialogs";
import { destroyChildren, errMessage } from "../lib/uiutil";
import { dlog } from "../app/log";
import type { CoreWiring } from "./core";
import type { FileopsWiring, GridWiring, NavWiring } from "./types";

export const wireChrome = async (deps: {
  core: CoreWiring;
  nav: NavWiring;
  // late clusters — only read at runtime, post-boot
  getGrid: () => GridWiring;
  getFileops: () => FileopsWiring;
  getKeyRouter: () => { sidebarActive(): boolean; placeIdx(): number };
  // network "Connect to Server…" prompt — prompt overlaps keymap, wired LAST
  getPrompt: () => {
    open(o: {
      title: string;
      placeholder?: string;
      okLabel?: string;
      initial?: string;
      password?: boolean;
    }): Promise<string | null>;
  };
  // grid's finishDragCtx (internal drag commit) — grid wiring builds it later
  finishDrag(): void;
  // drag-resize: sidebar rows span the panel width, so a press on the resize
  // band must arm the gesture instead of navigating. Wired after chrome
  // (renderer TDZ) — read at press time.
  resizePress?(x: number): boolean;
}) => {
  const { core, nav, getGrid, getFileops, getKeyRouter } = deps;
  const { byId, stripSelectable } = core.lookup;
  const { makeIconSlot, setIconState, drainIconQueue } = core.slots;
  const { themeGet, home, state } = core;
  const uiStyle = () => core.config.ui.uiStyle;
  // mouse pointer shapes (OSC 22): the single shared tty-guarded sink from
  // wireCore — per-cluster instances diverged and stuck the shape across
  // widget boundaries, so every ctx here takes core.setPointer.
  const setPointer = core.setPointer;

  // --- File context menu (right-click a tile) — widget lives in ./ui-menu.
  // Hoisted above chrome/toolbar/conflict/grid-ctx, which all consume
  // closeFileMenu/openContextMenu/fileMenuIsOpen. Safe pre-boot: every ctx
  // field defers renderer access (same seam rule as makeSlots) ---
  const menu = makeMenu({
    byId,
    rootAdd: (node) => renderer.root.add(node),
    termW: () => renderer.terminalWidth,
    termH: () => renderer.terminalHeight,
    stripSelectable,
    drainIconQueue,
    uiStyle,
    colors: themeGet,
    menuW: MENU_W,
    floats: core.floats,
    makeIconSlot,
    setPointer,
  });

  // --- Network locations: "+ → connect" calls land here. The impls are
  // assigned further down (they need notify); the wrappers only defer, and
  // nothing invokes them before the wiring returns (TDZ seam rule). ---
  let connectServerImpl: (raw?: string) => Promise<void> = async () => {};
  let disconnectServerImpl: (mountPath: string) => Promise<void> = async () => {};
  const connectServer = (raw?: string): void => {
    void connectServerImpl(raw);
  };
  const disconnectServer = (mountPath: string): void => {
    void disconnectServerImpl(mountPath);
  };

  // --- Sidebar row hover nudge (per-row icon lift for every place/pin/device
  // row). The impl is assigned below (it reads chrome.placesHost); the wrapper
  // only defers — same TDZ seam as the network impls above. ---
  let hoverRowImpl: (key: string, hovered: boolean) => void = () => {};

  // --- Places sidebar + tab strip — widget lives in ./ui-chrome ---
  const chrome = makeChrome({
    byId,
    uiStyle,
    colors: themeGet,
    transparentForce: () => core.config.ui.transparentBg === "force",
    sw: () => core.geometry.sw,
    sideInnerW: core.sideInnerW,
    tabBar: () => core.config.ui.tabBar,
    sidebarSections: () => ({
      showRecent: core.config.ui.sidebarShowRecent,
      showStarred: core.config.ui.sidebarShowStarred,
      showTrash: core.config.ui.sidebarShowTrash,
      showUserDirs: core.config.ui.sidebarShowUserDirs,
      showBookmarks: core.config.ui.sidebarShowBookmarks,
      showDevices: core.config.ui.sidebarShowDevices,
      showNetwork: core.config.ui.sidebarShowNetwork,
    }),
    // [ui] sidebar-section-titles: name each group in place of the dividers
    sectionTitles: () => core.config.ui.sidebarSectionTitles,
    // tab chip shrink reads the live pane width — the layout tree's own rects,
    // so a split/closing pane repaints the strip at the right size. Arrow-
    // deferred: the renderer const below is the TDZ seam, same as menu's termW.
    availW: (pane) => {
      const main = renderer.terminalWidth - core.geometry.sidebarEff - core.geometry.previewEff;
      const id = pane === 1 ? "p1" : "p0";
      if (!core.panes.leafIds().includes(id)) return main;
      const rects = leafRectsOf(core.panes.tree, { x: 0, y: 0, w: main, h: 1 });
      return Math.max(0, rects.get(id)?.w ?? main);
    },
    rasterSig: () =>
      rasterSigOf(
        core.config.ui.icons,
        core.isTtyMode(),
        core.config.ui.forceGlyph,
        core.config.ui.iconStyle,
        core.config.ui.transparentBg,
      ),
    renderAll: nav.renderAll,
    navigate: nav.navigate,
    blurTerminal: () => getFileops().terminal.blurTerminal(),
    closeFileMenu: menu.closeFileMenu,
    openContextMenu: menu.openContextMenu,
    sidebarEntriesFor: (place, x, y) => getGrid().menuEntries.sidebarEntriesFor(place, x, y),
    finishDrag: deps.finishDrag,
    dlog: (msg) => dlog(msg),
    trashPaths: (paths) => getFileops().trash.trashPaths(paths),
    moveInto: (dest, items) => getFileops().fileops.moveInto(dest, items),
    kbActive: () => getKeyRouter().sidebarActive(),
    kbIdx: () => getKeyRouter().placeIdx(),
    tabs: (pane) => getMap(nav.tabModels, pane === 1 ? "p1" : "p0"),
    focusPane: (pane) => getGrid().focusPane(pane === 1 ? "p1" : "p0"),
    closeTab: (pane, i) => getMap(nav.tabModels, pane === 1 ? "p1" : "p0").closeTab(i),
    switchTab: (pane, i) => getMap(nav.tabModels, pane === 1 ? "p1" : "p0").switchTab(i),
    newTab: (pane, dir) => getMap(nav.tabModels, pane === 1 ? "p1" : "p0").newTab(dir),
    // toolbars are built after the chrome ctx (TDZ seam) — keep the arrow
    hoverBtn: (pane, id, icon, onMouseDown) =>
      getMap(toolbars, pane === 1 ? "p1" : "p0").hoverBtn(id, icon, onMouseDown),
    stripSelectable,
    drainIconQueue,
    makeIconSlot,
    setIconState,
    stateCwd: () => state.cwd,
    connectServer,
    hoverRow: (key, hovered) => hoverRowImpl(key, hovered),
    setPointer,
    resizePress: (x) => deps.resizePress?.(x) ?? false,
  });

  // --- Sidebar hover animator (impl for the deferred wrapper above): row refs
  // derive live from placesHost (main icon = specs[0], label + selection flag
  // per row), so every place/pin/device row nudges without its own registry.
  // Synchronous (no timeline), so it can live pre-renderer like the chrome. ---
  const sidebarHover = makeSidebarHover({
    byId,
    rowRefs: () =>
      new Map(
        chrome.placesHost.map((r) => [
          r.rowId,
          {
            rowId: r.rowId,
            iconSlotId: r.specs[0]?.slotId ?? "",
            labelId: r.labelId,
            selected: r.selected,
          },
        ]),
      ),
    hoverOpts: () => ({
      enabled: core.config.ui.sidebarHoverAnimation,
      direction: core.config.ui.sidebarHoverDirection as SidebarHoverDirection,
      includeLabel: core.config.ui.sidebarHoverIncludeLabel,
    }),
  });
  hoverRowImpl = (key, hovered) => sidebarHover.playHover(key, hovered);

  // --- Toolbars — widget lives in ./ui-toolbar (nav buttons, crumbs, inline
  // path edit, sort/search buttons). ONE PER PANE, each with its own id prefix
  // so the nodes can coexist in the renderable registry. ---
  // [ui] pathbar-position: wiring/panes bakes the column child order from this
  // seam (it builds the columns, this wiring owns the config).
  setPathbarPosition(() => core.config.ui.pathbarPosition);
  const makePaneToolbar = (id: PaneId) =>
    makeToolbar({
      prefix: `tfm-${id}-`,
      renderer: () => renderer,
      byId,
      destroyChildren,
      stripSelectable,
      uiStyle,
      colors: themeGet,
      transparentForce: () => core.config.ui.transparentBg === "force",
      makeIconSlot,
      setIconState,
      closeFileMenu: menu.closeFileMenu,
      blurTerminal: () => getFileops().terminal.blurTerminal(),
      focusPane: () => getGrid().focusPane(id),
      navigate: nav.navigate,
      // arrow wrapper: notify is declared below (TDZ seam rule)
      notify: (m, t, l) => notify(m, t, l),
      // the toolbar shows ITS pane's history, not the focused pane's: `state`
      // is the active-pane facade, so read the real per-pane state here
      canBack: () => core.panes.stateOf(id).histIdx > 0,
      canFwd: () => core.panes.stateOf(id).histIdx < core.panes.stateOf(id).history.length - 1,
      goBack: nav.goBack,
      goFwd: nav.goFwd,
      openContextMenu: menu.openContextMenu,
      sortEntries: () => getGrid().menuEntries.sortEntries(),
      cwd: () => core.panes.stateOf(id).cwd,
      // per-navigate new-crumbs cascade (see renderCrumbs' lastCrumbTargets
      // guard): arrow-deferred, dirBarAnims is built post-renderer below
      // (TDZ seam)
      animateCrumbs: (ids: string[]) => getMap(dirBarAnims, id).playIds(ids),
      home,
      setPointer,
    });
  const toolbars = makeLeafRegistry(core.panes, (id) => makePaneToolbar(id));

  // --- Layout: the pre-mount skeleton (title + three panels) lives in
  // ./ui-boot-layout; ids are repainted by rethemeChrome, so they must stay
  // byte-identical there. ---
  const container = buildAppContainer({
    sw: core.geometry.sw,
    sideInnerW: core.sideInnerW(),
    // eager object, not a getter — buildAppContainer/buildTitle read fields
    // directly (typed as Theme in ui-boot-layout so tsc enforces this)
    colors: core.colors,
    uiStyle: core.config.ui.uiStyle,
    transparentForce: core.config.ui.transparentBg === "force",
    previewWidth: core.config.ui.previewWidth,
    previewEnabled: core.config.ui.previewEnabled,
    infoEnabled: core.config.ui.infoSidebar,
    title: buildTitle({ width: core.sideInnerW(), colors: core.colors, mode: core.config.ui.sidebarTitle }),
  });

  // --- Renderer boot. On a Linux text console, gpm is the only mouse source
  // (its kernel report path can't carry motion), so we open the /dev/gpmctl
  // client socket and merge translated SGR bytes into a PassThrough the
  // renderer reads as stdin. Everywhere else startGpmInput returns null and
  // the plain process.stdin is used — no behavior change. ---
  const gpmStream = new PassThrough();
  const gpmInput = startGpmInput({
    onBytes: (s) => gpmStream.write(s),
    log: (m) => dlog(m),
  });
  if (gpmInput) {
    process.stdin.pipe(gpmStream);
    (gpmStream as { setRawMode?: (v: boolean) => void; isTTY?: boolean }).setRawMode = (v) =>
      process.stdin.setRawMode?.(v);
    (gpmStream as { isTTY?: boolean }).isTTY = true;
  }
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    targetFps: 60,
    maxFps: 120,
    ...(gpmInput ? { stdin: gpmStream as unknown as NodeJS.ReadStream } : {}),
    // tty mode forces opaque (same rule as wiring/core + ui-retheme)
    ...(core.config.ui.transparentBg !== "off" && !core.isTtyMode() ? {} : { backgroundColor: core.colors.bg }),
  });
  renderer.root.add(container);
  warmEmbeddedIcons(); // index the embedded svg blobs while the renderer boots
  // opencode-style: global bg lives on the renderer, not per-box — transparent
  // modes stay transparent here (the old unconditional reset re-opaqued boot)
  if (core.config.ui.transparentBg !== "off" && !core.isTtyMode()) renderer.setBackgroundColor("transparent");
  else renderer.setBackgroundColor(core.colors.bg);

  // --- Sidebar startup intro (cold-boot-only): one reused timeline over the
  // places sidebar, played by the playSidebarIntro boot step after the first
  // renderAll. Built here (post-renderer — engine.attach needs the frame
  // loop); row ids resolve live from placesHost at play time, so the factory
  // sees the rows renderAll just built. ---
  const sidebarIntro = makeSidebarAnim({
    renderer,
    byId,
    opts: () => ({
      // text-cell anims need no graphics protocol — enabled in tty mode too
      enabled: core.config.ui.sidebarAnimation,
      style: core.config.ui.sidebarAnimationStyle,
      ms: core.config.ui.sidebarAnimationMs,
      slideCells: core.config.ui.sidebarAnimationSlideCells,
      dir: core.config.ui.sidebarAnimationSlideDir as SlideDir,
      staggerPct: core.config.ui.sidebarAnimationStaggerPct,
      ease: core.config.ui.sidebarAnimationEase as EaseKey,
      includeTitle: core.config.ui.sidebarAnimationIncludeTitle,
    }),
    rootId: () => "tfm-sidebar-root",
    rowIds: () => chrome.placesHost.map((r) => r.rowId),
    // a hidden title ([ui] sidebar-title off) resolves to nothing, so opting
    // in while it is hidden cascades the rows exactly as before
    titleId: () => (core.config.ui.sidebarTitle !== "none" ? "tfm-title-box" : ""),
  });

  // --- Top bar intro (cold-boot-only): cascades each bar's buttons + crumbs
  // left-to-right, played by the playTopbarIntro boot step right after the
  // sidebar intro. Built here (post-renderer — engine.attach needs the frame
  // loop); item ids resolve live — crumbs were just built by renderAll. ---
  const topbarIntro = makeTopbarAnim({
    renderer,
    byId,
    opts: () => ({
      enabled: core.config.ui.topbarAnimation,
      style: core.config.ui.topbarAnimationStyle,
      ms: core.config.ui.topbarAnimationMs,
      slideCells: core.config.ui.topbarAnimationSlideCells,
      dir: core.config.ui.topbarAnimationSlideDir as SlideDir,
      staggerPct: core.config.ui.topbarAnimationStaggerPct,
      ease: core.config.ui.topbarAnimationEase as EaseKey,
    }),
    barIds: () => [...toolbarItemIds(byId, "tfm-p0-"), ...toolbarItemIds(byId, "tfm-p1-")],
  });

  // --- Directory-bar animation (per-navigate, not just boot): only the NEWLY
  // appeared crumbs cascade in — the shared prefix stays put. One animator
  // per pane; the toolbar diffs its crumb targets and hands the suffix ids to
  // playIds (post-rebuild, so the fresh nodes are targeted). Rapid
  // re-navigates retarget cleanly (playIds re-resolves + restarts the one
  // reused timeline). ---
  const makeDirBarAnim = (id: PaneId) =>
    makeTopbarAnim({
      renderer,
      byId,
      opts: () => ({
        enabled: core.config.ui.directoryBarAnimation,
        style: core.config.ui.directoryBarStyle,
        ms: core.config.ui.directoryBarMs,
        slideCells: core.config.ui.directoryBarSlideCells,
        dir: core.config.ui.directoryBarDir as SlideDir,
        staggerPct: core.config.ui.directoryBarStaggerPct,
        ease: core.config.ui.directoryBarEase as EaseKey,
      }),
      barIds: () => crumbItemIds(byId, `tfm-${id}-`),
    });
  const dirBarAnims = makeLeafRegistry(core.panes, (id) => makeDirBarAnim(id));
  // --- Notifications — its consumers (recent-open, undo, fileops, terminal,
  // trashops, settings, dnd72) take `notify` directly; the sticky transfer
  // progress toast lives in the same stack via notifySticky, so every
  // survivor reflows uniformly and two toasts never share a slot. ---
  const { notify, notifySticky } = makeNotify({
    rootAdd: (node) => renderer.root.add(node),
    remove: (node) => {
      const n = node as NodeLike;
      // the toast's own parent, or the root when it was never re-parented
      const p = (n.parent ?? renderer.root) as NodeLike;
      p.remove(n);
    },
    byId,
    termW: () => renderer.terminalWidth,
    accentBg: () => core.colors.accentBg,
    white: () => core.colors.white,
    sidebarFgMuted: () => core.colors.sidebarFgMuted,
    ansi1: () => core.colors.ansi1,
    ansi2: () => core.colors.ansi2,
    makeIconSlot: core.slots.makeIconSlot,
    drainIconQueue: core.slots.drainIconQueue,
    stripSelectable: core.lookup.stripSelectable,
    durationMs: () => core.config.ui.toastDurationMs,
  });

  // --- Escalation primitive for the adaptive open: password gate (cached
  // timestamp first), then the default app elevated with the user's env
  // preserved (-E keeps Wayland / display sockets, so GUI editors work).
  // One gate per wire scope, like wireFileops. Built before makeRecentOpen
  // so the open can take it directly. ---
  const ensureSudoChrome = makeEnsureSudo({ getPrompt: deps.getPrompt, notify });
  const openAsRoot = makeOpenAsRoot({
    ensureSudo: ensureSudoChrome,
    notify,
    log: (msg) => dlog(msg),
  });
  // same gate scope for Open With… on unreadable files: the picker lists the
  // handlers, the chosen one launches elevated after the password prompt.
  const launchAppAsRoot = makeLaunchAppAsRoot({
    ensureSudo: ensureSudoChrome,
    notify,
    log: (msg) => dlog(msg),
  });

  // --- Recent-files recording + default open: batching/toast logic lives in
  // ./recent-open (tested); xbel write, open/xdg-open spawn and the app probe
  // are injected here. Unreadable files escalate through openAsRoot above —
  // the open is adaptive, there is no separate elevated row. Executables fork
  // to grid's Run prompt (lazy via getGrid — pick wires last) instead of the
  // opener, which would land them in the browser/editor. ---
  const { openFileDefault } = makeRecentOpen({
    inTrashView: core.inTrashView,
    notify,
    upsertRecent: upsertRecentXbel,
    spawnOpen: (p, onFailed) => {
      spawnOpenTarget(
        spawnSafe,
        p,
        (err) => {
          onFailed();
          dlog(`open ${p}: ${err.message}`);
          notify(`Can't open ${path.basename(p)} · ${err.message}`, "open", "error");
        },
        { detached: true },
      );
    },
    appForFile,
    openAsRoot,
    isExecutable: (p) => classifyPath(p),
    askExecutable: (p, info, openAnyway) => getGrid().askExecutable(p, info, openAnyway),
  });

  const dialogs = makeDialogs({
    byId,
    rootAdd: (node) => renderer.root.add(node),
    stripSelectable,
    termH: () => renderer.terminalHeight,
    uiStyle,
    colors: () => core.colors,
    closeFileMenu: menu.closeFileMenu,
    setPointer,
  });

  // --- Network location actions (impls for the deferred wrappers above):
  // Linux: connect through gvfs, driving credential prompts through the
  // shared text overlay, then refresh places and navigate the FUSE path.
  // `gio` is spawned argv-array (never shelled) with stdin/stdout pipes the
  // app scripts, so gio's own terminal prompt never touches the TUI.
  // Darwin: `open <uri>` hands auth to Finder and the volume lands under
  // /Volumes (polled on a longer budget — Finder auth takes seconds);
  // disconnect is `diskutil unmount` on the resolved mount path. ---
  const GIO_TIMEOUT_MS = 120_000;

  const runGio = async (args: string[], interactive: boolean): Promise<GioResult> => {
    // separate closure so the narrowed Subprocess subtype survives the
    // try/catch below (an explicit Bun.Subprocess annotation widens stdout/
    // stdin back to number|stream unions and nothing typechecks afterwards)
    const spawnGioProc = (a: string[], i: boolean) =>
      Bun.spawn(["gio", ...a], {
        stdin: i ? "pipe" : "ignore",
        stdout: "pipe",
        stderr: "pipe",
        // LC_ALL=C pins the prompt labels to English (User/Password/Domain) so
        // takeGioPrompt's matcher is deterministic under any user locale
        env: { ...process.env, LC_ALL: "C", LANG: "C" },
      });
    let proc: ReturnType<typeof spawnGioProc>;
    try {
      proc = spawnGioProc(args, interactive);
    } catch (err) {
      // missing gio binary: Bun throws ENOENT synchronously — degrade to a
      // failure result (connect/disconnect already toast GioResult failures)
      // instead of an unhandled rejection out of the fire-and-forget wrapper
      return { code: 127, stdout: "", stderr: errMessage(err) };
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let cancelled = false;
    const arm = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        try {
          proc.kill();
        } catch {}
      }, GIO_TIMEOUT_MS);
    };
    arm();
    let buf = "";
    let stderr = "";

    const answerPrompt = async (p: GioPrompt): Promise<void> => {
      if (p.message) {
        // last line is the specific ask ("Enter user and password for …");
        // the first is a generic "Authentication Required"
        const line = p.message.split("\n").filter(Boolean).pop();
        if (line) nav.setStatusMsg(line.slice(0, 120));
      }
      const answer = await deps.getPrompt().open({
        title: p.title,
        ...(p.default ? { initial: p.default } : {}),
        ...(p.kind === "choice" ? { placeholder: "Number" } : {}),
        okLabel: p.kind === "choice" ? "Send" : "OK",
        password: p.password,
      });
      if (answer === null) {
        cancelled = true;
        try {
          proc.kill();
        } catch {}
        return;
      }
      try {
        if (proc.stdin) {
          proc.stdin.write(`${answer}\n`);
          proc.stdin.flush?.();
        }
      } catch {}
      arm();
    };

    const stdoutDone = (async () => {
      const dec = new TextDecoder();
      for await (const chunk of proc.stdout) {
        buf += dec.decode(chunk as Uint8Array, { stream: true });
        if (!interactive) continue;
        for (;;) {
          const p = takeGioPrompt(buf);
          if (!p) break;
          buf = buf.slice(p.consumed);
          await answerPrompt(p);
          if (cancelled) return;
        }
      }
    })();
    const stderrDone = (async () => {
      const dec = new TextDecoder();
      for await (const chunk of proc.stderr) stderr += dec.decode(chunk as Uint8Array, { stream: true });
    })();
    const code = await proc.exited;
    clearTimeout(timer);
    await Promise.all([stdoutDone, stderrDone]);
    if (cancelled) return { code: 130, stdout: "", stderr: "cancelled" };
    return { code, stdout: "", stderr: timedOut ? stderr || "timed out" : stderr };
  };

  // darwin `open <uri>`: fire-and-wait exit (Finder owns auth UI from here)
  const runDarwinOpenMount = async (uri: string): Promise<GioResult> => {
    try {
      const proc = Bun.spawn(["open", uri], {
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
        timeout: 30_000,
      });
      const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      return { code: await proc.exited, stdout: out, stderr: err };
    } catch (err) {
      return { code: 127, stdout: "", stderr: errMessage(err) };
    }
  };

  // darwin unmount by URI: resolve the /Volumes path through the mount table
  // (the sink only carries URIs), then diskutil unmount
  const runDarwinUnmountUri = async (uri: string): Promise<GioResult> => {
    try {
      const proc = Bun.spawn(["mount"], { stdout: "pipe", stderr: "ignore", stdin: "ignore", timeout: 10_000 });
      const text = await new Response(proc.stdout).text();
      await proc.exited;
      const norm = uri.replace(/\/+$/, "").toLowerCase();
      const hit = parseSmbMounts(parseMountTable(text)).find((m) => m.uri.replace(/\/+$/, "").toLowerCase() === norm);
      if (!hit) return { code: 1, stdout: "", stderr: `not mounted: ${uri}` };
      const dutil = diskutilBin();
      const up = Bun.spawn([dutil, ...diskutilUnmountArgv(hit.target)], {
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
        timeout: 30_000,
      });
      const [out, err] = await Promise.all([new Response(up.stdout).text(), new Response(up.stderr).text()]);
      return { code: await up.exited, stdout: out, stderr: err };
    } catch (err) {
      return { code: 127, stdout: "", stderr: errMessage(err) };
    }
  };

  const network = makeNetworkActions(
    {
      gvfsRoot,
      // mount can prompt for credentials; unmount never does
      mount: (uri) => (isDarwin() ? runDarwinOpenMount(uri) : runGio(buildMountArgs(uri), true)),
      unmount: (uri) => (isDarwin() ? runDarwinUnmountUri(uri) : runGio(buildUnmountArgs(uri), false)),
      readdir: readdir,
      notify: (m, t, l) => {
        try {
          notify(m, t, l);
        } catch {}
      },
      log: (m) => dlog(m),
    },
    // `open smb://` returns once Finder takes over, well before the volume
    // lands — poll ~10s instead of the gvfs ~1s
    { resolveAttempts: isDarwin() ? 40 : 4 },
  );

  connectServerImpl = async (raw?: string): Promise<void> => {
    // fail fast when the mounter is absent (minimal/container distros) —
    // otherwise the URL prompt opens first and only the mount spawn fails
    // afterwards. `open`/diskutil ship macOS, so darwin skips the probe.
    if (!isDarwin() && !Bun.which("gio")) {
      notify("Can't connect: gio not installed", "network", "error");
      return;
    }
    let input = raw ?? "";
    if (!input) {
      const v = await deps.getPrompt().open({
        title: "Connect to Server…",
        placeholder: "sftp://user@host/path",
        okLabel: "Connect",
      });
      if (!v) return;
      input = v;
    }
    const mountPath = await network.connect(input);
    if (!mountPath) return;
    await loadSystemPlaces();
    nav.renderAll();
    nav.navigate(mountPath);
  };

  disconnectServerImpl = async (mountPath: string): Promise<void> => {
    if (!isDarwin() && !Bun.which("gio")) {
      notify("Can't disconnect: gio not installed", "network", "error");
      return;
    }
    const cwd = core.state.cwd;
    // leave the share before unmounting it — navigating away first avoids
    // reading a dead FUSE path
    if (cwd === mountPath || cwd.startsWith(mountPath + path.sep)) nav.navigate(core.home);
    const ok = await network.disconnect(mountPath);
    if (!ok) return;
    await loadSystemPlaces();
    nav.renderAll();
  };

  return {
    renderer,
    menu,
    chrome,
    sidebarIntro,
    topbarIntro,
    toolbars,
    activeToolbar: () => getMap(toolbars, core.panes.activeId),
    notify,
    notifySticky,
    ensureSudo: ensureSudoChrome,
    openFileDefault,
    launchAppAsRoot,
    dialogs,
    connectServer,
    disconnectServer,
    stopGpm: () => gpmInput?.stop(),
    stopChromeTimers: () => chrome.dispose(),
  };
};
