// Regenerate config.example.toml from the schema. Run: bun scripts/regen-example.ts
// The repo copy is byte-identical to exampleToml() (see
// src/config/config-schema.test.ts). Add a key row, then re-run this — do not
// hand-edit the file or the test fails.
import { exampleToml } from "../src/config/config-schema.ts";
import { writeFileSync } from "node:fs";
writeFileSync(new URL("../config.example.toml", import.meta.url), exampleToml());
console.log("regenerated config.example.toml");
