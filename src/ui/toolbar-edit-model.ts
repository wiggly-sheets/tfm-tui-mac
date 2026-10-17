// --- Pure toolbar edit ops (ui-toolbar-editor.ts): add / move / remove /
// toggle over an ordered, duplicate-free toolbar id list. No renderer, no
// tree — the editor only owns the DOM. Every op returns a fresh list and
// never mutates its input. ---

import type { ToolbarItemId } from "../app/toolbar-items";

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, Math.trunc(v)));

// insert id at `index`, clamped to 0..length. A duplicate is a no-op (the
// editor adds by dropping a palette chip, and re-adding a present id must not
// reorder it). `index` is the insertion boundary in the CURRENT list.
export const addItem = (list: readonly ToolbarItemId[], id: ToolbarItemId, index: number): ToolbarItemId[] => {
  if (list.includes(id)) return [...list];
  const at = clamp(index, 0, list.length);
  return [...list.slice(0, at), id, ...list.slice(at)];
};

// move the item at `from` to the insertion boundary `to` in the ORIGINAL list.
// Removing first shifts every boundary above `from` down one, so an insert
// after the source subtracts one (the drop-index off-by-one).
export const moveItem = (list: readonly ToolbarItemId[], from: number, to: number): ToolbarItemId[] => {
  if (from < 0 || from >= list.length) return [...list];
  const item = list[from] as ToolbarItemId;
  const without = list.filter((_, i) => i !== from);
  const at = clamp(to > from ? to - 1 : to, 0, without.length);
  return [...without.slice(0, at), item, ...without.slice(at)];
};

export const removeItem = (list: readonly ToolbarItemId[], id: ToolbarItemId): ToolbarItemId[] =>
  list.filter((x) => x !== id);

// palette chip: present removes, absent appends. Kept here so the palette has
// one op either way.
export const toggleItem = (list: readonly ToolbarItemId[], id: ToolbarItemId): ToolbarItemId[] =>
  list.includes(id) ? removeItem(list, id) : addItem(list, id, list.length);
