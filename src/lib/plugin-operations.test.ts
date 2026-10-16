// FS-operation registry (api.operations.register): shape + duplicate
// validation, unregister, live enabled gate, and the paths run() receives.

import { describe, expect, test } from "bun:test";
import { makePluginOperations } from "./plugin-operations";

const op = (id: string, run: (paths: string[]) => void = () => {}) => ({ id, title: `title ${id}`, run });

describe("plugin operation registry", () => {
  test("accepts a valid registration and lists it with its plugin", () => {
    const ops = makePluginOperations();
    const seen: string[][] = [];
    const off = ops.register(
      "aaa",
      op("aaa:zip", (paths) => seen.push(paths)),
    );
    const listed = ops.list();
    expect(listed.map((o) => o.id)).toEqual(["aaa:zip"]);
    expect(listed[0]?.plugin).toBe("aaa");
    listed[0]?.run(["/a", "/b"]);
    expect(seen).toEqual([["/a", "/b"]]);
    off();
    expect(ops.list()).toEqual([]);
  });

  test("rejects a duplicate id (first wins) and logs it", () => {
    const ops = makePluginOperations();
    const logs: string[] = [];
    ops.register("aaa", op("shared:op"), { log: (m) => logs.push(m) });
    const off = ops.register("bbb", op("shared:op"), { log: (m) => logs.push(m) });
    expect(ops.list().map((o) => o.id)).toEqual(["shared:op"]);
    expect(ops.list()[0]?.plugin).toBe("aaa");
    expect(logs.join("\n")).toContain("already registered");
    off();
    expect(ops.list().map((o) => o.id)).toEqual(["shared:op"]);
  });

  test("rejects invalid shapes and logs each rejection", () => {
    const ops = makePluginOperations();
    const logs: string[] = [];
    ops.register("aaa", "nope", { log: (m) => logs.push(m) });
    ops.register("aaa", { id: "x:y", title: "y" }, { log: (m) => logs.push(m) });
    ops.register("aaa", { id: "", title: "y", run: () => {} }, { log: (m) => logs.push(m) });
    expect(ops.list()).toEqual([]);
    expect(logs.length).toBe(3);
  });

  test("enabled is read live, so a disabled plugin's operation drops out", () => {
    const ops = makePluginOperations();
    let on = true;
    ops.register("aaa", op("aaa:zip"), { enabled: () => on });
    expect(
      ops
        .list()
        .filter((o) => o.enabled)
        .map((o) => o.id),
    ).toEqual(["aaa:zip"]);
    on = false;
    expect(ops.list().filter((o) => o.enabled)).toEqual([]);
  });
});
