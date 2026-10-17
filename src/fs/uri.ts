import os from "node:os";
import path from "node:path";
import { realpathSync } from "node:fs";

// --- Pure path/URI/XDG primitives shared by the sidebar places, recent/starred
// registries and the clipboard bridge. No state, no UI. ---

export const RECENT_URI = "recent://";
export const STARRED_URI = "starred://";
// an archive opened as a folder: "archive:///path/foo.zip?inner/sub" (see
// app/archive-nav for the model). Only the prefix is needed here, so a URI is
// recognized without pulling the archive engine into this leaf module.
export const ARCHIVE_URI = "archive://";

export const isArchiveUri = (p: string): boolean => p.startsWith(ARCHIVE_URI);

export const isVirtualUri = (p: string): boolean => p === RECENT_URI || p === STARRED_URI || isArchiveUri(p);

export const xdgDataHome = (): string => process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local/share");

export const xdgStateHome = (): string => process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local/state");

// XBEL timestamps are ISO-8601; Date.parse handles them
export const parseIso = (s: string): number => {
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : 0;
};

export const uriToPath = (uri: string): string | null => {
  if (!uri.startsWith("file://")) return null;
  try {
    return decodeURIComponent(uri.slice(7));
  } catch {
    return null;
  }
};

// lenient file:// -> path decode for external payloads (kitty/yazi drops,
// gnome-clipboard payloads): strips an optional authority part with the first
// slash and swallows malformed percent escapes instead of dropping the line.
//
// A remote drop can carry file:///../../../etc/shadow: decode alone yields
// /../../../etc/shadow and the caller copies it into cwd. So the result is
// resolved against `root` (default $HOME) and must stay inside it — a path
// that escapes via ../ or a symlink that points outside root is rejected.
// `root` is normalized so a trailing-slash or symlinked root still bounds the
// check; callers that already know their own root pass it explicitly.
export const fileUriToPath = (uri: string, root?: string): string | null => {
  let u = uri.slice(7);
  // file://host/path → /path (keep the slash: a host-strip that drops it turns
  // an absolute path into a cwd-relative one that ENOENTs or copies wrongly)
  if (!u.startsWith("/")) {
    const slash = u.indexOf("/");
    if (slash >= 0) u = u.slice(slash);
  }
  // swallow malformed escapes (return the raw slice) — a bad escape is not a
  // traversal, and dropping the line would lose a legitimately-decoded entry
  try {
    u = decodeURIComponent(u);
  } catch {}
  if (!u.startsWith("/")) return null;
  // A remote drop can carry file:///../../../etc/shadow: decode alone yields
  // /../../../etc/shadow and the caller copies it into cwd. Reject any `..`
  // segment — the escape vector — before resolving.
  if (u.split("/").some((seg) => seg === "..")) return null;
  const resolved = path.resolve(u);
  if (root) {
    // caller knows its own root: bound the result lexically AND against
    // symlinks that point outside it
    let base: string;
    try {
      base = path.resolve(root);
    } catch {
      return null;
    }
    const rel = path.relative(base, resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
    let real: string;
    try {
      real = realpathSync(resolved);
    } catch {
      // absent: nothing to escape through; the lexical check above bounds it
      return resolved;
    }
    const realRel = path.relative(base, real);
    if (realRel.startsWith("..") || path.isAbsolute(realRel)) return null;
  }
  return resolved;
};

// path -> file:// URI, percent-encoding every segment except the root slash.
// (Named xmlEscapeUri in the monolith days — it escapes for URIs, not XML.)
export const pathToUri = (p: string): string =>
  `file://${p
    .split("/")
    .map((seg, i) => (i === 0 ? seg : encodeURIComponent(seg)))
    .join("/")}`;
