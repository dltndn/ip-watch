import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { ScanError } from "../src/scanner.js";
import {
  classifyPingResult,
  createRealScanner,
  parseArpScanOutput,
} from "../src/real-scanner.js";
import { calculateCidrState, listUsableHosts } from "../src/state.js";

const CIDR = "10.0.0.0/29";
const FIXED_NOW = new Date("2026-09-02T06:00:00.000Z");
const FIXTURES = new URL("./fixtures/", import.meta.url);

const BASIC_STDOUT = readFixture("arp-scan-basic.txt");
const EMPTY_STDOUT = readFixture("arp-scan-empty.txt");
const DUPLICATE_STDOUT = readFixture("arp-scan-duplicates.txt");

describe("parseArpScanOutput", () => {
  it("parses header, vendor columns, and lowercases MAC addresses", () => {
    const observations = parseArpScanOutput(BASIC_STDOUT);

    expect(observations).toEqual([
      { ipAddress: "10.0.0.1", responded: true, macAddress: "aa:bb:cc:dd:ee:01" },
      { ipAddress: "10.0.0.3", responded: true, macAddress: "11:22:33:44:55:66" },
      { ipAddress: "8.8.8.8", responded: true, macAddress: "de:ad:be:ef:00:01" },
      { ipAddress: "10.0.0.99", responded: true, macAddress: "aa:bb:cc:dd:ee:99" },
    ]);
  });

  it("returns an empty array when there are no result lines", () => {
    expect(parseArpScanOutput(EMPTY_STDOUT)).toEqual([]);
  });

  it("merges duplicate IPs and keeps the first MAC", () => {
    expect(parseArpScanOutput(DUPLICATE_STDOUT)).toEqual([
      { ipAddress: "10.0.0.1", responded: true, macAddress: "aa:bb:cc:dd:ee:01" },
    ]);
  });
});

describe("createRealScanner", () => {
  it("returns ARP and ping-only responders and satisfies calculateCidrState", async () => {
    const pinged: string[] = [];
    const scanner = createRealScanner(baseConfig(), {
      now: () => FIXED_NOW,
      runArpScan: async () => ({ stdout: BASIC_STDOUT }),
      runPing: async ({ ip }) => {
        pinged.push(ip);
        if (ip === "10.0.0.2") {
          return;
        }
        throw execError({ code: 1 });
      },
    });

    const result = await scanner.scan();

    expect(result.cidr).toBe(CIDR);
    expect(result.scannedAt).toBe("2026-09-02T06:00:00.000Z");
    expect(result.observations).toEqual([
      { ipAddress: "10.0.0.1", responded: true, macAddress: "aa:bb:cc:dd:ee:01" },
      { ipAddress: "10.0.0.3", responded: true, macAddress: "11:22:33:44:55:66" },
      { ipAddress: "10.0.0.2", responded: true, macAddress: null },
    ]);
    expect(result.observations.some((observation) => observation.ipAddress === "8.8.8.8")).toBe(
      false,
    );
    expect(result.observations.some((observation) => observation.ipAddress === "10.0.0.99")).toBe(
      false,
    );

    const snapshot = calculateCidrState([], result);
    expect(snapshot.records).toHaveLength(6);
    expect(snapshot.summary.active).toBe(3);
    expect(snapshot.summary.available).toBe(3);
    expect(snapshot.records.find((record) => record.ipAddress === "10.0.0.1")?.observedStatus).toBe(
      "ACTIVE",
    );
    expect(snapshot.records.find((record) => record.ipAddress === "10.0.0.2")?.observedStatus).toBe(
      "ACTIVE",
    );
    expect(snapshot.records.find((record) => record.ipAddress === "10.0.0.2")?.macAddress).toBeNull();
    expect(pinged.sort(compareIp)).toEqual(["10.0.0.2", "10.0.0.4", "10.0.0.5", "10.0.0.6"]);
  });

  it("pings only ARP-silent usable hosts and never exceeds pingConcurrency", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const pinged: string[] = [];
    const scanner = createRealScanner(baseConfig({ pingConcurrency: 2 }), {
      now: () => FIXED_NOW,
      runArpScan: async () => ({ stdout: BASIC_STDOUT }),
      runPing: async ({ ip }) => {
        pinged.push(ip);
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await delay(30);
        inFlight -= 1;
        throw execError({ code: 1 });
      },
    });

    await scanner.scan();

    const usable = listUsableHosts(CIDR);
    expect(pinged).toHaveLength(usable.length - 2);
    expect(pinged).not.toContain("10.0.0.1");
    expect(pinged).not.toContain("10.0.0.3");
    expect(pinged.every((ip) => usable.includes(ip))).toBe(true);
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(maxInFlight).toBe(2);
  });

  it("treats an empty arp-scan fixture as success with no ARP responders", async () => {
    const scanner = createRealScanner(baseConfig(), {
      now: () => FIXED_NOW,
      runArpScan: async () => ({ stdout: EMPTY_STDOUT }),
      runPing: async () => {
        throw execError({ code: 1 });
      },
    });

    const result = await scanner.scan();
    expect(result.observations).toEqual([]);
    expect(calculateCidrState([], result).summary.available).toBe(6);
  });

  it("rejects with ScanError when arp-scan is missing", async () => {
    const scanner = createRealScanner(baseConfig(), {
      now: () => FIXED_NOW,
      runArpScan: async () => {
        throw execError({ code: "ENOENT" });
      },
      runPing: async () => undefined,
    });

    await expect(scanner.scan()).rejects.toSatisfy((error: unknown) => {
      return error instanceof ScanError && error.message === "arp-scan failed: executable not found";
    });
  });

  it("rejects with ScanError when arp-scan exits non-zero", async () => {
    const scanner = createRealScanner(baseConfig(), {
      now: () => FIXED_NOW,
      runArpScan: async () => {
        throw execError({ code: 1 });
      },
      runPing: async () => undefined,
    });

    await expect(scanner.scan()).rejects.toSatisfy((error: unknown) => {
      return (
        error instanceof ScanError &&
        error.message === "arp-scan failed: command exited with an error"
      );
    });
  });

  it("rejects with ScanError when arp-scan times out", async () => {
    const scanner = createRealScanner(baseConfig(), {
      now: () => FIXED_NOW,
      runArpScan: async () => {
        throw execError({ killed: true, signal: "SIGTERM" });
      },
      runPing: async () => undefined,
    });

    await expect(scanner.scan()).rejects.toSatisfy((error: unknown) => {
      return error instanceof ScanError && error.message === "arp-scan timed out";
    });
  });

  it("rejects with ScanError when ping is missing", async () => {
    const scanner = createRealScanner(baseConfig(), {
      now: () => FIXED_NOW,
      runArpScan: async () => ({ stdout: EMPTY_STDOUT }),
      runPing: async () => {
        throw execError({ code: "ENOENT" });
      },
    });

    await expect(scanner.scan()).rejects.toSatisfy((error: unknown) => {
      return error instanceof ScanError && error.message === "ping failed: executable not found";
    });
  });

  it("rejects with ScanError when ping exits with a permission error", async () => {
    const scanner = createRealScanner(baseConfig(), {
      now: () => FIXED_NOW,
      runArpScan: async () => ({ stdout: EMPTY_STDOUT }),
      runPing: async () => {
        throw execError({ code: 2 });
      },
    });

    await expect(scanner.scan()).rejects.toSatisfy((error: unknown) => {
      return error instanceof ScanError && error.message === "ping failed: permission denied";
    });
  });

  it("rejects with ScanError when ping times out as a killed process", async () => {
    const scanner = createRealScanner(baseConfig(), {
      now: () => FIXED_NOW,
      runArpScan: async () => ({ stdout: EMPTY_STDOUT }),
      runPing: async () => {
        throw execError({ killed: true, signal: "SIGTERM" });
      },
    });

    await expect(scanner.scan()).rejects.toSatisfy((error: unknown) => {
      return error instanceof ScanError && error.message === "ping timed out";
    });
  });

  it("omits hosts when ping exits 1 and does not fail the scan", async () => {
    const scanner = createRealScanner(baseConfig(), {
      now: () => FIXED_NOW,
      runArpScan: async () => ({ stdout: EMPTY_STDOUT }),
      runPing: async () => {
        throw execError({ code: 1 });
      },
    });

    const result = await scanner.scan();
    expect(result.observations).toEqual([]);
    expect(() => calculateCidrState([], result)).not.toThrow();
  });

  it("propagates cancellation to the active arp-scan command", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const scanner = createRealScanner(baseConfig(), {
      now: () => FIXED_NOW,
      runArpScan: ({ signal }) => {
        receivedSignal = signal;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
            { once: true },
          );
        });
      },
      runPing: async () => undefined,
    });

    const scan = scanner.scan(controller.signal);
    controller.abort();

    expect(receivedSignal).toBe(controller.signal);
    await expect(scan).rejects.toSatisfy((error: unknown) => {
      return error instanceof ScanError && error.message === "scan cancelled";
    });
  });
});

