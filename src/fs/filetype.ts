import { readFile } from "node:fs/promises";

// --- File type classification (extension -> icon-name category), shared by
// grid tiles, preview gating and the properties dialog. Returns icon NAMES
// only ("file-code", "zip-box", …); resolving names to glyphs lives in
// ./glyphs so this module never touches UI state. ---

// generic `file` is the fallback, mirroring nautilus's themed-icon fallback
// chain in spirit
export const FILE_ICON_BY_EXT: Record<string, string> = {
  js: "file-code",
  jsx: "file-code",
  mjs: "file-code",
  cjs: "file-code",
  ts: "file-code",
  tsx: "file-code",
  py: "file-code",
  rb: "file-code",
  rs: "file-code",
  go: "file-code",
  c: "file-code",
  h: "file-code",
  cpp: "file-code",
  cc: "file-code",
  hpp: "file-code",
  java: "file-code",
  kt: "file-code",
  swift: "file-code",
  cs: "file-code",
  php: "file-code",
  lua: "file-code",
  pl: "file-code",
  sh: "file-code",
  bash: "file-code",
  zsh: "file-code",
  fish: "file-code",
  ps1: "file-code",
  vue: "file-code",
  svelte: "file-code",
  html: "file-code",
  css: "file-code",
  scss: "file-code",
  sql: "file-code",
  json: "file-code",
  yaml: "file-code",
  yml: "file-code",
  toml: "file-code",
  xml: "file-code",
  ini: "file-code",
  conf: "file-code",
  zig: "file-code",
  nim: "file-code",
  ex: "file-code",
  exs: "file-code",
  hs: "file-code",
  ml: "file-code",
  r: "file-code",
  dart: "file-code",
  md: "file-document",
  markdown: "file-document",
  txt: "file-document",
  doc: "file-document",
  docx: "file-document",
  odt: "file-document",
  rtf: "file-document",
  log: "file-document",
  eps: "file-document",
  png: "file-image",
  jpg: "file-image",
  jpeg: "file-image",
  gif: "file-image",
  webp: "file-image",
  svg: "file-image",
  bmp: "file-image",
  ico: "file-image",
  tiff: "file-image",
  avif: "file-image",
  heic: "file-image",
  xcf: "file-image",
  mp4: "file-video",
  mkv: "file-video",
  avi: "file-video",
  mov: "file-video",
  webm: "file-video",
  wmv: "file-video",
  flv: "file-video",
  m4v: "file-video",
  mp3: "file-music",
  flac: "file-music",
  wav: "file-music",
  ogg: "file-music",
  oga: "file-music",
  m4a: "file-music",
  opus: "file-music",
  aac: "file-music",
  wma: "file-music",
  aiff: "file-music",
  zip: "zip-box",
  tar: "zip-box",
  gz: "zip-box",
  bz2: "zip-box",
  xz: "zip-box",
  zst: "zip-box",
  "7z": "zip-box",
  rar: "zip-box",
  cab: "zip-box",
  apk: "android",
  aab: "android",
  apks: "android",
  xapk: "android",
  jar: "zip-box",
  pdf: "file-pdf-box",
  iso: "disc",
  iso9660: "disc",
  img: "disc",
  bin: "disc",
  cue: "disc",
  mdf: "disc",
  nrg: "disc",
  cso: "disc",
  exe: "cog-box",
  msi: "cog-box",
  bat: "cog-box",
  cmd: "cog-box",
  com: "cog-box",
  dll: "cog-box",
  sys: "cog-box",
  so: "cog-box",
  o: "cog-box",
  a: "cog-box",
  class: "cog-box",
  appimage: "cog-box",
  deb: "package",
  rpm: "package",
  ttf: "file-font",
  otf: "file-font",
  woff: "file-font",
  woff2: "file-font",
  ttc: "file-font",
  eot: "file-font",
  epub: "book-open",
  mobi: "book-open",
  azw: "book-open",
  azw3: "book-open",
  fb2: "book-open",
  crt: "certificate",
  cer: "certificate",
  der: "certificate",
  pem: "certificate",
  key: "certificate",
  p12: "certificate",
  pfx: "certificate",
  blend: "cube",
  dwg: "cube",
  obj: "cube",
  stl: "cube",
  fbx: "cube",
  glb: "cube",
  eml: "email",
  torrent: "magnet",
  db: "database",
  sqlite: "database",
  sqlite3: "database",
  db3: "database",
  dmg: "harddisk",
  vhdx: "harddisk",
  vdi: "harddisk",
  qcow2: "harddisk",
  kra: "file-image",
};

