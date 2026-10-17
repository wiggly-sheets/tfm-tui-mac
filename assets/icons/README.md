# Icons

The SVG glyphs in this directory are [Material Design Icons](https://materialdesignicons.com)
(MDI), licensed under the Apache License 2.0. The files are normalized to a
24×24 `viewBox` with no hardcoded colour: the rasterizer
(`src/ui/icons.ts`, `rasterizeSvg`) replaces `#`-hex fills or injects a `fill`
on the root `<svg>`, so every glyph takes the theme's foreground colour.

The upstream source is the [Templarian/MaterialDesign](https://github.com/Templarian/MaterialDesign)
repository (`svg/<name>.svg`).

Two files are renamed from their upstream name because upstream has no
exact match:

- `view-columns.svg` is upstream `view-column.svg`.
- `view-dashboard-vertical.svg` is upstream `view-dashboard-variant.svg`
  (the closest three-pane layout mark).
