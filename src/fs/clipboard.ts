import { existsSync, realpathSync } from "node:fs";
import { spawnSafe } from "./spawn-safe";
import { fileUriToPath } from "./uri";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  clipboardInfoArgs,
  hasFinderFileRefs,
  isDarwin,
  parseDarwinFileUrls,
  parseDarwinPosixList,
  pbpasteFileUrlArgs,
  posixPathOfClipboardArgs,
  type CopiedFiles,
} from "./darwin";

// --- System clipboard bridge (Nautilus-style copied-files). Nautilus
// publishes files on the CLIPBOARD selection as MIME
// `x-special/gnome-copied-files`: first line = "copy"|"cut", then one
// file:// URI per line (percent-encoded).
//
// We publish BARE PATHS, not the gnome format: a selection owner has exactly
// ONE mime type (wl-copy/xclip can't offer text/plain AND gnome-copied-files
// at once), and publishing the gnome type makes every text client (terminals,
// editors, browsers) paste NOTHING — not even the URIs. Bare text keeps
// paste-anywhere working; Tfm→Nautilus paste-as-files is drag-out's job
// (OSC 72), and the read side still accepts Nautilus's gnome payload. ---

const CLIP_TYPE = "x-special/gnome-copied-files";

type ClipTool = {
  get: string;
  put: string;
  putBase: string[];
  getArgs: string[];
  /** read without a mime filter — the bare-path text fallback */
  getTextArgs: string[];
};

export const sysClipTool = (platform: string = process.platform): ClipTool | null => {
  // macOS: pbcopy/pbpaste text path (paste-anywhere, like the Linux text
  // publish). No x-special/gnome type on darwin — Finder file refs arrive via
  // the osascript lane in readCopiedFilesFromSystemClipboard, never as a MIME.
  if (isDarwin(platform)) {
    return { get: "pbpaste", put: "pbcopy", putBase: [], getArgs: [], getTextArgs: [] };
  }
  if (process.env.WAYLAND_DISPLAY) {
    return {
      get: "wl-paste",
      put: "wl-copy",
      putBase: [],
      getArgs: ["-t", CLIP_TYPE],
      getTextArgs: [],
    };
  }
  if (process.env.DISPLAY) {
    // -l 10: serve target probes + fetches from the file manager AND a text
    // preview without expiring mid-paste (-l 4 expired after a few requests)
    return {
      get: "xclip",
      put: "xclip",
      putBase: ["-selection", "clipboard", "-l", "10"],
      getArgs: ["-selection", "clipboard", "-o", "-t", CLIP_TYPE],
      getTextArgs: ["-selection", "clipboard", "-o"],
    };
  }
  return null;
};

export type { CopiedFiles };

// internal-clipboard cut check (tile dimming): the pressed path is "cut" when
// the pending clipboard is a cut containing it. null clipboard = nothing cut.
export const isCutKeyFor = (
  clip: { mode: string; items: { path: string }[] } | null | undefined,
  key: string,
): boolean => clip?.mode === "cut" && clip.items.some((i) => i.path === key);

// parse a gnome-copied-files payload: op from the first line ("cut" → move),
// body = file:// URIs only. null when the payload holds no usable URIs.
export const parseCopiedFiles = (text: string): CopiedFiles | null => {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return null;
  const op: "copy" | "move" = lines[0] === "cut" ? "move" : "copy";
  const body = lines[0] === "copy" || lines[0] === "cut" ? lines.slice(1) : lines;
  const paths = body
    .filter((l) => l.startsWith("file://"))
    .map((l) => fileUriToPath(l))
    .filter((p): p is string => p !== null);
  if (!paths.length) return null;
  return { op, paths };
};

// tfm's own publish format: bare absolute paths, one per line. Only paths
// that EXIST are accepted — random copied prose must never turn a paste into
// a file op, and stale pastes shouldn't spawn error toasts. `exists` is
// injectable so tests stay fs-free.
export const parsePlainPaths = (text: string, exists: (p: string) => boolean = existsSync): CopiedFiles | null => {
  const paths = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("/") && exists(l));
  return paths.length ? { op: "copy", paths } : null;
};

const execFileP = promisify(execFile);

type ClipLog = (msg: string) => void;

// publish bare paths (one per line) as text/plain so paste-anywhere works in
// terminals/editors/browsers; fails silently with a log line when no tool is
// available. spawnFn is injectable so tests pin the exact argv + payload a
// text/plain client receives (the contract a gnome-MIME publish broke once).
// Darwin resolves symlinks (realpath absolute) so a pasted path survives the
// link's later move; Finder paste-as-files stays drag-out's job (same split
// as Nautilus).
export const publishPathsToSystemClipboard = (
  mode: string,
  items: { path: string }[],
  log: ClipLog = () => {},
  spawnFn: typeof spawnSafe = spawnSafe,
  platform: string = process.platform,
): void => {
  const t = sysClipTool(platform);
  if (!t || !items.length) return;
  const payload = items
    .map((i) => {
      if (!isDarwin(platform)) return i.path;
      try {
        return realpathSync(i.path);
      } catch {
        return i.path;
      }
    })
    .join("\n");
  try {
    const p = spawnFn(t.put, [...t.putBase], { stdio: ["pipe", "ignore", "ignore"] }, (err) =>
      log(`system clipboard FAILED: ${err.message}`),
    );
    p.stdin?.end(payload);
    p.unref?.();
    log(`system clipboard <- ${mode} ${items.length} item(s) via ${t.put} (text paths)`);
  } catch (err) {
    log(`system clipboard FAILED: ${err}`);
  }
};

