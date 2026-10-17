// --- Wiring-level test for core.panes.setTree (layout presets): the tree swap
// must reconcile the per-leaf state/scroller maps and repoint a dropped active
// pane, while leaving the legacy 0|1 shims intact. No renderer is touched, so
// a stub suffices; TFM_CONFIG points at a missing file for a hermetic default
// config. ---
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { defaultTree } from "../app/layout";
import { presetThreePane } from "../app/layout-presets";
import { wireCore } from "./core";

const prevConfig = process.env.TFM_CONFIG;

beforeAll(() => {
  process.env.TFM_CONFIG = "/nonexistent/tfm-core-test/config.toml";
});
afterAll(() => {
  if (prevConfig === undefined) delete process.env.TFM_CONFIG;
  else process.env.TFM_CONFIG = prevConfig;
});

const mkCore = () => wireCore({ renderer: () => ({}) as never, clipboard: () => null });

describe("core.panes.setTree", () => {
  test("adding p2 keeps existing state and repoints nothing", () => {
    const core = mkCore();
    core.panes.setTree(defaultTree());
    const p0 = core.panes.stateOf("p0");
    const shim0 = core.panes.states[0];
    const shim1 = core.panes.states[1];

    core.panes.setTree(presetThreePane());

    expect(core.panes.leafIds()).toEqual(["p0", "p1", "p2"]);
    expect(core.panes.stateOf("p0")).toBe(p0);
    expect(core.panes.stateOf("p2")).toBeDefined();
    expect(core.scrollerRefs.has("p2")).toBe(true);
    // legacy 0|1 shims are boot-fixed snapshots and must survive a swap
    expect(core.panes.states[0]).toBe(shim0);
    expect(core.panes.states[1]).toBe(shim1);
  });

  test("dropping panes deletes their state and repoints the active pane", () => {
    const core = mkCore();
    core.panes.setTree(presetThreePane());
    core.panes.setActiveId("p2");
    const orphan1 = core.panes.states[1];

    core.panes.setTree({ kind: "leaf", id: "p0" });

    expect(core.panes.leafIds()).toEqual(["p0"]);
    expect(core.scrollerRefs.size).toBe(1);
    expect(core.panes.activeId).toBe("p0");
    // the orphaned shim slot still points at the pre-swap p1 state (harmless:
    // no live consumer indexes the tuple for a pane that no longer exists)
    expect(core.panes.states[1]).toBe(orphan1);
  });

  test("the tree-change fan-out fires once per swap", () => {
    const core = mkCore();
    let fired = 0;
    core.panes.onTreeChange(() => {
      fired++;
    });
    core.panes.setTree(defaultTree());
    core.panes.setTree(presetThreePane());
    expect(fired).toBe(2);
  });
});
