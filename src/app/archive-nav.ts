// --- Archive browsing model: an archive opened as a folder. The pane's cwd IS
// the location ("archive:///path/foo.zip?inner/sub"), so the whole navigation
// stack — history, back/forward, tabs, the virtual-place guards — works
// unchanged. Pure: no fs, no renderer; the member list arrives from fs/archive
// and the renderer maps it to grid rows. ---

import path from "node:path";
import { detectArchiveFormat, type ArchiveEntryInfo } from "../fs/archive";
import { ARCHIVE_URI } from "../fs/uri";

export type ArchiveLocation = { archive: string; inner: string };

export const archiveUri = (archive: string, inner = ""): string =>
  // "?" is legal in a file name, so it is escaped in the container part: it is
  // the only byte that would misparse (the inner path follows it)
  `${ARCHIVE_URI}${archive.replace(/\?/g, "%3F")}${inner ? `?${inner}` : ""}`;

export const parseArchiveUri = (uri: string): ArchiveLocation | null => {
  if (!uri.startsWith(ARCHIVE_URI)) return null;
  const rest = uri.slice(ARCHIVE_URI.length);
  const q = rest.indexOf("?");
  const archive = (q < 0 ? rest : rest.slice(0, q)).replace(/%3F/g, "?");
  if (!detectArchiveFormat(archive)) return null;
  return { archive, inner: q < 0 ? "" : rest.slice(q + 1) };
};

// one row of the folder view: the member's own name plus its kind and size
export type ArchiveDirEntry = { name: string; isDir: boolean; size?: number };

// the flat member list becomes `inner dir -> children`. Intermediate dirs are
// synthesized when the container stores no entry for them (zip writers usually
// store none), so `a/b/c.txt` is reachable without an `a/` or `a/b/` member.
export const buildArchiveTree = (entries: readonly ArchiveEntryInfo[]): Map<string, ArchiveDirEntry[]> => {
  const dirs = new Map<string, Map<string, ArchiveDirEntry>>();
  const at = (dir: string): Map<string, ArchiveDirEntry> => {
    const hit = dirs.get(dir);
    if (hit) return hit;
    const made = new Map<string, ArchiveDirEntry>();
    dirs.set(dir, made);
    return made;
  };
  const ensure = (dir: string): void => {
    if (dir === "" || dirs.has(dir)) return;
    at(dir);
    const up = path.posix.dirname(dir);
    ensure(up === "." ? "" : up);
  };
  for (const e of entries) {
    if (!e.name) continue;
    const name = e.isDir ? e.name.replace(/\/+$/, "") : e.name;
    const parentRaw = path.posix.dirname(name);
    const parent = parentRaw === "." ? "" : parentRaw;
    ensure(parent);
    at(parent).set(name, { name: path.posix.basename(name), isDir: e.isDir, size: e.size });
    if (e.isDir) ensure(name);
  }
  // synthesized intermediate dirs: zip writers usually store none, so `a/b/c.txt`
  // is reachable without an `a/` or `a/b/` member. Every dir key (except the
  // root) is added to its parent's list as a dir entry when the container
  // holds no real entry for it — a real `sub/` member already occupies that
  // name and is left untouched.
  for (const dir of dirs.keys()) {
    if (!dir) continue;
    const parent = path.posix.dirname(dir) === "." ? "" : path.posix.dirname(dir);
    const kids = at(parent);
    if (!kids.has(dir)) kids.set(dir, { name: path.posix.basename(dir), isDir: true });
  }
  return new Map([...dirs].map(([dir, kids]) => [dir, [...kids.values()]]));
};

// children of `inner` ("" = the archive root). Hidden members are dropped
// unless asked for — the rule listDir applies to a real folder. Order is the
// container's; the caller sorts with the pane's own sort mode.
export const listArchiveDir = (
  tree: ReadonlyMap<string, ArchiveDirEntry[]>,
  inner: string,
  showHidden = false,
): ArchiveDirEntry[] => {
  const kids = tree.get(inner) ?? [];
  return showHidden ? [...kids] : kids.filter((e) => !e.name.startsWith("."));
};

// one level up INSIDE the archive; null at the root (the caller leaves it)
export const archiveInnerParent = (inner: string): string | null => {
  if (!inner) return null;
  const up = path.posix.dirname(inner);
  return up === "." ? "" : up;
};

// where backspace goes: the enclosing member, or the archive's own folder at
// the root. null = not an archive location (the caller keeps its own rule).
export const archiveParent = (uri: string): string | null => {
  const loc = parseArchiveUri(uri);
  if (!loc) return null;
  const up = archiveInnerParent(loc.inner);
  return up === null ? path.dirname(loc.archive) : archiveUri(loc.archive, up);
};

// the in-grid header line: container name plus inner path. Too long is cut from
// the LEFT — the deepest component is the one that says where you are.
export const archiveBreadcrumb = (uri: string, max = 80): string => {
  const loc = parseArchiveUri(uri);
  if (!loc) return uri;
  const full = loc.inner ? `${path.basename(loc.archive)}/${loc.inner}` : path.basename(loc.archive);
  return full.length <= max ? full : `…${full.slice(full.length - Math.max(1, max - 1))}`;
};