// shared-mime-info database (same data nautilus's GIO consults): ext -> mime,
// highest-weight glob wins. Loaded once at boot; absent file degrades silently.
let globs2ByExt: Map<string, string> | null = null;
const globs2Weight = new Map<string, number>();

export async function loadGlobs2(): Promise<void> {
  try {
    const text = await readFile("/usr/share/mime/globs2", "utf8");
    for (const line of text.split("\n")) {
      if (!line || line.startsWith("#")) continue;
      const parts = line.split(":");
      if (parts.length < 3 || !parts[0] || !parts[1] || !parts[2]) continue;
      const weight = parseInt(parts[0], 10);
      const mime = parts[1];
      const glob = parts[2];
      if (!Number.isFinite(weight) || !glob.startsWith("*.")) continue;
      const ext = glob.slice(2).toLowerCase();
      if (!ext || ext.includes("*") || ext.includes("?") || ext.includes("[")) continue;
      const prevW = globs2Weight.get(ext);
      if (prevW === undefined || weight > prevW) {
        globs2ByExt ??= new Map();
        globs2ByExt.set(ext, mime);
        globs2Weight.set(ext, weight);
      }
    }
  } catch {}
}

export const mimeForExt = (ext: string): string | undefined => globs2ByExt?.get(ext.toLowerCase());

// --- macOS UTI → MIME (Spotlight `mdls kMDItemContentType` reports UTIs,
// not MIME types). Hand table for the common tree; unknown UTIs fall through
// to `file --mime-type` + the ext map in mimeForPath below. ---
const UTI_TO_MIME: Record<string, string> = {
  "public.plain-text": "text/plain",
  "public.utf8-plain-text": "text/plain",
  "public.utf16-plain-text": "text/plain",
  "public.text": "text/plain",
  "public.html": "text/html",
  "public.xml": "application/xml",
  "public.yaml": "application/yaml",
  "public.json": "application/json",
  "public.source-code": "text/plain",
  "public.script": "text/plain",
  "public.shell-script": "application/x-sh",
  "com.apple.property-list": "application/x-plist",
  "public.png": "image/png",
  "public.jpeg": "image/jpeg",
  "public.tiff": "image/tiff",
  "public.gif": "image/gif",
  "public.svg-image": "image/svg+xml",
  "public.heic": "image/heic",
  "public.heif": "image/heif",
  "public.avif": "image/avif",
  "com.microsoft.bmp": "image/bmp",
  "com.truevision.tga-image": "image/x-tga",
  "public.mpeg-4": "video/mp4",
  "public.avi": "video/x-msvideo",
  "public.mpeg": "video/mpeg",
  "public.mov": "video/quicktime",
  "public.mp3": "audio/mpeg",
  "public.aiff-audio": "audio/aiff",
  "public.wav": "audio/wav",
  "public.mpeg-4-audio": "audio/mp4",
  "com.adobe.pdf": "application/pdf",
  "public.zip-archive": "application/zip",
  "public.tar-archive": "application/x-tar",
  "public.archive": "application/octet-stream",
  "public.disk-image": "application/x-apple-diskimage",
  "public.folder": "public.folder",
  "public.data": "application/octet-stream",
  "public.executable": "application/octet-stream",
  "public.unix-executable": "application/octet-stream",
  "com.apple.application-bundle": "application/octet-stream",
  "com.microsoft.word.doc": "application/msword",
  "org.openxmlformats.wordprocessingml.document":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "public.rtf": "application/rtf",
  "public.epub": "application/epub+zip",
  "public.font": "font/collection",
  "public.truetype-font": "font/ttf",
  "public.opentype-font": "font/otf",
};

