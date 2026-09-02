import { describe, expect, it } from "vitest";

import {
  CidrError,
  ScanStateError,
  calculateCidrState,
  listUsableHosts,
  parseIpv4Cidr,
  summarizeRecords,
  type IpRecord,
  type NormalizedHostObservation,
  type NormalizedScanResult,
} from "../src/state.js";

const CIDR = "10.0.0.0/29";
const SCAN_AT = "2026-09-02T06:00:00.000Z";
const LATER_SCAN_AT = "2026-09-02T06:00:10.000Z";
const HOSTS = [
  "10.0.0.1",
  "10.0.0.2",
  "10.0.0.3",
  "10.0.0.4",
  "10.0.0.5",
  "10.0.0.6",
] as const;

describe("parseIpv4Cidr", () => {
  it("generates 254 numeric hosts from .1 through .254 for a /24", () => {
    const parsed = parseIpv4Cidr("192.168.1.0/24");
    const hosts = parsed.usableHosts;

    expect(hosts).toHaveLength(254);
    expect(parsed.usableHostCount).toBe(254);
    expect(hosts[0]).toBe("192.168.1.1");
    expect(hosts[8]).toBe("192.168.1.9");
    expect(hosts[9]).toBe("192.168.1.10");
    expect(hosts[253]).toBe("192.168.1.254");
    expect(hosts).not.toContain("192.168.1.0");
    expect(hosts).not.toContain("192.168.1.255");
    expect(parsed.networkAddress).toBe("192.168.1.0");
    expect(parsed.broadcastAddress).toBe("192.168.1.255");
  });

  it("excludes network and broadcast addresses for a /29", () => {
    expect(listUsableHosts(CIDR)).toEqual([...HOSTS]);
  });

  it("treats non-network-aligned input as the containing network", () => {
    expect(listUsableHosts("192.168.1.42/24")).toEqual(
      listUsableHosts("192.168.1.0/24"),
    );
    expect(listUsableHosts("10.0.0.5/29")).toEqual([...HOSTS]);
    expect(parseIpv4Cidr("192.168.1.42/24").networkAddress).toBe("192.168.1.0");
    expect(parseIpv4Cidr("192.168.1.42/24").broadcastAddress).toBe("192.168.1.255");
  });

  it.each(["192.168.1.0/31", "192.168.1.1/32"])(
    "rejects unsupported prefix %s",
    (cidr) => {
      expect(() => parseIpv4Cidr(cidr)).toThrowError(
        new CidrError("UNSUPPORTED_PREFIX", "CIDR prefixes /31 and /32 are not supported"),
      );
    },
  );

  it("rejects ranges with more than 254 usable hosts", () => {
    expect(() => parseIpv4Cidr("10.0.0.0/23")).toThrowError(
      new CidrError(
        "TOO_MANY_HOSTS",
        "CIDR supports at most 254 usable hosts; received 510",
        510,
      ),
    );
  });

  it.each(["192.168.1.1", "2001:db8::/32", "192.168.001.0/24", "192.168.1.999/24"])(
    "rejects invalid CIDR %s",
    (cidr) => {
      expect(() => parseIpv4Cidr(cidr)).toThrow(CidrError);
    },
  );
});

