import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { Request, Response } from "express";

import { scanOutcomeToEvent, createSseHub, type SseHub } from "../src/sse.js";
import type { CidrStateSnapshot } from "../src/state.js";

const EMPTY_SNAPSHOT: CidrStateSnapshot = {
  records: [],
  summary: {
    total: 0,
    active: 0,
    inactive: 0,
    available: 0,
    reserved: 0,
    allocationCandidates: 0,
  },
};

describe("createSseHub", () => {
  let hub: SseHub | undefined;

  afterEach(() => {
    hub?.close();
    hub = undefined;
    vi.useRealTimers();
  });

  function connect(connection: { req: Request; res: FakeResponse }): void {
    hub?.handleConnection(connection.req, connection.res as unknown as Response);
  }

  it("sets required headers and tracks connections", () => {
    hub = createSseHub();
    const { req, res } = createFakeConnection();

    connect({ req, res });

    expect(res.statusCode).toBe(200);
    expect(res.headers).toMatchObject({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    expect(res.flushed).toBe(true);
    expect(hub.connectionCount()).toBe(1);
  });

  it("writes dashboard.updated events to every connection", () => {
    hub = createSseHub();
    const first = createFakeConnection();
    const second = createFakeConnection();
    connect(first);
    connect(second);

    const event = {
      reason: "note" as const,
      changedIps: ["10.0.0.1"],
      scannedAt: null,
    };
    hub.broadcast(event);

    const expected = `event: dashboard.updated\ndata: ${JSON.stringify(event)}\n\n`;
    expect(first.res.chunks).toEqual([expected]);
    expect(second.res.chunks).toEqual([expected]);
  });

  it("removes a connection when res or req emits close", () => {
    hub = createSseHub();
    const { req, res } = createFakeConnection();
    connect({ req, res });
    expect(hub.connectionCount()).toBe(1);

    res.emit("close");
    expect(hub.connectionCount()).toBe(0);

    const other = createFakeConnection();
    connect(other);
    expect(hub.connectionCount()).toBe(1);
    other.req.emit("close");
    expect(hub.connectionCount()).toBe(0);
  });

  it("sends comment heartbeats on the configured interval", () => {
    vi.useFakeTimers();
    hub = createSseHub({ heartbeatIntervalMs: 20 });
    const { req, res } = createFakeConnection();
    connect({ req, res });

    expect(res.chunks).toEqual([]);
    vi.advanceTimersByTime(20);
    expect(res.chunks).toEqual([": heartbeat\n\n"]);
    vi.advanceTimersByTime(20);
    expect(res.chunks).toEqual([": heartbeat\n\n", ": heartbeat\n\n"]);
  });

  it("drops a connection that throws during write without failing broadcast", () => {
    hub = createSseHub();
    const healthy = createFakeConnection();
    const broken = createFakeConnection();
    broken.res.writeImpl = () => {
      throw new Error("socket closed");
    };
    connect(healthy);
    connect(broken);

    expect(() => {
      hub?.broadcast({
        reason: "scan",
        changedIps: [],
        scannedAt: "2026-09-02T01:00:00.000Z",
      });
    }).not.toThrow();

    expect(hub.connectionCount()).toBe(1);
    expect(healthy.res.chunks).toHaveLength(1);
  });
});

describe("scanOutcomeToEvent", () => {
  it("maps a normal success to scan", () => {
    expect(
      scanOutcomeToEvent({
        status: "success",
        snapshot: EMPTY_SNAPSHOT,
        scannedAt: "2026-09-02T01:00:05.000Z",
        recovered: false,
      }),
    ).toEqual({
      reason: "scan",
      changedIps: [],
      scannedAt: "2026-09-02T01:00:05.000Z",
    });
  });

  it("maps a recovered success to error-recovered", () => {
    expect(
      scanOutcomeToEvent({
        status: "success",
        snapshot: EMPTY_SNAPSHOT,
        scannedAt: "2026-09-02T01:00:05.000Z",
        recovered: true,
      }),
    ).toEqual({
      reason: "error-recovered",
      changedIps: [],
      scannedAt: "2026-09-02T01:00:05.000Z",
    });
  });

  it("maps a failed scan to scan-error", () => {
    expect(
      scanOutcomeToEvent({ status: "failed", error: "interface missing" }),
    ).toEqual({
      reason: "scan-error",
      changedIps: [],
      scannedAt: null,
    });
  });

  it("maps a skipped scan to null", () => {
    expect(scanOutcomeToEvent({ status: "skipped" })).toBeNull();
  });
});

interface FakeResponse extends EventEmitter {
  statusCode: number;
  headers: Record<string, string>;
  flushed: boolean;
  chunks: string[];
  writableEnded: boolean;
  destroyed: boolean;
  writeImpl?: (chunk: string) => boolean;
  writeHead(statusCode: number, headers?: Record<string, string>): FakeResponse;
  setHeader(name: string, value: string | number | readonly string[]): FakeResponse;
  flushHeaders(): void;
  write(chunk: unknown): boolean;
  end(chunk?: unknown): FakeResponse;
}

function createFakeConnection(): { req: Request; res: FakeResponse } {
  const req = new EventEmitter() as Request;
  const res = new EventEmitter() as FakeResponse;
  res.statusCode = 0;
  res.headers = {};
  res.flushed = false;
  res.chunks = [];
  res.writableEnded = false;
  res.destroyed = false;

  res.writeHead = (statusCode, headers) => {
    res.statusCode = statusCode;
    if (headers) {
      Object.assign(res.headers, headers);
    }
    return res;
  };

  res.setHeader = (name, value) => {
    res.headers[name] = String(value);
    return res;
  };

  res.flushHeaders = () => {
    res.flushed = true;
  };

  res.write = (chunk) => {
    if (res.writeImpl) {
      return res.writeImpl(String(chunk));
    }
    res.chunks.push(String(chunk));
    return true;
  };

  res.end = (chunk) => {
    if (chunk !== undefined) {
      res.chunks.push(String(chunk));
    }
    res.writableEnded = true;
    res.emit("close");
    return res;
  };

  return { req, res };
}
