// --- Kitty DnD machine id (docs/dnd-protocol.rst "Machine id"): the hashed
// local identity that lets the terminal flag cross-machine drops (X=1). Wire
// form is `1:<hex-hmac-sha256>` over the platform's raw id with the fixed
// protocol key; anything unreadable degrades to "" (local-only behavior,
// unchanged). Sources: /etc/machine-id on Linux, the IOPlatformUUID hardware
// UUID on darwin (macOS ships no /etc/machine-id). Reads/spawns arrive via
// seam; the resolved id is memoized because the darwin source spawns ioreg. ---

import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { isDarwin } from "../fs/darwin";

export const MACHINE_ID_HMAC_KEY = "tty-dnd-protocol-machine-id";

// base id -> wire form ("1:<lowercase hex>"); unknown future versions must be
// treated as a different machine, so only version 1 is ever produced here
export const hashedMachineId = (baseId: string): string =>
  `1:${createHmac("sha256", MACHINE_ID_HMAC_KEY).update(baseId).digest("hex")}`;

// `ioreg -rd1 -c IOPlatformExpertDevice` prints one `"Key" = <value>` per line;
// IOPlatformUUID is the hardware UUID (stable per machine, no privileges).
// Anything else — no such line, unquoted value, binary garbage — yields "" so
// the caller degrades exactly like an unreadable /etc/machine-id.
const parsePlatformUuid = (ioregOut: string): string =>
  /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(ioregOut)?.[1]?.trim() ?? "";

export type MachineIdDeps = {
  platform?: string;
  // /etc/machine-id reader (linux source; seam, never the live file in tests)
  read?: () => string;
  // command runner for the darwin source (seam; default spawns ioreg)
  run?: (bin: string, args: string[]) => string;
};

const readMachineIdFile = (): string => readFileSync("/etc/machine-id", "utf8");
const runIoreg = (bin: string, args: string[]): string => execFileSync(bin, args, { encoding: "utf8", timeout: 5_000 });

// the platform's raw id, trimmed, hashed the same way on both platforms
export const localMachineId = (deps: MachineIdDeps = {}): string => {
  const { platform = process.platform, read = readMachineIdFile, run = runIoreg } = deps;
  try {
    const raw = isDarwin(platform) ? parsePlatformUuid(run("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"])) : read();
    const base = raw.trim();
    return base ? hashedMachineId(base) : "";
  } catch {
    return "";
  }
};

// Memoized per process: the darwin source spawns a process and no platform id
// changes mid-run. disableDrops/enableDrops re-arms (restart recovery) re-read
// this, so the spawn must not repeat per call.
let cached: string | undefined;
export const machineId = (deps: MachineIdDeps = {}): string => (cached ??= localMachineId(deps));
export const resetMachineId = (): void => {
  cached = undefined;
};
