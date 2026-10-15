// Cross-compiles the release matrix from one host. Usage:
//
//   bun run scripts/build.ts linux-x64 mac-arm64      # positional targets
//   bun run scripts/build.ts --targets=mac-universal  # --targets= flag (comma list)
//   bun run scripts/build.ts all                      # every target
//
// Targets: linux-x64, linux-arm64, mac-x64, mac-arm64, mac-universal.
// mac-universal builds both darwin slices and lipos them into
// dist/tfm-universal-macos, so it needs a macOS host (lipo).
import { readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const ENTRY = "src/index.ts";
// assets/icons/*.svg — expanded here so the spawn needs no shell to glob
const ICONS = readdirSync(path.join(ROOT, "assets/icons"))
  .filter((f) => f.endsWith(".svg"))
  .map((f) => path.join("assets/icons", f));

type Slice = { bunTarget: string; outfile: string };

const SLICES: Record<string, Slice> = {
  "linux-x64": { bunTarget: "bun-linux-x64", outfile: "dist/tfm-x86_64-linux" },
  "linux-arm64": { bunTarget: "bun-linux-arm64", outfile: "dist/tfm-aarch64-linux" },
  "mac-x64": { bunTarget: "bun-darwin-x64", outfile: "dist/tfm-x86_64-macos" },
  "mac-arm64": { bunTarget: "bun-darwin-arm64", outfile: "dist/tfm-aarch64-macos" },
};
const UNIVERSAL = "mac-universal";
const UNIVERSAL_OUT = "dist/tfm-universal-macos";
const MAC_SLICES = ["mac-x64", "mac-arm64"];
const ALL = [...Object.keys(SLICES), UNIVERSAL];

const sliceOf = (name: string): Slice => {
  const slice = SLICES[name];
  if (!slice) throw new Error(`not a build slice: ${name}`);
  return slice;
};

const usage = () => `usage: bun run scripts/build.ts <target...>

targets:
  ${ALL.join("\n  ")}

examples:
  bun run scripts/build.ts linux-x64 mac-arm64
  bun run scripts/build.ts --targets=mac-universal
  bun run scripts/build.ts all`;

// positional targets, a --targets=a,b,c flag, or "all" for the full matrix
const parseTargets = (argv: string[]): string[] => {
  const raw: string[] = [];
  for (const arg of argv) {
    if (arg.startsWith("--targets=")) raw.push(...arg.slice("--targets=".length).split(","));
    else if (arg.startsWith("-")) throw new Error(`unknown flag: ${arg}\n\n${usage()}`);
    else raw.push(arg);
  }
  const picked = raw.map((t) => t.trim()).filter(Boolean);
  if (picked.length === 0) throw new Error(`no targets given\n\n${usage()}`);
  const targets = picked.includes("all") ? ALL : picked;
  for (const target of targets) {
    if (target !== UNIVERSAL && !SLICES[target]) throw new Error(`unknown target: ${target}\n\n${usage()}`);
  }
  return [...new Set(targets)];
};

// bun's cross-compiled mac binaries — and any lipo output — carry an invalid
// signature, which fails codesign --verify. Re-sign ad-hoc so they ship valid.
const signMac = (files: string[]): void => {
  if (process.platform !== "darwin") return;
  for (const file of files) {
    const res = Bun.spawnSync(["codesign", "--force", "--sign", "-", file], {
      cwd: ROOT,
      stdout: "inherit",
      stderr: "inherit",
    });
    if (res.exitCode !== 0) throw new Error(`codesign failed: ${file}`);
  }
};

// One `bun build --compile` per target — the same invocation as `bun run compile`
const buildSlice = async (name: string): Promise<void> => {
  const { bunTarget, outfile } = sliceOf(name);
  console.log(`\n▸ ${name} → ${outfile} (--target=${bunTarget})`);
  const proc = Bun.spawn(
    ["bun", "build", "--compile", `--target=${bunTarget}`, ENTRY, ...ICONS, "--outfile", outfile],
    { cwd: ROOT, stdout: "inherit", stderr: "inherit" },
  );
  if ((await proc.exited) !== 0) throw new Error(`${name}: bun build failed`);
  if (bunTarget.includes("darwin")) signMac([outfile]);
};

// Both darwin slices + lipo → one fat Mach-O. Returns the slice files it built.
const buildUniversal = async (alreadyBuilt: Set<string>): Promise<string[]> => {
  if (process.platform !== "darwin") {
    throw new Error("mac-universal needs a macOS host: lipo is unavailable elsewhere");
  }
  const produced: string[] = [];
  for (const name of MAC_SLICES) {
    if (alreadyBuilt.has(name)) continue;
    await buildSlice(name);
    produced.push(sliceOf(name).outfile);
  }
  console.log(`\n▸ lipo ${MAC_SLICES.map((n) => sliceOf(n).outfile).join(" + ")} → ${UNIVERSAL_OUT}`);
  const lipo = Bun.spawn(["lipo", "-create", "-output", UNIVERSAL_OUT, ...MAC_SLICES.map((n) => sliceOf(n).outfile)], {
    cwd: ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await lipo.exited) !== 0) throw new Error("mac-universal: lipo failed");
  // lipo invalidates the fat container's signature, so re-sign the result
  signMac([UNIVERSAL_OUT]);
  Bun.spawnSync(["lipo", "-info", UNIVERSAL_OUT], { cwd: ROOT, stdout: "inherit" });
  return produced;
};

const main = async (): Promise<void> => {
  const targets = parseTargets(process.argv.slice(2));
  const built: string[] = [];
  const builtNames = new Set<string>();

  for (const name of targets) {
    if (name === UNIVERSAL) continue;
    await buildSlice(name);
    builtNames.add(name);
    built.push(sliceOf(name).outfile);
  }
  if (targets.includes(UNIVERSAL)) {
    built.push(...(await buildUniversal(builtNames)), UNIVERSAL_OUT);
  }

  console.log(`\nbuilt ${built.length}:`);
  for (const file of built) {
    console.log(`  ${file}  (${(statSync(path.join(ROOT, file)).size / 1048576).toFixed(1)} MB)`);
  }
};

try {
  await main();
} catch (err) {
  console.error(`build: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
