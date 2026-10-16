import { chmod, cp, mkdir, rename as fsRename, rm, writeFile, open } from "node:fs/promises";
import { accessSync, constants, existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToUri } from "./uri";
import { swallow } from "../app/log";
import {
  copyXattrs,
  darwinTrashMove,
  darwinVolumeTrash,
  isDarwin,
  parseMountTable,
  type XattrDeps,
  type XattrRun,
} from "./darwin";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

// execFile captures stdout; a non-zero exit (missing/unwritable attribute) is
// reported as a code so copyXattrs skips it instead of throwing.
const execFileP = promisify(execFile);

// `xattr -p -x` returns the value as hex (twice the byte length), so Node's
// 1 MiB default maxBuffer would silently truncate resource forks over ~512 KiB.
// The write side (`-w -x <hex>`) is still bounded by ARG_MAX for enormous values.
export const XATTR_MAX_BUFFER = 64 * 1024 * 1024;

export const runXattr: XattrRun = async (bin, args) => {
  try {
    const { stdout } = await execFileP(bin, args, {
      timeout: 10_000,
      encoding: "utf8",
      maxBuffer: XATTR_MAX_BUFFER,
    });
    return { stdout: String(stdout), code: 0 };
  } catch (err) {
    const e = err as { code?: unknown; stdout?: unknown };
    return { stdout: typeof e.stdout === "string" ? e.stdout : "", code: typeof e.code === "number" ? e.code : 1 };
  }
};

// best-effort macOS xattr carry-over for a file — or, recursively, a whole tree —
// that already landed at dest (Linux no-op). The copy landing path runs this
// through the enqueueXattr lane so per-file progress never waits on it; the
// EXDEV move path (fsMove) awaits it directly. macOS `cp` carries the ROOT dir's
// xattrs only, so a directory walk copies each descendant's too (lstat: a symlink
// is never followed into). Never throws.
export const preserveXattrs = async (src: string, dest: string, deps: XattrDeps = { run: runXattr }): Promise<void> => {
  await copyXattrs(src, dest, deps);
  if (!isDarwin(deps.platform ?? process.platform)) return;
  let isDir: boolean;
  try {
    isDir = lstatSync(src).isDirectory();
  } catch {
    return;
  }
  if (!isDir) return;
  let kids: string[];
  try {
    kids = readdirSync(src);
  } catch {
    return;
  }
  for (const k of kids) await preserveXattrs(path.join(src, k), path.join(dest, k), deps);
};

// copy ONLY this node's own xattrs (no walk). The tree-copy lane enqueues each
// descendant itself, so using the recursive preserveXattrs at every directory
// level would redo every child's attributes; preserveXattrs stays for the EXDEV
// move path, which owns the whole tree in one awaited op. Never throws.
export const preserveXattrsShallow = (src: string, dest: string, deps: XattrDeps = { run: runXattr }): Promise<void> =>
  copyXattrs(src, dest, deps);

// Serialized single-lane queue for best-effort xattr work: the tree-copy path
// (transfer) enqueues one op per landed file so copy progress is NOT blocked by
// an /usr/bin/xattr spawn, and the lane runs them one at a time. fsMove's EXDEV
// path awaits preserveXattrs directly instead. copyXattrs never rejects, and
// rejects are swallowed anyway so one failure can't wedge the lane.
// XATTR_QUEUE_MAX bounds the backlog (one chain link + closure per landed file):
// past the cap, enqueueXattr drops the work on purpose — a dropped xattr is
// cosmetic macOS metadata, an unbounded chain is a leak.
export const XATTR_QUEUE_MAX = 4096;

let xattrLane: Promise<void> = Promise.resolve();
let xattrQueued = 0;

export const enqueueXattr = (op: () => Promise<void>): void => {
  if (xattrQueued >= XATTR_QUEUE_MAX) return;
  xattrQueued++;
  xattrLane = xattrLane
    .then(op)
    .catch(() => {})
    .finally(() => {
      xattrQueued--;
    });
};

// drain the queue (tests; shutdown) — resolves once every enqueued op settled
export const awaitXattrQueue = (): Promise<void> => xattrLane;