describe("classifyPingResult", () => {
  it("treats a resolved ping as a response", () => {
    expect(classifyPingResult(null)).toEqual({ status: "responded" });
    expect(classifyPingResult(undefined)).toEqual({ status: "responded" });
  });

  it("treats exit code 1 as a normal non-response", () => {
    expect(classifyPingResult(execError({ code: 1 }))).toEqual({ status: "no-reply" });
  });

  it("treats a missing executable as a scan failure", () => {
    expect(classifyPingResult(execError({ code: "ENOENT" }))).toEqual({
      status: "failure",
      message: "ping failed: executable not found",
    });
  });

  it("treats a killed process as a timeout failure", () => {
    expect(classifyPingResult(execError({ killed: true, signal: "SIGTERM" }))).toEqual({
      status: "failure",
      message: "ping timed out",
    });
  });

  it("treats exit code 2 as a permission failure", () => {
    expect(classifyPingResult(execError({ code: 2 }))).toEqual({
      status: "failure",
      message: "ping failed: permission denied",
    });
  });

  it("treats other numeric exit codes as scan failures", () => {
    expect(classifyPingResult(execError({ code: 3 }))).toEqual({
      status: "failure",
      message: "ping failed: command exited with an error",
    });
  });
});

function baseConfig(
  overrides: Partial<{ pingConcurrency: number }> = {},
): Parameters<typeof createRealScanner>[0] {
  return {
    targetCidr: CIDR,
    networkInterface: "eth0",
    scanTimeoutMs: 10_000,
    pingTimeoutMs: 1_000,
    pingConcurrency: overrides.pingConcurrency ?? 20,
  };
}

function readFixture(name: string): string {
  return readFileSync(new URL(name, FIXTURES), "utf8");
}

function execError(partial: {
  code?: string | number;
  killed?: boolean;
  signal?: NodeJS.Signals;
}): Error {
  const error = new Error("Command failed") as Error & {
    code?: string | number;
    killed?: boolean;
    signal?: NodeJS.Signals;
  };
  if (partial.code !== undefined) {
    error.code = partial.code;
  }
  if (partial.killed !== undefined) {
    error.killed = partial.killed;
  }
  if (partial.signal !== undefined) {
    error.signal = partial.signal;
  }
  return error;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function compareIp(left: string, right: string): number {
  return left.localeCompare(right, "en", { numeric: true });
}
