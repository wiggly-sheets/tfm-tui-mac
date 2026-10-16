// The three gesture solvers are pure and pinned here first; the factory test
// drives the real handler pair (arm on press, live width on drag, one commit on
// release) against a fake node tree — no renderer needed, the geometry readers
// are just screenX/width.
import { describe, expect, test } from "bun:test";
import {
  clampResize,
  makeMouseResize,
  previewWidthAt,
  sidebarWidthAt,
  splitPctAt,
  type MouseResizeCtx,
  type MouseResizeWiring,
  type ResizeBounds,
  type ResizeTarget,
} from "./mouse-resize";
import type { MaybeNode } from "../lib/node-like";

describe("resize solvers", () => {
  test("clampResize rounds and clamps into the stepper bounds", () => {
    expect(clampResize(26.4, 16, 60)).toBe(26);
    expect(clampResize(26.6, 16, 60)).toBe(27);
    expect(clampResize(5, 16, 60)).toBe(16);
    expect(clampResize(500, 16, 60)).toBe(60);
  });

  test("sidebarWidthAt: the cursor column IS the last visible column", () => {
    // left 0 → x 25 is the 26th column
    expect(sidebarWidthAt(25, 0, 16, 60)).toBe(26);
    // panel offset by its own left edge
    expect(sidebarWidthAt(5, 2, 16, 60)).toBe(16); // 5-2+1=4 → clamped up
    expect(sidebarWidthAt(61, 2, 16, 60)).toBe(60); // clamped down
  });

  test("previewWidthAt measures from the terminal's right edge", () => {
    expect(previewWidthAt(60, 100, 20, 80)).toBe(40);
    expect(previewWidthAt(90, 100, 20, 80)).toBe(20); // clamped to min
    expect(previewWidthAt(0, 100, 20, 80)).toBe(80); // clamped to max
  });

  test("splitPctAt keeps a percent of the free width and the min pane", () => {
    // inner = 60-1 = 59; x 26+30 → 30 cols left of the divider
    expect(splitPctAt(56, 26, 60, 20, 50)).toBeCloseTo((30 / 59) * 100, 6);
    // dragging past the right pane's minimum pins it at inner - min
    expect(splitPctAt(200, 26, 60, 20, 50)).toBeCloseTo((39 / 59) * 100, 6);
    // too narrow for two minimum panes: the current ratio stands
    expect(splitPctAt(56, 26, 30, 20, 42)).toBe(42);
  });
});

describe("makeMouseResize", () => {
  type Node = { screenX: number; width: number; visible?: boolean; flexGrow?: number };

  const makeNodes = (): { nodes: Record<string, Node>; sidebar: Node; preview: Node } => {
    const sidebar: Node = { screenX: 0, width: 26 };
    const preview: Node = { screenX: 60, width: 40 };
    return {
      sidebar,
      preview,
      nodes: {
        "tfm-sidebar-root": sidebar,
        "tfm-title-box": { screenX: 0, width: 24 },
        "tfm-places": { screenX: 0, width: 24 },
        "tfm-preview": preview,
        "tfm-panes": { screenX: 26, width: 74 },
        "tfm-pane-divider": { screenX: 50, width: 1 },
        "tfm-pane-col-0": { screenX: 26, width: 24, flexGrow: 1 },
        "tfm-pane-col-1": { screenX: 51, width: 49, flexGrow: 1 },
      },
    };
  };

  const makeCtx = (over: Partial<MouseResizeCtx> = {}) => {
    const { nodes, sidebar, preview } = makeNodes();
    const events: string[] = [];
    let split = 50;
    const bounds: Record<ResizeTarget, ResizeBounds> = {
      sidebar: { min: 16, max: 60 },
      split: { min: 1, max: 200 },
      preview: { min: 20, max: 80 },
    };
    const ctx: MouseResizeCtx = {
      // the factory only assigns handlers onto root; the test calls the
      // returned pair directly, so a bare object is enough
      renderer: { root: {} } as unknown as MouseResizeCtx["renderer"],
      byId: (id) => (nodes[id] ?? undefined) as MaybeNode,
      enabled: () => true,
      termW: () => 100,
      mainW: () => 74,
      bounds: (t) => bounds[t],
      setSidebarWidth: (w) => {
        events.push(`sidebar=${w}`);
        sidebar.width = w;
      },
      setPreviewWidth: (w) => {
        events.push(`preview=${w}`);
        preview.width = w;
      },
      setSplitPct: (pct) => {
        events.push(`split=${Math.round(pct)}`);
        split = pct;
      },
      splitPct: () => split,
      commit: (t) => events.push(`commit:${t}`),
      blocked: () => false,
      log: () => {},
      ...over,
    };
    return { ctx, events, wiring: makeMouseResize(ctx) };
  };

  const down = (x: number) => ({ x, y: 1, button: 0 }) as never;

  test("press on the sidebar edge, drag, release → one commit", () => {
    const { events, wiring } = makeCtx();
    wiring.onMouseDown(down(24));
    wiring.onMouseDrag({ x: 35, y: 1 } as never);
    expect(events).toEqual(["sidebar=36"]);
    wiring.onMouseDragEnd({ x: 35, y: 1 } as never);
    expect(events).toEqual(["sidebar=36", "sidebar=36", "commit:sidebar"]);
    expect(wiring.active()).toBe(false);
  });

  test("release without a move still lands (click-to-set-width fallback)", () => {
    const { events, wiring } = makeCtx();
    wiring.onMouseDown(down(25));
    wiring.onMouseUp(down(31));
    expect(events).toEqual(["sidebar=32", "commit:sidebar"]);
  });

  test("press away from every edge arms nothing and drags do nothing", () => {
    const { events, wiring } = makeCtx();
    wiring.onMouseDown(down(40));
    expect(wiring.active()).toBe(false);
    wiring.onMouseDrag({ x: 50, y: 1 } as never);
    wiring.onMouseUp({ x: 50, y: 1 } as never);
    expect(events).toEqual([]);
  });

  test("the right panel's left edge resizes it; the split divider needs dual pane", () => {
    const previewOnly = makeCtx({ enabled: (t) => t === "preview" });
    previewOnly.wiring.onMouseDown(down(60));
    previewOnly.wiring.onMouseDrag({ x: 70, y: 1 } as never);
    previewOnly.wiring.onMouseUp({ x: 70, y: 1 } as never);
    expect(previewOnly.events).toEqual(["preview=30", "preview=30", "commit:preview"]);

    const splitOn = makeCtx({ enabled: (t) => t === "split" });
    splitOn.wiring.onMouseDown(down(50));
    splitOn.wiring.onMouseDrag({ x: 56, y: 1 } as never);
    splitOn.wiring.onMouseUp({ x: 56, y: 1 } as never);
    // 30 of inner 73 → 41%
    expect(splitOn.events).toEqual(["split=41", "split=41", "commit:split"]);
  });

  test("a blocked gesture never arms, and edgePress reports the toggles", () => {
    const { wiring } = makeCtx();
    expect(wiring.edgePress("sidebar", 24)).toBe(true);
    expect(wiring.edgePress("sidebar", 10)).toBe(false);
    expect(wiring.edgePress("preview", 60)).toBe(true);

    const blocked = makeCtx({ blocked: () => true });
    blocked.wiring.onMouseDown(down(24));
    expect(blocked.wiring.active()).toBe(false);

    const off: MouseResizeWiring = makeCtx({ enabled: () => false }).wiring;
    expect(off.edgePress("sidebar", 24)).toBe(false);
  });
});
