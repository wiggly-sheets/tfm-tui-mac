// --- Plugin custom views: the registry behind api.views.register. A view
// joins the ACTIVE pane's grid|list|columns cycle and is painted in place of
// the core renderers (see app/panes' viewCycle + wiring/grid's renderPane).
// Pure module: no renderer/fs imports, so panes/ and the loader can read it
// without an import cycle. Shared singleton mirrors sharedPluginEvents (tests
// use makePluginViews for isolation).
//
// Validation is per-registration and never throws into the plugin: a bad shape
// or a duplicate id is logged and dropped, first registration wins. `enabled`
// is read live at list() time, so the Plugins-view on/off toggle gates views
// without re-registering them.

import type { PluginView } from "../plugins/plugin-api";

export type RegisteredView = PluginView & { plugin: string; enabled: boolean };

export type PluginViews = {
  // returns an unregister fn (a rejected registration returns a no-op)
  register(
    plugin: string,
    raw: unknown,
    opts?: { enabled?: () => boolean; log?: (message: string) => void },
  ): () => void;
  // every accepted view, load order preserved; `enabled` is read live
  list(): RegisteredView[];
};

// a view id must be a non-empty, reasonably short nameable string
const validId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 64;

export const makePluginViews = (): PluginViews => {
  const entries: Array<{ view: PluginView; plugin: string; enabled: () => boolean }> = [];
  return {
    register: (plugin, raw, opts) => {
      const log = opts?.log;
      if (typeof raw !== "object" || raw === null) {
        log?.(`plugin ${plugin}: view registration must be an object — dropped`);
        return () => {};
      }
      const r = raw as { id?: unknown; label?: unknown; render?: unknown };
      if (!validId(r.id) || !validId(r.label) || typeof r.render !== "function") {
        log?.(`plugin ${plugin}: view needs { id, label, render(ctx) } — dropped`);
        return () => {};
      }
      if (entries.some((e) => e.view.id === r.id)) {
        log?.(`plugin ${plugin}: view id ${JSON.stringify(r.id)} already registered — dropped (first wins)`);
        return () => {};
      }
      const entry = {
        view: { id: r.id, label: r.label, render: r.render as PluginView["render"] },
        plugin,
        enabled: opts?.enabled ?? (() => true),
      };
      entries.push(entry);
      return () => {
        const i = entries.indexOf(entry);
        if (i >= 0) entries.splice(i, 1);
      };
    },
    list: () =>
      entries.map((e) => ({
        ...e.view,
        plugin: e.plugin,
        // a throwing enabled() read (broken state file) degrades to enabled
        enabled: (() => {
          try {
            return e.enabled();
          } catch {
            return true;
          }
        })(),
      })),
  };
};

let shared: PluginViews | null = null;
export const sharedPluginViews = (): PluginViews => {
  if (!shared) shared = makePluginViews();
  return shared;
};
