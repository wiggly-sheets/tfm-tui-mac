// --- User themes: the loader is fault-tolerant and the shipped sample must
// parse, so a first-run user gets a working file instead of a silent skip. ---
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "./config-schema";
import { parse } from "smol-toml";
import { configPath } from "./config";
import { loadUserThemes, THEME_SAMPLE, coerceTheme, THEMES_DIR } from "./themes";

const mk = () => mkdtempSync(path.join(os.tmpdir(), "tfm-themes-"));

describe("loadUserThemes", () => {
  test("missing folder returns nothing", () => {
    const r = loadUserThemes("/nonexistent/tfm-themes");
    expect(r.presets).toHaveLength(0);
    expect(r.failed).toHaveLength(0);
  });

  test("non-toml files are ignored", () => {
    const d = mk();
    try {
      writeFileSync(path.join(d, "README.txt"), "not a theme");
      const r = loadUserThemes(d);
      expect(r.presets).toHaveLength(0);
      expect(r.failed).toHaveLength(0);
    } finally {
      rmSync(d, { recursive: true });
    }
  });

  test("a complete valid theme loads", () => {
    const d = mk();
    try {
      writeFileSync(path.join(d, "my.toml"), THEME_SAMPLE);
      const r = loadUserThemes(d);
      expect(r.presets).toHaveLength(1);
      expect(r.failed).toHaveLength(0);
      expect(r.presets[0]!.name).toBe("my");
      expect(r.presets[0]!.theme).toEqual(defaultConfig.theme);
    } finally {
      rmSync(d, { recursive: true });
    }
  });

  test("a theme missing a key is skipped and reported", () => {
    const d = mk();
    try {
      writeFileSync(path.join(d, "broken.toml"), `[theme]\nbg = "#1a1b26"\naccent = "#7aa2f7"\n`);
      const r = loadUserThemes(d);
      expect(r.presets).toHaveLength(0);
      expect(r.failed).toHaveLength(1);
      expect(r.failed[0]!.startsWith("broken.toml:")).toBe(true);
    } finally {
      rmSync(d, { recursive: true });
    }
  });

  test("a theme with a bad hex value is skipped and reported", () => {
    const d = mk();
    try {
      writeFileSync(
        path.join(d, "badhex.toml"),
        `[theme]\n${Object.entries(defaultConfig.theme)
          .map(([k, v]) => `${k} = "${v}"`)
          .join("\n")}\nbg = "#nope"\n`,
      );
      const r = loadUserThemes(d);
      expect(r.presets).toHaveLength(0);
      expect(r.failed).toHaveLength(1);
      expect(r.failed[0]!.startsWith("badhex.toml:")).toBe(true);
    } finally {
      rmSync(d, { recursive: true });
    }
  });

  test("malformed toml is skipped and reported", () => {
    const d = mk();
    try {
      writeFileSync(path.join(d, "bad.toml"), "this is not = = toml [[[");
      const r = loadUserThemes(d);
      expect(r.presets).toHaveLength(0);
      expect(r.failed).toHaveLength(1);
      expect(r.failed[0]!.startsWith("bad.toml:")).toBe(true);
    } finally {
      rmSync(d, { recursive: true });
    }
  });

  test("mix of good and bad: presets load, failures are listed", () => {
    const d = mk();
    try {
      writeFileSync(path.join(d, "good.toml"), THEME_SAMPLE);
      writeFileSync(path.join(d, "bad.toml"), "garbage = = = [[[");
      const r = loadUserThemes(d);
      expect(r.presets.map((p) => p.name)).toEqual(["good"]);
      expect(r.failed).toHaveLength(1);
      expect(r.failed[0]!.startsWith("bad.toml:")).toBe(true);
    } finally {
      rmSync(d, { recursive: true });
    }
  });

  test("files load in alphabetical order", () => {
    const d = mk();
    try {
      // two distinct valid themes, named by file
      const a = THEME_SAMPLE;
      const b = THEME_SAMPLE.replace(/#1a1b26/g, "#000000").replace("sample", "b");
      writeFileSync(path.join(d, "b.toml"), b);
      writeFileSync(path.join(d, "a.toml"), a);
      const r = loadUserThemes(d);
      expect(r.presets.map((p) => p.name)).toEqual(["a", "b"]);
      expect(r.presets[0]!.theme).toEqual(defaultConfig.theme);
      expect(r.presets[1]!.theme.bg).toBe("#000000");
    } finally {
      rmSync(d, { recursive: true });
    }
  });

  test("the shipped THEME_SAMPLE parses to the default palette", () => {
    // the template dropped on first run must be valid — otherwise every new
    // user silently gets a skipped theme instead of a working starting point
    const doc = parse(THEME_SAMPLE) as { theme?: unknown };
    expect(coerceTheme(doc.theme)).toEqual(defaultConfig.theme);
  });

  test("THEMES_DIR sits next to config.toml", () => {
    // configPath() is ~/.config/tfm/config.toml; themes live in its sibling
    const dir = THEMES_DIR();
    expect(dir).toBe(path.join(path.dirname(configPath()), "themes"));
  });
});
