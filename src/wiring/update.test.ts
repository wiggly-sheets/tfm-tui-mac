import { describe, expect, test } from "bun:test";
import pkg from "../../package.json";
import { REPO, type UpdateCheckCache } from "../app/update";
import { runUpdateCheck } from "./update";

const marker = {
  version: pkg.version,
  installDir: "/usr/local/bin",
  repo: REPO,
  method: "script",
};

const newer = `v9.9.9`;

type Seen = { notified: string[]; fetched: number; written: UpdateCheckCache[] };

const run = async (
  opts: { check?: boolean; cache?: UpdateCheckCache | null; tag?: string | null; execPath?: string; marker?: unknown },
  seen: Seen,
): Promise<void> => {
  await runUpdateCheck(
    {
      check: opts.check ?? true,
      notify: (m) => {
        seen.notified.push(m);
      },
    },
    {
      execPath: opts.execPath ?? "/usr/local/bin/tfm",
      installDirResolved: "/usr/local/bin",
      marker: opts.marker !== undefined ? opts.marker : marker,
      now: () => 1_700_000_000_000,
      readCache: () => opts.cache ?? null,
      writeCache: (c) => {
        seen.written.push(c);
        return Promise.resolve();
      },
      latestTag: () => {
        seen.fetched++;
        return Promise.resolve(opts.tag === undefined ? newer : opts.tag);
      },
    },
  );
};

const fresh = (): Seen => ({ notified: [], fetched: 0, written: [] });

describe("runUpdateCheck", () => {
  test("[update] check off: no fetch, no toast", async () => {
    const seen = fresh();
    await run({ check: false }, seen);
    expect(seen.fetched).toBe(0);
    expect(seen.notified).toEqual([]);
  });

  test("not an install.sh copy (dev exec path): no fetch", async () => {
    const seen = fresh();
    await run({ execPath: "/usr/local/bin/bun" }, seen);
    expect(seen.fetched).toBe(0);
    expect(seen.notified).toEqual([]);
  });

  test("a check inside the 24h window is skipped", async () => {
    const seen = fresh();
    await run({ cache: { at: 1_700_000_000_000 - 1000 } }, seen);
    expect(seen.fetched).toBe(0);
  });

  test("a newer tag toasts once and is remembered as notifiedTag", async () => {
    const seen = fresh();
    await run({}, seen);
    expect(seen.notified).toEqual([`tfm 9.9.9 is available · run tfm --update`]);
    expect(seen.written.at(-1)?.notifiedTag).toBe(newer);
    expect(seen.written.at(-1)?.tag).toBe(newer);
  });

  test("the notified tag is not toasted again", async () => {
    const seen = fresh();
    await run({ cache: { at: 0, tag: newer, notifiedTag: newer } }, seen);
    expect(seen.fetched).toBe(1);
    expect(seen.notified).toEqual([]);
    expect(seen.written.at(-1)?.notifiedTag).toBe(newer);
  });

  test("a current or older tag never toasts", async () => {
    const seen = fresh();
    await run({ tag: `v${pkg.version}` }, seen);
    expect(seen.notified).toEqual([]);
    // newest known tag is still recorded so the cache reflects reality
    expect(seen.written.at(-1)?.tag).toBe(`v${pkg.version}`);
  });

  test("no reachable release is recorded without a toast", async () => {
    const seen = fresh();
    await run({ tag: null }, seen);
    expect(seen.notified).toEqual([]);
    expect(seen.written.at(-1)?.at).toBe(1_700_000_000_000);
  });
});