// --- Deterministic fs+path operations: the primitives runTransfer, trash and
// undo sit on. No prompts, no UI, no state — callers own decisions; these own
// correctness (never overwrite silently, EXDEV fallback, XDG trash spec). ---

// Trash root (spec: $XDG_DATA_HOME/Trash, default ~/.local/share/Trash —
// which is where the monolith hardcoded it). Darwin: ~/.Trash (the Finder's
// own root, so emptied/listed entries match what Finder shows). The XDG
// override is honored on both (test sandboxes redirect through it).
// Resolved per call, not at import, so env redirection works.
export const trashDir = (): string => {
  if (process.env.XDG_DATA_HOME) return path.join(process.env.XDG_DATA_HOME, "Trash");
  if (isDarwin()) return path.join(os.homedir(), ".Trash");
  return path.join(os.homedir(), ".local/share", "Trash");
};

// trash FILES dir: the xdg files/ subdir on Linux, the root itself on darwin
// (native trash lands entries at the root — a files/ subdir would hide them
// from Finder and from the empty/count/listing passes below)
export const trashFilesDir = (platform: string = process.platform): string =>
  isDarwin(platform) ? trashDir() : path.join(trashDir(), "files");

// is a cwd the trash FILES dir? (virtual URIs like recent:// resolve to junk
// paths, never the trash root, so no guard needed at the call site)
export const isTrashFilesDir = (p: string, platform: string = process.platform): boolean => {
  const homeFiles = trashFilesDir(platform);
  try {
    if (path.resolve(p) === homeFiles) return true;
  } catch {}
  // topdir trashes (removable media) also count — check the target's own root
  try {
    const roots = trashRootsFor(p, platform);
    return roots.some((r) => path.resolve(p) === trashFilesSubdir(r, platform));
  } catch {
    return false;
  }
};

// is a path the trash FILES dir or anything under it? Files landing there
// without .trashinfo are unrestorable, so paste/move targets must check the
// SUBTREE (unlike isTrashFilesDir, which matches the dir itself exactly).
export const isInTrashFiles = (p: string, platform: string = process.platform): boolean => {
  try {
    const target = path.resolve(p);
    const roots = [trashFilesDir(platform), ...trashRootsFor(p, platform).map((r) => trashFilesSubdir(r, platform))];
    return roots.some((root) => target === path.resolve(root) || target.startsWith(path.resolve(root) + path.sep));
  } catch {
    return false;
  }
};

// is `inner` the same path as `outer` or anywhere inside it? Ancestor
// relationship for self-drop guards (copying a folder into itself/its own
// subtree recurses unboundedly) — shared by runTransfer and moveInto.
export const isWithinOrEqual = (inner: string, outer: string): boolean => {
  try {
    const i = path.resolve(inner);
    const o = path.resolve(outer);
    return i === o || i.startsWith(o + path.sep);
  } catch {
    return false;
  }
};

// files dir under a trash ROOT (per-mount or home): files/ subdir on Linux,
// the root itself on darwin (native trash lands entries at the root)
export const trashFilesSubdir = (root: string, platform: string = process.platform): string =>
  isDarwin(platform) ? root : path.join(root, "files");

// best-effort count of home-trash entries for the empty-trash confirm
// prompt. -1 when the trash is unreadable (prompt omits the count then).
// Async on darwin because the mount probe must never block the TUI (a hung
// network mount could freeze the event loop for up to 10 seconds with execSync).
export const countTrashItems = async (
  mountsText?: string,
  platform: string = process.platform,
): Promise<number> => {
  let home: string[];
  try {
    home = readdirSync(trashFilesDir(platform));
  } catch {
    return -1;
  }
  let n = home.length;
  // per-mount trashes hold real entries too — the confirm count must not
  // under-report them ($topdir/.Trash-$uid on Linux, /Volumes/.Trashes on mac)
  for (const dir of await allTrashFilesDirs(mountsText, platform)) {
    try {
      if (path.resolve(dir) === path.resolve(trashFilesDir(platform))) continue;
    } catch {
      continue;
    }
    try {
      n += readdirSync(dir).length;
    } catch {
      // yanked device mid-count — home count still stands
    }
  }
  return n;
};

