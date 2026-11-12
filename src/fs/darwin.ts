import os from "node:os";
import path from "node:path";

// --- macOS (darwin arm64) platform leaf: gates, argv builders and output
// parsers for every Linux-shell-out replacement. Pure (platform injectable,
// never read process.platform deep in logic) so tests pin the darwin branches
// on Linux CI via platform mock. Live settings gate ALL macOS branches on
// process.platform === "darwin"; Linux behavior is byte-identical. Uses
// Bun.which + absolute /usr/bin paths; no new runtime deps. ---

export type CopiedFiles = { op: "copy" | "move"; paths: string[] };

export const isDarwin = (platform: string = process.platform): boolean => platform === "darwin";

// macOS bundles are directories on disk but single launchable objects to
// Finder. Shared by every open path so double-click, Enter and the context
// menu agree.
export const isAppBundle = (p: string): boolean => /\.(app|pkg)$/i.test(p);

// absolute diskutil (ships at /usr/sbin, outside minimal PATH)
export const diskutilBin = (which: (bin: string) => string | null = Bun.which): string =>
  which("diskutil") ?? "/usr/sbin/diskutil";

// default file/URL opener: `open` on macOS, xdg-open on Linux
export const openerBin = (platform: string = process.platform): string => (isDarwin(platform) ? "open" : "xdg-open");

// AppleScript string literal (double-quoted; backslash + quote escaped)
export const applescriptString = (s: string): string => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

// osascript fallback when `open` itself fails (essentially never — last resort).
// The path is passed as a script PARAMETER (osascript's `on run {f} … end run`
// + `--`), never interpolated into the AppleScript source. Interpolation would
// require escaping every AppleScript metacharacter; a filename containing
// `"; tell application "System Events" to shut down; "` would break out of
// POSIX file "…" and inject arbitrary AppleScript. argv-passed strings are
// AppleScript-safe by construction.
export const finderOpenArgs = (target: string): string[] => [
  "-e",
  "on run {f}",
  "-e",
  'tell application "Finder" to open POSIX file f',
  "-e",
  "end run",
  "--",
  target,
];

// --- trash: /usr/bin/trash first (ships macOS 26+, renames collisions itself
// as "<base> HH-MM-SS.txt"), else JXA NSFileManager, else Finder delete. Never
// rm — a silent rm -rf is exactly what the trash op must never become. ---
export const TRASH_CLI = "/usr/bin/trash";
export const trashCliArgs = (p: string): string[] => [p];

export const jxaTrashArgs = (p: string): string[] => [
  "-l",
  "JavaScript",
  "-e",
  `ObjC.import("Cocoa"); var u=$.NSURL.fileURLWithPath(${JSON.stringify(p)}); $.NSFileManager.defaultManager.trashItemAtURLResultingItemURLError(u, $(), $());`,
];

export const finderDeleteArgs = (p: string): string[] => [
  "-e",
  "on run {f}",
  "-e",
  'tell application "Finder" to delete POSIX file f',
  "-e",
  "end run",
  "--",
  p,
];

// trash CLI collision rename is "<base> HH-MM-SS.txt" (probed): find the
// real landing under one trash root so the undo unit pairs deterministically
// instead of moving a stranger back. fs fns injectable so tests stay fs-free.
export const findTrashedPath = (
  trashRoot: string,
  base: string,
  exists: (p: string) => boolean = () => false,
  readdir: (dir: string) => string[] = () => [],
  mtimeMs: (p: string) => number | null = () => null,
  // snapshot of the root before the trash op: a pre-existing same-name entry
  // must never be mistaken for THIS file's landing (restoring it to the new
  // path would move the wrong file).
  before?: ReadonlySet<string>,
  sinceMs?: number,
): string | null => {
  const direct = `${trashRoot}/${base}`;
  try {
    if (!before?.has(base) && exists(direct)) return direct;
  } catch {}
  // collision rename keeps the base as a prefix ("a.txt 12-04-44-650.txt");
  // Finder may use "<stem> 2.<ext>". Only names that appeared during this op
  // qualify when a snapshot/timestamp is available.
  const stem = base.replace(/\.[^.]+$/, "");
  const prefixed = (name: string): boolean =>
    name.startsWith(`${base} `) || (stem !== base && name.startsWith(`${stem} `));
  try {
    let best: string | null = null;
    let bestMs = -1;
    for (const name of readdir(trashRoot)) {
      if (name === base || !prefixed(name)) continue;
      if (before?.has(name)) continue;
      const ms = mtimeMs(`${trashRoot}/${name}`) ?? -1;
      if (sinceMs !== undefined && ms >= 0 && ms < sinceMs - 5_000) continue;
      if (ms >= bestMs) {
        bestMs = ms;
        best = `${trashRoot}/${name}`;
      }
    }
    if (best) return best;
  } catch {}
  return null;
};

