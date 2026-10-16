# Audit verify 2026-10-16

Archive symlink-traversal guards after merge `8095ad6`

## 1. JS zip fallback and tar fallback sanitization

**VERIFIED-COVERED**

`src/fs/archive.ts`

- `jsZipExtract` pre-creation guard:
  - `const dest = path.resolve(base, e.name);` — lines 910-922
  - `if (dest !== base && !dest.startsWith(`${base}${path.sep}`)) return false;` — line 922
  - Symlink second pass:
    `const dest = path.resolve(base, e.name);` — line 961
    `if (dest !== base && !dest.startsWith(`${base}${path.sep}`)) { skipped++; continue; }` — lines 962-965
  - Comment: `// links land DEAD LAST (second pass below): an entry that resolves through an on-disk link would otherwise write outside staging.` — lines 937-939

- Preflight refusal before any lane:
  - `export const isUnsafeEntryName = (name: string): boolean => !name || name.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(name) || name.split("/").includes("..");` — lines 304-305
  - `export const unsafeEntryReason = (e: ArchiveEntryInfo): string | null => { ... if (e.symlink && t) { const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(e.name), t)); if (path.posix.isAbsolute(t) || resolved === ".." || resolved.startsWith("../")) return \`unsafe symlink ${e.name} -> ${t}\`; } }` — lines 310-317

- `firstUnsafeMember` used in fileops before extraction:
  - `const unsafe = await firstUnsafeMember(fmt, file, runArchive, archiveWhich, platform);` — line 1306
  - `if (unsafe) { failed++; failWhy.add(`${path.basename(file)}: ${unsafe}`); continue; }` — lines 1307-1310

- Tar JS fallback:
  - `const n = await new Bun.Archive(data).extract(destDir);` — line 783
  - Extraction runs into staging only; preflight above refuses unsafe members. No per-entry callback exists, so the preflight + staging sweep is the guard.

Evidence shows zip entries are skipped when destination escapes base and symlink targets that escape the root are refused by `unsafeEntryReason`. The second-pass order remains but is now protected by preflight refusal and staging sanitization.

## 2. Escape sweep after extraction / `../evil` pre-existence

**VERIFIED-COVERED**

`src/fs/fileops.ts`

- Snapshot guard:
  - `const beforeDest = await snapshotNames(destDir);` — line 1320
  - `const beforeParent = ... await snapshotNames(parentDir);` — line 1321
- Escape sweep:
  - `// escape sweep first: trash anything the tool wrote outside staging, then refuse the archive` — lines 1348-1350
  - `for (const name of afterDest) { if (name === stageBase || beforeDest.has(name)) continue; await xdgTrashMove(...); }` — lines 1353-1357
- Same for parent directory — lines 1363-1373
- Staged link sanitization:
  - `const cutLinks = await sanitizeStagedLinks(stage);` — line 1380
  - `if (target !== base && !target.startsWith(`${base}${path.sep}`)) { await rm(abs, { force: true }); removed++; }` — lines 1236-1239
- Preflight prevents `../evil` reaching extraction:
  - `// zip-slip preflight: a tool handed \`../evil\` writes it relative to the staging dir... An archive holding an absolute, \`..\` or escaping-symlink member is refused before any tool runs` — lines 1300-1304

The `../evil` member name is caught by `isUnsafeEntryName` → `firstUnsafeMember` → archive refused before extraction. The post-extraction sweep remains as a backstop and now also trashes escaped writes. Pre-existing `evil` is still present, but the archive is refused before it can be created.

## 3. Guard functions found

`src/fs/archive.ts`

- `isUnsafeEntryName` — line 304
- `unsafeEntryReason` — line 310
- `firstUnsafeMember` — line 1114
- `readZipEntries` symlink detection — line 662
- `jsZipExtract` destination prefix check — lines 922, 962
- `jsTarExtract` — lines 763-792

`src/fs/fileops.ts`

- `snapshotNames` — line 1202
- `sanitizeStagedLinks` — line 1209
- `firstUnsafeMember` preflight — line 1306
- Escape sweep with `xdgTrashMove` — lines 1356, 1368
- Comments `zip-slip preflight` — line 1300, `Spawn-lane containment` — line 1195

Grep hits for `zip-slip`, `symlink`, `traversal`, `sanitize`, `escape` confirm the guards above.

## 4. Archive-as-folder view traversal guard

**NOT-APPLICABLE / LIMITED**

`src/app/archive-nav.ts`

- `parseArchiveUri` returns `{ archive, inner }` with no validation of `inner`: lines 18-25
- `archiveInnerParent` uses `path.posix.dirname(inner)` — lines 85-87
- `listArchiveDir` does `tree.get(inner) ?? []` — line 79

The view is virtual. `buildArchiveTree` builds a map of synthetic dirs from `ArchiveEntryInfo` names; navigation is a map lookup, not filesystem access. `inner` containing `..` will simply miss the map and return empty. No filesystem traversal occurs. No explicit `isUnsafeEntryName` check is performed on the URI inner component, but the model cannot escape the archive because it never touches the FS. The browsing path is therefore safe by construction; a stricter URI-normalise would be defensive but not required for extraction safety.

## What remains

- `jsTarExtract` still delegates to `Bun.Archive.extract` with no per-member validation. It is protected by the preflight `firstUnsafeMember` for listable archives, and by staging + `sanitizeStagedLinks` + escape sweep for spawn lanes. Unlistable tarballs bypass preflight and rely solely on the staging sweep.
- The second-pass symlink write order in `jsZipExtract` remains. With preflight and staged link sanitisation the practical risk is low, but an unsafe symlink target that is internal to the archive could still be created and later used by a subsequent write within the same extraction run. Preflight already refuses escaping targets; internal symlinks are left to the staged link sanitiser.
- Archive browsing URI does not normalize `inner`. No FS impact, but inconsistent with the stricter extraction guards.

## Per-point verdicts

1. VERIFIED-COVERED
2. VERIFIED-COVERED
3. VERIFIED-COVERED
4. NOT-APPLICABLE