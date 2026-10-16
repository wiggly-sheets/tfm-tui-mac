// --- Plugin FS operations: the registry behind api.operations.register. One
// operation is a command-palette entry AND a file-context-menu entry that runs
// with the selection-aware absolute paths (see wiring/plugins' palette list and
// the loader's fileMenu synthesis). Pure module (no renderer/fs imports) so the
// loader and the palette share one instance. Shared singleton mirrors
// sharedPluginViews; tests use makePluginOperations for isolation.
//
// Validation is per-registration and never throws into the plugin: a bad shape
// or a duplicate id is logged and dropped, first registration wins. Errors
// thrown by run() are the caller's job — the menu and palette invoke paths
// isolate them into toasts.

import type { PluginOperation } from "../plugins/plugin-api";

export type RegisteredOperation = PluginOperation & { plugin: string; enabled: boolean };

export type PluginOperations = {
  register(
    plugin: string,
    raw: unknown,
    opts?: { enabled?: () => boolean; log?: (message: string) => void },
  ): () => void;
  // every accepted operation, load order preserved; `enabled` is read live
  list(): RegisteredOperation[];
};

const validId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 64;

export const makePluginOperations = (): PluginOperations => {
  const entries: Array<{ op: PluginOperation; plugin: string; enabled: () => boolean }> = [];
  return {
    register: (plugin, raw, opts) => {
      const log = opts?.log;
      if (typeof raw !== "object" || raw === null) {
        log?.(`plugin ${plugin}: operation registration must be an object — dropped`);
        return () => {};
      }
      const r = raw as { id?: unknown; title?: unknown; run?: unknown };
      if (!validId(r.id) || !validId(r.title) || typeof r.run !== "function") {
        log?.(`plugin ${plugin}: operation needs { id, title, run(paths) } — dropped`);
        return () => {};
      }
      if (entries.some((e) => e.op.id === r.id)) {
        log?.(`plugin ${plugin}: operation id ${JSON.stringify(r.id)} already registered — dropped (first wins)`);
        return () => {};
      }
      const entry = {
        op: { id: r.id, title: r.title, run: r.run as PluginOperation["run"] },
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
        ...e.op,
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

let shared: PluginOperations | null = null;
export const sharedPluginOperations = (): PluginOperations => {
  if (!shared) shared = makePluginOperations();
  return shared;
};
