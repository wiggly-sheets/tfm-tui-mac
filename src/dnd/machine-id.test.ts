import { describe, expect, test } from "bun:test";
import { hashedMachineId, localMachineId, machineId, resetMachineId } from "./machine-id";

// captured from `ioreg -rd1 -c IOPlatformExpertDevice` on macOS
const IOREG_OUTPUT = `+-o J316sAP  <class IOPlatformExpertDevice, id 0x1000002a5, registered, matched, active, busy 0 (209 ms), retain 18>
  {
    "IOPlatformUUID" = "2C267241-FF17-504F-AAAA-2E169240FEA6",
    "IOPolledInterface" = "AppleARMPMU!PMU"
  }`;

describe("hashedMachineId", () => {
  test("matches the openssl reference vector", () => {
    // printf '%s' 'test-machine-id' | openssl dgst -sha256 -hmac 'tty-dnd-protocol-machine-id'
    const expected = "1:eb8902438164bda69a84a0d04625870bf22a242b04a0168b2515eecd8e4cc362";
    expect(hashedMachineId("test-machine-id")).toBe(expected);
    expect(hashedMachineId("test-machine-id")).toMatch(/^1:[0-9a-f]{64}$/);
  });
});

describe("localMachineId", () => {
  test("hashes the trimmed machine-id file", () => {
    expect(localMachineId({ platform: "linux", read: () => "abc123\n" })).toBe(
      "1:d75eec716b9f34dcb6681096f8333bb5401771a7df739591b9e4952562918a87",
    );
  });

  test("missing/unreadable file degrades to empty (local-only behavior)", () => {
    expect(
      localMachineId({
        platform: "linux",
        read: () => {
          throw new Error("ENOENT");
        },
      }),
    ).toBe("");
  });

  test("darwin hashes the IOPlatformUUID hardware uuid (no /etc/machine-id there)", () => {
    const seen: string[][] = [];
    const id = localMachineId({
      platform: "darwin",
      run: (bin, args) => {
        seen.push([bin, ...args]);
        return IOREG_OUTPUT;
      },
    });
    expect(id).toBe("1:99dd2cc026aaeba6df4689def2eb282d04a4ee44cc268cdd4502e8b6627c14d2");
    expect(id).toMatch(/^1:[0-9a-f]{64}$/);
    expect(seen).toEqual([["ioreg", "-rd1", "-c", "IOPlatformExpertDevice"]]);
  });

  test("darwin command failure degrades to empty", () => {
    expect(
      localMachineId({
        platform: "darwin",
        run: () => {
          throw new Error("ENOENT");
        },
      }),
    ).toBe("");
  });

  test("darwin garbage output degrades to empty", () => {
    expect(localMachineId({ platform: "darwin", run: () => "\x01\x02 not ioreg output" })).toBe("");
    expect(localMachineId({ platform: "darwin", run: () => 'IOPlatformUUID = "unquoted"' })).toBe("");
    expect(localMachineId({ platform: "darwin", run: () => '"IOPlatformUUID" = ""' })).toBe("");
  });
});

describe("machineId", () => {
  test("memoizes the resolved id (one spawn per process)", () => {
    resetMachineId();
    let calls = 0;
    const deps = {
      platform: "darwin",
      run: () => {
        calls++;
        return IOREG_OUTPUT;
      },
    };
    expect(machineId(deps)).toBe(machineId(deps));
    expect(calls).toBe(1);
    resetMachineId();
  });
});
