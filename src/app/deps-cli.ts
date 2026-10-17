// --- `tfm deps <subcommand>`: headless dependency management ---

import { checkAllPkgs, makeInstallPlan, type WhichFn } from "./deps";
import { spawnSafe } from "../fs/spawn-safe";

export type DepsCommand = "list" | "check" | "install" | "help";

export type DepsArgs = {
  cmd: DepsCommand;
  targets: string[];
  error: string | null;
};

export const parseDepsArgs = (args: string[]): DepsArgs => {
  const bad = (error: string): DepsArgs => ({ cmd: "help", targets: [], error });
  const first = args[0];
  if (first === undefined || first === "list" || first === "ls") return { cmd: "list", targets: [], error: null };
  if (first === "help" || first === "--help" || first === "-h") return { cmd: "help", targets: [], error: null };
  if (first === "check") return { cmd: "check", targets: [], error: null };
  if (first === "install" || first === "i" || first === "add") {
    const targets = args.slice(1);
    if (targets.length && (targets[0] === "--help" || targets[0] === "-h")) {
      return { cmd: "help", targets: [], error: null };
    }
    return { cmd: "install", targets, error: null };
  }
  return bad(`unknown deps subcommand: ${JSON.stringify(first)}`);
};

export const depsHelp = (): string =>
  `tfm deps — manage optional system dependencies

Usage: tfm deps [list]
       tfm deps check
       tfm deps install [pkg...]

  list              show installed status of each optional tool (default)
  check             returns 0 if all optional tools installed, 1 if any missing
  install [pkg...]  install missing or specified optional tools via package manager
`;

type ExecFn = (
  bin: string,
  args: string[],
  opts?: { stdio?: "inherit" | "pipe" | "ignore" },
) => Promise<{ status: number | null }>;

type DepsCliDeps = {
  which?: WhichFn;
  platform?: string;
  out?: (line: string) => void;
  err?: (line: string) => void;
  exec?: ExecFn;
};

const defaultExec: ExecFn = (bin, args) =>
  new Promise((resolve) => {
    const child = spawnSafe(bin, args, { stdio: "inherit" }, () => resolve({ status: 1 }));
    child.on("close", (code) => resolve({ status: code }));
  });

export const runDepsCli = async (args: string[], deps: DepsCliDeps = {}): Promise<number> => {
  const out = deps.out ?? ((s) => console.log(s));
  const err = deps.err ?? ((s) => console.error(s));
  const which = deps.which ?? Bun.which;
  const platform = deps.platform ?? process.platform;
  const exec = deps.exec ?? defaultExec;

  const parsed = parseDepsArgs(args);
  if (parsed.error) {
    err(`tfm: ${parsed.error}`);
    out(depsHelp());
    return 2;
  }

  if (parsed.cmd === "help") {
    out(depsHelp());
    return 0;
  }

  const { pm, statuses } = checkAllPkgs(which, platform);

  if (parsed.cmd === "list") {
    out(`Package Manager: ${pm ? `${pm.name} (${pm.checkBin})` : "none detected"}\n`);
    out("Optional Dependencies:");
    for (const st of statuses) {
      const statusStr = st.installed ? `[installed] (${st.foundBin})` : "[missing]";
      out(`  ${st.spec.name.padEnd(12)} ${statusStr.padEnd(24)} ${st.spec.blurb}`);
    }
    return 0;
  }

  if (parsed.cmd === "check") {
    const missing = statuses.filter((st) => !st.installed);
    if (missing.length === 0) {
      out("All optional dependencies are installed.");
      return 0;
    }
    err(`Missing ${missing.length} optional dependenc${missing.length === 1 ? "y" : "ies"}:`);
    for (const st of missing) {
      err(`  - ${st.spec.name} (${st.spec.id}): ${st.spec.blurb}`);
    }
    if (pm) {
      const plan = makeInstallPlan(
        missing.map((m) => m.spec.id),
        which,
        platform,
      );
      const cmdStr = `${plan.sudo ? "sudo " : ""}${plan.bin} ${plan.args.join(" ")}`;
      err(`\nRun '${cmdStr}' or 'tfm deps install' to install.`);
    } else {
      err("\nNo supported package manager found to auto-install missing tools.");
    }
    return 1;
  }

  if (parsed.cmd === "install") {
    try {
      const plan = makeInstallPlan(parsed.targets, which, platform);
      let runBin = plan.bin;
      let runArgs = plan.args;
      if (plan.sudo && platform !== "darwin") {
        if (!which("sudo")) {
          err(`Root required to install via ${plan.pm.name}, but 'sudo' was not found.`);
          err(`Please run manually as root: ${plan.bin} ${plan.args.join(" ")}`);
          return 1;
        }
        runArgs = [plan.bin, ...plan.args];
        runBin = "sudo";
      }

      out(`Installing ${plan.pkgsToInstall.join(", ")} via ${plan.pm.name} (${runBin} ${runArgs.join(" ")})...`);
      const res = await exec(runBin, runArgs);
      if (res.status === 0) {
        out("Installation completed successfully.");
        return 0;
      }
      err(`Installation failed with exit code ${res.status}.`);
      return res.status ?? 1;
    } catch (e) {
      err(`tfm: ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
  }

  return 0;
};
