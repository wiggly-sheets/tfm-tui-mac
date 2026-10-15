// --- Nerd Font glyphs: FALLBACK ONLY ---
// Used when no SVG rasterizer is installed (resvg/rsvg-convert) or a raster
// hasn't drained yet.
// Codepoints verified against the MesloLGLDZ Nerd Font Mono cmap — never
// paste guessed ones (see AGENTS.md "Icons").
//
// Two styles ([ui] icon-style): every slot keeps its filled codepoint under
// the base name, and slots with an MDI outline sibling carry it under
// `<name>-outline` (same suffix as the outline SVG assets, so the coverage
// test sees both). Slots with no outline sibling (power, sort, pause,
// content-*, chevrons, …) have no -outline entry and resolve filled.
// close/check stay filled-only deliberately: their MDI "outline" variants
// are different busy icons (multi-X, double-check), not hollow versions.
import type { IconStyle } from "../config/config-schema";

// The generic file glyph, NAMED rather than looked up: every file-type category
// falls back to it (and ensureGlyphFallbacks fills the table from it), so it
// needs to be a value the type system knows is present, not a Record lookup.
// Defined before glyphChains so it can be referenced inline.
export const FILE_GLYPH = "\u{F0214}";

// Fallback chains for common Nerd Fonts. Each entry tries primary (Meslo-verified),
// then alternatives for JetBrainsMono, FiraCode, Hack, UbuntuMono, etc.
// The first codepoint present in the terminal's font will render correctly.
type GlyphChain = string | string[];

