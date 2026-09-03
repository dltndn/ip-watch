import { describe, expect, it } from "vitest";

import { ConfigError, loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("counts usable hosts for a non-network-aligned CIDR", () => {
    const config = loadConfig({
      TARGET_CIDR: "192.168.1.42/24",
      USE_MOCK_SCANNER: "true",
    });

    expect(config.targetCidr).toBe("192.168.1.42/24");
    expect(config.targetHostCount).toBe(254);
  });

  it("loads the documented defaults for a mock scanner", () => {
    const config = loadConfig({
      TARGET_CIDR: "192.168.1.0/24",
      USE_MOCK_SCANNER: "true",
    });

    expect(config).toMatchObject({
      nodeEnv: "development",
      bindAddress: "0.0.0.0",
      port: 3000,
      databasePath: "/app/data/ip-watch.sqlite3",
      targetCidr: "192.168.1.0/24",
      targetHostCount: 254,
      scanIntervalMs: 10_000,
      scanTimeoutMs: 10_000,
      pingTimeoutMs: 1_000,
      pingConcurrency: 20,
      useMockScanner: true,
    });
  });

  it("rejects a missing TARGET_CIDR before startup", () => {
    expect(() => loadConfig({ USE_MOCK_SCANNER: "true" })).toThrowError(
      new ConfigError("TARGET_CIDR is required"),
    );
  });

  it.each(["192.168.1.1", "192.168.1.999/24", "192.168.001.0/24"])(
    "rejects invalid CIDR %s",
    (targetCidr) => {
      expect(() =>
        loadConfig({ TARGET_CIDR: targetCidr, USE_MOCK_SCANNER: "true" }),
      ).toThrow(ConfigError);
    },
  );

  it("rejects a CIDR with more than 254 usable hosts", () => {
    expect(() =>
      loadConfig({ TARGET_CIDR: "10.0.0.0/23", USE_MOCK_SCANNER: "true" }),
    ).toThrow(/at most 254 usable hosts/);
  });

  it.each(["192.168.1.0/31", "192.168.1.1/32"])(
    "rejects unsupported prefix in %s",
    (targetCidr) => {
      expect(() =>
        loadConfig({ TARGET_CIDR: targetCidr, USE_MOCK_SCANNER: "true" }),
      ).toThrow(/\/31 and \/32 are not supported/);
    },
  );

  it("requires an interface for the real scanner", () => {
    expect(() => loadConfig({ TARGET_CIDR: "10.0.0.0/24" })).toThrow(
      /NETWORK_INTERFACE is required/,
    );
  });

  it.each([
    ["PORT", "0"],
    ["SCAN_INTERVAL_MS", "-1"],
    ["PING_CONCURRENCY", "255"],
  ])("rejects out-of-range %s", (name, value) => {
    expect(() =>
      loadConfig({
        TARGET_CIDR: "10.0.0.0/24",
        USE_MOCK_SCANNER: "true",
        [name]: value,
      }),
    ).toThrow(ConfigError);
  });

  it("defaults STALE_THRESHOLD_DAYS to 0 when unset", () => {
    const config = loadConfig({
      TARGET_CIDR: "192.168.1.0/24",
      USE_MOCK_SCANNER: "true",
    });
    expect(config.staleThresholdDays).toBe(0);
  });

  it('treats STALE_THRESHOLD_DAYS "0" as off', () => {
    const config = loadConfig({
      TARGET_CIDR: "192.168.1.0/24",
      USE_MOCK_SCANNER: "true",
      STALE_THRESHOLD_DAYS: "0",
    });
    expect(config.staleThresholdDays).toBe(0);
  });

  it("accepts a valid positive STALE_THRESHOLD_DAYS", () => {
    const config = loadConfig({
      TARGET_CIDR: "192.168.1.0/24",
      USE_MOCK_SCANNER: "true",
      STALE_THRESHOLD_DAYS: "30",
    });
    expect(config.staleThresholdDays).toBe(30);
  });

  it("rejects STALE_THRESHOLD_DAYS above the maximum", () => {
    expect(() =>
      loadConfig({
        TARGET_CIDR: "192.168.1.0/24",
        USE_MOCK_SCANNER: "true",
        STALE_THRESHOLD_DAYS: "36501",
      }),
    ).toThrow(ConfigError);
  });

  it.each(["-1", "1.5", "abc", "30d"])(
    "rejects invalid STALE_THRESHOLD_DAYS %s",
    (value) => {
      expect(() =>
        loadConfig({
          TARGET_CIDR: "192.168.1.0/24",
          USE_MOCK_SCANNER: "true",
          STALE_THRESHOLD_DAYS: value,
        }),
      ).toThrow(ConfigError);
    },
  );
});
