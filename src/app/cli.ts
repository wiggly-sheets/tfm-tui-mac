// --- CLI argument grammar: `tfm [OPTIONS] [PATH]`. Pure (no fs, no process
// probing) so index.ts can answer --help/--version before the lazy app graph
// loads, and tests can drive every spelling. Handles both layouts: `bun
// src/index.ts PATH` (argv[1] is the script) and the compiled `tfm PATH`
// (argv[1] is the first user arg). GNU-style permutation: flags may appear
// before or after the path. `--` ends option parsing. ---

import pkg from "../../package.json";
import type { ViewMode } from "../config/config-schema";

export type CliOptions = {
  help: boolean;
  version: boolean;
  config: string | null;
  paths: string[];
  // --no-restore / --restore: force session restore off/on. null = the default
  // rule (a launch PATH suppresses restore).
  restore: boolean | null;
  // --view=…: the active pane's initial view mode (null = [ui] view-mode)
  view: ViewMode | null;
  preview: boolean;
  info: boolean;
  terminal: boolean;
  // `tfm plugins <args>` — a headless management subcommand (no TUI boot)
  command: { name: string; args: string[] } | null;
  // first parse failure; when set, callers print it + usage hint and exit 2
  error: string | null;
};

export const parseArgs = (argv: string[]): CliOptions => {
  const opts: CliOptions = {
    help: false,
    version: false,
    config: null,
    paths: [],
    restore: null,
    view: null,
    preview: false,
    info: false,
    terminal: false,
    command: null,
    error: null,
  };
  let args = argv.slice(1);
  // Two script-token layouts: `bun src/index.ts PATH` (argv[1] is the script)
  // and the compiled binary, whose runtime injects `["bun",
  // "/$bunfs/root/tfm", ...PATH]` — argv[0] is literally "bun" and argv[1] is
  // the virtual entry, never a user path. Only strip under a JS runner —
  // otherwise a real path named `index.js` (or `path/index.ts`) is swallowed.
  const runner = (argv[0] ?? "").replace(/\\/g, "/").split("/").pop() ?? "";
  const script = args[0] ?? "";
  const isScriptToken = /index\.[tj]s$/.test(script) || script.startsWith("/$bunfs/");
  if (/^(bun|node|deno)(\.exe)?$/.test(runner) && args.length && isScriptToken) {
    args = args.slice(1);
  }

  // subcommand form short-circuits option parsing: everything after `plugins`
  // belongs to it (so a URL with dashes isn't read as a flag)
  if (args[0] === "plugins") {
    opts.command = { name: "plugins", args: args.slice(1) };
    return opts;
  }

  const fail = (msg: string): CliOptions => {
    opts.error = msg;
    return opts;
  };
  const isViewMode = (v: string): v is ViewMode => v === "grid" || v === "list" || v === "columns";

  let endOpts = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (endOpts) {
      opts.paths.push(a);
      continue;
    }
    if (a === "--") {
      endOpts = true;
      continue;
    }
    if (a === "-h" || a === "--help") {
      opts.help = true;
      continue;
    }
    if (a === "-v" || a === "--version") {
      opts.version = true;
      continue;
    }
    // --debug/-d is consumed by ./log (which still scans argv); accepted here
    if (a === "-d" || a === "--debug") continue;
    // -C/--cwd is the explicit start directory: it lands in paths[], so it
    // behaves exactly like the positional PATH (validation, chdir, restore
    // suppression) with no second code path in the app.
    if (a === "-C" || a === "--cwd") {
      const v = args[++i];
      if (v === undefined || v === "") return fail(`option '${a}' needs a value`);
      opts.paths.push(v);
      continue;
    }
    if (a.startsWith("--cwd=")) {
      const v = a.slice("--cwd=".length);
      if (v === "") return fail("option '--cwd' needs a value");
      opts.paths.push(v);
      continue;
    }
    if (a === "--no-restore") {
      opts.restore = false;
      continue;
    }
    if (a === "--restore") {
      opts.restore = true;
      continue;
    }
    if (a === "--preview") {
      opts.preview = true;
      continue;
    }
    if (a === "--info") {
      opts.info = true;
      continue;
    }
    if (a === "--terminal") {
      opts.terminal = true;
      continue;
    }
    if (a === "--view") {
      const v = args[++i];
      if (v === undefined) return fail(`option '${a}' needs a value`);
      if (!isViewMode(v)) return fail(`option '${a}' must be grid, list or columns`);
      opts.view = v;
      continue;
    }
    if (a.startsWith("--view=")) {
      const v = a.slice("--view=".length);
      if (!isViewMode(v)) return fail("option '--view' must be grid, list or columns");
      opts.view = v;
      continue;
    }
    if (a === "-c" || a === "--config") {
      const v = args[++i];
      if (v === undefined || v === "") return fail(`option '${a}' needs a value`);
      opts.config = v;
      continue;
    }
    if (a.startsWith("--config=")) {
      const v = a.slice("--config=".length);
      if (v === "") return fail("option '--config' needs a value");
      opts.config = v;
      continue;
    }
    if (a.startsWith("-c") && a.length > 2) {
      opts.config = a.slice(2);
      continue;
    }
    // a lone "-" is a path (rare but valid); anything else dash-led is unknown
    if (a.startsWith("-") && a !== "-") return fail(`unknown option '${a}'`);
    opts.paths.push(a);
  }
  return opts;
};

export const usageText = (): string => `tfm ${pkg.version} — terminal file manager

Usage: tfm [OPTIONS] [PATH]

  PATH               directory to open (default: current dir). A file opens
                     its parent folder and selects that file.

Options:
  -h, --help         show this help and exit
  -v, --version      print version and exit
  -d, --debug        write a verbose event log (for bug reports)
  -c, --config FILE  use FILE instead of ~/.config/tfm/config.toml
  -C, --cwd DIR      start in DIR (same as PATH)
  --no-restore       ignore the saved session and start where PATH says
  --restore          reopen the saved session, even with a PATH
  --view=MODE        start in MODE: grid, list or columns
  --preview          start with the preview pane open
  --info             start with the info sidebar open
  --terminal         open the integrated terminal on launch
  --                 treat the rest as PATH (names that start with '-')

Commands:
  plugins [list|search|add|remove|update|new]   manage plugins (see 'tfm plugins help')
`;
