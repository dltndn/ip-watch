import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  getDashboardSnapshot,
  listIpRecords,
  openDatabase,
  updateIpRecord,
  upsertScanRecords,
  type SqliteDatabase,
} from "../src/db.js";
import { calculateCidrState, type IpRecord } from "../src/state.js";

const CIDR = "10.0.0.0/29";
const OTHER_CIDR = "192.168.10.0/30";
const SCAN_AT = "2026-09-02T06:00:00.000Z";

describe("openDatabase", () => {
  const opened: Array<{ db: SqliteDatabase; dir: string }> = [];

  afterEach(() => {
    for (const item of opened.splice(0)) {
      item.db.close();
      rmSync(item.dir, { recursive: true, force: true });
    }
  });

  it("applies and verifies WAL mode and busy_timeout=5000", () => {
    const { db } = openTemp(opened);

    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.pragma("busy_timeout", { simple: true })).toBe(5000);
  });

  it("fails startup without falling back when the path cannot be opened", () => {
    const missingParent = join(
      tmpdir(),
      `ip-watch-missing-${Date.now()}`,
      "ip-watch.sqlite3",
    );

    expect(() => openDatabase(missingParent)).toThrow();

    const dir = mkdtempSync(join(tmpdir(), "ip-watch-dir-"));
    try {
      expect(() => openDatabase(dir)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("enforces table constraints on the real schema", () => {
    const { db } = openTemp(opened);
    const insert = db.prepare(`
      INSERT INTO ip_records (
        cidr, ip_address, observed_status, is_reserved, mac_address, note,
        first_seen_at, last_seen_at, last_checked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insert.run(CIDR, "10.0.0.1", "AVAILABLE", 0, null, "", null, null, SCAN_AT);

    expect(() =>
      insert.run(CIDR, "10.0.0.1", "ACTIVE", 0, null, "", null, null, SCAN_AT),
    ).toThrow(/UNIQUE constraint failed|PRIMARY KEY/i);

    expect(() =>
      insert.run(CIDR, "10.0.0.2", "RESERVED", 0, null, "", null, null, SCAN_AT),
    ).toThrow(/CHECK constraint failed/i);

    expect(() =>
      insert.run(CIDR, "10.0.0.2", "AVAILABLE", 2, null, "", null, null, SCAN_AT),
    ).toThrow(/CHECK constraint failed/i);

    expect(() =>
      insert.run(
        CIDR,
        "10.0.0.2",
        "AVAILABLE",
        0,
        null,
        "x".repeat(1001),
        null,
        null,
        SCAN_AT,
      ),
    ).toThrow(/CHECK constraint failed/i);

    expect(() =>
      insert.run(CIDR, "10.0.0.2", "AVAILABLE", 0, null, null, null, null, SCAN_AT),
    ).toThrow(/NOT NULL/i);

    insert.run(
      CIDR,
      "10.0.0.2",
      "AVAILABLE",
      1,
      null,
      "x".repeat(1000),
      null,
      null,
      SCAN_AT,
    );
    expect(listIpRecords(db, CIDR)).toHaveLength(2);
  });
});

describe("ip record persistence", () => {
  const opened: Array<{ db: SqliteDatabase; dir: string }> = [];

  afterEach(() => {
    for (const item of opened.splice(0)) {
      item.db.close();
      rmSync(item.dir, { recursive: true, force: true });
    }
  });

  it("reads CIDR-isolated records in numeric IP order", () => {
    const { db } = openTemp(opened);
    upsertScanRecords(db, [
      record({ ipAddress: "10.0.0.10", cidr: "10.0.0.0/24" }),
      record({ ipAddress: "10.0.0.2", cidr: "10.0.0.0/24" }),
      record({ ipAddress: "192.168.10.1", cidr: OTHER_CIDR }),
    ]);

    expect(listIpRecords(db, "10.0.0.0/24").map((item) => item.ipAddress)).toEqual([
      "10.0.0.2",
      "10.0.0.10",
    ]);
    expect(listIpRecords(db, OTHER_CIDR).map((item) => item.ipAddress)).toEqual([
      "192.168.10.1",
    ]);
  });

  it("converts integer booleans and leaves UTC ISO strings unchanged", () => {
    const { db } = openTemp(opened);
    upsertScanRecords(db, [
      record({
        ipAddress: "10.0.0.1",
        observedStatus: "ACTIVE",
        isReserved: true,
        macAddress: "aa:bb:cc:dd:ee:01",
        note: "router",
        firstSeenAt: SCAN_AT,
        lastSeenAt: SCAN_AT,
      }),
    ]);

    expect(listIpRecords(db, CIDR)[0]).toEqual({
      cidr: CIDR,
      ipAddress: "10.0.0.1",
      observedStatus: "ACTIVE",
      isReserved: true,
      macAddress: "aa:bb:cc:dd:ee:01",
      note: "router",
      firstSeenAt: SCAN_AT,
      lastSeenAt: SCAN_AT,
      lastCheckedAt: SCAN_AT,
    });
  });

  it("does not overwrite note or reservation during scan upsert", () => {
    const { db } = openTemp(opened);
    upsertScanRecords(db, [
      record({
        ipAddress: "10.0.0.1",
        note: "keep me",
        isReserved: true,
      }),
    ]);

    upsertScanRecords(db, [
      record({
        ipAddress: "10.0.0.1",
        observedStatus: "ACTIVE",
        note: "scanner must not win",
        isReserved: false,
        macAddress: "aa:bb:cc:dd:ee:01",
        firstSeenAt: SCAN_AT,
        lastSeenAt: SCAN_AT,
      }),
    ]);

    expect(listIpRecords(db, CIDR)[0]).toMatchObject({
      observedStatus: "ACTIVE",
      note: "keep me",
      isReserved: true,
      macAddress: "aa:bb:cc:dd:ee:01",
    });
  });

  it("rolls back the whole scan upsert when a later row fails", () => {
    const { db } = openTemp(opened);
    upsertScanRecords(db, [
      record({
        ipAddress: "10.0.0.1",
        observedStatus: "AVAILABLE",
        note: "original",
      }),
    ]);

    expect(() =>
      upsertScanRecords(db, [
        record({
          ipAddress: "10.0.0.1",
          observedStatus: "ACTIVE",
          note: "would change if committed",
          firstSeenAt: SCAN_AT,
          lastSeenAt: SCAN_AT,
        }),
        {
          ...record({ ipAddress: "10.0.0.2" }),
          observedStatus: "NOT_A_STATUS" as IpRecord["observedStatus"],
        },
      ]),
    ).toThrow(/CHECK constraint failed/i);

    expect(listIpRecords(db, CIDR)).toEqual([
      record({
        ipAddress: "10.0.0.1",
        observedStatus: "AVAILABLE",
        note: "original",
      }),
    ]);
  });

  it("updates only supplied note or reservation fields", () => {
    const { db } = openTemp(opened);
    upsertScanRecords(db, [
      record({
        ipAddress: "10.0.0.1",
        observedStatus: "ACTIVE",
        note: "before",
        isReserved: false,
        macAddress: "aa:bb:cc:dd:ee:01",
        firstSeenAt: SCAN_AT,
        lastSeenAt: SCAN_AT,
      }),
    ]);

    expect(updateIpRecord(db, CIDR, "10.0.0.1", { note: "after" })).toMatchObject({
      note: "after",
      isReserved: false,
      observedStatus: "ACTIVE",
      macAddress: "aa:bb:cc:dd:ee:01",
    });
    expect(updateIpRecord(db, CIDR, "10.0.0.1", { isReserved: true })).toMatchObject({
      note: "after",
      isReserved: true,
    });

    expect(() =>
      updateIpRecord(db, CIDR, "10.0.0.1", { note: "x".repeat(1001) }),
    ).toThrow(/CHECK constraint failed/i);
    expect(listIpRecords(db, CIDR)[0]).toMatchObject({
      note: "after",
      isReserved: true,
    });

    expect(() => updateIpRecord(db, CIDR, "10.0.0.9", { note: "missing" })).toThrow(
      /not found/,
    );
  });

  it("calculates dashboard allocation candidates from one consistent snapshot", () => {
    const { db } = openTemp(opened);
    const snapshot = calculateCidrState(
      [
        record({ ipAddress: "10.0.0.3", isReserved: true }),
        record({ ipAddress: "10.0.0.4", isReserved: true, note: "held" }),
      ],
      {
        cidr: CIDR,
        scannedAt: SCAN_AT,
        observations: [
          { ipAddress: "10.0.0.1", responded: true, macAddress: "aa:bb:cc:dd:ee:01" },
          { ipAddress: "10.0.0.4", responded: true, macAddress: null },
        ],
      },
    );

    upsertScanRecords(db, snapshot.records);
    updateIpRecord(db, CIDR, "10.0.0.3", { isReserved: true });
    updateIpRecord(db, CIDR, "10.0.0.6", { isReserved: true });

    const dashboard = getDashboardSnapshot(db, CIDR);
    const stored = listIpRecords(db, CIDR);

    expect(
      dashboard.records.map(({ effectiveStatus: _effectiveStatus, ...record }) => record),
    ).toEqual(stored);
    expect(
      dashboard.records.every((record) => record.effectiveStatus === record.observedStatus),
    ).toBe(true);
    expect(dashboard.summary.total).toBe(6);
    expect(dashboard.summary.active).toBe(2);
    expect(dashboard.summary.available).toBe(4);
    expect(dashboard.summary.reserved).toBe(3);
    expect(dashboard.summary.allocationCandidates).toBe(2);
    expect(
      dashboard.records.filter(
        (item) => item.observedStatus === "AVAILABLE" && !item.isReserved,
      ).map((item) => item.ipAddress),
    ).toEqual(["10.0.0.2", "10.0.0.5"]);
  });
});

function openTemp(opened: Array<{ db: SqliteDatabase; dir: string }>): {
  db: SqliteDatabase;
  path: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "ip-watch-db-"));
  const path = join(dir, "ip-watch.sqlite3");
  const db = openDatabase(path);
  opened.push({ db, dir });
  return { db, path };
}

function record(overrides: Partial<IpRecord> & { ipAddress: string }): IpRecord {
  return {
    cidr: CIDR,
    observedStatus: "AVAILABLE",
    isReserved: false,
    macAddress: null,
    note: "",
    firstSeenAt: null,
    lastSeenAt: null,
    lastCheckedAt: SCAN_AT,
    ...overrides,
  };
}
