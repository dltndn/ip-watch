import { pathToFileURL } from "node:url";
import type { Server } from "node:http";

import type { Express } from "express";

import { createApp } from "./app.js";
import { ConfigError, loadConfig, type AppConfig } from "./config.js";
import { openDatabase, type SqliteDatabase } from "./db.js";
import { registerRoutes } from "./routes.js";
import { createScanLoop, type ScanLoop } from "./scan-loop.js";
import { createRealScanner } from "./real-scanner.js";
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

    let shuttingDown = false;
    const shutdown = async (reason: string, exitCode: number): Promise<void> => {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      process.exitCode = exitCode;
      console.log(`Shutdown started: ${reason}`);

      try {
        await runtime.scanLoop.shutdown();
        runtime.sse.close();
        await closeHttpServer(server);
        closeDatabase(runtime.db);
        console.log("Shutdown complete");
      } catch (error) {
        process.exitCode = 1;
        console.error("Shutdown failed", error);
        runtime.sse.close();
        closeDatabase(runtime.db);
      }
    };

    process.once("SIGTERM", () => {
      void shutdown("SIGTERM received", 0);
    });
    process.once("SIGINT", () => {
      void shutdown("SIGINT received", 0);
    });

    server.on("error", (error) => {
      console.error("HTTP server failed", error);
      void shutdown("HTTP server error", 1);
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

  return createRealScanner(config);
}

function closeDatabase(db: SqliteDatabase | undefined): void {
  if (db?.open) {
    db.close();
  }
}

function closeHttpServer(server: Server): Promise<void> {
  if (!server.listening) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  start();
}
