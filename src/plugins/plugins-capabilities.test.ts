// Capability registrations end-to-end through the loader: api.views.register
// and api.operations.register reach the (injected) registries with the plugin's
// own name + live enabled gate, operations join the file menu, and unloading
// the plugin unregisters both.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { makePluginOperations } from "../lib/plugin-operations";
import { makePluginViews } from "../lib/plugin-views";
import { makePluginRegistry, makePluginStore } from "./plugins";
import type { LoadedPlugin, PluginApi } from "./plugin-api";

const cacheSandbox = mkdtempSync(path.join(os.tmpdir(), "tfm-plugins-caps-cache-"));
const prevCacheHome = process.env.XDG_CACHE_HOME;
process.env.XDG_CACHE_HOME = cacheSandbox;
afterAll(() => {
  if (prevCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = prevCacheHome;
  rmSync(cacheSandbox, { recursive: true, force: true });
});

// plugin files run in-process, so their run() writes into a global sink
const calls = { op: [] as string[][] };
(globalThis as { __capCalls?: typeof calls }).__capCalls = calls;

const CAP_PLUGIN = `export default {
  name: "cap",
  apiVersion: 4,
  activate(api) {
    api.views.register({ id: "cap:tree", label: "Tree", render: () => null });
    api.operations.register({
      id: "cap:zip",
      title: "Cap: zip",
      run: (paths) => globalThis.__capCalls.op.push(paths),
    });
    return { fileMenu: () => [{ label: "own entry", run: () => {} }] };
  },
};
`;

// the same ids from a second plugin: both registrations must be dropped, the
// first plugin winning, each with a log line
const DUP_PLUGIN = `export default {
  name: "dup",
  activate(api) {
    api.views.register({ id: "cap:tree", label: "Other tree", render: () => null });
    api.operations.register({ id: "cap:zip", title: "Dup zip", run: () => {} });
    return {};
  },
};
`;

const BAD_PLUGIN = `export default {
  name: "bad",
  activate(api) {
    api.views.register({ id: "bad:view" });
    api.operations.register({ id: "", title: "", run: 1 });
    return {};
  },
};
`;

const mkDir = (): string => mkdtempSync(path.join(os.tmpdir(), "tfm-plugins-caps-"));
const writePlugin = (dir: string, file: string, body: string): void => writeFileSync(path.join(dir, file), body);

// the base api is never used for views/operations (the loader scopes them):
// recording stubs prove the scoped registrations ran instead
const mkApi = (dir: string, notes: string[]): PluginApi => ({
  notify: () => {},
  setStatusMsg: () => {},
  log: (message) => notes.push(message),
  store: (name) => makePluginStore(dir, name),
  selection: () => [],
  cwd: () => "/home/u",
  navigate: () => {},
  open: () => {},
  reveal: () => {},
  select: () => {},
  commands: () => [],
  ui: { pick: () => {}, confirm: async () => false, prompt: async () => null, notifySticky: () => () => {} },
  events: { on: () => () => {} },
  hooks: { beforeFileOp: () => () => {} },
  views: {
    register: () => {
      notes.push("base views.register used");
      return () => {};
    },
  },
  operations: {
    register: () => {
      notes.push("base operations.register used");
      return () => {};
    },
  },
});

const load = async (dir: string, notes: string[]) => {
  const views = makePluginViews();
  const operations = makePluginOperations();
  const registry = makePluginRegistry({ dir, api: mkApi(dir, notes), warn: (m) => notes.push(m), views, operations });
  await registry.scan();
  return { registry, views, operations };
};

describe("capability registrations through the loader", () => {
  test("views + operations register under the plugin's name", async () => {
    const dir = mkDir();
    try {
      writePlugin(dir, "cap.ts", CAP_PLUGIN);
      const notes: string[] = [];
      const { views, operations } = await load(dir, notes);
      expect(notes).not.toContain("base views.register used");
      expect(notes).not.toContain("base operations.register used");
      expect(views.list().map((v) => `${v.plugin}/${v.id}:${v.label}`)).toEqual(["cap/cap:tree:Tree"]);
      expect(operations.list().map((o) => `${o.plugin}/${o.id}`)).toEqual(["cap/cap:zip"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an operation joins the file context menu beside the plugin's own entries", async () => {
    const dir = mkDir();
    try {
      writePlugin(dir, "cap.ts", CAP_PLUGIN);
      const notes: string[] = [];
      const { registry } = await load(dir, notes);
      const p = registry.plugins.find((x): x is LoadedPlugin => x.name === "cap");
      expect(p?.fileMenu).not.toBeNull();
      const entries = p?.fileMenu?.({ paths: [] }) ?? [];
      expect(entries.map((e) => e.label)).toEqual(["Cap: zip", "own entry"]);
      calls.op.length = 0;
      entries[0]?.run(["/a", "/b"]);
      expect(calls.op).toEqual([["/a", "/b"]]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("duplicate ids are rejected, first plugin wins, both logged", async () => {
    const dir = mkDir();
    try {
      writePlugin(dir, "aaa-cap.ts", CAP_PLUGIN.replace('name: "cap"', 'name: "aaa"'));
      writePlugin(dir, "dup.ts", DUP_PLUGIN);
      const notes: string[] = [];
      const { views, operations } = await load(dir, notes);
      expect(views.list().map((v) => `${v.plugin}/${v.id}`)).toEqual(["aaa/cap:tree"]);
      expect(operations.list().map((o) => `${o.plugin}/${o.id}`)).toEqual(["aaa/cap:zip"]);
      const log = notes.join("\n");
      expect(log).toContain('view id "cap:tree" already registered');
      expect(log).toContain('operation id "cap:zip" already registered');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("invalid registrations are logged and dropped without sinking the plugin", async () => {
    const dir = mkDir();
    try {
      writePlugin(dir, "bad.ts", BAD_PLUGIN);
      const notes: string[] = [];
      const { registry, views, operations } = await load(dir, notes);
      expect(registry.errors).toEqual([]);
      expect(registry.plugins.map((p) => p.name)).toEqual(["bad"]);
      expect(views.list()).toEqual([]);
      expect(operations.list()).toEqual([]);
      const log = notes.join("\n");
      expect(log).toContain("view needs { id, label, render(ctx) }");
      expect(log).toContain("operation needs { id, title, run(paths) }");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("unloading the plugin unregisters its view and operation", async () => {
    const dir = mkDir();
    try {
      writePlugin(dir, "cap.ts", CAP_PLUGIN);
      const notes: string[] = [];
      const { registry, views, operations } = await load(dir, notes);
      expect(views.list().length).toBe(1);
      expect(operations.list().length).toBe(1);
      // the flat fixture was migrated into the folder layout on the first scan
      rmSync(path.join(dir, "cap"), { recursive: true, force: true });
      const diff = await registry.scan();
      expect(diff.removed).toEqual(["cap"]);
      expect(views.list()).toEqual([]);
      expect(operations.list()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a disabled plugin's registrations stay listed but report enabled:false", async () => {
    const dir = mkDir();
    try {
      writePlugin(dir, "cap.ts", CAP_PLUGIN);
      const notes: string[] = [];
      const { registry, views, operations } = await load(dir, notes);
      makePluginStore(dir, "cap").set("enabled", false);
      expect(registry.plugins.map((p) => p.name)).toEqual(["cap"]);
      expect(views.list().map((v) => v.enabled)).toEqual([false]);
      expect(operations.list().map((o) => o.enabled)).toEqual([false]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