export const utiToMime = (uti: string): string | undefined => UTI_TO_MIME[uti.trim()];

// content-type probe for a path: mdls UTI → table, else `file --mime-type`,
// else the shared-mime-info ext map. `run` injectable so tests never shell
// out. Linux callers keep xdg-mime (see apps.ts); this is the darwin lane.
export const mimeForPath = async (
  p: string,
  run: (cmd: string[]) => Promise<string> = async () => "",
): Promise<string | undefined> => {
  try {
    const uti = (await run(["mdls", "-raw", "-name", "kMDItemContentType", p])).trim();
    const mapped = uti ? utiToMime(uti) : undefined;
    if (mapped) return mapped;
  } catch {}
  try {
    const out = (await run(["file", "-b", "--mime-type", p])).trim().split(";")[0]?.trim();
    if (out) return out;
  } catch {}
  return mimeForExt(extOf(p));
};

const ARCHIVE_MIMES = new Set([
  "application/zip",
  "application/gzip",
  "application/x-gzip",
  "application/bzip2",
  "application/x-bzip2",
  "application/x-xz",
  "application/x-7z-compressed",
  "application/vnd.rar",
  "application/x-rar-compressed",
  "application/zstd",
  "application/x-tar",
  "application/java-archive",
  "application/vnd.android.package-archive",
  "application/vnd.ms-cab-compressed",
]);

const EXE_MIMES = new Set(["application/x-msdownload"]);

const PACKAGE_MIMES = new Set(["application/vnd.debian.binary-package", "application/x-rpm"]);

const EBOOK_MIMES = new Set(["application/epub+zip"]);

const CERT_MIMES = new Set(["application/pkix-cert", "application/x-x509-ca-cert"]);

const TORRENT_MIMES = new Set(["application/x-bittorrent"]);

const DB_MIMES = new Set(["application/x-sqlite3", "application/vnd.sqlite3"]);

// optical disc images (same data nautilus consults): ext-table entries above
// cover the common extensions; this set catches the long tail that only
// resolves via globs2 (e.g. .cdr-style variants)
const OPTICAL_MIMES = new Set([
  "application/x-cd-image",
  "application/vnd.efi.iso",
  "application/x-compressed-iso",
  "application/x-cue",
  "application/x-nrg",
]);

export const mimeCategory = (mime: string): string => {
  const media = mime.split("/")[0] ?? "";
  if (media === "image") return "file-image";
  if (media === "video") return "file-video";
  if (media === "audio") return "file-music";
  if (media === "font") return "file-font";
  if (media === "message") return "email";
  if (ARCHIVE_MIMES.has(mime)) return "zip-box";
  if (OPTICAL_MIMES.has(mime)) return "disc";
  if (EXE_MIMES.has(mime)) return "cog-box";
  if (PACKAGE_MIMES.has(mime)) return "package";
  if (EBOOK_MIMES.has(mime)) return "book-open";
  if (CERT_MIMES.has(mime)) return "certificate";
  if (TORRENT_MIMES.has(mime)) return "magnet";
  if (DB_MIMES.has(mime)) return "database";
  if (mime === "application/pdf") return "file-pdf-box";
  if (
    /^text\/x-/.test(mime) ||
    [
      "text/html",
      "text/css",
      "application/javascript",
      "application/json",
      "application/xml",
      "application/yaml",
    ].includes(mime) ||
    mime.endsWith("+xml") ||
    mime.endsWith("+json")
  )
    return "file-code";
  if (
    media === "text" ||
    /^(application\/msword|application\/rtf|application\/vnd\.oasis\.opendocument\.text)/.test(mime)
  )
    return "file-document";
  return "file";
};

