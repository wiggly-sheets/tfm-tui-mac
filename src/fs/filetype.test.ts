import { describe, expect, test } from "bun:test";
import {
  FILE_ICON_BY_EXT,
  extOf,
  fileIconFor,
  fileIsImage,
  fileIsVideo,
  loadGlobs2,
  mimeCategory,
  mimeForExt,
  mimeForPath,
  utiToMime,
} from "./filetype";

describe("extOf", () => {
  test("lowercases and handles dotfiles / no-ext / multi-dot", () => {
    expect(extOf("Photo.JPG")).toBe("jpg");
    expect(extOf("archive.tar.gz")).toBe("gz");
    expect(extOf("Makefile")).toBe("");
    expect(extOf(".hidden")).toBe(""); // leading dot = no ext
    expect(extOf(".config.toml")).toBe("toml");
  });

  test("matches path.extname on dirs, trailing dots and trailing slashes", () => {
    expect(extOf("foo.")).toBe("");
    expect(extOf("a/.hidden")).toBe("");
    expect(extOf("/a.b/c")).toBe(""); // dot in a dir segment is not an ext
    expect(extOf("/x/y.z/")).toBe("z"); // trailing slashes are ignored
    expect(extOf("")).toBe("");
  });
});

describe("mimeCategory", () => {
  // the whole classification table: one row per media-type family the icon
  // picker distinguishes. A failure names the exact mime that slipped.
  test("maps media types to their icon category", () => {
    const cases: [string, string][] = [
      // one representative per branch: media prefix, each mime set, the code
      // suffix rules, the document rules and the fallback
      ["image/png", "file-image"],
      ["video/mp4", "file-video"],
      ["audio/flac", "file-music"],
      ["font/ttf", "file-font"],
      ["message/rfc822", "email"],
      ["application/x-tar", "zip-box"],
      ["application/vnd.android.package-archive", "zip-box"],
      ["application/vnd.efi.iso", "disc"],
      ["application/x-cue", "disc"],
      ["application/x-msdownload", "cog-box"],
      ["application/vnd.debian.binary-package", "package"],
      ["application/epub+zip", "book-open"],
      ["application/pkix-cert", "certificate"],
      ["application/x-bittorrent", "magnet"],
      ["application/x-sqlite3", "database"],
      ["application/pdf", "file-pdf-box"],
      // media prefix wins over +xml suffix (svg is an image first)
      ["image/svg+xml", "file-image"],
      ["text/x-python", "file-code"],
      ["application/javascript", "file-code"],
      ["application/atom+xml", "file-code"],
      ["application/ld+json", "file-code"],
      ["text/plain", "file-document"],
      ["application/vnd.oasis.opendocument.text", "file-document"],
      ["application/octet-stream", "file"],
      ["", "file"],
    ];
    for (const [mime, want] of cases) {
      expect({ mime, category: mimeCategory(mime) }).toEqual({ mime, category: want });
    }
  });
});

describe("fileIconFor", () => {
  test("known extensions map to their category icon (case-insensitive)", () => {
    const cases: [string, string][] = [
      // one representative extension per icon category; the table's shape is
      // covered by the integrity block below
      ["app.ts", "file-code"],
      ["PHOTO.JPG", "file-image"],
      ["archive.7z", "zip-box"],
      ["ubuntu.iso", "disc"],
      ["setup.msi", "cog-box"],
      ["run.BAT", "cog-box"],
      ["pkg.deb", "package"],
      ["font.OTF", "file-font"],
      ["book.mobi", "book-open"],
      ["site.crt", "certificate"],
      ["model.blend", "cube"],
      ["mail.eml", "email"],
      ["linux.torrent", "magnet"],
      ["data.sqlite", "database"],
      ["disk.vhdx", "harddisk"],
      ["app.apk", "android"],
    ];
    for (const [name, want] of cases) {
      expect({ name, icon: fileIconFor(name) }).toEqual({ name, icon: want });
    }
  });

  test("dotfiles, extensionless and unknown extensions fall back to file", () => {
    expect(fileIconFor(".bashrc")).toBe("file");
    expect(fileIconFor("Makefile")).toBe("file");
    expect(fileIconFor("data.xyzzy")).toBe("file");
  });
});

