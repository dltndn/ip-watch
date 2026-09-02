import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import {
  listIpRecords,
  openDatabase,
  type SqliteDatabase,
} from "../src/db.js";
import { registerRoutes } from "../src/routes.js";
import { createScanLoop, type ScanLoop } from "../src/scan-loop.js";
import {
  MockScanner,
  errorFrame,
  okFrame,
  pingObservation,
} from "../src/scanner.js";
import { scanOutcomeToEvent, type DashboardUpdateEvent, type SseHub } from "../src/sse.js";
import { listUsableHosts } from "../src/state.js";

const CIDR = "10.0.0.0/29";
const USABLE_HOSTS = listUsableHosts(CIDR);
const TARGET_IP = USABLE_HOSTS[0]!;
const FIXED_NOW = new Date("2026-09-02T08:00:00.000Z");

describe("HTTP routes", () => {
  const opened: Array<{ db: SqliteDatabase; dir: string; scanLoop: ScanLoop }> =
    [];

  afterEach(() => {
    for (const item of opened.splice(0)) {
      item.scanLoop.stop();
      if (item.db.open) {
        item.db.close();
      }
      rmSync(item.dir, { recursive: true, force: true });
    }
  });

  it("GET /api/dashboard returns cidr, records, summary and scan status", async () => {
    const ctx = assemble(opened, { frames: [okFrame([])] });
    await ctx.scanLoop.triggerScan();

    const response = await request(ctx.app).get("/api/dashboard");

    expect(response.status).toBe(200);
    expect(response.body.cidr).toBe(CIDR);
    expect(response.body.records).toHaveLength(USABLE_HOSTS.length);
    expect(response.body.summary).toEqual({
      total: USABLE_HOSTS.length,
      active: 0,
      inactive: 0,
      available: USABLE_HOSTS.length,
      reserved: 0,
      allocationCandidates: USABLE_HOSTS.length,
    });
    expect(
      response.body.summary.active +
        response.body.summary.inactive +
        response.body.summary.available,
    ).toBe(response.body.summary.total);
    expect(response.body.summary.allocationCandidates).toBe(
      response.body.records.filter(
        (record: { observedStatus: string; isReserved: boolean }) =>
          record.observedStatus === "AVAILABLE" && !record.isReserved,
      ).length,
    );
    expect(response.body.scan).toEqual({
      isScanning: false,
      lastSuccessfulScanAt: FIXED_NOW.toISOString(),
      lastError: null,
    });
  });

  it("PATCH /api/ips/:ip updates a note, persists it, and broadcasts once", async () => {
    const ctx = assemble(opened, { frames: [okFrame([])] });
    await ctx.scanLoop.triggerScan();
    ctx.events.length = 0;

    const response = await request(ctx.app)
      .patch(`/api/ips/${TARGET_IP}`)
      .send({ note: "lab printer" });

    expect(response.status).toBe(200);
    expect(response.body.note).toBe("lab printer");
    expect(response.body.ipAddress).toBe(TARGET_IP);
    expect(
      listIpRecords(ctx.db, CIDR).find((row) => row.ipAddress === TARGET_IP)
        ?.note,
    ).toBe("lab printer");
    expect(ctx.events).toEqual([
      { reason: "note", changedIps: [TARGET_IP], scannedAt: null },
    ]);
  });

  it("PATCH /api/ips/:ip updates reservation and broadcasts reservation", async () => {
    const ctx = assemble(opened, { frames: [okFrame([])] });
    await ctx.scanLoop.triggerScan();
    ctx.events.length = 0;

    const response = await request(ctx.app)
      .patch(`/api/ips/${TARGET_IP}`)
      .send({ isReserved: true });

    expect(response.status).toBe(200);
    expect(response.body.isReserved).toBe(true);
    expect(
      listIpRecords(ctx.db, CIDR).find((row) => row.ipAddress === TARGET_IP)
        ?.isReserved,
    ).toBe(true);
    expect(ctx.events).toEqual([
      { reason: "reservation", changedIps: [TARGET_IP], scannedAt: null },
    ]);
  });

  it("PATCH /api/ips/:ip with note and isReserved broadcasts both events", async () => {
    const ctx = assemble(opened, { frames: [okFrame([])] });
    await ctx.scanLoop.triggerScan();
    ctx.events.length = 0;

    const response = await request(ctx.app)
      .patch(`/api/ips/${TARGET_IP}`)
      .send({ note: "reserved host", isReserved: true });

    expect(response.status).toBe(200);
    expect(response.body.note).toBe("reserved host");
    expect(response.body.isReserved).toBe(true);
    expect(ctx.events).toEqual([
      { reason: "note", changedIps: [TARGET_IP], scannedAt: null },
      { reason: "reservation", changedIps: [TARGET_IP], scannedAt: null },
    ]);
  });

  it("rejects invalid PATCH bodies without broadcasting", async () => {
    const ctx = assemble(opened, { frames: [okFrame([])] });
    await ctx.scanLoop.triggerScan();
    ctx.events.length = 0;

    const tooLong = await request(ctx.app)
      .patch(`/api/ips/${TARGET_IP}`)
      .send({ note: "n".repeat(1001) });
    expectError(tooLong, 400, "INVALID_INPUT");

    const badReserved = await request(ctx.app)
      .patch(`/api/ips/${TARGET_IP}`)
      .send({ isReserved: "yes" });
    expectError(badReserved, 400, "INVALID_INPUT");

    const emptyBody = await request(ctx.app)
      .patch(`/api/ips/${TARGET_IP}`)
      .send({});
    expectError(emptyBody, 400, "INVALID_INPUT");

    const outsideCidr = await request(ctx.app)
      .patch("/api/ips/192.168.1.1")
      .send({ note: "nope" });
    expectError(outsideCidr, 404, "NOT_FOUND");

    const malformed = await request(ctx.app)
      .patch("/api/ips/not-an-ip")
      .send({ note: "nope" });
    expect([400, 404]).toContain(malformed.status);
    expect(malformed.body).toEqual({
      error: {
        code: expect.stringMatching(/^(INVALID_INPUT|NOT_FOUND)$/),
        message: expect.any(String),
      },
    });

    expect(ctx.events).toEqual([]);
    expect(
      listIpRecords(ctx.db, CIDR).find((row) => row.ipAddress === TARGET_IP)
        ?.note,
    ).toBe("");
  });

  it("POST /api/scan succeeds and fills records", async () => {
    const ctx = assemble(opened, {
      frames: [okFrame([pingObservation(TARGET_IP)])],
    });

    const response = await request(ctx.app).post("/api/scan");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "success" });
    expect(ctx.events).toEqual([]);
    const records = listIpRecords(ctx.db, CIDR);
    expect(records).toHaveLength(USABLE_HOSTS.length);
    expect(records.find((row) => row.ipAddress === TARGET_IP)?.observedStatus).toBe(
      "ACTIVE",
    );
  });

  it("POST /api/scan returns failed, keeps DB state, and emits scan-error", async () => {
    const ctx = assemble(opened, {
      frames: [
        okFrame([pingObservation(TARGET_IP)]),
        errorFrame("interface missing"),
      ],
      wireScanSettled: true,
    });

    await ctx.scanLoop.triggerScan();
    const beforeFailure = listIpRecords(ctx.db, CIDR);
    ctx.events.length = 0;

    const response = await request(ctx.app).post("/api/scan");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "failed" });
    expect(listIpRecords(ctx.db, CIDR)).toEqual(beforeFailure);
    expect(ctx.events).toEqual([
      { reason: "scan-error", changedIps: [], scannedAt: null },
    ]);
  });

  it("GET / renders HTML that includes the target CIDR", async () => {
    const ctx = assemble(opened, { frames: [okFrame([])] });

    const response = await request(ctx.app).get("/");

    expect(response.status).toBe(200);
    expect(response.type).toMatch(/html/);
    expect(response.text).toContain(CIDR);
  });

  it("returns the common error body for invalid JSON and unknown API paths", async () => {
    const ctx = assemble(opened, { frames: [okFrame([])] });
    await ctx.scanLoop.triggerScan();
    ctx.events.length = 0;

    const invalidJson = await request(ctx.app)
      .patch(`/api/ips/${TARGET_IP}`)
      .set("Content-Type", "application/json")
      .send('{"note":');
    expectError(invalidJson, 400, "INVALID_INPUT");

    const unknown = await request(ctx.app).get("/api/nope");
    expectError(unknown, 404, "NOT_FOUND");

    expect(ctx.events).toEqual([]);
  });
});