// read a file payload from the system clipboard: Nautilus's gnome-copied-files
// first, then tfm's own bare-path text publish (a second instance's clipboard
// carries text/plain, not the gnome MIME). null when neither yields paths.
// Darwin: `clipboard info` furl detect → osascript POSIX paths (verified;
// multi-file degrades to the first) → pbpaste -Prefer file-url → pbpaste text.
export const readCopiedFilesFromSystemClipboard = async (
  log: ClipLog = () => {},
  platform: string = process.platform,
): Promise<CopiedFiles | null> => {
  if (isDarwin(platform)) return readDarwinClipboard(log);
  const t = sysClipTool(platform);
  if (!t) {
    log("paste: no system clipboard tool");
    return null;
  }
  const read = async (args: string[]): Promise<string | null> => {
    try {
      // timeout: a hung wl-paste/xclip must not stall paste forever
      const { stdout } = await execFileP(t.get, args, { timeout: 10_000 });
      return String(stdout ?? "");
    } catch (err) {
      log(`paste: clipboard read failed (${args.join(" ") || "default"}): ${err}`);
      return null;
    }
  };
  log(`paste: reading system clipboard via ${t.get}`);
  const gnome = await read(t.getArgs);
  if (gnome) {
    const lines = gnome.split(/\r?\n/).filter(Boolean);
    log(`paste: system clip lines=${lines.length} head=${JSON.stringify(lines.slice(0, 2))}`);
    const parsed = parseCopiedFiles(gnome);
    if (parsed) return parsed;
    const plain = parsePlainPaths(gnome);
    if (plain) return plain;
  }
  // gnome MIME not offered (a text-only clipboard): re-read without the filter
  const text = await read(t.getTextArgs);
  const plain = text ? parsePlainPaths(text) : null;
  if (!plain) log("paste: no usable file paths in system clip");
  return plain;
};

// darwin read lane (exec runner injectable so tests fake osascript/pbpaste)
export const readDarwinClipboard = async (
  log: ClipLog = () => {},
  run: (bin: string, args: string[]) => Promise<string | null> = async (bin, args) => {
    try {
      const { stdout } = await execFileP(bin, args, { timeout: 10_000 });
      return String(stdout ?? "");
    } catch (err) {
      log(`paste: clipboard read failed (${[bin, ...args].join(" ")}): ${err}`);
      return null;
    }
  },
): Promise<CopiedFiles | null> => {
  log("paste: reading system clipboard via osascript+pbpaste");
  const resolveExisting = (paths: string[]): string[] | null => {
    if (!paths.length) return null;
    const resolved = paths.map((p) => {
      try {
        return realpathSync(p);
      } catch {
        return p;
      }
    });
    return resolved.every((p) => existsSync(p)) ? resolved : null;
  };
  // Finder file refs: osascript POSIX paths AND the file-url paste both
  // parse ALL paths — the wider hit wins so a multi-file copy never
  // collapses to its first entry (the old single-path degrade).
  if (hasFinderFileRefs((await run("/usr/bin/osascript", clipboardInfoArgs())) ?? "")) {
    const posixPaths = resolveExisting(
      parseDarwinPosixList((await run("/usr/bin/osascript", posixPathOfClipboardArgs())) ?? ""),
    );
    const furlRaw = await run("pbpaste", pbpasteFileUrlArgs());
    let furl: CopiedFiles | null = null;
    if (furlRaw) {
      const darwinUrls = parseDarwinFileUrls(furlRaw, fileUriToPath);
      const resolvedDarwin = darwinUrls ? resolveExisting(darwinUrls.paths) : null;
      furl = resolvedDarwin
        ? { op: "copy", paths: resolvedDarwin }
        : (parseCopiedFiles(furlRaw) ?? parsePlainPaths(furlRaw));
    }
    const furlPaths = furl?.paths ?? [];
    const best =
      posixPaths && furl
        ? furlPaths.length >= posixPaths.length
          ? furl
          : { op: "copy" as const, paths: posixPaths }
        : (furl ?? (posixPaths ? { op: "copy" as const, paths: posixPaths } : null));
    if (best) return best;
  }
  const text = await run("pbpaste", []);
  const plain = text ? parsePlainPaths(text) : null;
  if (!plain) log("paste: no usable file paths in system clip");
  return plain;
};
