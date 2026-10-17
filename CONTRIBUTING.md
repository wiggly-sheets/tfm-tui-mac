# Contributing

## Requirements

- Bun >= 1.4 (CI and releases pin 1.4.0).
- Linux or macOS. `mac-universal` builds need a macOS host.

## Setup

```bash
git clone https://github.com/wiggly-sheets/tfm-tui-mac.git
cd tfm-tui-mac
bun install --frozen-lockfile
bun run dev
```

`bun run dev` is `bun run --watch src/index.ts`. `bun run compile` writes a
standalone binary to `dist/tfm`; `bun run scripts/build.ts <target>` cross-compiles
release targets (`linux-x64`, `linux-arm64`, `mac-x64`, `mac-arm64`,
`mac-universal`).

## Checks

```bash
bun run check   # biome + strict typecheck (tsgo --noEmit)
bun test
```

Run both before opening a pull request, and add a test for new logic. Edits to
`install.sh` or `source.sh` also need `bash -n install.sh source.sh`.

## Generated config

`config.example.toml` is generated from `src/config/config-schema.ts`
(`exampleToml()`) and a test asserts the repo copy is byte-identical. After
changing a `[ui]`, `[keys]` or `[theme]` row:

```bash
bun scripts/regen-example.ts
```

Do not hand-edit `config.example.toml`.

## Module layering

Keep the layers as they are:

- `src/app/` — pure models and decisions. No I/O, no rendering.
- `src/fs/` — filesystem and platform leaves, including `src/fs/darwin.ts`.
- `src/wiring/` — dependency injection: connects the pure models to real I/O.
- `src/ui/` — OpenTUI rendering.
- `src/input/` — key routing (`src/input/keymap.ts` is the one keypress router).
- `src/config/config-schema.ts` is the single source of config keys, key
  actions and theme presets.

Pure logic belongs in `src/app`, so it can be tested without a terminal.

## Releases

Releases are built by `.github/workflows/release.yml` on a version tag:

```bash
git tag v1.0.0
git push origin v1.0.0
```

The tag must match `package.json` (`v` + the version there), or the workflow
fails before building. The workflow compiles the Linux x64/arm64 and macOS
x64/arm64/universal artifacts, attaches the ffmpeg sidecars, and publishes the
release with `dist/*.gz` plus a `.sha256` sidecar each.
