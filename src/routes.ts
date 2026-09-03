import { isIP } from "node:net";

import type {
  ErrorRequestHandler,
  Express,
  Request,
  Response,
} from "express";

import type { AppConfig } from "./config.js";
import {
  getDashboardSnapshot,
  updateIpRecord,
  type IpRecordPatch,
  type SqliteDatabase,
} from "./db.js";
import type { ScanLoop } from "./scan-loop.js";
import type { SseHub } from "./sse.js";
import { effectiveStatus, listUsableHosts } from "./state.js";

export interface RouteDeps {
  config: AppConfig;
  db: SqliteDatabase;
  scanLoop: ScanLoop;
  sse: SseHub;
}

type ApiErrorCode =
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "PAYLOAD_TOO_LARGE"
  | "INTERNAL";

const NOTE_MAX_LENGTH = 1000;

export function registerRoutes(app: Express, deps: RouteDeps): void {
  const usableHosts = new Set(listUsableHosts(deps.config.targetCidr));

  app.get("/", (_request, response) => {
    const nowMs = Date.now();
    const thresholdMs = deps.config.staleThresholdDays * 86_400_000;
    const snapshot = getDashboardSnapshot(
      deps.db,
      deps.config.targetCidr,
      nowMs,
      thresholdMs,
    );
    const scan = deps.scanLoop.getStatus();
    response.render("dashboard", {
      cidr: deps.config.targetCidr,
      summary: snapshot.summary,
      lastSuccessfulScanAt: scan.lastSuccessfulScanAt,
    });
  });

  app.get("/api/dashboard", (_request, response) => {
    const nowMs = Date.now();
    const thresholdMs = deps.config.staleThresholdDays * 86_400_000;
    const snapshot = getDashboardSnapshot(
      deps.db,
      deps.config.targetCidr,
      nowMs,
      thresholdMs,
    );
    response.status(200).json({
      cidr: deps.config.targetCidr,
      records: snapshot.records,
      summary: snapshot.summary,
      scan: deps.scanLoop.getStatus(),
    });
  });

  app.get("/events", (request, response) => {
    deps.sse.handleConnection(request, response);
  });

  app.patch("/api/ips/:ip", (request, response) => {
    const ip = request.params.ip;
    if (typeof ip !== "string" || isIP(ip) !== 4) {
      sendError(
        response,
        400,
        "INVALID_INPUT",
        "IP address must be a valid IPv4 address.",
      );
      return;
    }

    if (!usableHosts.has(ip)) {
      sendError(response, 404, "NOT_FOUND", "IP address was not found.");
      return;
    }

    const patch = parseIpPatch(request.body);
    if (patch.error !== undefined) {
      sendError(response, 400, "INVALID_INPUT", patch.error);
      return;
    }

    try {
      const updated = updateIpRecord(
        deps.db,
        deps.config.targetCidr,
        ip,
        patch.value,
      );

      if (Object.prototype.hasOwnProperty.call(patch.value, "note")) {
        deps.sse.broadcast({
          reason: "note",
          changedIps: [ip],
          scannedAt: null,
        });
      }
      if (Object.prototype.hasOwnProperty.call(patch.value, "isReserved")) {
        deps.sse.broadcast({
          reason: "reservation",
          changedIps: [ip],
          scannedAt: null,
        });
      }

      const nowMs = Date.now();
      const thresholdMs = deps.config.staleThresholdDays * 86_400_000;
      response.status(200).json({
        ...updated,
        effectiveStatus: effectiveStatus(updated, nowMs, thresholdMs),
      });
    } catch (error) {
      if (isIpRecordNotFound(error)) {
        sendError(response, 404, "NOT_FOUND", "IP address was not found.");
        return;
      }

      console.error("Failed to update IP record", error);
      sendError(response, 500, "INTERNAL", "Failed to update IP record.");
    }
  });

  app.post("/api/scan", async (_request, response) => {
    try {
      const outcome = await deps.scanLoop.triggerScan();
      response.status(200).json({ status: outcome.status });
    } catch (error) {
      console.error("Failed to trigger scan", error);
      sendError(response, 500, "INTERNAL", "Failed to trigger scan.");
    }
  });

  app.use("/api", (_request, response) => {
    sendError(response, 404, "NOT_FOUND", "The requested resource was not found.");
  });

  app.use(apiErrorHandler);
}

function parseIpPatch(
  body: unknown,
): { value: IpRecordPatch; error?: undefined } | { error: string; value?: undefined } {
  if (!isPlainObject(body)) {
    return { error: "Request body must be a JSON object." };
  }

  const hasNote = Object.prototype.hasOwnProperty.call(body, "note");
  const hasReserved = Object.prototype.hasOwnProperty.call(body, "isReserved");

  if (!hasNote && !hasReserved) {
    return { error: "Provide note and/or isReserved" };
  }

  const patch: IpRecordPatch = {};

  if (hasNote) {
    const note = body.note;
    if (typeof note !== "string" || note.length > NOTE_MAX_LENGTH) {
      return {
        error: "Note must be a string of at most 1000 characters.",
      };
    }
    patch.note = note;
  }

  if (hasReserved) {
    const isReserved = body.isReserved;
    if (typeof isReserved !== "boolean") {
      return { error: "isReserved must be a boolean." };
    }
    patch.isReserved = isReserved;
  }

  return { value: patch };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIpRecordNotFound(error: unknown): boolean {
  return error instanceof Error && /not found/i.test(error.message);
}

function sendError(
  response: Response,
  status: number,
  code: ApiErrorCode,
  message: string,
): void {
  response.status(status).json({
    error: {
      code,
      message,
    },
  });
}

const apiErrorHandler: ErrorRequestHandler = (
  error: unknown,
  _request: Request,
  response: Response,
  next,
) => {
  if (response.headersSent) {
    next(error);
    return;
  }

  if (isJsonParseError(error)) {
    sendError(
      response,
      400,
      "INVALID_INPUT",
      "Request body must be valid JSON.",
    );
    return;
  }

  if (isPayloadTooLargeError(error)) {
    sendError(
      response,
      413,
      "PAYLOAD_TOO_LARGE",
      "Request body must not exceed 32 KB.",
    );
    return;
  }

  console.error(error);
  sendError(response, 500, "INTERNAL", "An internal error occurred.");
};

function isJsonParseError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const candidate = error as { type?: unknown; status?: unknown };
  if (candidate.type === "entity.parse.failed") {
    return true;
  }

  return error instanceof SyntaxError && candidate.status === 400;
}

function isPayloadTooLargeError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const candidate = error as { type?: unknown; status?: unknown };
  return candidate.type === "entity.too.large" || candidate.status === 413;
}
