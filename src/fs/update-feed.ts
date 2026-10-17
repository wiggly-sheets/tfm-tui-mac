// --- Self-update side effects: install marker, update-check cache, GitHub
// fetch, verified download, atomic replace. Everything external is injectable
// (fetch impl, exec path, temp dir) so the tests never touch the network; the
// pure decision rules live in ../app/update. Mirrors install.sh's install_binary
// (sibling temp + rename) so a running tfm never sees a half-written binary. ---

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { chmod, cp, mkdir, rename as fsRename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "fflate";
import { latestReleaseApiUrl, type UpdateCheckCache } from "../app/update";
import { atomicWriteFile, fsyncPath } from "./fsutil";
import { spawnSafe } from "./spawn-safe";

const DEFAULT_TIMEOUT_MS = 8000;

// `${XDG_DATA_HOME:-$HOME/.local/share}/tfm` — the install.sh data root.
export const tfmDataDir = (): string =>
  path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"), "tfm");

export const installMarkerPath = (): string => path.join(tfmDataDir(), "install.json");
export const updateCheckPath = (): string => path.join(tfmDataDir(), "update-check.json");

const readJson = (p: string): unknown => {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
};

export const readInstallMarker = (): unknown => readJson(installMarkerPath());

export const readUpdateCheck = (): UpdateCheckCache | null => {
  const raw = readJson(updateCheckPath());
  return typeof raw === "object" && raw !== null ? (raw as UpdateCheckCache) : null;
};

export const writeUpdateCheck = async (cache: UpdateCheckCache): Promise<void> => {
  const p = updateCheckPath();
  await mkdir(path.dirname(p), { recursive: true });
  await atomicWriteFile(p, JSON.stringify(cache));
};

// Physical directory the running executable lives in (symlinks resolved, so it
// compares equal to the marker's installDir — the install.sh copy).
export const installDirOf = (execPath: string): string => {
  try {
    return path.dirname(realpathSync(execPath));
  } catch {
    return path.dirname(execPath);
  }
};

export type FetchDeps = { fetchImpl?: typeof fetch; timeoutMs?: number };

export type LatestRelease = { tag: string; assets: string[] };

// The release JSON carries both the tag and the asset list, so the ffmpeg
// sidecar can be offered only when the release actually ships it. Any failure
// is "no release known", never a throw.
export const fetchLatestRelease = async (deps: FetchDeps = {}): Promise<LatestRelease | null> => {
  const f = deps.fetchImpl ?? fetch;
  try {
    const res = await f(latestReleaseApiUrl, {
      signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      headers: { accept: "application/vnd.github+json" },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { tag_name?: unknown; assets?: unknown };
    if (typeof body.tag_name !== "string" || !body.tag_name) return null;
    const assets = Array.isArray(body.assets)
      ? body.assets.map((a) => (a as { name?: unknown }).name).filter((n): n is string => typeof n === "string")
      : [];
    return { tag: body.tag_name, assets };
  } catch {
    return null;
  }
};

export const fetchLatestTag = async (deps: FetchDeps = {}): Promise<string | null> =>
  (await fetchLatestRelease(deps))?.tag ?? null;

const fetchBytes = async (f: typeof fetch, url: string, timeoutMs: number): Promise<Uint8Array> => {
  const res = await f(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
};

// Download `<base>/<asset>` + its `.sha256`, verify, gunzip, chmod 0755 into
// `dir`. Returns the staged path. Throws (and leaves nothing behind) on any
// failure — checksum included, so a corrupted download never reaches the swap.
export const downloadVerifiedBinary = async (input: {
  base: string;
  asset: string;
  dir: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<string> => {
  const f = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const out = path.join(input.dir, input.asset.replace(/\.gz$/, ""));
  try {
    const gz = await fetchBytes(f, `${input.base}/${input.asset}`, timeoutMs);
    const sidecar = new TextDecoder().decode(await fetchBytes(f, `${input.base}/${input.asset}.sha256`, timeoutMs));
    // The sidecar is `<digest> <filename>` (install.sh compares the first token
    // the same way). An empty/whitespace sidecar is a missing checksum, not a
    // match: a self-updater that cannot verify must refuse, never swap.
    const want = sidecar.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
    if (!want) throw new Error("no checksum published");
    const got = createHash("sha256").update(gz).digest("hex");
    if (want !== got) throw new Error("checksum mismatch");
    await writeFile(out, gunzipSync(gz));
    await chmod(out, 0o755);
    return out;
  } catch (err) {
    await rm(out, { force: true }).catch(() => {});
    throw err;
  }
};

// Sibling temp + rename, same shape as install.sh's `$DEST/.tfm-new.$$`: the
// target is either the old binary or the complete new one, never a truncation.
export const replaceBinaryAtomic = async (src: string, dest: string): Promise<void> => {
  const tmp = `${dest}.tfm-new.${process.pid}`;
  try {
    await cp(src, tmp);
    await chmod(tmp, 0o755);
    await fsyncPath(tmp);
    await fsRename(tmp, dest);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
};

// install.sh also installs a second command name. Refresh it ONLY when it is
// already there — a user who never had it must not get it from an update.
export const refreshSecondName = async (dir: string): Promise<void> => {
  const link = path.join(dir, "terminal-file-manager");
  // lstat, not existsSync: a dangling symlink IS present (and should be fixed)
  try {
    lstatSync(link);
  } catch {
    return;
  }
  const target = path.join(dir, "tfm");
  try {
    await rm(link, { force: true });
    await symlink(target, link);
    return;
  } catch {}
  // no symlinks on this filesystem (exFAT/vfat): install a copy instead
  try {
    await cp(target, link);
  } catch {}
};

// best-effort bounded child run: stdout as text + exit code (null on spawn
// failure or timeout). Used for the staged-binary smoke test.
export const smokeRun = (
  bin: string,
  args: string[],
  timeoutMs = 15000,
): Promise<{ code: number | null; stdout: string }> =>
  new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    const done = (code: number | null): void => {
      if (settled) return;
      settled = true;
      resolve({ code, stdout });
    };
    let child: ReturnType<typeof spawnSafe> | null = null;
    try {
      child = spawnSafe(bin, args, { stdio: ["ignore", "pipe", "ignore"], timeoutMs }, () => done(null));
    } catch {
      done(null);
      return;
    }
    if (!child) {
      done(null);
      return;
    }
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.on("close", (code) => done(code));
    child.on("error", () => done(null));
  });
