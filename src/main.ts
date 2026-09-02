import { pathToFileURL } from "node:url";

import type { Express } from "express";

import { createApp } from "./app.js";
import { ConfigError, loadConfig, type AppConfig } from "./config.js";
import { openDatabase, type SqliteDatabase } from "./db.js";
import { createScanLoop, type ScanLoop } from "./scan-loop.js";
import { createMockScanner, type Scanner } from "./scanner.js";

export interface AppRuntime {
  config: AppConfig;
  db: SqliteDatabase;
  app: Express;
  scanner: Scanner;
  scanLoop: ScanLoop;
}

export function createRuntime(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): AppRuntime {
  const config = loadConfig(environment);
  const db = openDatabase(config.databasePath);
  try {
    const scanner = createScanner(config);
    const scanLoop = createScanLoop({
      scanner,
      db,
      cidr: config.targetCidr,
      intervalMs: config.scanIntervalMs,
    });
    const app = createApp(config);
    app.locals.db = db;
    app.locals.scanLoop = scanLoop;
    return { config, db, app, scanner, scanLoop };
  } catch (error) {
    closeDatabase(db);
    throw error;
  }
}

export function start(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): void {
  let db: SqliteDatabase | undefined;
  let scanLoop: ScanLoop | undefined;
  try {
    const runtime = createRuntime(environment);
    db = runtime.db;
    scanLoop = runtime.scanLoop;
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
      closeDatabase(db);
      process.exitCode = 1;
    });
  } catch (error) {
    scanLoop?.stop();
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
