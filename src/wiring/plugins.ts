// --- Plugins wiring: user extensions from ~/.config/tfm/plugins/*.ts.
// Runs after fileops (api context needs selection + nav/chrome sinks) and
// before grid/settings (menu entries merge plugin sections; aggregated rows
// feed the settings model). A plugin failure never breaks boot — loadPlugins
// isolates per plugin. ---

import { Text } from "@opentui/core";
import { destroyChildren, errMessage } from "../lib/uiutil";
import { stickyClose } from "../ui/notify";
import path from "node:path";
import pkg from "../../package.json";
import { dlog } from "../app/log";
import type { Command } from "../lib/command";
import type { ScrollerLike } from "../lib/node-like";
import { sharedPluginEvents } from "../lib/plugin-events";
import { sharedPluginHooks } from "../lib/plugin-hooks";
import { sharedPluginOperations } from "../lib/plugin-operations";
import { sharedPluginViews } from "../lib/plugin-views";
import { pluginViewIdOf } from "../app/panes";
import type { PaneId } from "../app/layout";
import { listDir, type Entry } from "../fs/listing";
import { installPluginRuntimeSupport } from "../ui/ui-plugin-runtime";
import { makePluginSlots } from "../ui/ui-plugin-slots";
import { KEY_SCHEMA } from "../config/config-schema";
import { keySpecEqual } from "../config/keyspec";
import {
  flattenPluginCommands,
  flattenPluginOperations,
  getPluginCommandBinds,
  isPluginEnabled,
  type PluginApi,
  type PluginStore,
  type PluginView,
  type PluginViewCtx,
} from "../plugins/plugin-api";
import { makePluginRegistry, makePluginStore, pluginsDir } from "../plugins/plugins";
import type { CoreWiring } from "./core";
import type { ChromeWiring, GridFoundationWiring, NavWiring } from "./types";

export type PluginsWiring = Awaited<ReturnType<typeof wirePlugins>>;

// TDZ-safe late-cluster reader: getKeymap/getPick/getPrompt close over
// wirings that initialize AFTER the first plugin scan (an eager plugin calling
// api.commands()/ui.pick at activate top level would otherwise throw a
// ReferenceError and fail its own load). The guard is ONE-SHOT: the first
// failure (the legitimate pre-boot case) logs and returns the fallback; every
// later call propagates. Re-arming on every call converted any real
// wiring-order bug into a permanent silent fallback — indistinguishable from
// pre-boot except via a --debug dlog line.
export const tdzSafe = <T>(get: () => T, fallback: T): (() => T) => {
  let armed = true;
  return () => {
    try {
      return get();
    } catch (err) {
      if (!armed) throw err;
      armed = false;
      try {
        dlog(`tdzSafe fallback: ${errMessage(err)}`);
      } catch {}
      return fallback;
    }
  };
};

