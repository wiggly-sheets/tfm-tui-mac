import path from "node:path";
import { fmtBytes, fmtDate, idName, mimeLabelFor, permWords } from "./propsinfo";

// --- Pure info-sidebar model: a resolved selection in, display rows out. No
// fs, no renderer, no app state — the UI module (./ui-info) does the stat'ing
// and the async dir walks, then hands the numbers here. Formatting helpers are
// the SAME ones the properties dialog uses (./propsinfo) so the two views of
// one file can never disagree. ---

export type InfoRow = { label: string; value: string };

// structural subset of node:fs Stats — real Stats satisfies it, and tests can
// build a literal without touching disk.
export type InfoStat = {
  size: number;
  mode: number;
  uid: number;
  gid: number;
  mtimeMs: number;
  atimeMs: number;
  birthtimeMs: number;
  isDirectory(): boolean;
};

// recursive dir totals; "pending" while the walk runs, null when the tree is
// too large to scan (dirWalkStats gives up past 200k entries)
export type DirInfo = { bytes: number; files: number; folders: number } | "pending" | null;

export type InfoSelection =
  | { kind: "none" }
  | { kind: "single"; path: string; st: InfoStat; home: string; dir?: DirInfo }
  | { kind: "multi"; count: number; bytes: number; files: number; folders: number };

// rwx triad as the familiar octal string (mode & 0o777), e.g. 644 -> "644"
export const permOctal = (mode: number): string => (mode & 0o777).toString(8).padStart(3, "0");

const dirItemsText = (d: DirInfo): string =>
  d === "pending"
    ? "calculating…"
    : d === null
      ? "200k+ entries — too large to scan"
      : `${d.files} files · ${d.folders} folders`;

const dirSizeText = (d: DirInfo): string =>
  d === "pending" ? "calculating…" : d === null ? "200k+ entries — too large to scan" : fmtBytes(d.bytes);

export const infoRows = (sel: InfoSelection): InfoRow[] => {
  if (sel.kind === "none") return [];
  if (sel.kind === "multi") {
    return [
      { label: "selected", value: `${sel.count} items` },
      { label: "size", value: fmtBytes(sel.bytes) },
      { label: "items", value: `${sel.files} files · ${sel.folders} folders` },
    ];
  }
  const { path: p, st } = sel;
  const isDir = st.isDirectory();
  const rows: InfoRow[] = [
    { label: "name", value: path.basename(p) },
    { label: "kind", value: isDir ? "folder" : mimeLabelFor(p) },
  ];
  if (isDir) {
    rows.push({ label: "items", value: dirItemsText(sel.dir ?? null) });
    rows.push({ label: "size", value: dirSizeText(sel.dir ?? null) });
  } else {
    rows.push({ label: "size", value: `${fmtBytes(st.size)} (${st.size} bytes)` });
  }
  rows.push(
    { label: "created", value: fmtDate(st.birthtimeMs) },
    { label: "modified", value: fmtDate(st.mtimeMs) },
    { label: "accessed", value: fmtDate(st.atimeMs) },
    // owner/group reuse the props dialog's id-name lookup (uid:gid), and the
    // permission words reuse permWords (execute reads as "enter" for folders)
    { label: "permissions", value: `${permOctal(st.mode)} · ${permWords(st.mode, 6, isDir)}` },
    { label: "owner", value: `${idName(st.uid)}:${idName(st.gid)}` },
    { label: "path", value: p.replace(sel.home, "~") },
  );
  return rows;
};