// every trash FILES dir currently mounted: home first, then one per mount
// (<mountpoint>/.Trash-<uid>/files per /proc/mounts entry on Linux;
// /Volumes/<vol>/.Trashes/<uid> per `mount` on darwin). Unreadable or
// missing dirs are still listed (callers readdir best-effort) — only the
// parse itself must never throw. mountsText is an injectable seam (tests pass
// a fake table; production reads /proc/mounts or runs `mount`).
//
// Async on darwin: `mount` is spawned with a bounded timeout so a hung
// network mount cannot freeze the TUI. On Linux, /proc/mounts is read
// synchronously (no spawn needed).
export const allTrashFilesDirs = async (
  mountsText?: string,
  platform: string = process.platform,
): Promise<string[]> => {
  const home = trashFilesDir(platform);
  const out = [home];
  const seen = new Set<string>();
  try {
    seen.add(path.resolve(home));
  } catch {}
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  if (isDarwin(platform)) {
    let text = mountsText;
    if (text === undefined) {
      // shortcut: 2 s timeout on the mount probe — enough for normal mounts,
      // short enough that a hung network share never freezes the TUI; upgrade
      // to a per-mount stat-based probe if per-volume trash counts ever need
      // to be enumerated without a blocking `mount` call
      const MOUNT_TIMEOUT_MS = 2_000;
      try {
        const proc = Bun.spawn(["mount"], {
          stdout: "pipe",
          stderr: "ignore",
          stdin: "ignore",
          timeout: MOUNT_TIMEOUT_MS,
        });
        text = await new Response(proc.stdout).text();
        await proc.exited;
      } catch {
        return out;
      }
    }
    for (const m of parseMountTable(text ?? "")) {
      // user volumes only — system/private mounts never hold user trash
      if (m.target !== "/Volumes" && !m.target.startsWith("/Volumes/")) continue;
      const dir = darwinVolumeTrash(m.target, uid);
      try {
        const r = path.resolve(dir);
        if (!seen.has(r)) {
          seen.add(r);
          out.push(dir);
        }
      } catch {}
    }
    return out;
  }
  let text: string;
  if (mountsText !== undefined) {
    text = mountsText;
  } else {
    try {
      text = readFileSync("/proc/mounts", "utf8");
    } catch {
      return out;
    }
  }
  for (const line of text.split("\n")) {
    const mp = parseProcMountpoint(line);
    if (!mp) continue;
    try {
      const r = path.resolve(path.join(mp, `.Trash-${uid}`, "files"));
      if (!seen.has(r)) {
        seen.add(r);
        out.push(path.join(mp, `.Trash-${uid}`, "files"));
      }
    } catch {}
  }
  return out;
};

// network and automount filesystems never hold tfm trash (trashPaths refuses
// network paths outright) — probing them here would hang on a dead server or
// trigger an autofs mount for nothing. Deny by fstype, not by path.
const PROC_MOUNT_SKIP_FSTYPES = new Set([
  "nfs",
  "nfs4",
  "cifs",
  "smbfs",
  "smb3",
  "sshfs",
  "fuse.sshfs",
  "fuse.gvfsd-fuse",
  "autofs",
]);

// one /proc/mounts line → mountpoint, or null. Fields are
// `device mountpoint fstype opts …` with octal escapes in the first two
// (\040 space, \011 tab, \012 newline, \134 backslash).
const parseProcMountpoint = (line: string): string | null => {
  const parts = line.split(" ");
  if (parts.length < 3) return null;
  const mp = parts[1];
  const fstype = parts[2];
  if (!mp || !fstype || PROC_MOUNT_SKIP_FSTYPES.has(fstype)) return null;
  try {
    return mp.replace(/\\040/g, " ").replace(/\\011/g, "\t").replace(/\\012/g, "\n").replace(/\\134/g, "\\");
  } catch {
    return null;
  }
};

// progress-toast threshold shared by the transfer pre-scan (./fileops) and
// the toast widget (./ui-progress re-exports it): tiny transfers don't need
// a toast. One predicate so the two can't drift apart again.
export const shouldToast = (totalBytes: number, totalFiles: number): boolean =>
  totalBytes > 4 * 1024 * 1024 || totalFiles > 4;

