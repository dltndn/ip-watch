import { describe, expect, it } from "vitest";

import {
  MockScanner,
  ScanError,
  createLifecycleScenario,
  createMockScanner,
  errorFrame,
  okFrame,
  pingObservation,
  silentObservation,
} from "../src/scanner.js";
import { calculateCidrState } from "../src/state.js";

const CIDR = "10.0.0.0/29";
const FIXED_NOW = new Date("2026-09-02T06:00:00.000Z");

describe("MockScanner", () => {
  it("consumes frames in order and stamps scannedAt from the injected clock", async () => {
    const scenario = createLifecycleScenario(CIDR);
    let current = FIXED_NOW.getTime();
    const scanner = new MockScanner({
      cidr: CIDR,
      frames: scenario.frames.slice(0, 3),
      now: () => new Date(current),
      repeatLast: false,
    });

    const first = await scanner.scan();
    current += 1_000;
    const second = await scanner.scan();

    expect(first.cidr).toBe(CIDR);
    expect(first.scannedAt).toBe("2026-09-02T06:00:00.000Z");
    expect(first.observations).toEqual([]);
    expect(second.scannedAt).toBe("2026-09-02T06:00:01.000Z");
    expect(second.observations).toEqual([
      {
        ipAddress: scenario.hosts.arp,
        responded: true,
        macAddress: scenario.macAddresses.original,
      },
    ]);
  });

  it("throws ScanError on an error frame", async () => {
    const scanner = new MockScanner({
      cidr: CIDR,
      frames: [errorFrame("arp-scan missing")],
      now: () => FIXED_NOW,
      repeatLast: false,
    });

    await expect(scanner.scan()).rejects.toSatisfy((error: unknown) => {
      return error instanceof ScanError && error.message === "arp-scan missing";
    });
  });

  it("repeats the last successful frame after the list is exhausted", async () => {
    const scenario = createLifecycleScenario(CIDR);
    const scanner = new MockScanner({
      cidr: CIDR,
      frames: [okFrame([pingObservation(scenario.hosts.ping)])],
      now: () => FIXED_NOW,
    });

    const first = await scanner.scan();
    const second = await scanner.scan();

    expect(second.observations).toEqual(first.observations);
    expect(second.scannedAt).toBe(first.scannedAt);
  });

  it("returns observations that satisfy calculateCidrState", async () => {
    const scenario = createLifecycleScenario(CIDR);
    const scanner = new MockScanner({
      cidr: CIDR,
      frames: scenario.frames.filter((frame) => frame.kind === "ok"),
      now: () => FIXED_NOW,
      repeatLast: false,
    });

    let existing: ReturnType<typeof calculateCidrState>["records"] = [];
    for (const _frame of scenario.frames.filter((frame) => frame.kind === "ok")) {
      const result = await scanner.scan();
      for (const observation of result.observations) {
        expect(observation.ipAddress.startsWith("10.0.0.")).toBe(true);
        if (!observation.responded) {
          expect(observation.macAddress).toBeNull();
        }
      }

      const snapshot = calculateCidrState(existing, result);
      expect(snapshot.records).toHaveLength(6);
      existing = snapshot.records;
    }
  });

  it("expresses the six required mock scenarios in one lifecycle", async () => {
    const scenario = createLifecycleScenario(CIDR);
    const scanner = new MockScanner({
      cidr: CIDR,
      frames: scenario.frames,
      now: () => FIXED_NOW,
      repeatLast: false,
    });

    const unseen = await scanner.scan();
    expect(unseen.observations).toEqual([]);
    expect(calculateCidrState([], unseen).summary.available).toBe(6);

    const arp = await scanner.scan();
    expect(arp.observations).toEqual([
      {
        ipAddress: scenario.hosts.arp,
        responded: true,
        macAddress: scenario.macAddresses.original,
      },
    ]);

    const ping = await scanner.scan();
    expect(ping.observations).toContainEqual({
      ipAddress: scenario.hosts.ping,
      responded: true,
      macAddress: null,
    });

    const disconnected = await scanner.scan();
    expect(disconnected.observations).toContainEqual(
      silentObservation(scenario.hosts.arp),
    );

    const macChanged = await scanner.scan();
    expect(macChanged.observations).toEqual([
      {
        ipAddress: scenario.hosts.arp,
        responded: true,
        macAddress: scenario.macAddresses.changed,
      },
    ]);

    await expect(scanner.scan()).rejects.toBeInstanceOf(ScanError);
  });

  it("builds a deterministic default mock scanner from config", async () => {
    const scanner = createMockScanner(
      { targetCidr: CIDR },
      { now: () => FIXED_NOW },
    );

    const first = await scanner.scan();
    const second = await scanner.scan();

    expect(first.scannedAt).toBe("2026-09-02T06:00:00.000Z");
    expect(first.observations).toEqual([]);
    expect(second.observations.length).toBeGreaterThan(0);
    expect(() => calculateCidrState([], second)).not.toThrow();
  });
});
