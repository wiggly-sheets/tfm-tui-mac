import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readArchiveEntries } from "./archive-read";

// Minimal ustar writer: 512-byte header (name + octal size + regular-file
// typeflag) followed by the zero-padded data blocks and the end-of-archive
// marker. Enough for the preview's header walk.
const tarHeader = (name: string, size: number): Uint8Array => {
  const h = new Uint8Array(512);
  h.set(Buffer.from(name, "utf8"), 0);
  h.set(Buffer.from(`${size.toString(8).padStart(11, "0")}\0`, "latin1"), 124);
  h[156] = 0x30; // '0' = regular file
  return h;
};

const tarBytes = (entries: Array<[name: string, size: number]>): Buffer => {
  const blocks: Uint8Array[] = [];
  for (const [name, size] of entries) {
    blocks.push(tarHeader(name, size));
    if (size > 0) blocks.push(new Uint8Array(Math.ceil(size / 512) * 512));
  }
  blocks.push(new Uint8Array(1024)); // two zero blocks terminate the archive
  return Buffer.concat(blocks);
};

const FROZEN = 1700000000; // integer seconds → exact mtimeMs

describe("readArchiveEntries", () => {
  test("lists tar members (name + size) and keeps the two-block terminator out", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tfm-ar-"));
    try {
      const f = path.join(dir, "a.tar");
      writeFileSync(f, tarBytes([["one.txt", 3]]));
      const entries = await readArchiveEntries(f);
      expect(entries?.map((e) => e.name)).toEqual(["one.txt"]);
      expect(entries?.[0]?.size).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reuses the listing while path/mtime/size are unchanged", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tfm-ar-cache-"));
    try {
      const f = path.join(dir, "c.tar");
      writeFileSync(f, tarBytes([["one.txt", 3]]));
      utimesSync(f, FROZEN, FROZEN);
      const first = await readArchiveEntries(f);
      expect(first?.map((e) => e.name)).toEqual(["one.txt"]);

      // same size (one member either way), same frozen mtime, different bytes:
      // a re-read would see two.txt, the cache must serve the old listing
      writeFileSync(f, tarBytes([["two.txt", 3]]));
      utimesSync(f, FROZEN, FROZEN);
      const cached = await readArchiveEntries(f);
      expect(cached?.map((e) => e.name)).toEqual(["one.txt"]);

      // a moved mtime invalidates (an edited container re-reads once)
      utimesSync(f, FROZEN + 5, FROZEN + 5);
      const fresh = await readArchiveEntries(f);
      expect(fresh?.map((e) => e.name)).toEqual(["two.txt"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("non-archives and missing files yield null", async () => {
    expect(await readArchiveEntries("/nonexistent/definitely-not.tar")).toBeNull();
    const dir = mkdtempSync(path.join(os.tmpdir(), "tfm-ar-none-"));
    try {
      const f = path.join(dir, "plain.txt");
      writeFileSync(f, "hello");
      expect(await readArchiveEntries(f)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