// terse human text for the fs error codes users actually hit — "FAILED" alone
// gives them nothing to act on (retry vs chmod vs free disk space)
const FS_ERR_TEXT: Record<string, string> = {
  ENOENT: "source gone",
  EACCES: "permission denied",
  EPERM: "permission denied",
  ENOSPC: "disk full",
  EBUSY: "file busy",
  ETXTBSY: "file busy",
  EISDIR: "is a directory",
  ENOTDIR: "not a directory",
  ENAMETOOLONG: "name too long",
  EROFS: "read-only fs",
  EMFILE: "too many open files",
};

export const fsErrText = (err: unknown): string => {
  const code = errCode(err);
  if (typeof code === "string") return FS_ERR_TEXT[code] ?? code.toLowerCase();
  return err instanceof Error ? (err.message.split(":")[0]?.toLowerCase() ?? "unknown error") : "unknown error";
};

// shared FAILED clause for op summaries: "N FAILED (reason)" with the first
// collected reason. The seven trash/transfer/undo summaries compose it into
// their own sentences (separators stay per-site), so the FAILED phrasing
// can't drift apart again. Callers gate on failed > 0.
export const failSuffix = (failed: number, failWhy: Set<string>): string => {
  const why = [...failWhy][0];
  return `${failed} FAILED${why ? ` (${why})` : ""}`;
};

// sync readability probe behind the adaptive opens (default open + Open
// With… route unreadable files through the sudo gate instead of spawning a
// doomed unprivileged child). One syscall; callers, not this, decide.
export const canReadSync = (p: string): boolean => {
  try {
    accessSync(p, constants.R_OK);
    return true;
  } catch {
    return false;
  }
};

// errno-style .code off an unknown caught value (fs renames, child-proc
// failures) — structural narrowing instead of `any`
export const errCode = (err: unknown): unknown => {
  if (typeof err === "object" && err !== null && "code" in err) return err.code;
  return undefined;
};

// split "report.pdf" -> {stem "report", ext ".pdf"}; extensionless names and
// dotfiles ("Makefile", ".x") keep the whole name as stem. Shared by
// uniqueTarget (" (copy)" dialect) and inline-create (" 2" dialect).
export const splitStemExt = (base: string): { stem: string; ext: string } => {
  const dot = base.lastIndexOf(".");
  return dot > 0 ? { stem: base.slice(0, dot), ext: base.slice(dot) } : { stem: base, ext: "" };
};

// nautilus naming for an OCCUPIED name: first suggestion is " (copy)", then
// " (copy 2)", … Callers must only invoke this when `dir/base` already exists
// (runTransfer collisions, replace-stash) — the base name itself is never
// checked, and that's load-bearing for the replace flow's expectations.
export const uniqueTarget = (dir: string, base: string): string => {
  const { stem, ext } = splitStemExt(base);
  for (let i = 2; ; i++) {
    const cand = i === 2 ? path.join(dir, `${stem} (copy)${ext}`) : path.join(dir, `${stem} (copy ${i - 1})${ext}`);
    if (!existsSync(cand)) return cand;
  }
};

export const fsMove = async (src: string, dest: string): Promise<void> => {
  try {
    await fsRename(src, dest);
  } catch (err: unknown) {
    if (errCode(err) !== "EXDEV") throw err;
    // cross-device: copy+delete (no atomic rename across filesystems).
    // Via an EXCLUSIVELY-claimed sibling tmp (same .tfm-part-* shape the
    // transfer engine sweeps) so a crash can't leave a half-written dest and
    // a concurrent op can't share our tmp: only a complete tmp is renamed
    // into place. The caller (runTransfer) routes big moves through the
    // durable tmp+rename engine with progress + half-copy cleanup — this
    // fallback is for single renames that unexpectedly hit EXDEV (bind
    // mounts). Remove source only after the copy succeeded.
    const srcStat = lstatSync(src);
    const tmp = await claimTmp(dest, srcStat.isDirectory());
    try {
      await cp(src, tmp, { recursive: true, preserveTimestamps: true });
      // cp merges into the claimed dir instead of creating it, so the root
      // keeps mkdir-default mode — restore the source's explicitly
      if (srcStat.isDirectory()) {
        try {
          // eslint-disable-next-line no-bitwise
          await chmod(tmp, srcStat.mode & 0o7777);
        } catch {}
      }
      await fsRename(tmp, dest);
      // Finder metadata lives in xattrs that cp drops — best-effort, never fatal
      await preserveXattrs(src, dest);
    } catch (copyErr) {
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
      throw copyErr;
    }
    try {
      await rm(src, { recursive: true });
    } catch (err) {
      // partial source deletion; the complete copy in dest is the only intact
      // data now — keep it and say what actually happened instead of a bare errno
      throw new Error(`source partially removed: ${fsErrText(err)}`);
    }
  }
};

