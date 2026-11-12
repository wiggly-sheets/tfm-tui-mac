// --- Directory listing + sort: pure fs/dir-entry logic. No renderer, no UI
// state — sort mode arrives as params so callers (grid, tests) own state.
// Virtual places (Recent/Starred) resolve through the registries in ./recent. ---
import { lstat, mkdir, readdir, stat } from "node:fs/promises";
import { lstatSync, statSync } from "node:fs";
import path from "node:path";
import { RECENT_URI, STARRED_URI } from "./uri";
import { readRecentXbelAsync, readStarredList, recentListingGen } from "./recent";
import { isTrashFilesDir, isTrashMetaItem, pruneTrashMeta } from "./fsutil";
import type { SortMode } from "../lib/sort";
import { extOf } from "./filetype";

export type Entry = {
  name: string;
  isDir: boolean;
  size?: number;
  mtimeMs?: number;
  abs?: string;
  // set at scan time (free from the dirent; probed for virtual/search rows):
  // drives the list-row link badge. Not part of the structural sig — a
  // retargeted link keeps its name, same documented staleness as isDir.
  isLink?: boolean;
};

// One collator for the whole process (JSC/Bun rebuilds collation data on every
// String#localeCompare call, turning an n log n sort into a slow-mode flood —
// Nautilus caches collation keys per file for the same reason). Default
// options == localeCompare(undefined) semantics: pure speed, same order.
const NAME_COLLATOR = new Intl.Collator();
const cmpName = (a: string, b: string): number => NAME_COLLATOR.compare(a, b);

export const compareEntries = (sortBy: SortMode, sortAsc: boolean) => {
  // memoized so a "type" sort pays one extOf per NAME, not one per comparison
  const exts = new Map<string, string>();
  const extCached = (n: string): string => {
    let e = exts.get(n);
    if (e === undefined) {
      e = extOf(n);
      exts.set(n, e);
    }
    return e;
  };
  const cmp = (x: Entry, y: Entry): number => {
    switch (sortBy) {
      case "size":
        return (x.size ?? 0) - (y.size ?? 0);
      case "mtime":
        return (x.mtimeMs ?? 0) - (y.mtimeMs ?? 0);
      case "type":
        return cmpName(extCached(x.name), extCached(y.name)) || cmpName(x.name, y.name);
      default:
        return cmpName(x.name, y.name);
    }
  };
  return (a: Entry, b: Entry): number =>
    // dirs sort first, always — like nautilus
    Number(b.isDir) - Number(a.isDir) || (sortAsc ? cmp(a, b) : -cmp(a, b));
};

// shared stat-and-build for the virtual places: vanished files are dropped,
// an explicit mtime (XBEL Modified) wins over the fs mtime
const statEntries = (items: Array<{ path: string; mtimeMs?: number }>): Entry[] => {
  const out: Entry[] = [];
  for (const it of items) {
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(it.path);
    } catch {
      continue;
    }
    // size/mtime are the link's own (on-disk cost); routing still follows it.
    // A second lstat (not the dirent — virtual rows have none) also settles
    // isLink, so one probe serves both.
    let link: ReturnType<typeof lstatSync> | null = null;
    try {
      link = lstatSync(it.path);
    } catch {}
    out.push({
      name: path.basename(it.path),
      isDir: st.isDirectory(),
      abs: it.path,
      size: link?.size ?? st.size,
      mtimeMs: it.mtimeMs ?? link?.mtimeMs ?? st.mtimeMs ?? 0,
      isLink: link?.isSymbolicLink() ?? false,
    });
  }
  return out;
};

const recentEntries = async (): Promise<Entry[]> =>
  statEntries((await readRecentXbelAsync()).map((it) => ({ path: it.path, mtimeMs: it.modified })));

const starredEntries = async (): Promise<Entry[]> => statEntries(readStarredList().map((p) => ({ path: p })));

