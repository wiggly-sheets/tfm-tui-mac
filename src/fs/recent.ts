import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { mimeForExt } from "./filetype";
import { parseIso, pathToUri, uriToPath, xdgDataHome, xdgStateHome } from "./uri";
import { isDarwin } from "./darwin";
import { swallow } from "../app/log";

// --- Recent files (freedesktop recently-used.xbel) + tfm's starred registry.
// Persistence only: read/write these two registries, nothing else. Batching
// opens and building grid Entries live in ./recent-open and ./listing. ---

type XbelItem = { path: string; modified: number };

const xbelPath = (): string => path.join(xdgDataHome(), "recently-used.xbel");

// mdfind line parser: shared by the sync test seam and the async boot path.
// Undated (modified 0 sorts after dated), capped, existence-checked.
const parseMdfindLines = (raw: string, exists: (p: string) => boolean, limit: number): XbelItem[] => {
  const out: XbelItem[] = [];
  const seen = new Set<string>();
  for (const line of raw.split("\n")) {
    const p = line.trim();
    if (!p || !path.isAbsolute(p) || seen.has(p)) continue;
    try {
      if (!exists(p)) continue;
    } catch {
      continue;
    }
    seen.add(p);
    out.push({ path: p, modified: 0 });
    if (out.length >= limit) break;
  }
  return out;
};

// async mdfind runner: execFileSync runs on the main thread and a hung
// Spotlight daemon froze the Recent pane's first paint for up to 10s. Bun.spawn
// with the same timeout lets the event loop stay live; failure → [] silently.
const mdfindRecentAsync = async (limit: number): Promise<XbelItem[]> => {
  try {
    const proc = Bun.spawn(["mdfind", "-onlyin", os.homedir(), "kMDItemLastUsedDate >= $time.today(-30)"], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    });
    const raw = await new Response(proc.stdout).text();
    await proc.exited;
    return parseMdfindLines(raw, existsSync, limit);
  } catch {
    return [];
  }
};

// darwin best-effort supplement: files OTHER apps opened recently
// (kMDItemLastUsedDate). tfm's own opens still land in xbel via
// upsertRecentXbel, so Recent works with zero Spotlight dependence —
// this only widens it. Sync signature stays for tests (the injected run
// is a plain string producer); the boot path goes through mdfindRecentAsync.
export const readDarwinRecent = (
  run: () => string = () =>
    execFileSync("mdfind", ["-onlyin", os.homedir(), "kMDItemLastUsedDate >= $time.today(-30)"], {
      timeout: 10_000,
    }).toString(),
  exists: (p: string) => boolean = existsSync,
  limit = 200,
): XbelItem[] => {
  try {
    return parseMdfindLines(run(), exists, limit);
  } catch {
    return [];
  }
};

const mergeRecent = (dated: XbelItem[], undated: XbelItem[]): XbelItem[] => {
  const seen = new Set<string>();
  const uniq: XbelItem[] = [];
  for (const it of [...dated.sort((a, b) => b.modified - a.modified), ...undated]) {
    if (seen.has(it.path)) continue;
    seen.add(it.path);
    uniq.push(it);
  }
  return uniq;
};

// sync variant: tests + linux (no mdfind). The darwin Spotlight supplement is
// injected via `run` (a sync string producer) so tests stay hermetic; the boot
// path uses readRecentXbelAsync instead (mdfind on Bun.spawn, never blocking
// the main thread — a hung Spotlight daemon used to freeze the Recent pane's
// first paint for up to 10s).
export const readRecentXbel = (platform: string = process.platform, run: () => string = () => ""): XbelItem[] => {
  // sandboxed tree (XDG_DATA_HOME set: tests, secondary profiles): the xbel
  // is that context's whole truth — merging the host's global Spotlight
  // recents would leak another profile's files into this one
  const darwin = isDarwin(platform) && !process.env.XDG_DATA_HOME;
  let xml = "";
  try {
    xml = readFileSync(xbelPath(), "utf8");
  } catch {
    return darwin ? mergeRecent([], readDarwinRecent(run)) : [];
  }
  const out: XbelItem[] = [];
  const bmRe = /<bookmark\b[^>]*href="([^"]+)"[^>]*>/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: classic exec-loop idiom
  while ((m = bmRe.exec(xml))) {
    const href = m[1];
    if (href === undefined) continue;
    const p = uriToPath(href);
    if (!p) continue;
    // modified attr lives on the same tag; fall back to the application entry
    const tag = m[0];
    const mod = tag.match(/modified="([^"]+)"/)?.[1];
    out.push({ path: p, modified: mod ? parseIso(mod) : 0 });
  }
  // newest first, one row per file (+ darwin Spotlight supplement, deduped)
  return darwin ? mergeRecent(out, readDarwinRecent(run)) : mergeRecent(out, []);
};

