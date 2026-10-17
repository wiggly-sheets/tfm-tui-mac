// --- `tfm --update`: headless self-update for install.sh installs (no TUI, no
// renderer). Refuses anything it did not install (dev run, package manager,
// moved binary), then downloads the release for THIS arch, verifies the
// published checksum, smoke-tests the staged binary and only then swaps it in.
// Exit code: 0 = updated or already current, 1 = refused/failed. ---

import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pkg from "../../package.json";
import { errMessage } from "../lib/uiutil";
import {
  fetchLatestRelease,
  downloadVerifiedBinary,
  installDirOf,
  readInstallMarker,
  refreshSecondName,
  replaceBinaryAtomic,
  smokeRun,
  writeUpdateCheck,
} from "../fs/update-feed";
import {
  installRefusalReason,
  isNewer,
  REPO,
  releaseBaseUrl,
  UPDATE_REFUSALS,
  updateAssetName,
  versionOf,
} from "./update";

export type UpdateCliDeps = {
  execPath?: string;
  platform?: string;
  arch?: string;
  tmpDir?: string;
  fetchImpl?: typeof fetch;
  out?: (line: string) => void;
  err?: (line: string) => void;
};

export const runUpdateCli = async (deps: UpdateCliDeps = {}): Promise<number> => {
  const out = deps.out ?? ((s) => console.log(s));
  const err = deps.err ?? ((s) => console.error(s));
  const execPath = deps.execPath ?? process.execPath;
  const marker = readInstallMarker();
  const installDir = installDirOf(execPath);
  const refusal = installRefusalReason({ marker, execPath, installDirResolved: installDir });
  if (refusal) {
    err(`tfm: ${refusal}`);
    return 1;
  }
  const arch = updateAssetName(deps.platform ?? process.platform, deps.arch ?? process.arch);
  if (!arch) {
    err(`tfm: ${UPDATE_REFUSALS.arch}`);
    return 1;
  }
  const fetchDeps = deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {};
  const tmp = deps.tmpDir ?? (await mkdtemp(path.join(os.tmpdir(), "tfm-update-")));
  const ownsTmp = deps.tmpDir === undefined;
  try {
    out(`checking ${REPO} for a newer release`);
    const release = await fetchLatestRelease(fetchDeps);
    if (!release) {
      err("tfm: could not reach GitHub — check your connection and try again");
      return 1;
    }
    if (!isNewer(release.tag, pkg.version)) {
      out(`tfm ${pkg.version} is already up to date`);
      return 0;
    }
    const next = versionOf(release.tag);
    const base = releaseBaseUrl(release.tag);
    const destBin = path.join(installDir, "tfm");
    out(`downloading tfm ${next} (${arch})`);
    let staged: string;
    try {
      staged = await downloadVerifiedBinary({ base, asset: `tfm-${arch}.gz`, dir: tmp, ...fetchDeps });
    } catch (e) {
      err(`tfm: download failed — ${errMessage(e)}`);
      return 1;
    }
    const smoke = await smokeRun(staged, ["--version"]);
    if (smoke.code !== 0 || !smoke.stdout.includes(`tfm ${next}`)) {
      err(`tfm: the downloaded build did not report tfm ${next} — nothing was changed`);
      return 1;
    }
    try {
      await replaceBinaryAtomic(staged, destBin);
    } catch (e) {
      err(`tfm: could not replace ${destBin} — ${errMessage(e)}`);
      return 1;
    }
    await refreshSecondName(installDir);
    // ffmpeg sidecar is best-effort: only when this install already has one and
    // the release ships it, and a failure must not fail the main update.
    const ffAsset = `tfm-ffmpeg-${arch}.gz`;
    const ffDest = path.join(installDir, "tfm-ffmpeg");
    if (existsSync(ffDest) && release.assets.includes(ffAsset)) {
      try {
        const ff = await downloadVerifiedBinary({ base, asset: ffAsset, dir: tmp, ...fetchDeps });
        const ffSmoke = await smokeRun(ff, ["-hide_banner", "-version"]);
        if (ffSmoke.code !== 0) throw new Error("the ffmpeg build did not run");
        await replaceBinaryAtomic(ff, ffDest);
        out("updated the tfm-ffmpeg sidecar");
      } catch (e) {
        err(`tfm: warning: ffmpeg sidecar not updated — ${errMessage(e)}`);
      }
    }
    // record the installed tag so the next launch does not toast what we just
    // installed
    await writeUpdateCheck({ at: Date.now(), tag: release.tag, notifiedTag: release.tag }).catch(() => {});
    out(`updated tfm ${pkg.version} → ${next} · restart tfm to use it`);
    return 0;
  } finally {
    if (ownsTmp) await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
};
