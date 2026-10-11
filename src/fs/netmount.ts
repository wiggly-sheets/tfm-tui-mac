import path from "node:path";
import { readdir } from "node:fs/promises";
import { watch } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { errMessage } from "../lib/uiutil";
import { gvfsRoot, parseGvfsName, parseServerInput } from "./network";
import { isDarwin, parseMountTable, parseSmbMounts } from "./darwin";
import type { NotifyLevel } from "../lib/notify-level";

// --- Network location orchestration: connect/disconnect through `gio mount`
// and enumerate active gvfs mounts. All process/fs access is injected (sink),
// so the unit is testable without a server or a desktop session. Connecting
// goes through GVFS so the mount becomes an ordinary local FUSE path. ---

export type GioResult = { code: number; stdout: string; stderr: string };

export type NetworkSink = {
  gvfsRoot(): string;
  // mount a URI through gio, driving any credential prompts; unmount is
  // non-interactive. Both resolve the exit code + captured output.
  mount(uri: string): Promise<GioResult>;
  unmount(uri: string): Promise<GioResult>;
  readdir(dir: string): Promise<string[]>;
  notify(msg: string, title?: string, level?: NotifyLevel): void;
  log?(msg: string): void;
};

export type NetworkMount = { path: string; uri: string; label: string; scheme: string };

const lastLine = (s: string): string =>
  s
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .pop() ?? "";

// active network mounts. Linux: gvfs FUSE dirs under the runtime dir.
// Darwin: smbfs rows of the mount table (Finder mounts under /Volumes;
// mountText injectable so tests never shell out). Unreadable/missing = none.
export const listNetworkMounts = async (
  readdirImpl: (dir: string) => Promise<string[]> = (d) => readdir(d),
  platform: string = process.platform,
  mountText?: string,
): Promise<NetworkMount[]> => {
  if (isDarwin(platform)) {
    try {
      let text = mountText;
      if (text === undefined) {
        text = await promisify(execFile)("mount", [], { timeout: 10_000 }).then((r) => String(r.stdout ?? ""));
      }
      return parseSmbMounts(parseMountTable(text ?? "")).map((m) => ({
        path: m.target,
        uri: m.uri,
        label: m.label,
        scheme: "smb",
      }));
    } catch {
      return [];
    }
  }
  try {
    const dir = gvfsRoot(platform);
    const names = await readdirImpl(dir);
    const out: NetworkMount[] = [];
    for (const name of names) {
      const parsed = parseGvfsName(name);
      if (!parsed) continue;
      out.push({ path: path.join(dir, name), uri: parsed.uri, label: parsed.label, scheme: parsed.scheme });
    }
    return out;
  } catch {
    return [];
  }
};

// watch /Volumes on darwin for network mount changes (no gvfs watcher)
export const watchDarwinVolumes = (onChange: () => void, platform: string = process.platform): (() => void) | null => {
  if (!isDarwin(platform)) return null;
  const watcher = watch("/Volumes", { persistent: false }, () => onChange());
  watcher.unref?.();
  return () => watcher.close();
};

const nameMatchesUri = (name: string, uri: string): boolean => {
  const n = parseGvfsName(name);
  if (!n) return false;
  try {
    const u = new URL(uri);
    return n.scheme === u.protocol.replace(":", "") && n.host.toLowerCase() === u.hostname.toLowerCase();
  } catch {
    return false;
  }
};

export const makeNetworkActions = (sink: NetworkSink, opts?: { resolveAttempts?: number }) => {
  // in-session uri per mount path (a gvfs dir name can be ambiguous to
  // reverse); falls back to reconstructing from the dir name
  const uriByPath = new Map<string, string>();
  // `open smb://` hands auth to Finder and returns before the volume lands —
  // darwin callers pass a longer poll budget (default stays gvfs-fast)
  const attempts = opts?.resolveAttempts ?? 4;

  const readNames = async (): Promise<string[]> => {
    try {
      return await sink.readdir(sink.gvfsRoot());
    } catch {
      return [];
    }
  };

  const resolveName = async (uri: string, before: Set<string>): Promise<string | null> => {
    // gio returns after the mount exists, but readdir can lag by a beat —
    // poll with a delay (back-to-back readdirs all fire within milliseconds
    // and a slow FUSE arrival deterministically reads "mount path not found"
    // after a SUCCESSFUL mount, orphaning it)
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 250));
      const names = await readNames();
      const fresh = names.filter((n) => !before.has(n));
      const picked = fresh[0] ?? names.find((n) => nameMatchesUri(n, uri));
      if (picked) return picked;
    }
    return null;
  };

  const connect = async (raw: string): Promise<string | null> => {
    const parsed = parseServerInput(raw);
    if (!parsed) {
      sink.notify("Unsupported server address", "network", "error");
      return null;
    }
    const before = new Set(await readNames());
    let res: GioResult;
    try {
      res = await sink.mount(parsed.uri);
    } catch (err) {
      sink.notify(`Connect failed: ${errMessage(err)}`, "network", "error");
      return null;
    }
    if (res.code !== 0) {
      const why = lastLine(res.stderr) || lastLine(res.stdout) || "unknown error";
      sink.notify(`Connect failed: ${why}`, "network", "error");
      sink.log?.(`gio mount ${parsed.uri} exit ${res.code}: ${why}`);
      return null;
    }
    const name = await resolveName(parsed.uri, before);
    if (!name) {
      sink.notify(`Connected to ${parsed.label} (mount path not found)`, "network", "error");
      return null;
    }
    const mountPath = path.join(sink.gvfsRoot(), name);
    uriByPath.set(mountPath, parsed.uri);
    sink.notify(`Connected to ${parsed.label}`, "network", "success");
    return mountPath;
  };

  const disconnect = async (mountPath: string, fallbackUri?: string): Promise<boolean> => {
    const name = path.basename(mountPath);
    const uri = uriByPath.get(mountPath) ?? fallbackUri ?? parseGvfsName(name)?.uri;
    if (!uri) {
      sink.notify("Can't determine the mount to disconnect", "network", "error");
      return false;
    }
    let res: GioResult;
    try {
      res = await sink.unmount(uri);
    } catch (err) {
      sink.notify(`Disconnect failed: ${errMessage(err)}`, "network", "error");
      return false;
    }
    if (res.code !== 0) {
      const why = lastLine(res.stderr) || lastLine(res.stdout) || "unknown error";
      sink.notify(`Disconnect failed: ${why}`, "network", "error");
      sink.log?.(`gio mount -u ${uri} exit ${res.code}: ${why}`);
      return false;
    }
    uriByPath.delete(mountPath);
    sink.notify(`Disconnected ${parseGvfsName(name)?.label ?? uri}`, "network", "success");
    return true;
  };

  return {
    connect,
    disconnect,
    rememberUri: (mountPath: string, uri: string): void => {
      uriByPath.set(mountPath, uri);
    },
    uriForPath: (mountPath: string): string | undefined => uriByPath.get(mountPath),
  };
};
