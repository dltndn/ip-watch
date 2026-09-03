import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  listIpRecords,
  openDatabase,
  updateIpRecord,
  type SqliteDatabase,
} from "../src/db.js";
import { createScanLoop } from "../src/scan-loop.js";
import {
  MockScanner,
  createLifecycleScenario,
  errorFrame,
  okFrame,
  pingObservation,
  type Scanner,
} from "../src/scanner.js";
import type { IpRecord } from "../src/state.js";

const CIDR = "10.0.0.0/29";
const FIXED_NOW = new Date("2026-09-02T07:00:00.000Z");

describe("scan loop", () => {
  const opened: Array<{ db: SqliteDatabase; dir: string }> = [];

  afterEach(() => {
    for (const item of opened.splice(0)) {
      if (item.db.open) {
        item.db.close();
      }
      rmSync(item.dir, { recursive: true, force: true });
    }
  });

  it("records ACTIVE then INACTIVE when a host replies and later goes silent", async () => {
    const scenario = createLifecycleScenario(CIDR);
    const { db } = openTemp(opened);
    const loop = createLoop(
      db,
      new MockScanner({
        cidr: CIDR,
        frames: [scenario.frames[1]!, scenario.frames[3]!],
        now: () => FIXED_NOW,
        repeatLast: false,
      }),
    );

    await expectSuccess(loop.triggerScan());
    expect(record(db, scenario.hosts.arp).observedStatus).toBe("ACTIVE");

    await expectSuccess(loop.triggerScan());
    expect(record(db, scenario.hosts.arp).observedStatus).toBe("INACTIVE");
  });

  it("stores a ping-only response as ACTIVE with a null MAC", async () => {
    const scenario = createLifecycleScenario(CIDR);
    const { db } = openTemp(opened);
    const loop = createLoop(
      db,
      new MockScanner({
        cidr: CIDR,
        frames: [okFrame([pingObservation(scenario.hosts.ping)])],
        now: () => FIXED_NOW,
        repeatLast: false,
      }),
    );

    await expectSuccess(loop.triggerScan());
    const stored = record(db, scenario.hosts.ping);
    expect(stored.observedStatus).toBe("ACTIVE");
    expect(stored.macAddress).toBeNull();
  });

  it("updates mac_address when the same host replies with a new MAC", async () => {
    const scenario = createLifecycleScenario(CIDR);
    const { db } = openTemp(opened);
    const loop = createLoop(
      db,
      new MockScanner({
        cidr: CIDR,
        frames: [scenario.frames[1]!, scenario.frames[4]!],
        now: () => FIXED_NOW,
        repeatLast: false,
      }),
    );

    await expectSuccess(loop.triggerScan());
    expect(record(db, scenario.hosts.arp).macAddress).toBe(scenario.macAddresses.original);

    await expectSuccess(loop.triggerScan());
    expect(record(db, scenario.hosts.arp).macAddress).toBe(scenario.macAddresses.changed);
  });

  it("skips a second scan while the first scan is still running", async () => {
    const scenario = createLifecycleScenario(CIDR);
    const { db } = openTemp(opened);
    const gate = createDeferred<void>();
    const logs: string[] = [];
    const loop = createLoop(
      db,
      new MockScanner({
        cidr: CIDR,
        frames: [
          okFrame([pingObservation(scenario.hosts.ping)], () => gate.promise),
        ],
        now: () => FIXED_NOW,
        repeatLast: false,
      }),
      {
        logger: {
          log: (message) => logs.push(message),
          error: (message) => logs.push(message),
        },
      },
    );

    const first = loop.triggerScan();
    const second = await loop.triggerScan();

    expect(second).toEqual({ status: "skipped" });
    expect(loop.getStatus().isScanning).toBe(true);
    expect(logs.some((line) => line.includes("already in progress"))).toBe(true);

    gate.resolve();
    await expectSuccess(first);
    expect(loop.getStatus().isScanning).toBe(false);
    expect(listIpRecords(db, CIDR)).toHaveLength(6);
  });

  it("cancels an active scan and rejects new scans during shutdown", async () => {
    const scenario = createLifecycleScenario(CIDR);
    const { db } = openTemp(opened);
    const gate = createDeferred<void>();
    const logs: string[] = [];
    const loop = createLoop(
      db,
      new MockScanner({
        cidr: CIDR,
        frames: [
          okFrame([pingObservation(scenario.hosts.ping)], () => gate.promise),
        ],
        now: () => FIXED_NOW,
        repeatLast: false,
      }),
      {
        logger: {
          log: (message) => logs.push(message),
          error: (message) => logs.push(message),
        },
      },
    );

    const activeScan = loop.triggerScan();
    expect(loop.getStatus().isScanning).toBe(true);

    await loop.shutdown();

    await expect(activeScan).resolves.toEqual({ status: "skipped" });
    await expect(loop.triggerScan()).resolves.toEqual({ status: "skipped" });
    expect(loop.getStatus().isScanning).toBe(false);
    expect(listIpRecords(db, CIDR)).toEqual([]);
    expect(logs.some((line) => line.includes("Scan cancelled"))).toBe(true);
    expect(logs.some((line) => line.includes("shutdown in progress"))).toBe(true);
  });

  it("preserves records on failure and clears lastError after the next success", async () => {
    const scenario = createLifecycleScenario(CIDR);
    const { db } = openTemp(opened);
    const loop = createLoop(
      db,
      new MockScanner({
        cidr: CIDR,
        frames: [
          scenario.frames[1]!,
          errorFrame("interface missing"),
          scenario.frames[1]!,
        ],
        now: () => FIXED_NOW,
        repeatLast: false,
      }),
    );

    await expectSuccess(loop.triggerScan());
    const beforeFailure = listIpRecords(db, CIDR);

    const failed = await loop.triggerScan();
    expect(failed).toEqual({ status: "failed", error: "interface missing" });
    expect(listIpRecords(db, CIDR)).toEqual(beforeFailure);
    expect(loop.getStatus().lastError).toEqual({
      message: "interface missing",
      occurredAt: FIXED_NOW.toISOString(),
    });

    await expectSuccess(loop.triggerScan());
    expect(loop.getStatus().lastError).toBeNull();
    expect(loop.getStatus().lastSuccessfulScanAt).toBe(FIXED_NOW.toISOString());
  });

  it("does not overwrite note or reservation on a later scan", async () => {
    const scenario = createLifecycleScenario(CIDR);
    const { db } = openTemp(opened);
    const loop = createLoop(
      db,
      new MockScanner({
        cidr: CIDR,
        frames: [scenario.frames[1]!, scenario.frames[1]!],
        now: () => FIXED_NOW,
        repeatLast: false,
      }),
    );

    await expectSuccess(loop.triggerScan());
    updateIpRecord(db, CIDR, scenario.hosts.arp, {
      note: "lab printer",
      isReserved: true,
    });

    await expectSuccess(loop.triggerScan());
    const stored = record(db, scenario.hosts.arp);
    expect(stored.note).toBe("lab printer");
    expect(stored.isReserved).toBe(true);
    expect(stored.observedStatus).toBe("ACTIVE");
  });

  it("keeps records and notes after reopening the same sqlite file", async () => {
    const scenario = createLifecycleScenario(CIDR);
    const dir = mkdtempSync(join(tmpdir(), "ip-watch-scan-loop-"));
    const databasePath = join(dir, "ip-watch.sqlite3");
    const db = openDatabase(databasePath);
    opened.push({ db, dir });

    const loop = createLoop(
      db,
      new MockScanner({
        cidr: CIDR,
        frames: [scenario.frames[1]!],
        now: () => FIXED_NOW,
        repeatLast: false,
      }),
    );

    await expectSuccess(loop.triggerScan());
    updateIpRecord(db, CIDR, scenario.hosts.arp, { note: "keep across reopen" });
    db.close();

    const reopened = openDatabase(databasePath);
    opened[opened.length - 1] = { db: reopened, dir };
    const stored = record(reopened, scenario.hosts.arp);
    expect(stored.note).toBe("keep across reopen");
    expect(stored.observedStatus).toBe("ACTIVE");
  });
});

function openTemp(opened: Array<{ db: SqliteDatabase; dir: string }>): {
  db: SqliteDatabase;
  dir: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "ip-watch-scan-loop-"));
  const db = openDatabase(join(dir, "ip-watch.sqlite3"));
  opened.push({ db, dir });
  return { db, dir };
}

function createLoop(
  db: SqliteDatabase,
  scanner: Scanner,
  extras: { logger?: { log: (msg: string) => void; error: (msg: string) => void } } = {},
) {
  return createScanLoop({
    scanner,
    db,
    cidr: CIDR,
    intervalMs: 60_000,
    now: () => FIXED_NOW,
    ...(extras.logger ? { logger: extras.logger } : {}),
  });
}

function record(db: SqliteDatabase, ipAddress: string): IpRecord {
  const found = listIpRecords(db, CIDR).find((row) => row.ipAddress === ipAddress);
  if (found === undefined) {
    throw new Error(`Missing IP record ${ipAddress}`);
  }
  return found;
}

async function expectSuccess(
  outcomePromise: Promise<{ status: string }>,
): Promise<void> {
  const outcome = await outcomePromise;
  expect(outcome.status).toBe("success");
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