// --- [ui] listings-cache: reuse a folder's raw entry list across repaints
// (yazi's folder cache + dir-signature revalidate). Every renderAll used to
// pay a full readdir (+ a stat per row for the list view / size/mtime sorts);
// back/forward, tab switches and selection changes re-asked the disk for
// identical data. The dir's own stat is the validity key: create/delete/rename
// ALWAYS bump its mtime, so the set of names can't go stale. Content edits
// don't touch it, and with [ui] listings-cache-stats (default on) the
// size/mtime fill rides along IN the cached entries for EVERY sort — the list
// view shows both columns whatever the sort is, so sorting no longer decides
// whether a stat is cached. Sorts stop re-statting every file on every
// repaint, so displayed stats (and everything keyed off them, e.g. thumbnail
// cache keys) can lag a live edit by up to the TTL window. With stats caching
// off the fill re-stats per call instead, and nothing ever goes stale — so no
// watcher per-file patching is ever needed (unlike yazi). The TTL
// ([ui] listings-cache-ttl) caps the worst case for stale stats AND for
// exotic filesystems whose dir mtimes freeze (some fuse/exFAT mounts, yazi's
// "soundless" partitions) — it is the only thing that must re-validate on a
// slow clock. One known hole: a symlink's isDir FOLLOWS ITS TARGET, and
// retargeting a link (dir↔file) bumps no directory mtime, so routing can lie
// until the TTL.
type CachedDir = {
  sig: string;
  entries: Entry[];
  t: number;
  // the (sortBy, sortAsc) order `entries` is currently in. An unchanged
  // repaint reuses it instead of re-running the n log n comparator (the
  // collator compares are the expensive half of a big folder's repaint).
  // Invalidated whenever the stat fill lands new size/mtime values, because
  // those can move a size/mtime sort.
  order?: { by: SortMode; asc: boolean };
};
const LISTINGS_CAP = 64;
const LISTINGS_TTL_MS = 2000;
const listings = new Map<string, CachedDir>();

// Drop the reusable listing cache so the next listDir re-reads from disk (one
// dir, or all when omitted). Without this the TTL serves a stale scan.
export const clearListingsCache = (dir?: string): void => {
  if (dir === undefined) listings.clear();
  else listings.delete(path.resolve(dir));
};

const scanDir = async (dir: string): Promise<Entry[]> => {
  const dirents = await readdir(dir, { withFileTypes: true });
  const out: Entry[] = [];
  for (const d of dirents) {
    let isDir = d.isDirectory();
    // a symlink is a folder only if its target is one — never follow it further
    if (d.isSymbolicLink()) {
      try {
        isDir = (await stat(path.join(dir, d.name))).isDirectory();
      } catch {
        isDir = false;
      }
    }
    out.push({ name: d.name, isDir, isLink: d.isSymbolicLink() });
  }
  return out;
};

// Stats written INTO entries, asynchronously and with bounded concurrency.
// ONE stat fills size AND mtimeMs, so switching sorts later finds them present;
// failed stats stay missing and are retried next call — never fake a zero.
//
// Used by BOTH the GRID's list view and the listings cache's stat fill. It must
// stay async: the old synchronous statSync loop it replaced froze the whole app
// (this render, the frame loop, the toast spinner) for tens to hundreds of ms on
// a big folder — exactly the console, where tty mode FORCES list view. The
// cache path used to call a sync `fillInto` and re-introduced that freeze, so it
// now routes here too. The loop yields between batches so input stays alive.
export const fillStatsInto = async (
  entries: Entry[],
  dir: string,
  deps?: { stat?: (p: string) => Promise<{ size: number; mtimeMs: number }>; concurrency?: number },
): Promise<number> => {
  // default follows NOTHING (lstat): the Size/mtime columns show link-own
  // bytes (on-disk cost, ls -l semantics) — a following default is how the
  // link row ended up repeating its target's size. Injected fakes keep working.
  const statFn = deps?.stat ?? ((p: string) => lstat(p));
  const workers = Math.max(1, Math.min(deps?.concurrency ?? 32, entries.length));
  let filled = 0;
  let i = 0;
  const worker = async (): Promise<void> => {
    while (i < entries.length) {
      const e = entries[i++];
      // already complete (a size/mtime sort filled it, or a retry landed)
      if (!e || (e.size !== undefined && e.mtimeMs !== undefined)) continue;
      try {
        const st = await statFn(e.abs ?? path.join(dir, e.name));
        e.size = st.size;
        e.mtimeMs = st.mtimeMs ?? 0;
        filled++;
      } catch {}
    }
  };
  await Promise.all(Array.from({ length: workers }, worker));
  // count of rows that got a stat: callers invalidate derived state (the
  // cached sort order) only when something actually moved
  return filled;
};

