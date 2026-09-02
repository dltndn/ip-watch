import type { Request, Response } from "express";

import type { ScanOutcome } from "./scan-loop.js";

export type DashboardUpdateReason =
  | "scan"
  | "note"
  | "reservation"
  | "scan-error"
  | "error-recovered";

export interface DashboardUpdateEvent {
  reason: DashboardUpdateReason;
  changedIps: string[];
  scannedAt: string | null;
}

export interface SseHub {
  handleConnection(req: Request, res: Response): void;
  broadcast(event: DashboardUpdateEvent): void;
  connectionCount(): number;
  close(): void;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const HEARTBEAT_COMMENT = ": heartbeat\n\n";

export function createSseHub(options?: {
  heartbeatIntervalMs?: number;
}): SseHub {
  const heartbeatIntervalMs =
    options?.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const connections = new Set<Response>();

  const timer = setInterval(() => {
    writeToAll(connections, HEARTBEAT_COMMENT);
  }, heartbeatIntervalMs);
  timer.unref?.();

  function remove(res: Response): void {
    connections.delete(res);
  }

  return {
    handleConnection(req, res) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders?.();

      connections.add(res);

      const onClose = () => {
        remove(res);
      };
      res.on("close", onClose);
      req.on("close", onClose);
      res.on("error", onClose);
    },

    broadcast(event) {
      const payload = `event: dashboard.updated\ndata: ${JSON.stringify(event)}\n\n`;
      writeToAll(connections, payload);
    },

    connectionCount() {
      return connections.size;
    },

    close() {
      clearInterval(timer);
      for (const res of [...connections]) {
        connections.delete(res);
        try {
          res.end();
        } catch {
          // Drop dead connections while shutting down.
        }
      }
    },
  };
}

export function scanOutcomeToEvent(
  outcome: ScanOutcome,
): DashboardUpdateEvent | null {
  if (outcome.status === "success") {
    return {
      reason: outcome.recovered ? "error-recovered" : "scan",
      changedIps: [],
      scannedAt: outcome.scannedAt,
    };
  }

  if (outcome.status === "failed") {
    return {
      reason: "scan-error",
      changedIps: [],
      scannedAt: null,
    };
  }

  return null;
}

function writeToAll(connections: Set<Response>, chunk: string): void {
  for (const res of [...connections]) {
    try {
      if (res.writableEnded || res.destroyed) {
        connections.delete(res);
        continue;
      }
      res.write(chunk);
    } catch {
      connections.delete(res);
    }
  }
}