describe("calculateCidrState", () => {
  it("marks ARP and Ping responses ACTIVE and missing hosts AVAILABLE", () => {
    const snapshot = calculateCidrState([], scanResult([
      arp("10.0.0.1", "AA:BB:CC:DD:EE:01"),
      ping("10.0.0.2"),
    ]));

    expect(record(snapshot, "10.0.0.1")).toMatchObject({
      observedStatus: "ACTIVE",
      macAddress: "aa:bb:cc:dd:ee:01",
      firstSeenAt: SCAN_AT,
      lastSeenAt: SCAN_AT,
      lastCheckedAt: SCAN_AT,
      note: "",
      isReserved: false,
    });
    expect(record(snapshot, "10.0.0.2")).toMatchObject({
      observedStatus: "ACTIVE",
      macAddress: null,
      firstSeenAt: SCAN_AT,
      lastSeenAt: SCAN_AT,
      lastCheckedAt: SCAN_AT,
    });
    expect(record(snapshot, "10.0.0.3")).toMatchObject({
      observedStatus: "AVAILABLE",
      macAddress: null,
      firstSeenAt: null,
      lastSeenAt: null,
      lastCheckedAt: SCAN_AT,
    });
    expect(snapshot.records.map((item) => item.ipAddress)).toEqual([...HOSTS]);
    expect(snapshot.summary).toEqual({
      total: 6,
      active: 2,
      inactive: 0,
      available: 4,
      reserved: 0,
      allocationCandidates: 4,
    });
  });

  it("marks prior lastSeenAt without a response as INACTIVE", () => {
    const previous = calculateCidrState([], scanResult([arp("10.0.0.1", "aa:bb:cc:dd:ee:01")]));
    const snapshot = calculateCidrState(previous.records, scanResult([], LATER_SCAN_AT));

    expect(record(snapshot, "10.0.0.1")).toMatchObject({
      observedStatus: "INACTIVE",
      macAddress: "aa:bb:cc:dd:ee:01",
      firstSeenAt: SCAN_AT,
      lastSeenAt: SCAN_AT,
      lastCheckedAt: LATER_SCAN_AT,
    });
    expect(record(snapshot, "10.0.0.2")).toMatchObject({
      observedStatus: "AVAILABLE",
      lastSeenAt: null,
      lastCheckedAt: LATER_SCAN_AT,
    });
  });

  it("sets firstSeenAt only when absent and always refreshes lastSeenAt for ACTIVE", () => {
    const first = calculateCidrState([], scanResult([arp("10.0.0.1", "aa:bb:cc:dd:ee:01")]));
    const second = calculateCidrState(
      first.records,
      scanResult([arp("10.0.0.1", "aa:bb:cc:dd:ee:01")], LATER_SCAN_AT),
    );

    expect(record(second, "10.0.0.1")).toMatchObject({
      observedStatus: "ACTIVE",
      firstSeenAt: SCAN_AT,
      lastSeenAt: LATER_SCAN_AT,
      lastCheckedAt: LATER_SCAN_AT,
    });
  });

  it("replaces MAC on a new ARP observation and preserves it for Ping-only or no response", () => {
    const withArp = calculateCidrState([], scanResult([arp("10.0.0.1", "aa:bb:cc:dd:ee:01")]));
    const replaced = calculateCidrState(
      withArp.records,
      scanResult([arp("10.0.0.1", "11:22:33:44:55:66")], LATER_SCAN_AT),
    );
    const pingOnly = calculateCidrState(
      replaced.records,
      scanResult([ping("10.0.0.1")], "2026-09-02T06:00:20.000Z"),
    );
    const silent = calculateCidrState(
      pingOnly.records,
      scanResult([], "2026-09-02T06:00:30.000Z"),
    );

    expect(record(replaced, "10.0.0.1").macAddress).toBe("11:22:33:44:55:66");
    expect(record(pingOnly, "10.0.0.1")).toMatchObject({
      observedStatus: "ACTIVE",
      macAddress: "11:22:33:44:55:66",
    });
    expect(record(silent, "10.0.0.1")).toMatchObject({
      observedStatus: "INACTIVE",
      macAddress: "11:22:33:44:55:66",
    });
  });

  it("preserves note and reservation across every scan calculation", () => {
    const seeded: IpRecord[] = HOSTS.map((ipAddress, index) => ({
      cidr: CIDR,
      ipAddress,
      observedStatus: "AVAILABLE",
      isReserved: index === 0 || index === 2,
      macAddress: null,
      note: index === 0 ? "gateway" : "",
      firstSeenAt: null,
      lastSeenAt: null,
      lastCheckedAt: null,
    }));
    const snapshot = calculateCidrState(
      seeded,
      scanResult([arp("10.0.0.1", "aa:bb:cc:dd:ee:01"), ping("10.0.0.2")]),
    );

    expect(record(snapshot, "10.0.0.1")).toMatchObject({
      observedStatus: "ACTIVE",
      note: "gateway",
      isReserved: true,
    });
    expect(record(snapshot, "10.0.0.2")).toMatchObject({
      observedStatus: "ACTIVE",
      note: "",
      isReserved: false,
    });
    expect(record(snapshot, "10.0.0.3")).toMatchObject({
      observedStatus: "AVAILABLE",
      isReserved: true,
    });
  });

  it("counts allocation candidates as unreserved AVAILABLE only", () => {
    const snapshot = calculateCidrState(
      [
        {
          cidr: CIDR,
          ipAddress: "10.0.0.3",
          observedStatus: "AVAILABLE",
          isReserved: true,
          macAddress: null,
          note: "held",
          firstSeenAt: null,
          lastSeenAt: null,
          lastCheckedAt: null,
        },
        {
          cidr: CIDR,
          ipAddress: "10.0.0.4",
          observedStatus: "AVAILABLE",
          isReserved: false,
          macAddress: null,
          note: "",
          firstSeenAt: SCAN_AT,
          lastSeenAt: SCAN_AT,
          lastCheckedAt: SCAN_AT,
        },
      ],
      scanResult([arp("10.0.0.1", "aa:bb:cc:dd:ee:01")]),
    );

    expect(snapshot.summary).toEqual({
      total: 6,
      active: 1,
      inactive: 1,
      available: 4,
      reserved: 1,
      allocationCandidates: 3,
    });
    expect(
      snapshot.records.filter(
        (item) => item.observedStatus === "AVAILABLE" && !item.isReserved,
      ).map((item) => item.ipAddress),
    ).toEqual(["10.0.0.2", "10.0.0.5", "10.0.0.6"]);
    expect(summarizeRecords(snapshot.records).allocationCandidates).toBe(3);
  });

  it("ignores existing records from another CIDR", () => {
    const snapshot = calculateCidrState(
      [
        {
          cidr: "192.168.1.0/24",
          ipAddress: "10.0.0.1",
          observedStatus: "ACTIVE",
          isReserved: true,
          macAddress: "aa:bb:cc:dd:ee:ff",
          note: "other",
          firstSeenAt: SCAN_AT,
          lastSeenAt: SCAN_AT,
          lastCheckedAt: SCAN_AT,
        },
      ],
      scanResult([]),
    );

    expect(record(snapshot, "10.0.0.1")).toMatchObject({
      observedStatus: "AVAILABLE",
      isReserved: false,
      macAddress: null,
      note: "",
    });
  });

  it.each([
    {
      name: "out-of-CIDR",
      observations: [arp("10.0.1.1", "aa:bb:cc:dd:ee:01")],
      message: /outside the target CIDR/,
    },
    {
      name: "network address",
      observations: [ping("10.0.0.0")],
      message: /outside the target CIDR/,
    },
    {
      name: "broadcast address",
      observations: [ping("10.0.0.7")],
      message: /outside the target CIDR/,
    },
    {
      name: "duplicate",
      observations: [ping("10.0.0.1"), arp("10.0.0.1", "aa:bb:cc:dd:ee:01")],
      message: /duplicate IP/,
    },
    {
      name: "malformed IP",
      observations: [ping("10.0.0.01")],
      message: /IP is invalid/,
    },
    {
      name: "malformed MAC",
      observations: [arp("10.0.0.1", "not-a-mac")],
      message: /MAC is invalid/,
    },
    {
      name: "MAC without a response",
      observations: [{ ipAddress: "10.0.0.1", responded: false, macAddress: "aa:bb:cc:dd:ee:01" }],
      message: /cannot include a MAC without a response/,
    },
  ])("rejects $name observations", ({ observations, message }) => {
    expect(() => calculateCidrState([], scanResult(observations))).toThrowError(
      ScanStateError,
    );
    expect(() => calculateCidrState([], scanResult(observations))).toThrow(message);
  });

  it("accepts Date.prototype.toISOString() UTC timestamps unchanged", () => {
    const scannedAt = new Date("2026-09-02T06:00:00.000Z").toISOString();
    const snapshot = calculateCidrState([], scanResult([], scannedAt));

    expect(scannedAt).toBe("2026-09-02T06:00:00.000Z");
    expect(record(snapshot, "10.0.0.1").lastCheckedAt).toBe(scannedAt);
  });

  it("accepts a UTC ISO timestamp without fractional seconds unchanged", () => {
    const scannedAt = "2026-09-02T06:00:00Z";
    const snapshot = calculateCidrState([], scanResult([ping("10.0.0.1")], scannedAt));

    expect(record(snapshot, "10.0.0.1").lastCheckedAt).toBe(scannedAt);
    expect(record(snapshot, "10.0.0.1").lastSeenAt).toBe(scannedAt);
  });

  it.each([
    ["malformed text", "not-a-utc-iso-timestamp"],
    ["a non-UTC offset", "2026-09-02T06:00:00.000+09:00"],
    ["a UTC offset instead of Z", "2026-09-02T06:00:00.000+00:00"],
    ["an impossible date", "2026-02-30T00:00:00.000Z"],
    ["an impossible time", "2026-09-02T25:00:00.000Z"],
  ])("rejects %s without returning records", (_label, scannedAt) => {
    let snapshot: ReturnType<typeof calculateCidrState> | undefined;
    expect(() => {
      snapshot = calculateCidrState([], scanResult([], scannedAt));
    }).toThrow(ScanStateError);
    expect(snapshot).toBeUndefined();
  });
});

function scanResult(
  observations: NormalizedHostObservation[],
  scannedAt = SCAN_AT,
): NormalizedScanResult {
  return {
    cidr: CIDR,
    scannedAt,
    observations,
  };
}

function arp(ipAddress: string, macAddress: string): NormalizedHostObservation {
  return { ipAddress, responded: true, macAddress };
}

function ping(ipAddress: string): NormalizedHostObservation {
  return { ipAddress, responded: true, macAddress: null };
}

function record(
  snapshot: ReturnType<typeof calculateCidrState>,
  ipAddress: string,
): IpRecord {
  const found = snapshot.records.find((item) => item.ipAddress === ipAddress);
  expect(found).toBeDefined();
  return found as IpRecord;
}
