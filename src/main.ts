import { pathToFileURL } from "node:url";

import { createApp } from "./app.js";
import { ConfigError, loadConfig } from "./config.js";

export function start(): void {
  try {
    const config = loadConfig();
    const app = createApp(config);
    const server = app.listen(config.port, config.bindAddress, () => {
      console.log(
        `IP Watch listening on http://${config.bindAddress}:${config.port} for ${config.targetCidr}`,
      );
    });

    server.on("error", (error) => {
      console.error("HTTP server failed", error);
      process.exitCode = 1;
    });
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
    } else {
      console.error("IP Watch failed to start", error);
    }
    process.exitCode = 1;
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  start();
}
