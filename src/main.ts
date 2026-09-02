import { pathToFileURL } from "node:url";

import type { Express } from "express";

import { createApp } from "./app.js";
import { ConfigError, loadConfig, type AppConfig } from "./config.js";
import { openDatabase, type SqliteDatabase } from "./db.js";

export interface AppRuntime {
  config: AppConfig;
  db: SqliteDatabase;
  app: Express;
}

export function createRuntime(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): AppRuntime {
  const config = loadConfig(environment);
  const db = openDatabase(config.databasePath);
  try {
    const app = createApp(config);
    app.locals.db = db;
    return { config, db, app };
  } catch (error) {
    closeDatabase(db);
    throw error;
  }
}

export function start(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): void {
  let db: SqliteDatabase | undefined;
  try {
    const runtime = createRuntime(environment);
    db = runtime.db;
    const server = runtime.app.listen(
      runtime.config.port,
      runtime.config.bindAddress,
      () => {
        console.log(
          `IP Watch listening on http://${runtime.config.bindAddress}:${runtime.config.port} for ${runtime.config.targetCidr}`,
        );
      },
    );

    server.on("error", (error) => {
      console.error("HTTP server failed", error);
      closeDatabase(db);
      process.exitCode = 1;
    });
  } catch (error) {
    closeDatabase(db);
    if (error instanceof ConfigError) {
      console.error(error.message);
    } else {
      console.error("IP Watch failed to start", error);
    }
    process.exitCode = 1;
  }
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