// lowercased extension without the dot; dotfiles (".bashrc") have none.
// Manual scan instead of path.extname (same contract, ~2x — path.extname
// re-scans the string; measured in scripts/bench-ts-vs-zig.ts, equivalent
// over a 500k-input fuzz incl. trailing dots/slashes and dots in dir segments).
export const extOf = (name: string): string => {
  let end = name.length;
  while (end > 0 && name.charCodeAt(end - 1) === 47) end--;
  if (end === 0) return "";
  const dot = name.lastIndexOf(".", end - 1);
  if (dot < 0) return "";
  if (dot <= name.lastIndexOf("/", end - 1) + 1) return "";
  return name.slice(dot + 1, end).toLowerCase();
};

export const fileIconFor = (name: string): string => {
  const ext = extOf(name);
  const direct = FILE_ICON_BY_EXT[ext];
  if (direct) return direct;
  // the mime table is loaded at boot and may be absent in tests
  const mime = globs2ByExt?.get(ext);
  return (mime ? mimeCategory(mime) : undefined) ?? "file";
};

export const fileIsImage = (name: string): boolean => {
  const ext = extOf(name);
  if (FILE_ICON_BY_EXT[ext] === "file-image") return true;
  const mime = globs2ByExt?.get(ext);
  return !!mime && mime.startsWith("image/");
};

export const fileIsVideo = (name: string): boolean => {
  const ext = extOf(name);
  // ext table first: `.ts` is TypeScript for us even though globs2 says video/mp2t
  if (FILE_ICON_BY_EXT[ext] === "file-video") return true;
  const mime = globs2ByExt?.get(ext);
  return !!mime && mime.startsWith("video/");
};

export const fileIsAudio = (name: string): boolean => {
  const ext = extOf(name);
  if (FILE_ICON_BY_EXT[ext] === "file-music") return true;
  const mime = globs2ByExt?.get(ext);
  return !!mime && mime.startsWith("audio/");
};

export const fileIsGif = (name: string): boolean => {
  const ext = extOf(name);
  if (ext === "gif") return true;
  const mime = globs2ByExt?.get(ext);
  return mime === "image/gif";
};

// Frames of a GIF (the count an animated one animates), read from the block
// structure: header + logical screen descriptor, then image descriptors (0x2C)
// counted, extension (0x21) and image data skipped by their sub-block lengths.
// 0 = not a GIF or a truncated walk (never throws, never over-counts — a
// corrupt tail stops the count where it broke).
export const gifFrameCount = (bytes: Uint8Array): number => {
  try {
    if (bytes.length < 13) return 0;
    if (String.fromCharCode(bytes[0] ?? 0, bytes[1] ?? 0, bytes[2] ?? 0) !== "GIF") return 0;
    const packed = bytes[10] ?? 0;
    // 0x80 = global color table present, low 3 bits = its size exponent
    let p = 13 + (packed & 0x80 ? 3 * 2 ** ((packed & 7) + 1) : 0);
    // sub-blocks: one length byte + that many bytes, 0-length terminator ends
    const skipBlocks = (from: number): number => {
      let q = from;
      for (;;) {
        if (q >= bytes.length) return -1;
        const len = bytes[q] ?? 0;
        if (len === 0) return q + 1;
        q += 1 + len;
      }
    };
    let frames = 0;
    for (;;) {
      if (p >= bytes.length) return frames;
      const block = bytes[p];
      if (block === 0x3b) return frames; // trailer
      if (block === 0x21) {
        const next = skipBlocks(p + 2); // 0x21 + extension label
        if (next < 0) return frames;
        p = next;
        continue;
      }
      if (block !== 0x2c) return frames; // corrupt block: keep what we counted
      // image descriptor: separator + left/top/width/height + packed = 10 bytes
      if (p + 10 > bytes.length) return frames;
      const imgFlags = bytes[p + 9] ?? 0;
      const next = skipBlocks(p + 10 + (imgFlags & 0x80 ? 3 * 2 ** ((imgFlags & 7) + 1) : 0) + 1);
      if (next < 0) return frames;
      frames++;
      p = next;
    }
  } catch {
    return 0;
  }
};