// raw scan (hidden INCLUDED — listDir filters per call so the showHidden
// toggle never re-reads the disk). Entries are returned as a fresh array of
// copies: the caller's sort must never mutate the cache.
const loadEntries = async (
  dir: string,
  o: {
    cache: boolean;
    now: () => number;
    ttlMs: number;
    // listings-cache-stats: fill EVERY row's size/mtime on a miss/hit (not just
    // for size/mtime sorts). The list view shows both columns whatever the
    // active sort is, and it used to re-lstat the whole folder on every paint
    // because the copies it got never wrote back into the cache.
    fillStats: boolean;
    sortBy: SortMode;
    sortAsc: boolean;
  },
): Promise<Entry[]> => {
  // a trash directory removed mid-session (Finder emptied it, the user deleted
  // it) must behave as an empty trash, not "can't open this folder"
  if (isTrashFilesDir(dir)) {
    try {
      await mkdir(dir, { recursive: true });
    } catch {}
  }
  // name/type orders don't depend on stats, so the cache owns them even with
  // stats caching off. size/mtime need the fill first: with fillStats off,
  // listDir fills its own copies and sorts after, so the cache order (and the
  // marker below) must not claim those modes.
  const ownsSort = o.fillStats || o.sortBy === "name" || o.sortBy === "type";
  const cmp = compareEntries(o.sortBy, o.sortAsc);
  const orderNow = (list: Entry[], cached: CachedDir | null): void => {
    if (cached?.order?.by === o.sortBy && cached.order.asc === o.sortAsc) return;
    list.sort(cmp);
    if (cached) cached.order = { by: o.sortBy, asc: o.sortAsc };
  };
  if (!o.cache) {
    const fresh = await scanDir(dir);
    if (o.fillStats) await fillStatsInto(fresh, dir);
    if (ownsSort) fresh.sort(cmp);
    return fresh.map((e) => ({ ...e }));
  }
  const key = path.resolve(dir);
  // mtime ONLY: a dir's st_size is block-granular and lies on most filesystems
  // async dir stat: on a FUSE/SMB cwd a sync stat here blocks the frame loop
  // before the cache check can even short-circuit
  const sig = String((await stat(dir)).mtimeMs);
  const hit = listings.get(key);
  if (hit && hit.sig === sig && o.now() - hit.t < o.ttlMs) {
    // re-insert so the LRU evicts the least-recently-USED dir; `t` is
    // deliberately NOT refreshed (absolute staleness cap, not idle expiry)
    listings.delete(key);
    listings.set(key, hit);
    if (o.fillStats) {
      // rows that failed last time are retried; complete rows are skipped
      // without an fs call, so a settled listing pays only the O(n) scan
      const filled = await fillStatsInto(hit.entries, dir);
      // new size/mtime values can reorder a size/mtime sort
      if (filled > 0) hit.order = undefined;
    }
    if (ownsSort) orderNow(hit.entries, hit);
    return hit.entries.map((e) => ({ ...e }));
  }
  const entries = await scanDir(dir);
  if (o.fillStats) await fillStatsInto(entries, dir);
  if (ownsSort) entries.sort(cmp);
  listings.delete(key);
  listings.set(key, { sig, entries, t: o.now(), ...(ownsSort ? { order: { by: o.sortBy, asc: o.sortAsc } } : {}) });
  while (listings.size > LISTINGS_CAP) {
    // Map iteration survives deletes; the first key is the least-recently-used
    for (const k of listings.keys()) {
      listings.delete(k);
      break;
    }
  }
  return entries.map((e) => ({ ...e }));
};