function assemble(
  opened: Array<{ db: SqliteDatabase; dir: string; scanLoop: ScanLoop }>,
  options: {
    frames: ConstructorParameters<typeof MockScanner>[0]["frames"];
    wireScanSettled?: boolean;
  },
) {
  const dir = mkdtempSync(join(tmpdir(), "ip-watch-routes-"));
  const databasePath = join(dir, "ip-watch.sqlite3");
  const db = openDatabase(databasePath);
  const config = loadConfig({
    TARGET_CIDR: CIDR,
    USE_MOCK_SCANNER: "true",
    DATABASE_PATH: databasePath,
    BIND_ADDRESS: "127.0.0.1",
  });
  const events: DashboardUpdateEvent[] = [];
  const recordingHub: SseHub = {
    handleConnection() {},
    broadcast(event) {
      events.push(event);
    },
    connectionCount() {
      return 0;
    },
    close() {},
  };

  const scanLoop = createScanLoop({
    scanner: new MockScanner({
      cidr: CIDR,
      frames: options.frames,
      now: () => FIXED_NOW,
      repeatLast: false,
    }),
    db,
    cidr: CIDR,
    intervalMs: 60_000,
    now: () => FIXED_NOW,
    logger: { log() {}, error() {} },
    ...(options.wireScanSettled
      ? {
          onScanSettled: (outcome) => {
            const event = scanOutcomeToEvent(outcome);
            if (event) {
              recordingHub.broadcast(event);
            }
          },
        }
      : {}),
  });
  opened.push({ db, dir, scanLoop });

  const app = createApp(config);
  registerRoutes(app, { config, db, scanLoop, sse: recordingHub });

  return { app, db, scanLoop, events, config };
}

function expectError(
  response: request.Response,
  status: number,
  code: "INVALID_INPUT" | "NOT_FOUND" | "INTERNAL",
): void {
  expect(response.status).toBe(status);
  expect(response.body).toEqual({
    error: {
      code,
      message: expect.any(String),
    },
  });
  expect(typeof response.body.error.message).toBe("string");
  expect(response.body.error.message.length).toBeGreaterThan(0);
  expect(response.body.error.message).not.toMatch(/at\s+\S+\s+\(/);
}