export type TrashRun = (bin: string, args: string[]) => Promise<{ code: number }>;

// native trash move: trash CLI → JXA → Finder delete. Resolves the real
// landing across the candidate roots (home + volume trash — the CLI picks by
// device) so undo pairs. Throws when every lane fails — callers surface it;
// never falls back to rm.
export const darwinTrashMove = async (
  absSrc: string,
  run: TrashRun,
  opts?: {
    trashRoots?: string[];
    exists?: (p: string) => boolean;
    readdir?: (dir: string) => string[];
    mtimeMs?: (p: string) => number | null;
  },
): Promise<string> => {
  const base = path.basename(absSrc);
  const roots = opts?.trashRoots ?? [path.join(os.homedir(), ".Trash")];
  const started = Date.now();
  const before = new Map<string, Set<string>>();
  const readdir = opts?.readdir;
  if (readdir) {
    for (const root of roots) {
      try {
        before.set(root, new Set(readdir(root)));
      } catch {
        before.set(root, new Set());
      }
    }
  }
  const lanes: Array<[string, string[]]> = [
    [TRASH_CLI, trashCliArgs(absSrc)],
    ["/usr/bin/osascript", jxaTrashArgs(absSrc)],
    ["/usr/bin/osascript", finderDeleteArgs(absSrc)],
  ];
  for (const [bin, args] of lanes) {
    try {
      const r = await run(bin, args);
      if (r.code !== 0) continue;
      for (const root of roots) {
        const hit = findTrashedPath(root, base, opts?.exists, opts?.readdir, opts?.mtimeMs, before.get(root), started);
        if (hit) return hit;
      }
      // trashed but unlocatable (raced listing): never guess a path that
      // already existed — that would overwrite an unrelated entry's origin and
      // restore the wrong file. Throwing is safer than a wrong undo pairing.
      const guess = `${roots[0] ?? path.join(os.homedir(), ".Trash")}/${base}`;
      if (!(opts?.exists?.(guess) ?? false)) return guess;
      throw new Error(`trash landed but could not be located: ${base}`);
    } catch {}
  }
  throw new Error(`trash failed for ${base} (no native lane worked)`);
};

// --- mounts: `diskutil list -plist` first (VolumeName labels), `mount` + df
// fallback. diskutil's list payload carries no Ejectable/Removable keys, so
// removable = mounted under /Volumes (macOS convention). ---
export type DiskVolume = { device: string; mountPoint: string; volumeName: string };

// one <dict>…</dict> chunk → volume when it carries a VolumeName (and a
// DeviceIdentifier); MountPoint is optional because an UNMOUNTED volume still
// belongs in the sidebar as a Mount row. keys arrive DeviceIdentifier,
// MountPoint, VolumeName in that order but each is matched independently so
// reordered payloads still parse.
const PSEUDO_VOLUME_NAMES = new Set([
  "Recovery",
  "VM",
  "Preboot",
  "Update",
  "xarts",
  "booter",
  "iSCPreboot",
  "Hardware",
]);