// Recent/Starred are rebuilt through Spotlight + a stat per row; a renderAll
// (theme flip, pane focus, drawer settle) must not pay that each time. Keyed by
// URI + registry generation + TTL, so a star/open updates immediately.
const virtualListings = new Map<string, { at: number; gen: number; entries: Entry[] }>();

export const listDir = async (
  dir: string,
  showHidden: boolean,
  sortBy: SortMode,
  sortAsc: boolean,
  opts?: {
    cache?: boolean;
    cacheStats?: boolean;
    ttlMs?: number;
    now?: () => number;
    platform?: string;
    // the caller displays size/date columns (list view): fill stats even for
    // name/type sorts. Grid-only callers leave it off and stay stat-free.
    needStats?: boolean;
  },
): Promise<Entry[]> => {
  let out: Entry[];
  const cacheOn = opts?.cache ?? true;
  const now = opts?.now?.() ?? Date.now();
  const ttl = opts?.ttlMs ?? LISTINGS_TTL_MS;
  const virtual = dir === RECENT_URI || dir === STARRED_URI;
  if (virtual && cacheOn) {
    const hit = virtualListings.get(dir);
    if (hit && hit.gen === recentListingGen() && now - hit.at < ttl) return hit.entries.map((e) => ({ ...e }));
  }
  const rememberVirtual = (entries: Entry[]): Entry[] => {
    if (virtual && cacheOn) virtualListings.set(dir, { at: now, gen: recentListingGen(), entries });
    return entries.map((e) => ({ ...e }));
  };
  if (dir === RECENT_URI) {
    out = await recentEntries();
    // recency order wins over the global sort mode, like nautilus
    return rememberVirtual(out.sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0)));
  }
  // stats-cached reads only apply to real dirs (virtual places are rebuilt
  // per call anyway) and need the listing cache itself on
  const fillAtLoad =
    dir !== STARRED_URI &&
    (opts?.cache ?? true) &&
    (opts?.cacheStats ?? true) &&
    (opts?.needStats === true || sortBy === "size" || sortBy === "mtime");
  if (dir === STARRED_URI) {
    out = (await starredEntries()).sort(compareEntries(sortBy, sortAsc));
    return rememberVirtual(out);
  } else {
    const all = await loadEntries(dir, {
      cache: opts?.cache ?? true,
      now: opts?.now ?? Date.now,
      ttlMs: opts?.ttlMs ?? LISTINGS_TTL_MS,
      // stats caching is on for EVERY sort: a name-sorted listing still feeds
      // the list view's size/date columns and the thumbnail keys, and filling
      // only on size/mtime sorts made the list view re-lstat the folder on
      // every repaint (its copies never wrote back into the cache)
      fillStats: fillAtLoad,
      sortBy,
      sortAsc,
    });
    // the native-darwin trash root holds tfm's own .tfm-info sidecar dir next
    // to the entries: never an item, even with show-hidden on
    const platform = opts?.platform ?? process.platform;
    const trashMeta = isTrashFilesDir(dir, platform);
    // a Finder Put Back / manual deletion removes the landing but not our
    // origin sidecar; prune it here so a later same-name item cannot inherit
    // the old path (best-effort, never fails the listing)
    if (trashMeta) pruneTrashMeta(dir, platform);
    out = all.filter(
      (e) => (showHidden || !e.name.startsWith(".")) && !(trashMeta && isTrashMetaItem(e.name, platform)),
    );
  }
  if ((sortBy === "size" || sortBy === "mtime") && !fillAtLoad) {
    // async + bounded concurrency (was a sync statSync loop that froze the UI
    // on a 10k-folder with cacheStats off); fillStatsInto skips rows that
    // already carry size/mtimeMs (virtual places filled above). loadEntries
    // left the sort to this branch: the stats have to land first.
    await fillStatsInto(out, dir);
    out.sort(compareEntries(sortBy, sortAsc));
  }
  return out;
};
