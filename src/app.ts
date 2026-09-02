import path from "node:path";

import express, { type Express } from "express";

import type { AppConfig } from "./config.js";

export function createApp(config: AppConfig): Express {
  const app = express();

  app.disable("x-powered-by");
  app.set("view engine", "ejs");
  app.set("views", path.join(process.cwd(), "views"));
  app.locals.config = config;

  app.use(express.json({ limit: "32kb" }));
  app.use(express.static(path.join(process.cwd(), "public")));

  app.get("/health", (_request, response) => {
    response.status(200).json({ status: "ok" });
  });

  return app;
}
