import { pathToFileURL } from "node:url";

import type { Express } from "express";

import { createApp } from "./app.js";
import { ConfigError, loadConfig, type AppConfig } from "./config.js";
import { openDatabase, type SqliteDatabase } from "./db.js";
import { registerRoutes } from "./routes.js";
import { createScanLoop, type ScanLoop } from "./scan-loop.js";
import { createMockScanner, type Scanner } from "./scanner.js";
import { createSseHub, scanOutcomeToEvent, type SseHub } from "./sse.js";

export interface AppRuntime {
  config: AppConfig;
  db: SqliteDatabase;
  app: Express;
  scanner: Scanner;
  scanLoop: ScanLoop;
  sse: SseHub;
}

export function createRuntime(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): AppRuntime {
  const config = loadConfig(environment);
  const db = openDatabase(config.databasePath);
  let sse: SseHub | undefined;
  try {
    const sseHub = createSseHub();
    sse = sseHub;
    const scanner = createScanner(config);
    const scanLoop = createScanLoop({
      scanner,
      db,
      cidr: config.targetCidr,
      intervalMs: config.scanIntervalMs,
      onScanSettled: (outcome) => {
        const event = scanOutcomeToEvent(outcome);
        if (event) {
          sseHub.broadcast(event);
        }
      },
    });
    const app = createApp(config);
    registerRoutes(app, { config, db, scanLoop, sse });
    app.locals.db = db;
    app.locals.scanLoop = scanLoop;
    app.locals.sse = sse;
    return { config, db, app, scanner, scanLoop, sse };
  } catch (error) {
    sse?.close();
    closeDatabase(db);
    throw error;
  }
}

export function start(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): void {
  let db: SqliteDatabase | undefined;
  let scanLoop: ScanLoop | undefined;
  let sse: SseHub | undefined;
  try {
    const runtime = createRuntime(environment);
    db = runtime.db;
    scanLoop = runtime.scanLoop;
    sse = runtime.sse;
    const server = runtime.app.listen(
      runtime.config.port,
      runtime.config.bindAddress,
      () => {
        console.log(
          `IP Watch listening on http://${runtime.config.bindAddress}:${runtime.config.port} for ${runtime.config.targetCidr}`,
        );
        runtime.scanLoop.start();
      },
    );

    server.on("error", (error) => {
      console.error("HTTP server failed", error);
      scanLoop?.stop();
      sse?.close();
      closeDatabase(db);
      process.exitCode = 1;
    });
  } catch (error) {
    scanLoop?.stop();
    sse?.close();
    closeDatabase(db);
    if (error instanceof ConfigError) {
      console.error(error.message);
    } else {
      console.error("IP Watch failed to start", error);
    }
    process.exitCode = 1;
  }
}

function createScanner(config: AppConfig): Scanner {
  if (config.useMockScanner) {
    return createMockScanner(config);
  }

  throw new Error("Real scanner is not implemented yet (stage 5)");
}

function closeDatabase(db: SqliteDatabase | undefined): void {
  if (db?.open) {
    db.close();
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  start();
}
