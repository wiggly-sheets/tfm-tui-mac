// Impure half of the self-updater, exercised with an injected fetch and an
// isolated XDG_DATA_HOME — no network, no real install dir.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "fflate";
import {
  downloadVerifiedBinary,
  readInstallMarker,
  readUpdateCheck,
  refreshSecondName,
  replaceBinaryAtomic,
  writeUpdateCheck,
} from "./update-feed";

let tmp: string;
const prevData = process.env.XDG_DATA_HOME;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "tfm-update-feed-"));
  process.env.XDG_DATA_HOME = path.join(tmp, "data");
});
afterEach(() => {
  if (prevData === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = prevData;
  rmSync(tmp, { recursive: true, force: true });
});

const shaOf = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

// serves the gz + its sidecar from memory; `sha` overrides the published digest
const fakeFetch = (gz: Uint8Array, sha: string): typeof fetch =>
  (async (url: string) =>
    String(url).endsWith(".sha256") ? new Response(`${sha}  asset.gz\n`) : new Response(gz)) as unknown as typeof fetch;

describe("downloadVerifiedBinary", () => {
  test("verifies, gunzips and marks the staged binary executable", async () => {
    const body = Buffer.from("#!/bin/sh\necho tfm\n");
    const gz = gzipSync(body);
    const out = await downloadVerifiedBinary({
      base: "https://example.test/base",
      asset: "tfm-x86_64-linux.gz",
      dir: tmp,
      fetchImpl: fakeFetch(gz, shaOf(gz)),
    });
    expect(out).toBe(path.join(tmp, "tfm-x86_64-linux"));
    expect(readFileSync(out)).toEqual(body);
    expect(lstatSync(out).mode & 0o777).toBe(0o755);
  });

  test("a checksum mismatch throws and leaves nothing behind", async () => {
    const body = Buffer.from("payload");
    const gz = gzipSync(body);
    const wrong = shaOf(Buffer.from("other"));
    await expect(
      downloadVerifiedBinary({
        base: "https://example.test/base",
        asset: "tfm.gz",
        dir: tmp,
        fetchImpl: fakeFetch(gz, wrong),
      }),
    ).rejects.toThrow("checksum mismatch");
    expect(existsSync(path.join(tmp, "tfm"))).toBe(false);
  });
});

describe("replaceBinaryAtomic", () => {
  test("swaps the target and cleans up the sibling temp", async () => {
    const src = path.join(tmp, "staged");
    const dest = path.join(tmp, "tfm");
    writeFileSync(src, "new build");
    writeFileSync(dest, "old build");
    await replaceBinaryAtomic(src, dest);
    expect(readFileSync(dest, "utf8")).toBe("new build");
    expect(existsSync(`${dest}.tfm-new.${process.pid}`)).toBe(false);
  });
});

describe("refreshSecondName", () => {
  test("re-points the second name only when it already exists", async () => {
    const dir = path.join(tmp, "bin");
    mkdirSync(dir, { recursive: true });
    await refreshSecondName(dir);
    expect(existsSync(path.join(dir, "terminal-file-manager"))).toBe(false);

    writeFileSync(path.join(dir, "tfm"), "bin");
    symlinkSync("gone", path.join(dir, "terminal-file-manager"));
    await refreshSecondName(dir);
    expect(readlinkSync(path.join(dir, "terminal-file-manager"))).toBe(path.join(dir, "tfm"));
  });
});

describe("install marker + update cache", () => {
  test("missing files read as absent", () => {
    expect(readInstallMarker()).toBeNull();
    expect(readUpdateCheck()).toBeNull();
  });

  test("the update cache round-trips", async () => {
    await writeUpdateCheck({ at: 123, tag: "v1.1.0", notifiedTag: "v1.1.0" });
    expect(readUpdateCheck()).toEqual({ at: 123, tag: "v1.1.0", notifiedTag: "v1.1.0" });
  });
});
