import { Box, Text } from "@opentui/core";
import { lstatSync, type Stats } from "node:fs";
import { destroyChildren, debounced, type Scheduler } from "../lib/uiutil";
import { dirWalkStats, inodeKey } from "../fs/propsinfo";
import { type InfoRow, type InfoSelection, infoRows } from "../fs/info-model";
import type { Theme } from "../config/config";
import type { MaybeNode } from "../lib/node-like";
import type { SelTileRef } from "../input/selection";

// --- Info sidebar (toggleable right pane): a live read-out of the ACTIVE
// pane's selection — file details, directory totals, or a multi-selection
// summary. Metadata + formatting live in ./info-model (pure, tested) and
// ../fs/propsinfo; this module only resolves the selection from the shared
// tileRefs, walks dirs async and paints tfm-info-* rows (ids byte-identical so
// rethemeChrome can repaint the pane surface). The gen-counter drops stale
// async walks, same guard as ui-preview/ui-props. Plain Text — works in tty
// mode as-is (no rasters), so nothing to degrade there. ---

type InfoCtx = {
  byId(id: string): MaybeNode;
  colors(): Theme;
  infoEnabled(): boolean; // config.ui.infoSidebar
  infoWidth(): number; // config.ui.previewWidth (shared right-region width)
  home: string;
  focusKey(): string | null; // focused tile's key, else null
  tileRefs: Map<string, SelTileRef>; // shared by ref; only .forEach read here
  // coalesce the bursts a key-repeat / band drag produces; injectable for tests
  sched?: Scheduler;
};

const LABEL_W = 12;

export const makeInfoSidebar = (ctx: InfoCtx) => {
  let infoGen = 0;

  const renderRows = (pane: MaybeNode, colors: Theme, rows: InfoRow[], width: number): void => {
    if (!pane) return;
    destroyChildren(pane);
    if (!rows.length) {
      pane.add(Text({ content: "no selection", fg: colors.sidebarFgMuted }));
      return;
    }
    const max = Math.max(1, width - LABEL_W - 2);
    for (const r of rows) {
      const v = String(r.value);
      pane.add(
        Box(
          { width: "100%", height: 1, flexDirection: "row" },
          Text({ content: ` ${r.label}`.padEnd(LABEL_W), fg: colors.sidebarFgMuted }),
          Text({ content: v.length > max ? `${v.slice(0, max - 1)}…` : v, fg: colors.white }),
        ),
      );
    }
  };

  const selectedPaths = (): { path: string; isDir: boolean }[] => {
    const out: { path: string; isDir: boolean }[] = [];
    ctx.tileRefs.forEach((r, k) => {
      if (r.selected) out.push({ path: k, isDir: r.isDir });
    });
    return out;
  };

  const renderMulti = async (
    pane: MaybeNode,
    colors: Theme,
    width: number,
    selected: { path: string; isDir: boolean }[],
    gen: number,
  ): Promise<void> => {
    // files: already listed, stat'd here; dirs walk async (same aggregate as
    // the multi-selection properties dialog — hardlinked bodies count once)
    let bytes = 0,
      files = 0,
      folders = 0;
    const dirPaths: string[] = [];
    const seen = new Set<string>();
    for (const it of selected) {
      let isDir = it.isDir;
      let lst: Stats | null = null;
      if (!isDir) {
        try {
          lst = lstatSync(it.path);
          isDir = lst.isDirectory();
        } catch {}
      }
      if (isDir) {
        dirPaths.push(it.path);
        continue;
      }
      files++;
      if (lst) {
        const k = inodeKey(lst);
        if (!seen.has(k)) {
          seen.add(k);
          bytes += lst.size ?? 0;
        }
      }
    }
    if (dirPaths.length) {
      const walks = await Promise.all(dirPaths.map((d) => dirWalkStats(d)));
      if (gen !== infoGen) return;
      for (const s of walks) {
        if (s) {
          bytes += s.bytes;
          files += s.files;
          folders += s.folders;
        }
      }
    }
    renderRows(pane, colors, infoRows({ kind: "multi", count: selected.length, bytes, files, folders }), width);
  };

  const renderInfoNow = async (): Promise<void> => {
    if (!ctx.infoEnabled()) return;
    const gen = ++infoGen;
    const pane = ctx.byId("tfm-info");
    if (!pane) return;
    const colors = ctx.colors();
    const width = ctx.infoWidth();

    const selected = selectedPaths();
    if (selected.length > 1) {
      await renderMulti(pane, colors, width, selected, gen);
      return;
    }
    // single selection = the focused tile, else the one selected (a click sets
    // both; focus is the source of truth when they disagree)
    const single = ctx.focusKey() ?? selected[0]?.path ?? null;
    if (!single) {
      renderRows(pane, colors, [], width);
      return;
    }

    let st: Stats | null = null;
    try {
      // on-disk identity: a symlink reports its own bytes, never the target's
      // (matches the properties dialog and the status bar)
      st = lstatSync(single);
    } catch {
      destroyChildren(pane);
      pane.add(Text({ content: "source gone", fg: colors.sidebarFgMuted }));
      return;
    }
    const isDir = st.isDirectory();
    const sel: InfoSelection = { kind: "single", path: single, st, home: ctx.home, dir: isDir ? "pending" : undefined };
    renderRows(pane, colors, infoRows(sel), width);
    if (!isDir) return;

    // directory totals land async (dirWalkStats); re-render once they settle
    const walk = await dirWalkStats(single);
    if (gen !== infoGen) return;
    renderRows(pane, colors, infoRows({ ...sel, dir: walk }), width);
  };

  const scheduleInfo = debounced(
    60,
    () => {
      void renderInfoNow();
    },
    ctx.sched ?? globalThis,
  );
  const renderInfo = (): void => {
    scheduleInfo();
  };

  return { renderInfo };
};