export const wirePlugins = async (deps: {
  core: CoreWiring;
  nav: NavWiring;
  chrome: ChromeWiring;
  gridFoundation: GridFoundationWiring;
  // the keymap (core command table) and the pick widget wire LAST — deferred
  // arrows (TDZ seam rule); only CALLED post-boot, never during activate.
  // confirm arrives the same way (fileops wires before plugins, but the
  // explicit getter keeps the cluster type leaf-clean).
  getKeymap: () => { commands(): Command[] };
  getPick: () => {
    open(opts: { title: string; items?: Array<{ label: string; hint?: string; run: () => void }> }): void;
  };
  getConfirm?: () => {
    confirm(message: string, yesLabel: string, onYes: () => void, danger?: boolean): boolean;
    isOpen(): boolean;
  };
  // single-line prompt (keymap wires LAST — lazy getter like getPick)
  getPrompt?: () => {
    open(opts: { title: string; placeholder?: string; okLabel?: string; initial?: string }): Promise<string | null>;
  };
}) => {
  const { core, nav, chrome, gridFoundation, getKeymap, getPick, getConfirm, getPrompt } = deps;
  // must run before the first external plugin import (registry.scan) so plugin
  // files can import @opentui/core against THIS process's singleton
  installPluginRuntimeSupport();
  const dir = pluginsDir();
  // UI-extension host: plugins returning `slots` render real OpenTUI nodes
  // into tfm's statusbar / sidebar-footer. Context is a stable ref with live
  // getters; mounted at boot (see wireBoot).
  const slotContext = {
    app: "tfm",
    version: pkg.version,
    renderer: () => chrome.renderer,
    colors: () => core.colors,
    cwd: () => core.state.cwd,
    selection: () => gridFoundation.selection.selPaths().map((s) => s.path),
  };
  const slotRegistry = makePluginSlots({ renderer: chrome.renderer, context: slotContext, log: (m) => dlog(m) });

  // --- Custom views (api.views.register): a plugin view is painted in place of
  // the core renderers for ONE pane. wiring/grid's renderPane calls
  // pluginViewFor for the decision and renderPluginView for the mount, so the
  // core render path keeps a one-line seam; the ctrl+g cycle order lives in
  // app/panes' viewCycle.
  const views = sharedPluginViews();
  const enabledViews = (): PluginView[] => views.list().filter((v) => v.enabled);

  // the plugin view selected for this pane, or null (none selected, plugin
  // gone, or the tty console — an unknown renderable stays off it, like grid)
  const pluginViewFor = (id: PaneId): PluginView | null => {
    if (core.isTtyMode()) return null;
    const wanted = pluginViewIdOf(core.panes.stateOf(id));
    if (!wanted) return null;
    return enabledViews().find((v) => v.id === wanted) ?? null;
  };

  // panes whose last paint was a plugin view: the core renderer's signature
  // cache cannot see the swap, so its first rebuild after the pane returns to a
  // core mode must be forced (the plugin mount cleared the pane's content)
  // shortcut: a grid render's armed loading placeholder ([ui] loading-delay-ms)
  // can still swap itself in over a freshly mounted view; upgrade if a view
  // ever flickers to the spinner
  const pluginViewPanes = new Set<PaneId>();

  const renderPluginView = async (id: PaneId, view: PluginView): Promise<void> => {
    const scroller: ScrollerLike | null = core.scrollerRefs.get(id)?.current ?? null;
    if (!scroller) return;
    const state = core.panes.stateOf(id);
    let entries: Entry[] = [];
    try {
      // the plain listing: the pane's type-to-search filter is a grid concept
      // and is not applied here (a view paints the folder, not a match set)
      // shortcut: no listings cache (each repaint lists fresh), upgrade when a
      // view-heavy plugin repaints hot folders
      entries = await listDir(state.cwd, state.showHidden, state.sortBy, state.sortAsc);
    } catch {
      entries = []; // restricted dir / virtual place: the view paints empty
    }
    // a slow listing must not paint over a view switch or navigation that
    // landed meanwhile (same stale-render guard the grid keeps by generation)
    if (pluginViewIdOf(core.panes.stateOf(id)) !== view.id || core.scrollerRefs.get(id)?.current !== scroller) return;
    const sel = gridFoundation.selections.get(id);
    const ctx: PluginViewCtx = {
      app: "tfm",
      version: pkg.version,
      renderer: () => chrome.renderer,
      colors: () => core.colors,
      cwd: state.cwd,
      pane: id,
      entries: entries.map((e) => ({
        name: e.name,
        path: e.abs ?? path.join(state.cwd, e.name),
        isDir: e.isDir,
        ...(e.size === undefined ? {} : { size: e.size }),
      })),
      selection: (sel?.selPaths() ?? []).map((s) => s.path),
    };
    destroyChildren(scroller.content);
    try {
      // no tiles to navigate: the previous grid's keys must not stay
      // actionable (same contract as the grid's own empty-pane path)
      sel?.tileRefs.clear();
      sel?.setFocusKeys([]);
    } catch {}
    let node: unknown = null;
    try {
      node = view.render(ctx);
    } catch (err) {
      // a throwing view renders empty rather than taking the pane down
      dlog(`plugin view ${view.id} render failed: ${errMessage(err)}`);
    }
    if (node === null || node === undefined) return;
    scroller.content.add(node);
    pluginViewPanes.add(id);
    try {
      core.lookup.stripSelectable();
    } catch {}
  };

  // true when the pane was showing a plugin view — the caller must force the
  // next core render (once), because its cached signature still describes the
  // grid content the plugin mount destroyed
  const leftPluginView = (id: PaneId): boolean => pluginViewPanes.delete(id);

  // api.operations: palette entries run with the LIVE selection (read at invoke
  // time). The same operations join the file context menu in the loader.
  const pluginOperations = () =>
    sharedPluginOperations()
      .list()
      .filter((o) => o.enabled);

  let loaded: Array<{
    commands: Array<{ id: string; title: string; hint?: string; run: () => void }>;
    store: PluginStore;
  }> = [];
  const api: PluginApi = {
    notify: (message, title) => chrome.notify(message, title ?? "tfm"),
    setStatusMsg: nav.setStatusMsg,
    log: (message) => dlog(message),
    store: (name) => makePluginStore(dir, name),
    // live reads — selection/cwd resolve at call time, so a plugin action
    // run minutes later still sees the current state, never a stale capture
    selection: () => gridFoundation.selection.selPaths(),
    cwd: () => core.state.cwd,
    // action surface: let a plugin drive tfm (not just observe). All guarded —
    // a throwing action must never break the plugin that called it.
    navigate: (dir) => {
      try {
        nav.navigate(dir);
      } catch {}
    },
    open: (p) => {
      try {
        chrome.openFileDefault(p);
      } catch {}
    },
    reveal: (p) => {
      if (!p) return;
      try {
        core.state.pendingSelect = p;
        nav.navigate(path.dirname(p));
      } catch {}
    },
    select: (paths) => {
      try {
        gridFoundation.selection.selectPaths(paths);
      } catch {}
    },
    // core table first, then plugin contributions in load order (hints fall
    // back to "" — most plugin commands carry no bind). Both late getters go
    // through tdzSafe: they close over wirings that initialize after scan.
    commands: () => [
      ...tdzSafe(() => getKeymap().commands(), [] as Command[])(),
      ...flattenPluginCommands(loaded.filter(isPluginEnabled)),
      ...flattenPluginOperations(pluginOperations(), () => gridFoundation.selection.selPaths().map((s) => s.path)),
    ],
    ui: {
      pick: (opts) => {
        const noop: () => {
          open(o: { title: string; items?: Array<{ label: string; hint?: string; run: () => void }> }): void;
        } = () => ({ open: () => {} });
        tdzSafe(getPick, noop())().open(opts);
      },
      confirm: (opts) =>
        new Promise<boolean>((resolve) => {
          const c = getConfirm?.();
          if (!c) {
            resolve(false);
            return;
          }
          let settled = false;
          // the poll timer must die on EVERY settle path — resolving without
          // clearing it leaks a 50ms interval per confirm (and holds the
          // event loop when the dialog never closes).
          let timer: ReturnType<typeof setInterval> | null = null;
          let hardTimer: ReturnType<typeof setTimeout> | null = null;
          const done = (v: boolean): void => {
            if (settled) return;
            settled = true;
            if (timer !== null) clearInterval(timer);
            if (hardTimer !== null) clearTimeout(hardTimer);
            resolve(v);
          };
          try {
            const opened = c.confirm(
              opts.body ? `${opts.title}: ${opts.body}` : opts.title,
              "Yes",
              () => done(true),
              opts.danger ?? false,
            );
            if (!opened) {
              done(false);
              return;
            }
          } catch {
            done(false);
            return;
          }
          // No/Esc/close resolves false — poll the open flag (the dialog has
          // no onNo hook; polling is the same settle pattern tests use).
          timer = setInterval(() => {
            try {
              if (!c.isOpen()) done(false);
            } catch {
              done(false);
            }
          }, 50);
          // backstop: a dialog that never closes must not pend forever.
          hardTimer = setTimeout(() => done(false), 5 * 60 * 1000);
        }),
      prompt: (opts) => {
        const p = tdzSafe(() => getPrompt?.(), null)();
        if (!p) return Promise.resolve(null);
        try {
          return p.open({
            title: opts.title,
            ...(opts.value !== undefined ? { initial: opts.value } : {}),
            ...(opts.placeholder !== undefined ? { placeholder: opts.placeholder } : {}),
            ...(opts.okLabel !== undefined ? { okLabel: opts.okLabel } : {}),
          });
        } catch {
          return Promise.resolve(null);
        }
      },
      notifySticky: (message, title) => {
        try {
          const handle = chrome.notifySticky(
            [Text({ content: String(title ?? "tfm").slice(0, 60) }), Text({ content: String(message).slice(0, 120) })],
            { width: 40, height: 3 },
          );
          return stickyClose(handle);
        } catch {
          return () => {};
        }
      },
    },
    events: {
      on: (evt, cb) => (sharedPluginEvents().on as (e: typeof evt, c: typeof cb) => () => void)(evt, cb),
    },
    hooks: {
      beforeFileOp: (fn) => sharedPluginHooks().onBeforeFileOp(fn),
    },
    // capability registrations: the loader replaces both with per-plugin
    // scoped versions (own name + live enabled gate). These fallbacks serve
    // direct api users (tests) and register against the shared registries.
    views: {
      register: (view) => sharedPluginViews().register("core", view, { log: (m) => dlog(m) }),
    },
    operations: {
      register: (op) => sharedPluginOperations().register("core", op, { log: (m) => dlog(m) }),
    },
  };
  const warn = (message: string): void => {
    chrome.notify(message, "plugins");
    dlog(message);
  };
  // registry-backed: the returned array is LIVE (rescan mutates it in place)
  // so the model, menus and api.commands merge see adds/removes with no
  // re-wiring; rescan also surfaces from the esc menu (no restart for
  // add/remove/edit — edits hot-reload via hashed staging, see plugins.ts)
  const registry = makePluginRegistry({
    dir,
    api,
    warn,
    registerSlots: (name, slots) => slotRegistry.register({ id: name, slots: slots as never }),
  });
  await registry.scan();
  loaded = registry.plugins;
  // colliding defaults load silently shadowed (core-wins at dispatch) — make
  // the shadowing visible once per load so authors/users know to remap.
  try {
    const seenPluginBinds: Array<{ title: string; spec: string }> = [];
    for (const p of registry.plugins) {
      for (const c of p.commands) {
        for (const spec of getPluginCommandBinds(p, c.id)) {
          const coreOwner = KEY_SCHEMA.find((row) =>
            (core.config.keys[row.action] ?? []).some((owned) => keySpecEqual(owned, spec)),
          );
          if (coreOwner) {
            api.log(
              `plugin ${p.name}: bind "${spec}" for ${JSON.stringify(c.id)} is shadowed by core "${coreOwner.label}" — remap it in the Plugins view`,
            );
            continue;
          }
          const sibling = seenPluginBinds.find((s) => keySpecEqual(s.spec, spec));
          if (sibling) {
            api.log(
              `plugin ${p.name}: bind "${spec}" for ${JSON.stringify(c.id)} is shadowed by "${sibling.title}" — remap it in the Plugins view`,
            );
            continue;
          }
          seenPluginBinds.push({ title: `${p.name}:${c.title}`, spec });
        }
      }
    }
  } catch {}
  try {
    sharedPluginEvents().emit("boot", {});
  } catch {}
  // promise confirm (danger-aware Yes/No) shared with the settings installer
  // rows — same dialog plugins get via api.ui.confirm, no second wrapper
  return {
    plugins: registry.plugins,
    reloadPlugins: () => registry.scan(),
    confirm: api.ui.confirm,
    deactivateAll: registry.deactivateAll,
    // Plugins-view on/off: register/unregister that plugin's slots immediately
    setSlotEnabled: registry.setSlotEnabled,
    // UI slots: mount after the boot layout exists; refresh with renderAll so
    // contributions see fresh cwd/selection
    slotRegistry,
    mountSlots: () => slotRegistry.mount((id) => core.lookup.byId(id)),
    refreshSlots: () => slotRegistry.refresh(),
    disposeSlots: () => slotRegistry.dispose(),
    // exposed for tests/consumers that want the built api surface
    api,
    // custom views: the ctrl+g cycle list + the grid render-path seam
    pluginViews: () => enabledViews().map((v) => ({ id: v.id, label: v.label })),
    pluginViewFor,
    renderPluginView,
    leftPluginView,
    // FS operations: the palette list (the menu side lives on LoadedPlugin)
    pluginOperations,
  };
};