const glyphChains: Record<string, GlyphChain> = {
  // Core UI icons (Material Design Icons)
  home: ["\u{F02DC}", "\u{E88A}", "\u{F015}"],
  star: ["\u{F04CE}", "\u{E838}", "\u{F005}"],
  clock: ["\u{F0954}", "\u{E876}", "\u{F017}"],
  bookmark: ["\u{F00C6}", "\u{E896}", "\u{F02E}"],
  "trash-can": ["\u{F0A79}", "\u{E872}", "\u{F1F8}"],
  folder: ["\u{F024B}", "\u{E88D}", "\u{F07B}"],
  "folder-outline": ["\u{F0256}", "\u{E88E}", "\u{F114}"],
  "home-outline": ["\u{F06A1}", "\u{E8E9}", "\u{F015}"],
  "star-outline": ["\u{F04D2}", "\u{E8EA}", "\u{F005}"],
  "clock-outline": ["\u{F0150}", "\u{E8EB}", "\u{F017}"],
  "bookmark-outline": ["\u{F00C3}", "\u{E8EC}", "\u{F02E}"],
  "trash-can-outline": ["\u{F0A7A}", "\u{E8ED}", "\u{F1F8}"],
  harddisk: ["\u{F02CA}", "\u{E88F}", "\u{F0A0}"],
  usb: ["\u{F0553}", "\u{E890}", "\u{F287}"],
  network: ["\u{F059F}", "\u{E891}", "\u{F1EB}"],
  eject: ["\u{F01EA}", "\u{E8E8}", "\u{F052}"],
  "eject-outline": ["\u{F0B91}", "\u{E8E9}", "\u{F052}"],
  search: ["\u{F0349}", "\u{E88B}", "\u{F002}"],
  "chevron-left": ["\u{F0141}", "\u{E8E5}", "\u{F053}"],
  "chevron-right": ["\u{F0142}", "\u{E8E6}", "\u{F054}"],
  "desktop-tower": ["\u{F01C5}", "\u{E8E7}", "\u{F085}"],
  file: FILE_GLYPH,
  "file-pdf-box": ["\u{F06D6}", "\u{E8F8}", "\u{F1C1}"],
  "file-outline": ["\u{F0224}", "\u{E88C}", "\u{F15B}"],
  cog: ["\u{F0493}", "\u{E8B8}", "\u{F013}"],
  "cog-outline": ["\u{F08BB}", "\u{E8B9}", "\u{F0AD}"],
  "power-plug": ["\u{F06A5}", "\u{E8BC}", "\u{F1E6}"],
  "power-plug-outline": ["\u{F1425}", "\u{E8BD}", "\u{F1E6}"],
  power: ["\u{F0425}", "\u{E8BC}", "\u{F011}"],
  eye: ["\u{F0208}", "\u{E8F4}", "\u{F06E}"],
  "eye-outline": ["\u{F06D0}", "\u{E8F5}", "\u{F06E}"],
  "eye-off": ["\u{F0209}", "\u{E8F6}", "\u{F070}"],
  "eye-off-outline": ["\u{F06D1}", "\u{E8F7}", "\u{F070}"],
  pencil: ["\u{F03EB}", "\u{E8E3}", "\u{F040}"],
  "pencil-outline": ["\u{F0CB6}", "\u{E8E4}", "\u{F303}"],
  "checkbox-marked": ["\u{F0132}", "\u{E873}", "\u{F046}"],
  "checkbox-marked-outline": ["\u{F0135}", "\u{E874}", "\u{F096}"],
  "checkbox-blank": ["\u{F012E}", "\u{E875}", "\u{F096}"],
  "checkbox-blank-outline": ["\u{F0131}", "\u{E875}", "\u{F096}"],
  play: ["\u{F040A}", "\u{E8E9}", "\u{F04B}"],
  "play-outline": ["\u{F0F1B}", "\u{E8EA}", "\u{F144}"],
  pause: ["\u{F03E4}", "\u{E8EB}", "\u{F04C}"],
  plus: ["\u{F0415}", "\u{E8EC}", "\u{F067}"],
  "plus-outline": ["\u{F0705}", "\u{E8ED}", "\u{F067}"],
  "folder-plus": ["\u{F0770}", "\u{E8EE}", "\u{F067}"],
  "folder-plus-outline": ["\u{F0B9D}", "\u{E8EF}", "\u{F067}"],
  close: ["\u{F0156}", "\u{E8E5}", "\u{F00D}"],
  check: ["\u{F012C}", "\u{E876}", "\u{F00C}"],
  terminal: ["\u{F120}", "\u{E8E6}", "\u{F120}"],
  disc: ["\u{F05EE}", "\u{E8ED}", "\u{F1C0}"],
  "cog-box": ["\u{F0494}", "\u{E8BA}", "\u{F013}"],
  package: ["\u{F03D3}", "\u{E8E7}", "\u{F013}"],
  "file-font": ["\u{F06D6}", "\u{E8F8}", "\u{F031}"],
  "book-open": ["\u{F00BD}", "\u{E8F9}", "\u{F02D}"],
  "book-open-outline": ["\u{F0B63}", "\u{E8FA}", "\u{F02D}"],
  database: ["\u{F01BC}", "\u{E8FB}", "\u{F1C0}"],
  "database-outline": ["\u{F1632}", "\u{E8FC}", "\u{F1C0}"],
  certificate: ["\u{F0124}", "\u{E8FD}", "\u{F0E6}"],
  "certificate-outline": ["\u{F1188}", "\u{E8FE}", "\u{F0E6}"],
  cube: ["\u{F01A6}", "\u{E8FF}", "\u{F1B2}"],
  "cube-outline": ["\u{F01A7}", "\u{E900}", "\u{F1B2}"],
  email: ["\u{F01EE}", "\u{E901}", "\u{F0E0}"],
  "email-outline": ["\u{F01F0}", "\u{E902}", "\u{F0E0}"],
  magnet: ["\u{F0347}", "\u{E903}", "\u{F076}"],
  android: ["\u{F0032}", "\u{E904}", "\u{F17B}"],
  "border-vertical": ["\u{F00D2}", "\u{E905}", "\u{F142}"],
  keyboard: ["\u{F030C}", "\u{E906}", "\u{F11C}"],
  "keyboard-outline": ["\u{F097B}", "\u{E907}", "\u{F11C}"],
  palette: ["\u{F03D8}", "\u{E908}", "\u{F03A}"],
  "palette-outline": ["\u{F0E0C}", "\u{E909}", "\u{F03A}"],
  "lightning-bolt": ["\u{F140B}", "\u{E90A}", "\u{F0E7}"],
  "lightning-bolt-outline": ["\u{F140C}", "\u{E90B}", "\u{F0E7}"],
  information: ["\u{F02FC}", "\u{E90C}", "\u{F129}"],
  "information-outline": ["\u{F02FD}", "\u{E90D}", "\u{F129}"],
  help: ["\u{F02D7}", "\u{E90E}", "\u{F059}"],
  "help-outline": ["\u{F0625}", "\u{E90F}", "\u{F059}"],
  "content-copy": ["\u{F018F}", "\u{E910}", "\u{F0C5}"],
  "content-paste": ["\u{F0192}", "\u{E911}", "\u{F0EA}"],
  "content-cut": ["\u{F0190}", "\u{E912}", "\u{F0C4}"],
  "content-duplicate": ["\u{F0191}", "\u{E913}", "\u{F0C5}"],
  "select-all": ["\u{F0478}", "\u{E914}", "\u{F0C5}"],
  sort: ["\u{F04BA}", "\u{E915}", "\u{F0DC}"],
  // File type icons (Material Design Icons)
  "file-code": ["\u{F06D6}", "\u{E916}", "\u{F121}"],
  "file-code-outline": ["\u{F102B}", "\u{E917}", "\u{F121}"],
  "file-document": ["\u{F06D6}", "\u{E918}", "\u{F15C}"],
  "file-document-outline": ["\u{F09EE}", "\u{E919}", "\u{F15C}"],
  "file-image": ["\u{F06D6}", "\u{E91A}", "\u{F1C5}"],
  "file-image-outline": ["\u{F0EB0}", "\u{E91B}", "\u{F1C5}"],
  "file-video": ["\u{F06D6}", "\u{E91C}", "\u{F03D}"],
  "file-video-outline": ["\u{F0E2C}", "\u{E91D}", "\u{F03D}"],
  "file-music": ["\u{F06D6}", "\u{E91E}", "\u{F001}"],
  "file-music-outline": ["\u{F0E2A}", "\u{E91F}", "\u{F001}"],
  "zip-box": ["\u{F06D6}", "\u{E920}", "\u{F1C6}"],
  "zip-box-outline": ["\u{F0FFA}", "\u{E921}", "\u{F1C6}"],
  // Brand
  tfm: ["\u{F024B}", "\u{E88D}", "\u{F07B}"],
  // Unicode arrows (not Nerd Font PUA) — standard across all fonts
  "arrow-up": "↑",
  "arrow-down": "↓",
};

// Resolve a glyph chain to the first available codepoint (fallback to tofu).
// The `?? "\u{FFFD}"` only satisfies the type: every chain in the table is a
// non-empty array or a bare string, so the empty-array branch never runs.
const resolveChain = (chain: GlyphChain): string => (Array.isArray(chain) ? (chain[0] ?? "\u{FFFD}") : chain);

// Build the flat glyph table from chains (primary codepoints only)
export const glyph: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  for (const [name, chain] of Object.entries(glyphChains)) {
    out[name] = resolveChain(chain);
  }
  return out;
})();

export const glyphFor = (name: string, style: IconStyle = "filled"): string => {
  if (style === "outline") return glyph[`${name}-outline`] ?? glyph[name] ?? "\u{FFFD}";
  return glyph[name] ?? "\u{FFFD}";
};

// every file-type category the classifier can emit must have a glyph: fill
// unknown ones with the generic file glyph so a new filetype never renders □
export const ensureGlyphFallbacks = (names: Iterable<string>): void => {
  for (const n of names) if (!(n in glyph)) glyph[n] = FILE_GLYPH;
};
