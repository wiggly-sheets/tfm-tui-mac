// Custom-view registry (api.views.register): shape + duplicate validation,
// unregister, and the live enabled gate the Plugins-view toggle rides on.

import { describe, expect, test } from "bun:test";
import { makePluginViews } from "./plugin-views";

const view = (id: string) => ({ id, label: `label ${id}`, render: () => null });

describe("plugin view registry", () => {
  test("accepts a valid registration and lists it with its plugin", () => {
    const views = makePluginViews();
    const off = views.register("aaa", view("aaa:tree"));
    expect(views.list().map((v) => v.id)).toEqual(["aaa:tree"]);
    expect(views.list()[0]?.plugin).toBe("aaa");
    expect(views.list()[0]?.enabled).toBe(true);
    off();
    expect(views.list()).toEqual([]);
  });

  test("rejects a duplicate id (first wins) and logs it", () => {
    const views = makePluginViews();
    const logs: string[] = [];
    views.register("aaa", view("shared:view"), { log: (m) => logs.push(m) });
    const off = views.register("bbb", view("shared:view"), { log: (m) => logs.push(m) });
    expect(views.list().map((v) => v.id)).toEqual(["shared:view"]);
    expect(views.list()[0]?.plugin).toBe("aaa");
    expect(logs.join("\n")).toContain("already registered");
    // the rejected registration's unsubscribe must not remove the accepted one
    off();
    expect(views.list().map((v) => v.id)).toEqual(["shared:view"]);
  });

  test("rejects invalid shapes and logs each rejection", () => {
    const views = makePluginViews();
    const logs: string[] = [];
    views.register("aaa", null, { log: (m) => logs.push(m) });
    views.register("aaa", { id: "x:y" }, { log: (m) => logs.push(m) });
    views.register("aaa", { id: "x:y", label: "y" }, { log: (m) => logs.push(m) });
    views.register("aaa", { id: "", label: "y", render: () => null }, { log: (m) => logs.push(m) });
    expect(views.list()).toEqual([]);
    expect(logs.length).toBe(4);
  });

  test("enabled is read live, so a disabled plugin's view drops out", () => {
    const views = makePluginViews();
    let on = true;
    views.register("aaa", view("aaa:tree"), { enabled: () => on });
    expect(
      views
        .list()
        .filter((v) => v.enabled)
        .map((v) => v.id),
    ).toEqual(["aaa:tree"]);
    on = false;
    expect(views.list().filter((v) => v.enabled)).toEqual([]);
  });
});