// production boot path: async mdfind so a hung Spotlight daemon can't block the
// event loop. Degrades to [] on any failure (same as the sync variant).
export const readRecentXbelAsync = async (platform: string = process.platform): Promise<XbelItem[]> => {
  const darwin = isDarwin(platform) && !process.env.XDG_DATA_HOME;
  let xml = "";
  try {
    xml = readFileSync(xbelPath(), "utf8");
  } catch {
    return darwin ? mergeRecent([], await mdfindRecentAsync(200)) : [];
  }
  const out: XbelItem[] = [];
  const bmRe = /<bookmark\b[^>]*href="([^"]+)"[^>]*>/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: classic exec-loop idiom
  while ((m = bmRe.exec(xml))) {
    const href = m[1];
    if (href === undefined) continue;
    const p = uriToPath(href);
    if (!p) continue;
    const tag = m[0];
    const mod = tag.match(/modified="([^"]+)"/)?.[1];
    out.push({ path: p, modified: mod ? parseIso(mod) : 0 });
  }
  return darwin ? mergeRecent(out, await mdfindRecentAsync(200)) : mergeRecent(out, []);
};

export const upsertRecentXbel = async (paths: string[]): Promise<void> => {
  try {
    let xml = "";
    try {
      xml = await readFile(xbelPath(), "utf8");
    } catch {}
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    type Kept = { uri: string; block: string };
    const kept: Kept[] = [];
    const counts = new Map<string, number>();
    const bmRe = /[ \t]*<bookmark\b[\s\S]*?<\/bookmark>[ \t]*\n?/g;
    for (const blk of xml.match(bmRe) ?? []) {
      const uri = blk.match(/href="([^"]+)"/)?.[1];
      if (!uri) continue;
      if (paths.some((p) => pathToUri(p) === uri)) {
        counts.set(uri, parseInt(blk.match(/count="(\d+)"/)?.[1] ?? "0", 10) + 1);
        continue;
      }
      kept.push({ uri, block: blk.trim() });
    }
    for (const p of paths) {
      const uri = pathToUri(p);
      const mime = mimeForExt(path.extname(p).slice(1)) ?? "application/octet-stream";
      const count = counts.get(uri) ?? 1;
      kept.push({
        uri,
        block: `  <bookmark href="${uri}" added="${now}" modified="${now}" visited="${now}">
    <info>
      <metadata owner="http://freedesktop.org">
        <mime:mime-type type="${mime}"/>
        <bookmark:applications>
          <bookmark:application name="tfm" exec="&apos;tfm&apos;" modified="${now}" count="${count}"/>
        </bookmark:applications>
      </metadata>
    </info>
  </bookmark>`,
      });
    }
    const head = `<?xml version="1.0" encoding="UTF-8"?>
<xbel version="1.0"
      xmlns:bookmark="http://www.freedesktop.org/standards/desktop-bookmarks"
      xmlns:mime="http://www.freedesktop.org/standards/shared-mime-info">
`;
    const body = kept
      .slice(-500)
      .map((k) => k.block)
      .join("\n");
    await writeFile(xbelPath(), `${head}${body}\n</xbel>\n`, "utf8");
  } catch (err) {
    // silently losing the recents rewrite looks like "tfm forgot my files"
    swallow("recent xbel write", err);
  }
};

// Starred registry: tfm's own list, kept in sync with gvfs metadata so
// nautilus sees the same stars (gio set metadata::starred).
const starredListPath = (): string => path.join(xdgStateHome(), "tfm", "starred.list");

export const readStarredList = (): string[] => {
  try {
    return readFileSync(starredListPath(), "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
};

export const writeStarredList = async (paths: string[]): Promise<void> => {
  try {
    await mkdir(path.dirname(starredListPath()), { recursive: true });
    await writeFile(starredListPath(), `${[...new Set(paths)].join("\n")}\n`, "utf8");
  } catch (err) {
    swallow("starred list write", err);
  }
};

export const starredRegistryAdd = (p: string): void => {
  void writeStarredList([...readStarredList(), p]);
};
export const starredRegistryRemove = (p: string): void => {
  void writeStarredList(readStarredList().filter((x) => x !== p));
};