describe("fileIsImage", () => {
  test("static image extensions are images", () => {
    expect(fileIsImage("x.png")).toBe(true);
    expect(fileIsImage("x.WEBP")).toBe(true);
  });

  test("non-images and dotfiles are not images", () => {
    expect(fileIsImage("x.ts")).toBe(false);
    expect(fileIsImage("x.mp4")).toBe(false);
    expect(fileIsImage(".profile")).toBe(false);
  });
});

describe("fileIsVideo", () => {
  test("video extensions are videos", () => {
    expect(fileIsVideo("x.mp4")).toBe(true);
    expect(fileIsVideo("x.MKV")).toBe(true);
    expect(fileIsVideo("x.webm")).toBe(true);
  });

  // .ts is TypeScript for tfm even though globs2 classifies it video/mp2t —
  // the ext table must win over the mime db
  test(".ts stays TypeScript, dotfiles are not videos", () => {
    expect(fileIsVideo("x.ts")).toBe(false);
    expect(fileIsVideo(".profile")).toBe(false);
  });
});

describe("FILE_ICON_BY_EXT integrity", () => {
  test("every value is one of the known icon-name categories", () => {
    const known = new Set([
      "file-code",
      "file-document",
      "file-image",
      "file-video",
      "file-music",
      "zip-box",
      "file-pdf-box",
      "disc",
      "cog-box",
      "package",
      "file-font",
      "book-open",
      "database",
      "certificate",
      "cube",
      "email",
      "magnet",
      "harddisk",
      "android",
    ]);
    for (const cat of Object.values(FILE_ICON_BY_EXT)) expect(known.has(cat)).toBe(true);
  });

  test("keys are lowercase so the case-insensitive lookup path stays honest", () => {
    for (const ext of Object.keys(FILE_ICON_BY_EXT)) expect(ext).toBe(ext.toLowerCase());
  });

  test("every emitted category has a matching assets/icons/<name>.svg (slot names must match filenames exactly)", async () => {
    const { existsSync } = await import("node:fs");
    const { default: path } = await import("node:path");
    const dir = path.join(import.meta.dir, "../../assets/icons");
    const cats = new Set([...Object.values(FILE_ICON_BY_EXT), "file"]);
    for (const cat of cats) expect(existsSync(path.join(dir, `${cat}.svg`))).toBe(true);
  });
});

describe("loadGlobs2 + mimeForExt (integration, needs shared-mime-info)", () => {
  test("boot-load resolves common mimes and never throws when absent", async () => {
    await loadGlobs2();
    if (mimeForExt("png") === undefined) return;
    expect(mimeForExt("png")).toMatch(/^image\//);
    expect(mimeForExt("PNG")).toMatch(/^image\//);
    expect(mimeForExt("mp4")).toMatch(/^video\//);
    expect(mimeForExt("no-such-ext-xyzzy")).toBeUndefined();
  });
});

describe("darwin UTI probe", () => {
  test("utiToMime covers the common tree, unknown UTIs miss", () => {
    expect(utiToMime("public.plain-text")).toBe("text/plain");
    expect(utiToMime("public.png")).toBe("image/png");
    expect(utiToMime("public.mpeg-4")).toBe("video/mp4");
    expect(utiToMime("com.adobe.pdf")).toBe("application/pdf");
    expect(utiToMime("public.zip-archive")).toBe("application/zip");
    expect(utiToMime("dyn.abcdef")).toBeUndefined();
    expect(utiToMime("  public.html  ")).toBe("text/html");
  });

  test("mimeForPath prefers mdls UTI, then file(1), then ext map", async () => {
    // mdls hit: file(1) must never run
    const seen: string[][] = [];
    expect(
      await mimeForPath("/x/a.txt", async (cmd) => {
        seen.push(cmd);
        return cmd[0] === "mdls" ? "public.plain-text" : "FAIL";
      }),
    ).toBe("text/plain");
    expect(seen.map((c) => c[0])).toEqual(["mdls"]);
    // unknown UTI: falls to file(1), parameters stripped
    expect(
      await mimeForPath("/x/a.bin", async (cmd) =>
        cmd[0] === "mdls" ? "dyn.xyz" : "application/x-foo; charset=binary",
      ),
    ).toBe("application/x-foo");
    // both tools dead: ext map (empty here — globs2 may be absent on mac)
    expect(await mimeForPath("/x/a.txt", async () => "")).toBe(mimeForExt("txt"));
  });
});
