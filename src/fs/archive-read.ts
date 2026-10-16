import { statSync } from "node:fs";
import { detectArchiveFormat, type ArchiveFormat } from "./archive";

// --- READ-ONLY archive listing for the preview pane: entry name + size per
// row. The archive ENGINE (extract/compress plans, tool argv, the js lanes)
// lives in ./archive.ts and is owned elsewhere — this file only CALLS its
// exported format detection and parses bytes itself. Nothing here extracts,
// writes, or descends into an archive. Pure parsers + one fs read; never
// throws, so a corrupt or exotic container paints nothing instead of dying. ---

export type ArchiveEntryInfo = { name: string; size: number };

// in-RAM parse: the preview must never OOM the renderer to list a container
export const ARCHIVE_LIST_MAX_BYTES = 64 * 1024 * 1024;
// shortcut: the .tar.gz lane gunzips in one shot, so only small ones get
// listed (a 64MB compressed stream can expand to gigabytes of headers),
// upgrade when a streaming gunzip is available for the header walk.
const ARCHIVE_GZ_MAX_BYTES = 16 * 1024 * 1024;
// rows the parser will hold; the pane shows far fewer
export const ARCHIVE_LIST_MAX_ENTRIES = 5000;

// formats with a pure (no-tool) reader here. 7z/rar/cab need their binaries,
// so their preview falls through to the generic file card.
const READABLE: ReadonlySet<ArchiveFormat> = new Set<ArchiveFormat>(["tar", "tar.gz", "zip"]);

const cstr = (b: Uint8Array, from: number, to: number): string => {
  let end = from;
  while (end < to && b[end] !== 0) end++;
  return Buffer.from(b.subarray(from, end)).toString("utf8");
};

// tar: 512-byte headers, name at 0..100 (ustar prefix at 345..500), size octal
// at 124..136, typeflag at 156. pax ('x'/'g') headers are skipped like `tar -t`
// skips them — listing them would show phantom entries.
export const tarEntries = (bytes: Uint8Array, limit = ARCHIVE_LIST_MAX_ENTRIES): ArchiveEntryInfo[] => {
  const out: ArchiveEntryInfo[] = [];
  let p = 0;
  for (;;) {
    if (out.length >= limit || p + 512 > bytes.length) return out;
    let zero = true;
    for (let i = 0; i < 512; i++) {
      if (bytes[p + i] !== 0) {
        zero = false;
        break;
      }
    }
    if (zero) return out; // end-of-archive marker (two zero blocks)
    let end = p + 124;
    while (end < p + 136 && bytes[end] !== 0 && bytes[end] !== 0x20) end++;
    const size = Number.parseInt(Buffer.from(bytes.subarray(p + 124, end)).toString("latin1"), 8);
    // base-256 (GNU >8GB) sizes: corrupt here, not a lie
    if (!Number.isSafeInteger(size) || size < 0) return out;
    const name = cstr(bytes, p, p + 100);
    const prefix = cstr(bytes, p + 345, p + 500);
    const type = bytes[p + 156];
    p += 512 + Math.ceil(size / 512) * 512;
    if (p > bytes.length) return out;
    // eslint-disable-next-line no-bitwise
    if (type !== 0x78 && type !== 0x67 && name) {
      out.push({ name: prefix ? `${prefix}/${name}` : name, size });
    }
  }
};

// zip: names + uncompressed sizes from the central directory (the local
// headers carry no size for streamed entries). Zip64 (0xFFFF counts) yields
// nothing rather than a misparse; a truncated walk yields what it reached.
export const zipEntries = (bytes: Uint8Array, limit = ARCHIVE_LIST_MAX_ENTRIES): ArchiveEntryInfo[] => {
  const out: ArchiveEntryInfo[] = [];
  try {
    if (bytes.length < 22) return out;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    const floor = Math.max(0, bytes.length - (65557 + 22));
    for (let eocd = bytes.length - 22; eocd >= floor; eocd--) {
      if (view.getUint32(eocd, true) !== 0x06054b50) continue;
      const total = view.getUint16(eocd + 10, true);
      if (total === 0xffff) return out;
      let p = view.getUint32(eocd + 16, true);
      for (let i = 0; i < total && out.length < limit; i++) {
        if (p + 46 > bytes.length || view.getUint32(p, true) !== 0x02014b50) return out;
        const nameLen = view.getUint16(p + 28, true);
        // flag bit 11 = UTF-8; otherwise the name is a legacy codepage
        // eslint-disable-next-line no-bitwise
        const utf8 = (view.getUint16(p + 8, true) & 0x800) !== 0;
        out.push({
          name: Buffer.from(bytes.subarray(p + 46, p + 46 + nameLen)).toString(utf8 ? "utf8" : "latin1"),
          size: view.getUint32(p + 24, true),
        });
        p += 46 + nameLen + view.getUint16(p + 30, true) + view.getUint16(p + 32, true);
      }
      return out;
    }
    return out;
  } catch {
    return out;
  }
};

// entries of `file`, or null when there is nothing to list (not an archive we
// read, unreadable, or past the memory guard the pane's render loop needs).
export const readArchiveEntries = async (
  file: string,
  fmt: ArchiveFormat | null = detectArchiveFormat(file),
  limit = ARCHIVE_LIST_MAX_ENTRIES,
): Promise<ArchiveEntryInfo[] | null> => {
  if (!fmt || !READABLE.has(fmt)) return null;
  try {
    const st = statSync(file, { throwIfNoEntry: false });
    if (!st?.isFile()) return null;
    const cap = fmt === "tar.gz" ? ARCHIVE_GZ_MAX_BYTES : ARCHIVE_LIST_MAX_BYTES;
    if (st.size > cap) return null;
    const raw = new Uint8Array(await Bun.file(file).bytes());
    if (fmt === "zip") return zipEntries(raw, limit);
    const tar = fmt === "tar.gz" ? Bun.gunzipSync(raw) : raw;
    return tarEntries(tar, limit);
  } catch {
    return null;
  }
};
