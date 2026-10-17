// --- Bottom-bar icon-size slider (Finder-style). It sits at the right of the
// tfm-status row and drives the EXISTING grid zoom through the config path, so
// ctrl+= / ctrl+- and the slider stay one mechanism (settings.zoomUiPatch).
// Visible only when [ui] icon-size-slider is on, the ACTIVE pane is in grid
// view, and a live image protocol exists — see ./icon-slider-model. ---

import { type CliRenderer, SliderRenderable } from "@opentui/core";
import type { Theme } from "../config/config";
import type { UiConfig, ViewMode } from "../config/config-schema";
import type { MaybeNode } from "../lib/node-like";
import { iconZoomLevel, iconZoomLevelCount, iconZoomPatchAt, showIconSlider } from "./icon-slider-model";

export const ICON_SLIDER_ID = "tfm-icon-slider";
// 14 cells: enough track for the thumb to travel. flexShrink 0 keeps it from
// ever collapsing under long status text — the label takes the hit instead.
const SLIDER_WIDTH = 14;
// live-preview cadence mirrors ui-progress's inline 120ms paint gate
const PREVIEW_MS = 100;
// quiet period after the last change that marks the end of a gesture
const COMMIT_MS = 150;

export type IconSliderCtx = {
  renderer: CliRenderer;
  byId(id: string): MaybeNode;
  colors(): Theme;
  ui(): UiConfig;
  viewMode(): ViewMode;
  imageProtocol(): unknown;
  // apply a grid-zoom patch through the config path (getRetheme().applyConfig)
  applyPatch(patch: Partial<UiConfig>): void;
  // persist once at gesture end (getRetheme().scheduleSaveConfig)
  commit(): void;
};

export const makeIconSlider = (ctx: IconSliderCtx) => {
  const levels = iconZoomLevelCount();

  // preview throttle + one commit per gesture. onChange fires per frame during
  // a drag; writing config per frame would renderAll per frame, so the preview
  // is throttled and the save waits for a quiet period.
  let pendingLevel = -1;
  let lastPreview = 0;
  let commitTimer: ReturnType<typeof setTimeout> | null = null;
  // true while refresh() writes the value: a programmatic set also fires
  // onChange, which must never schedule a commit
  let syncing = false;

  const applyLevel = (level: number): void => {
    if (level !== iconZoomLevel(ctx.ui())) ctx.applyPatch(iconZoomPatchAt(ctx.ui(), level));
  };

  const commit = (): void => {
    commitTimer = null;
    if (pendingLevel < 0) return;
    applyLevel(pendingLevel); // land the last frame if the throttle skipped it
    pendingLevel = -1;
    ctx.commit();
  };

  const onDrag = (value: number): void => {
    if (syncing) return;
    const level = Math.max(0, Math.min(levels - 1, Math.round(value)));
    pendingLevel = level;
    const now = Date.now();
    if (now - lastPreview >= PREVIEW_MS) {
      lastPreview = now;
      applyLevel(level);
    }
    if (commitTimer) clearTimeout(commitTimer);
    commitTimer = setTimeout(commit, COMMIT_MS);
  };

  const slider = new SliderRenderable(ctx.renderer, {
    id: ICON_SLIDER_ID,
    orientation: "horizontal",
    width: SLIDER_WIDTH,
    height: 1,
    flexShrink: 0,
    min: 0,
    max: levels - 1,
    value: iconZoomLevel(ctx.ui()),
    // track muted (the accessor the status text uses), thumb accent
    backgroundColor: ctx.colors().sidebarFgMuted,
    foregroundColor: ctx.colors().accent,
    onChange: onDrag,
  });
  ctx.byId("tfm-status")?.add(slider);

  // shortcut: release is detected as a quiet period after the last change, not
  // a mouse-up event — mouse-resize owns renderer.root's onMouseUp /
  // onMouseDragEnd (chaining would be order-fragile) and SliderRenderable keeps
  // its own onMouseUp private. A pause mid-drag may commit early; the value is
  // identical, so it is harmless.
  const refresh = (): void => {
    const colors = ctx.colors();
    try {
      slider.backgroundColor = colors.sidebarFgMuted;
      slider.foregroundColor = colors.accent;
    } catch {}
    const visible = showIconSlider({
      enabled: ctx.ui().iconSizeSlider,
      viewMode: ctx.viewMode(),
      imageProtocol: ctx.imageProtocol(),
    });
    try {
      slider.visible = visible;
      // never fight an in-flight drag: while a gesture is pending the thumb is
      // the user's, not the config's
      if (visible && pendingLevel < 0) {
        syncing = true;
        slider.value = iconZoomLevel(ctx.ui());
        syncing = false;
      }
    } catch {}
  };

  refresh();
  return { refresh, node: slider };
};
