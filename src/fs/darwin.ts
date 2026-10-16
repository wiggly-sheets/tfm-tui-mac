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

// absolute diskutil (ships at /usr/sbin, outside minimal PATH)
export const diskutilBin = (which: (bin: string) => string | null = Bun.which): string =>
  which("diskutil") ?? "/usr/sbin/diskutil";

// default file/URL opener: `open` on macOS, xdg-open on Linux
export const openerBin = (platform: string = process.platform): string => (isDarwin(platform) ? "open" : "xdg-open");

// AppleScript string literal (double-quoted; backslash + quote escaped)
export const applescriptString = (s: string): string => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

// osascript fallback when `open` itself fails (essentially never — last resort)
export const finderOpenArgs = (target: string): string[] => [
  "-e",
  `tell application "Finder" to open POSIX file ${applescriptString(target)}`,
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
  `tell application "Finder" to delete POSIX file ${applescriptString(p)}`,
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
): string | null => {
  const direct = `${trashRoot}/${base}`;
  try {
    if (exists(direct)) return direct;
  } catch {}
  // collision rename keeps base as a prefix ("a.txt 12-04-44-650.txt"):
  // take the newest sibling with that prefix
  try {
    let best: string | null = null;
    let bestMs = -1;
    for (const name of readdir(trashRoot)) {
      if (name !== base && !name.startsWith(`${base} `)) continue;
      const ms = mtimeMs(`${trashRoot}/${name}`) ?? -1;
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
        const hit = findTrashedPath(root, base, opts?.exists, opts?.readdir, opts?.mtimeMs);
        if (hit) return hit;
      }
      // trashed but unlocatable (raced listing): guess home so undo at least
      // aims at the right root instead of silently pairing nothing
      return `${roots[0] ?? path.join(os.homedir(), ".Trash")}/${base}`;
    } catch {}
  }
  throw new Error(`trash failed for ${base} (no native lane worked)`);
};

// --- mounts: `diskutil list -plist` first (VolumeName labels), `mount` + df
// fallback. diskutil's list payload carries no Ejectable/Removable keys, so
// removable = mounted under /Volumes (macOS convention). ---
export type DiskVolume = { device: string; mountPoint: string; volumeName: string };

// one <dict>…</dict> chunk → volume when it carries a MountPoint; keys arrive
// DeviceIdentifier, MountPoint, VolumeName in that order but each is matched
// independently so reordered payloads still parse.
export const parseDiskutilListPlist = (xml: string): DiskVolume[] => {
  const out: DiskVolume[] = [];
  for (const chunk of xml.split("<dict>")) {
    const mp = chunk.match(/<key>MountPoint<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
    if (!mp) continue;
    const device = chunk.match(/<key>DeviceIdentifier<\/key>\s*<string>([^<]+)<\/string>/)?.[1] ?? "";
    const volumeName = chunk.match(/<key>VolumeName<\/key>\s*<string>([^<]+)<\/string>/)?.[1] ?? "";
    out.push({ device: device ? `/dev/${device}` : "", mountPoint: mp, volumeName });
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
const MOUNT_SKIP_FSTYPE = new Set(["devfs", "autofs", "nfs", "smbfs"]);

export type DarwinMountEntry = { label: string; target: string; removable: boolean; device: string };

// diskutil volumes preferred (real VolumeName labels); mount-table fallback
// covers diskutil failure. System/private/dev mounts never list; / stays the
// "This Device" row owned by places.ts, not a device entry.
export const darwinMountEntries = (volumes: DiskVolume[], mounts: DarwinMount[]): DarwinMountEntry[] => {
  const byTarget = new Map(mounts.map((m) => [m.target, m]));
  const out: DarwinMountEntry[] = [];
  const push = (label: string, target: string, device: string): void => {
    if (!target || target === "/") return;
    if (MOUNT_SKIP_PREFIX.some((p) => target.startsWith(p))) return;
    const m = byTarget.get(target);
    if (m && MOUNT_SKIP_FSTYPE.has(m.fstype)) return;
    if (out.some((o) => o.target === target)) return;
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
export const diskutilMountArgv = (device: string): string[] => ["mountDisk", device];
export const diskutilUnmountArgv = (target: string): string[] => ["unmount", target];
export const diskutilEjectArgv = (device: string): string[] => ["eject", device];

// --- network: `open smb://…` hands auth to Finder, then the volume is polled
// under /Volumes (netmount's resolveName already polls); unmount is diskutil.
// LC_ALL=C stays Linux-only (runGio untouched). ---
export const DARWIN_NETWORK_ROOT = "/Volumes";

export type SmbMount = { target: string; uri: string; label: string };

// mount-table rows with smbfs fstype: device is //user@host/share
export const parseSmbMounts = (mounts: DarwinMount[]): SmbMount[] => {
  const out: SmbMount[] = [];
  for (const m of mounts) {
    if (m.fstype !== "smbfs") continue;
    const dev = m.device.replace(/^\/\//, "");
    const at = dev.indexOf("@");
    const hostShare = at >= 0 ? dev.slice(at + 1) : dev;
    const slash = hostShare.indexOf("/");
    const host = (slash >= 0 ? hostShare.slice(0, slash) : hostShare).toLowerCase();
    const share = slash >= 0 ? hostShare.slice(slash + 1) : "";
    if (!host) continue;
    const uri = `smb://${host}${share ? `/${share}` : "/"}`;
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
// absent; each failure is swallowed (best-effort — never throws).
export const writeFinderTags = (deps: TagWriteDeps, argvs: string[][]): void => {
  if (!isDarwin(deps.platform ?? process.platform)) return;
  const tagBin = deps.which("tag");
  if (!tagBin) return;
  for (const args of argvs) {
    try {
      void deps.exec(tagBin, args);
    } catch {}
  }
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
export const parseDarwinFileUrls = (out: string, fileUriToPath: (u: string) => string): CopiedFiles | null => {
  const paths: string[] = [];
  for (const tok of out.split(/\s+/)) {
    const t = tok.trim().replace(/^"|"$/g, "");
    if (!t) continue;
    if (t.startsWith("file://")) {
      try {
        const p = fileUriToPath(t);
        if (p.startsWith("/")) paths.push(p);
      } catch {}
    } else if (t.startsWith("/")) {
      paths.push(t);
    }
  }
  return paths.length ? { op: "copy", paths: [...new Set(paths)] } : null;
};

// --- Trash restore (darwin): Finder Put Back via osascript for files
// trashed outside tfm (no .trashinfo sidecar). Returns true when handled.
export const darwinTrashPutBack = async (paths: string[]): Promise<boolean> => {
  if (!isDarwin()) return false;
  for (const p of paths) {
    try {
      await Bun.spawn(
        [
          "/usr/bin/osascript",
          "-e",
          `tell application "Finder" to move POSIX file ${applescriptString(p)} to original location`,
        ],
        {
          stdout: "ignore",
          stderr: "ignore",
          stdin: "ignore",
          timeout: 10_000,
        },
      ).exited;
    } catch {
      return false;
    }
  }
  return true;
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