export const parseDiskutilListPlist = (xml: string): DiskVolume[] => {
  const out: DiskVolume[] = [];
  for (const chunk of xml.split("<dict>")) {
    const volumeName = chunk.match(/<key>VolumeName<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
    const mp = chunk.match(/<key>MountPoint<\/key>\s*<string>([^<]+)<\/string>/)?.[1] ?? "";
    // pseudo volumes (Recovery/VM/Preboot…) are never user-mountable entries;
    // their mounted siblings are already dropped by target in darwinMountEntries
    if (!volumeName || PSEUDO_VOLUME_NAMES.has(volumeName)) continue;
    const device = chunk.match(/<key>DeviceIdentifier<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
    if (!device) continue;
    out.push({ device: `/dev/${device}`, mountPoint: mp, volumeName });
  }
  return out;
};

export type DarwinMount = { device: string; target: string; fstype: string };

// "dev on target (fstype, opts…)" — split on the FIRST " on " (devices are
// single tokens except map names like `map auto_home`, which never contain
// " on "; targets may hold spaces). fstype is the first token inside the
// parens. Non-matching lines (headers, blanks) skip.
export const parseMountTable = (text: string): DarwinMount[] => {
  const out: DarwinMount[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const on = line.indexOf(" on ");
    if (on <= 0) continue;
    const device = line.slice(0, on).trim();
    const rest = line.slice(on + 4);
    const paren = rest.indexOf(" (");
    if (paren <= 0) continue;
    const target = rest.slice(0, paren).trim();
    const fstype = rest
      .slice(paren + 2)
      .split(/[,\s)]/)
      .find(Boolean);
    if (!device || !target || !fstype) continue;
    out.push({ device, target, fstype });
  }
  return out;
};

const MOUNT_SKIP_PREFIX = ["/System/", "/private/", "/dev", "/Library/Developer/"];
const MOUNT_SKIP_FSTYPE = new Set(["devfs", "autofs", "nfs", "smbfs", "afpfs", "devicefs", "fskit"]);

export type DarwinMountEntry = { label: string; target: string; removable: boolean; device: string };

// diskutil volumes preferred (real VolumeName labels); mount-table fallback
// covers diskutil failure. System/private/dev mounts never list; / stays the
// "This Device" row owned by places.ts, not a device entry. Volumes with a
// name but no MountPoint keep target "" + device so the existing Mount action
// (diskutilMountArgv) becomes reachable for unmounted drives.
export const darwinMountEntries = (volumes: DiskVolume[], mounts: DarwinMount[]): DarwinMountEntry[] => {
  const byTarget = new Map(mounts.map((m) => [m.target, m]));
  const out: DarwinMountEntry[] = [];
  const push = (label: string, target: string, device: string): void => {
    if (target === "/") return;
    if (target && MOUNT_SKIP_PREFIX.some((p) => target.startsWith(p))) return;
    if (!target && !label) return;
    const m = target ? byTarget.get(target) : undefined;
    if (m && MOUNT_SKIP_FSTYPE.has(m.fstype)) return;
    const key = target || device || label;
    if (out.some((o) => (o.target || o.device || o.label) === key)) return;
    out.push({
      label: label || target.split("/").pop() || target,
      target,
      // macOS convention: user volumes mount under /Volumes
      removable: target === "/Volumes" || target.startsWith("/Volumes/"),
      device: device || m?.device || "",
    });
  };
  for (const v of volumes) push(v.volumeName, v.mountPoint, v.device);
  // mount-table-only targets (diskutil missed/failed): basename labels
  for (const m of mounts) {
    if (MOUNT_SKIP_FSTYPE.has(m.fstype)) continue;
    push("", m.target, m.device);
  }
  return out;
};

// per-volume trash root for a mount target (caller already resolved the
// mount point via the device walk in fsutil)
export const darwinVolumeTrash = (mountTarget: string, uid: number): string => `${mountTarget}/.Trashes/${uid}`;

// diskutil device ops for the sidebar mount/eject rows
export const diskutilMountArgv = (device: string): string[] =>
  // a volume slice (`disk3s1`) is mounted directly; `mountDisk` is for whole
  // disks and would mount every volume on the device
  /\ds\d+$/.test(device) ? ["mount", device] : ["mountDisk", device];
export const diskutilUnmountArgv = (target: string): string[] => ["unmount", target];
export const diskutilEjectArgv = (device: string): string[] => ["eject", device];

// --- network: `open smb://…` hands auth to Finder, then the volume is polled
// under /Volumes (netmount's resolveName already polls); unmount is diskutil.
// LC_ALL=C stays Linux-only (runGio untouched). ---
export const DARWIN_NETWORK_ROOT = "/Volumes";

export type SmbMount = { target: string; uri: string; label: string };

// mount-table rows for network filesystems: smbfs/afpfs devices look like
// `//user@host/share`, nfs like `host:/export/path`. The URI never carries the
// connecting user (the table does not expose it), so comparisons normalize it
// away. Name kept for callers/tests; it covers all schemes `open` can mount.
export const parseSmbMounts = (mounts: DarwinMount[]): SmbMount[] => {
  const out: SmbMount[] = [];
  for (const m of mounts) {
    if (m.fstype === "nfs") {
      const dev = m.device.replace(/^\/\//, "");
      const colon = dev.indexOf(":");
      if (colon <= 0) continue;
      const host = dev.slice(0, colon).toLowerCase();
      const sharePath = dev.slice(colon + 1);
      if (!host) continue;
      const uri = `nfs://${host}${sharePath.startsWith("/") ? "" : "/"}${sharePath}`;
      const label = sharePath.split("/").filter(Boolean).pop() ?? host;
      out.push({ target: m.target, uri, label: sharePath ? `${host}/${label}` : host });
      continue;
    }
    if (m.fstype !== "smbfs" && m.fstype !== "afpfs") continue;
    const scheme = m.fstype === "afpfs" ? "afp" : "smb";
    const dev = m.device.replace(/^\/\//, "");
    const at = dev.indexOf("@");
    const hostShare = at >= 0 ? dev.slice(at + 1) : dev;
    const slash = hostShare.indexOf("/");
    const host = (slash >= 0 ? hostShare.slice(0, slash) : hostShare).toLowerCase();
    const share = slash >= 0 ? hostShare.slice(slash + 1) : "";
    if (!host) continue;
    const uri = `${scheme}://${host}${share ? `/${share}` : "/"}`;
    out.push({ target: m.target, uri, label: share ? `${host}/${share}` : host });
  }
  return out;
};

// mdls kMDItemUserTags raw output → tag names: "(Red,\n Starred\n)" or
// "(null)". Pure so tests pin it without Spotlight.
export const parseMdlsTags = (out: string): string[] => {
  const t = out.trim();
  if (t === "(null)" || !t.startsWith("(") || !t.endsWith(")")) return [];
  return t
    .slice(1, -1)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
};

export type StarTagDeps = {
  which: (bin: string) => string | null;
  exec: (bin: string, args: string[]) => unknown;
};

// Finder tag sync behind the Properties star toggle. `tag` CLI only:
// com.apple.metadata:_kMDItemUserTags is a binary plist — a plain write is
// invalid data, and `xattr -d` deletes every unrelated color/name tag with it.
// When the CLI is absent tfm leaves the attribute untouched (its own starred
// registry is then the source of truth). deps injectable so tests pin the
// "no xattr" guard headless.
export const syncStarTag = (deps: StarTagDeps, starred: boolean, targetPath: string): void => {
  const tagBin = deps.which("tag");
  if (!tagBin) return;
  void deps.exec(tagBin, starred ? ["-a", "Starred", targetPath] : ["-r", "Starred", targetPath]);
};

// --- Finder user tags (kMDItemUserTags) as a read/write surface for the
// Properties tag editor. Read reuses mdls + parseMdlsTags (the same value the
// star toggle adopts); write goes through the `tag` CLI only (same binary-plist
// reasoning as syncStarTag). Pure argv builders + parser are exported so tests
// pin them without a Mac. Off darwin, or with the CLI absent, or on any
// failure, everything degrades to a no-op that never throws. ---

export const mdlsTagsArgs = (p: string): string[] => ["-raw", "-name", "kMDItemUserTags", p];

export const tagAddArgs = (tag: string, p: string): string[] => ["-a", tag, p];
export const tagRemoveArgs = (tag: string, p: string): string[] => ["-r", tag, p];
// replace the whole tag set (comma-joined, the CLI's list separator)
export const tagSetArgs = (tags: string[], p: string): string[] => ["-s", tags.join(","), p];

export type TagReadDeps = {
  run: (bin: string, args: string[]) => Promise<{ stdout?: unknown }>;
  platform?: string;
};

// all Finder user tags for one path. Empty off darwin or on any failure.
export const readFinderTags = async (deps: TagReadDeps, p: string): Promise<string[]> => {
  if (!isDarwin(deps.platform ?? process.platform)) return [];
  try {
    const r = await deps.run("mdls", mdlsTagsArgs(p));
    return parseMdlsTags(String(r?.stdout ?? ""));
  } catch {
    return [];
  }
};

export type TagWriteDeps = StarTagDeps & { platform?: string };

// apply one `tag` CLI argv per target. No-op off darwin or when the CLI is
// absent; each failure is swallowed (best-effort — never throws). Returns
// false when nothing was written (CLI missing / wrong platform) so the tag
// editor can say so instead of optimistically showing an edit that never landed.
export const writeFinderTags = (deps: TagWriteDeps, argvs: string[][]): boolean => {
  if (!isDarwin(deps.platform ?? process.platform)) return false;
  const tagBin = deps.which("tag");
  if (!tagBin) return false;
  for (const args of argvs) {
    try {
      void deps.exec(tagBin, args);
    } catch {}
  }
  return true;
};

export type TagMergeOp = {
  op: "add" | "remove";
  tag: string;
};

// merge user-intended tag changes into a freshly re-read tag list. mdls lags
// the Spotlight index after a `tag` CLI write, so the re-read is authoritative
// for everything except the intended change, which is forced in (add) or out
// (remove). Result is sorted — the Properties list order is deterministic.
export const mergeTagChange = (fresh: string[], changes: TagMergeOp[]): string[] => {
  const set = new Set(fresh);
  for (const c of changes) {
    if (c.op === "add") set.add(c.tag);
    else set.delete(c.tag);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
};

// --- extended attributes: Finder tags (com.apple.metadata:_kMDItemUserTags),
// quarantine, download provenance and resource forks (com.apple.ResourceFork)
// live in xattrs, which a byte/mode/mtime copy silently drops. `xattr -p -x`
// reads the value as hex and `-w -x` writes hex back, so binary attributes
// survive a round-trip (a plain text write corrupts them). Best-effort: a
// listing spawn first keeps the common no-attribute file to that one spawn
// (no reads, no writes); every failure is swallowed so a copy never fails
// over an attribute it could not carry. deps injectable — syncStarTag's
// headless-test pattern. ---
export const XATTR_CLI = "/usr/bin/xattr";

export const xattrListArgs = (p: string): string[] => [p];
export const xattrReadArgs = (name: string, p: string): string[] => ["-p", "-x", name, p];
export const xattrWriteArgs = (name: string, hex: string, p: string): string[] => ["-w", "-x", name, hex, p];

export type XattrRun = (bin: string, args: string[]) => Promise<{ stdout: string; code: number }>;

export type XattrDeps = { run: XattrRun; platform?: string };

// Copy every xattr from src onto a file that already landed at dest. No-op off
// darwin (Linux byte-identical); no read/write spawns when src has none; a
// failed read skips that attribute, a failed write is ignored — never throws.
export const copyXattrs = async (src: string, dest: string, deps: XattrDeps): Promise<void> => {
  if (!isDarwin(deps.platform ?? process.platform)) return;
  let listed: { stdout: string; code: number };
  try {
    listed = await deps.run(XATTR_CLI, xattrListArgs(src));
  } catch {
    return;
  }
  if (listed.code !== 0) return;
  const names = listed.stdout
    .split("\n")
    .map((n) => n.trim())
    .filter(Boolean);
  for (const name of names) {
    try {
      const read = await deps.run(XATTR_CLI, xattrReadArgs(name, src));
      if (read.code !== 0) continue;
      await deps.run(XATTR_CLI, xattrWriteArgs(name, read.stdout.trim(), dest));
    } catch {}
  }
};

// --- clipboard: pbcopy/pbpaste text path (paste-anywhere, like the Linux
// text publish); Finder file refs detected via `clipboard info` furl, read
// back as realpath-absolute POSIX paths. No x-special/gnome type on darwin. ---
export const clipboardInfoArgs = (): string[] => ["-e", "clipboard info"];

export const hasFinderFileRefs = (info: string): boolean => /furl/i.test(info);

// live-verified on darwin arm64 (macOS 27): single-file returns its path;
// multi-file `POSIX path of (the clipboard)` errors (-1728) instead of
// listing, so the multi-file read rides pbpaste -Prefer below. Both lanes
// parse ALL paths (never first-only) — see parseDarwinPosixList /
/// parseDarwinFileUrls.
export const posixPathOfClipboardArgs = (): string[] => ["-e", "POSIX path of (the clipboard)"];

export const pbpasteFileUrlArgs = (): string[] => ["-Prefer", "public.file-url"];

// one osascript stdout → absolute paths. Handles newline-separated POSIX
// paths AND AppleScript list syntax ({" /a ", " /b "}) so a multi-file
// clipboard never collapses to its first entry. Also handles HFS paths
// (Macintosh HD:Users:name:file) from `the clipboard` output.
export const parseDarwinPosixList = (out: string): string[] => {
  const found: string[] = [];
  for (const m of out.matchAll(/"(\/[^"]+)"/g)) {
    const p = (m[1] ?? "").trim();
    if (p.startsWith("/")) found.push(p);
  }
  for (const line of out.split(/\r?\n/)) {
    const p = line.trim().replace(/^"|"$/g, "").trim();
    if (p.startsWith("/") && !found.includes(p)) found.push(p);
  }
  // HFS paths: "file Macintosh HD:path:to:file" → convert to POSIX
  for (const m of out.matchAll(/file\s+([^,\n]+)/g)) {
    const hfs = (m[1] ?? "").trim();
    if (!hfs) continue;
    // HFS to POSIX: replace : with /, prepend /Volumes or handle boot volume
    const posix = hfsToPosix(hfs);
    if (posix && !found.includes(posix)) found.push(posix);
  }
  return found;
};

// HFS path (Macintosh HD:Users:name:file) → POSIX (/Volumes/... or /)
const hfsToPosix = (hfs: string): string => {
  const parts = hfs.split(":").filter(Boolean);
  if (!parts.length) return "";
  // Boot volume: "Macintosh HD" -> "/" (or /System/Volumes/Data on APFS)
  if (parts.length === 1) return "/";
  const vol = parts[0];
  if (!vol) return "";
  const rest = parts.slice(1).join("/");
  // Heuristic: if volume name contains "HD" or "SSD" or "Macintosh", treat as boot
  const isBoot = /(Macintosh|HD|SSD)/i.test(vol);
  return isBoot ? `/${rest}` : `/Volumes/${vol}/${rest}`;
};

// one pbpaste -Prefer stdout → absolute paths. Splits on any whitespace so
// space-joined file:// URLs (single-line multi paste) still yield every
// entry; plain /paths pass through for text publishes.
export const parseDarwinFileUrls = (out: string, fileUriToPath: (u: string) => string | null): CopiedFiles | null => {
  const paths: string[] = [];
  for (const tok of out.split(/\s+/)) {
    const t = tok.trim().replace(/^"|"$/g, "");
    if (!t) continue;
    if (t.startsWith("file://")) {
      try {
        const p = fileUriToPath(t);
        if (p?.startsWith("/")) paths.push(p);
      } catch {}
    } else if (t.startsWith("/")) {
      paths.push(t);
    }
  }
  return paths.length ? { op: "copy", paths: [...new Set(paths)] } : null;
};

// --- Native-trash origin sidecars (darwin): the native trash lanes (/usr/bin/
// trash → JXA → Finder delete) land entries at the trash root with NO
// .trashinfo — Finder stays the bookkeeper — so tfm records the original path
// itself in a hidden metadata dir NEXT TO the landing:
//   ~/.Trash/<name>                  → ~/.Trash/.tfm-info/<name>.trashinfo
//   /Volumes/X/.Trashes/<uid>/<name> → …/.Trashes/<uid>/.tfm-info/<name>.trashinfo
// XDG-shaped roots (<root>/files/, used on Linux and whenever $XDG_DATA_HOME
// overrides the darwin root) keep their standard <root>/info sidecar. The body
// is the XDG [Trash Info] format, so the same Path= parser reads it.
//
// Finder-trashed items (trashed outside tfm) have no origin recorded anywhere:
// Finder exposes no "Put Back" API (`original item` is an alias property, and
// `move … to original location` does not even compile), and no xattr or
// .DS_Store entry carries the old path. Restore therefore reports failure for
// them instead of claiming a move that never happened.
export const TRASH_META_DIR = ".tfm-info";

// native macOS trash root: the home trash (.Trash) or a per-volume
// .Trashes/<uid> dir — the two shapes the native lanes land entries under
export const isDarwinTrashRoot = (dir: string): boolean => {
  const base = path.basename(dir);
  return base === ".Trash" || path.basename(path.dirname(dir)) === ".Trashes";
};

// --- search/shell: brew's fd is `fd` (no Debian fdfind rename); login shell
// is zsh on macOS. ---
export const fdBinary = (
  which: (bin: string) => string | null = Bun.which,
  platform: string = process.platform,
): string | null => (isDarwin(platform) ? which("fd") : (which("fd") ?? which("fdfind")));

export const defaultShell = (platform: string = process.platform): string =>
  process.env.SHELL || (isDarwin(platform) ? "/bin/zsh" : "/bin/bash");

// --- thumbnails: sips (ships macOS) behind brew magick; qlmanage covers video
// when no ffmpeg exists at all. ---
export const sipsThumbArgs = (src: string, dest: string, size: number): string[] => [
  "-Z",
  String(size),
  "-s",
  "format",
  "png",
  src,
  "--out",
  dest,
];

export const qlmanageThumbArgs = (size: number, outDir: string, src: string): string[] => [
  "-t",
  "-s",
  String(size),
  "-o",
  outDir,
  src,
];

// sidecar names probed in execDir order (release artifact renames per arch)
export const MACOS_FFMPEG_SIDECARS = ["tfm-ffmpeg-macos-arm64", "tfm-ffmpeg"];