// undo/restore moves must never clobber whatever now occupies the target —
// rename() silently overwrites on Linux, so a file created between the original
// op and ctrl+z would be destroyed. Bump to "name (copy)" instead. Returns
// the final destination (== dest unless it was occupied).
export const safeRestoreMove = async (src: string, dest: string): Promise<string> => {
  let d = dest;
  if (existsSync(d)) d = uniqueTarget(path.dirname(d), path.basename(d));
  await mkdir(path.dirname(d), { recursive: true });
  await fsMove(src, d);
  return d;
};

// best-effort removal of one trashinfo sidecar (undo/restore cleanup). Never
// throws — a stale .trashinfo is cosmetic, failing the whole undo over it is not.
export const rmTrashInfo = async (name: string, log?: (msg: string) => void): Promise<void> => {
  try {
    await rm(path.join(trashDir(), "info", `${name}.trashinfo`));
  } catch (err) {
    log?.(`trashinfo cleanup ${name}: ${fsErrText(err)}`);
  }
};

// sibling info path for per-mount trashes ($topdir/.Trash-$uid): a trash
// location already encodes its root (<root>/files/<name>), so its sidecar is
// <root>/info/<name>.trashinfo. Null unless the path is absolute and inside a
// files dir (relative paths fall back to home lookup).
export const trashInfoPathForTrashFile = (trashFilePath: string): string | null => {
  try {
    if (!path.isAbsolute(trashFilePath)) return null;
    const abs = path.resolve(trashFilePath);
    if (path.basename(path.dirname(abs)) !== "files") return null;
    return path.join(path.dirname(path.dirname(abs)), "info", `${path.basename(abs)}.trashinfo`);
  } catch {
    return null;
  }
};

// sibling-aware cleanup for per-mount trashes ($topdir/.Trash-$uid): the
// trash location already encodes its root (<root>/files/<name>), so delete
// <root>/info/<name>.trashinfo instead of assuming home trash. Falls back to
// home lookup ONLY when the path isn't inside a files dir (relative callers).
// A missing sibling sidecar is NOT a home lookup: a home entry with the same
// basename belongs to a different file, and deleting its .trashinfo would
// orphan it (restore reads Path= from that sidecar).
export const rmTrashInfoForPath = async (trashFilePath: string, log?: (msg: string) => void): Promise<void> => {
  const sibling = trashInfoPathForTrashFile(trashFilePath);
  if (sibling) {
    try {
      await rm(sibling);
    } catch (err) {
      if (errCode(err) !== "ENOENT") log?.(`trashinfo cleanup ${path.basename(trashFilePath)}: ${fsErrText(err)}`);
    }
    return;
  }
  await rmTrashInfo(path.basename(trashFilePath), log);
};

// --- XDG trash spec helpers ---

// Percent-encode an absolute path per the trash spec (Path= must be
// URL-encoded). Uses the shared path->URI encoder minus the scheme, so `/`
// separators survive and spaces, `%`, `#`, non-ASCII round-trip through
// decodeURIComponent on read.
export const encodeTrashPath = (p: string): string => pathToUri(path.resolve(p)).slice(7);

// Candidate trash roots for a target: home trash always, plus the topdir
// trash ($topdir/.Trash-$uid on Linux, $topdir/.Trashes/$uid on darwin) when
// the target lives on another filesystem (removable media — spec §2).
// Resolved per call for env-redirection tests. Device comparison rides
// lstatSync().dev — the same stat `stat -f %d` reports, without a spawn.
const trashRootsFor = (target: string, platform: string = process.platform): string[] => {
  const home = trashDir();
  // unreadable home-parent (the XDG data dir may not exist yet) = home trash
  // only — the old homedir fallback was unreachable (inside one try, the
  // first lstat's throw jumped straight to catch), so deviceOf must not make
  // it live: that walks /tmp targets to /tmp/.Trash-$uid and lands the file
  // OUTSIDE trashDir() (the trashops test pins the old behavior).
  const targetDev = deviceOf(target) ?? deviceOf(path.dirname(path.resolve(target)));
  const homeDev = deviceOf(path.dirname(home));
  if (targetDev === null || homeDev === null || targetDev === homeDev) return [home];
  // different filesystem — walk up to the mount point (dev changes there)
  let cur = path.resolve(target);
  let top = cur;
  while (true) {
    const parent = path.dirname(cur);
    if (parent === cur) {
      top = cur;
      break;
    }
    const curDev = deviceOf(cur);
    if (curDev === null) {
      cur = parent;
      continue;
    }
    const parentDev = deviceOf(parent);
    if (parentDev === null) {
      top = cur;
      break;
    }
    if (curDev !== parentDev) {
      top = cur;
      break;
    }
    cur = parent;
    top = cur;
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  // darwin per-volume root; Linux topdir root (spec §2)
  return isDarwin(platform) ? [darwinVolumeTrash(top, uid), home] : [path.join(top, `.Trash-${uid}`), home];
};

// XDG trash: `gio trash` fails on tmpfs ("system internal mounts"), so we
// write the .trashinfo ourselves and move into Trash/files. Returns the final
// path (name may be suffixed .2, .3 … on collisions).
//
// Ordering + atomicity: the destination NAME is claimed first with an
// O_EXCL (`wx`) .trashinfo placeholder — portable APIs expose no atomic
// no-clobber rename for dirs, but the `wx` create is atomic, so two
// concurrent trashers can never claim the same name (loser bumps to .2).
// Then the file moves, then the placeholder is overwritten with the real
// Path=/DeletionDate=. If the move fails the placeholder is removed (no
// orphan entry); if the final info write fails the move rolls back.
// Trash `p`, returning the final path. Linux: XDG move (`gio trash` fails on
// tmpfs, so the .trashinfo is written by hand). Darwin: native lane
// (/usr/bin/trash → JXA → Finder delete) so Finder stays the bookkeeper —
// entries land at the trash root with no .trashinfo, and Trash-view restore
// of such entries honestly reports "no trashinfo" like Finder-trashed files.
export const xdgTrashMove = async (p: string, platform: string = process.platform): Promise<string> => {
  const absSrc = path.resolve(p);
  if (isDarwin(platform)) return darwinTrashRun(absSrc);
  const roots = trashRootsFor(absSrc, platform);
  let lastErr: unknown = null;
  for (const root of roots) {
    try {
      return await xdgTrashMoveToRoot(absSrc, root);
    } catch (err) {
      lastErr = err;
      // topdir may be read-only/unwritable — fall through to home trash
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
};

// darwin native-trash runner: one spawn, exit code only (trash output is
// human chatter, never parsed). ENOENT (lane binary missing) degrades to a
// nonzero code so the next lane is tried, never an unhandled rejection.
const darwinTrashSpawn = async (bin: string, args: string[]): Promise<{ code: number }> => {
  try {
    const proc = Bun.spawn([bin, ...args], { stdout: "ignore", stderr: "ignore", stdin: "ignore", timeout: 30_000 });
    return { code: await proc.exited };
  } catch {
    return { code: 127 };
  }
};

// darwin lane behind xdgTrashMove: native move across the candidate roots
// (home + volume trash — the CLI picks by device), fs-backed landing scan
const darwinTrashRun = (absSrc: string): Promise<string> =>
  darwinTrashMove(absSrc, darwinTrashSpawn, {
    trashRoots: trashRootsFor(absSrc, "darwin"),
    exists: existsSync,
    readdir: (d) => readdirSync(d),
    mtimeMs: (p) => {
      try {
        return lstatSync(p).mtimeMs;
      } catch {
        return null;
      }
    },
  });

export const xdgTrashMoveToRoot = async (
  absSrc: string,
  root: string,
  // injectable move (default fsMove): the sudo replace-stash runs the SAME
  // claim/rename/finalize loop with sudo-mv — one loop, not a near-clone.
  move: (src: string, dest: string) => Promise<void> = fsMove,
): Promise<string> => {
  const filesDir = path.join(root, "files");
  const infoDir = path.join(root, "info");
  await mkdir(filesDir, { recursive: true });
  await mkdir(infoDir, { recursive: true });
  const base = path.basename(absSrc);
  const stamp = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const encoded = encodeTrashPath(absSrc);
  let name = base;
  for (let i = 2; ; i++) {
    const infoPath = path.join(infoDir, `${name}.trashinfo`);
    // atomic claim: fails with EEXIST when another trasher owns this name
    try {
      await writeFile(infoPath, `[Trash Info]\nPath=${encoded}\nDeletionDate=${stamp}\n`, { flag: "wx" });
    } catch (err) {
      if (errCode(err) === "EEXIST" || existsSync(path.join(filesDir, name))) {
        name = `${base}.${i}`;
        continue;
      }
      throw err;
    }
    // claimed — now move, then finalize the info (overwrite placeholder)
    const finalPath = path.join(filesDir, name);
    try {
      await move(absSrc, finalPath);
    } catch (moveErr) {
      try {
        await rm(infoPath, { force: true });
      } catch (cleanupErr) {
        // a leftover .trashinfo for a file that never moved is an orphan entry
        swallow("trash info cleanup after failed move", cleanupErr);
      }
      throw moveErr;
    }
    try {
      await writeFile(infoPath, `[Trash Info]\nPath=${encoded}\nDeletionDate=${stamp}\n`);
      // best-effort durability: info + dir fsync so a crash doesn't lose the
      // restore mapping for a file that already moved
      try {
        await fsyncPath(infoPath);
      } catch (syncErr) {
        swallow("trash info fsync", syncErr);
      }
    } catch (err) {
      // put the file back — a source-less trash entry is worse than no entry
      try {
        await move(finalPath, absSrc);
      } catch (undoErr) {
        if (err instanceof Error) {
          const e: Error & { rollbackFailed?: unknown } = err;
          e.rollbackFailed = undoErr;
        }
      }
      try {
        await rm(infoPath, { force: true });
      } catch (cleanupErr) {
        // failed rollback of the .trashinfo: the file is back but the entry
        // would linger without this line in the log
        swallow("trash info cleanup after failed write", cleanupErr);
      }
      throw err;
    }
    return finalPath;
  }
};

// st.dev of a path (lstat: moving a symlink moves the link, not its target).
// null when the path is gone/unstatable — callers must treat null as
// "unknown, use the safe fallback" (fsMove's EXDEV path), never as equal.
export const deviceOf = (p: string): number | null => {
  try {
    return lstatSync(p).dev;
  } catch {
    return null;
  }
};

export const crossDevice = (a: string, b: string): boolean => {
  const da = deviceOf(a),
    db = deviceOf(b);
  return da !== null && db !== null && da !== db;
};

// identity of a live file for undo guards: undo closures trash/restore by
// path, but the path may have been reoccupied since the op (user deleted the
// copy, then made a new file at the same name). dev+ino alone is NOT enough:
// ext4 hands a freed inode straight to the next create, so a stranger made
// right after the delete carries the SAME dev+ino. `born` (birth time, absent
// on filesystems that don't report one) breaks that tie — null when the path
// is gone/unstatable (callers treat null as "unknown, fall back to path
// semantics", never as a match).
export type FileId = { dev: number; ino: number; born?: number };

export const fileIdOf = (p: string): FileId | null => {
  try {
    const s = lstatSync(p);
    return s.birthtimeMs > 0 ? { dev: s.dev, ino: s.ino, born: s.birthtimeMs } : { dev: s.dev, ino: s.ino };
  } catch {
    return null;
  }
};

export const fileIdMatches = (id: FileId | null, p: string): boolean => {
  if (id === null) return true;
  const cur = fileIdOf(p);
  return cur !== null && cur.dev === id.dev && cur.ino === id.ino && (id.born === undefined || cur.born === id.born);
};

// two paths that resolve to the SAME on-disk file AND are a case-insensitive
// alias of each other. The case-only rename guard: on a case-insensitive FS
// `Foo` exists because it IS `foo`, and treating it as a collision would trash
// the source under a bogus conflict. True ONLY for that genuine alias: the two
// paths must be equal ignoring case (so distinct hardlinks to one inode, whose
// non-case paths differ, are NOT "same") and both inos must be non-zero (some
// FUSE/CIFS mounts report 0 for every file). A missing/unstatable path is never
// "same" (lstat throws → fileIdOf null). idOf is an injectable seam for tests.
export const sameFile = (a: string, b: string, idOf: (p: string) => FileId | null = fileIdOf): boolean => {
  // resolve first: relative-vs-absolute or a trailing separator spells the same
  // path but compares unequal as raw strings (a bogus "already exists")
  const ra = path.resolve(a);
  const rb = path.resolve(b);
  if (ra.toLowerCase() !== rb.toLowerCase()) return false;
  const ia = idOf(ra);
  if (ia === null || ia.ino === 0) return false;
  const ib = idOf(rb);
  return ib !== null && ib.ino !== 0 && ia.dev === ib.dev && ia.ino === ib.ino;
};

// trash `p` only if it is still the recorded file: a missing path is already
// at the desired end-state (success, nothing to do); a reoccupied path is
// skipped with a log (trashing the stranger would be wrong) — neither throws.
// A null id falls back to plain path semantics. Real trash errors propagate.
export const trashIfSameFile = async (
  p: string,
  id: FileId | null,
  log?: (msg: string) => void,
  platform: string = process.platform,
): Promise<void> => {
  if (!existsSync(p)) return;
  if (id && !fileIdMatches(id, p)) {
    log?.(`undo trash ${p}: file replaced since op, skipped`);
    return;
  }
  await xdgTrashMove(p, platform);
};

// tmp+rename write: a crash or EDQUOT mid-write never leaves a truncated
// file at the target path. Used for caches keyed by content version — a
// partial write there would be served as a valid hit forever.
export const atomicWriteFile = async (p: string, data: Uint8Array | string): Promise<void> => {
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, data);
  try {
    await fsRename(tmp, p);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
};

// Crash-orphan temp name — the orphan sweep regex in fileops anchors to this
// exact shape (`<base>.tfm-part-<pid>-<rand8>` sibling tmp); a substring
// match there silently deleted real user files (notes.tfm-part-2.md), so the
// shape contract lives in ONE place. (The `.tfm-extract-<pid>-<rand8>` staging
// DIR is a separate dot-prefixed shape, anchored by its own regex.)
export const tmpName = (base: string): string =>
  `${base}.tfm-part-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;

// Exclusive claim of a sibling tmp: the rand name is 64-bit, but two live ops
// on the same dest (or a planted name) would otherwise share one tmp and
// clobber each other mid-copy. mkdir/open-wx fail EEXIST atomically, so a won
// claim is proof of exclusivity; callers retry with a fresh name.
export const claimTmp = async (dest: string, dir = false): Promise<string> => {
  for (let i = 0; i < 10; i++) {
    const cand = tmpName(dest);
    try {
      if (dir) await mkdir(cand);
      else await (await open(cand, "wx")).close();
      return cand;
    } catch (err) {
      if (errCode(err) !== "EEXIST") throw err;
    }
  }
  throw new Error(`cannot claim temp for ${path.basename(dest)}`);
};

// fsync a single path (best-effort close; callers own error policy — the
// trash info fsync logs, the copy finish treats failure as fatal upstream).
export const fsyncPath = async (p: string, mode: string = "r"): Promise<void> => {
  const h = await open(p, mode);
  try {
    await h.sync();
  } finally {
    await h.close().catch(() => {});
  }
};
