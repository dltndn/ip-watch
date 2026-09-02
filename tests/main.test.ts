import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { createRuntime } from "../src/main.js";

const MAIN_ENTRY = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

describe("createRuntime", () => {
  const opened: Array<{ db: { close(): void }; dir: string }> = [];

  afterEach(() => {
    for (const item of opened.splice(0)) {
      item.db.close();
      rmSync(item.dir, { recursive: true, force: true });
    }
  });

  it("opens exactly DATABASE_PATH and keeps the handle on the app", () => {
    const dir = mkdtempSync(join(tmpdir(), "ip-watch-main-"));
    const databasePath = join(dir, "ip-watch.sqlite3");
    const runtime = createRuntime({
      TARGET_CIDR: "192.168.1.0/24",
      USE_MOCK_SCANNER: "true",
      DATABASE_PATH: databasePath,
      BIND_ADDRESS: "127.0.0.1",
      PORT: "34567",
    });
    opened.push({ db: runtime.db, dir });

    expect(runtime.config.databasePath).toBe(databasePath);
    expect(runtime.app.locals.db).toBe(runtime.db);
    expect(runtime.db.open).toBe(true);
    expect(runtime.db.pragma("journal_mode", { simple: true })).toBe("wal");
  });

  it("fails before HTTP setup when DATABASE_PATH cannot be opened", () => {
    const databasePath = join(
      tmpdir(),
      `ip-watch-missing-${Date.now()}`,
      "ip-watch.sqlite3",
    );

    expect(() =>
      createRuntime({
        TARGET_CIDR: "192.168.1.0/24",
        USE_MOCK_SCANNER: "true",
        DATABASE_PATH: databasePath,
        BIND_ADDRESS: "127.0.0.1",
        PORT: "34567",
      }),
    ).toThrow();
  });
});

describe("start entrypoint", () => {
  it("exits with a startup failure and never listens when DATABASE_PATH is unusable", async () => {
    const databasePath = join(
      tmpdir(),
      `ip-watch-missing-start-${Date.now()}`,
      "ip-watch.sqlite3",
    );
    const result = await runMainEntrypoint({
      TARGET_CIDR: "192.168.1.0/24",
      USE_MOCK_SCANNER: "true",
      DATABASE_PATH: databasePath,
      BIND_ADDRESS: "127.0.0.1",
      PORT: "34567",
    });

    expect(result.timedOut).toBe(false);
    expect(result.code).not.toBe(0);
    expect(result.stdout).not.toMatch(/listening/i);
    expect(result.stderr).toMatch(/failed to start/i);
  }, 15_000);
});

function runMainEntrypoint(
  env: Record<string, string>,
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", MAIN_ENTRY], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, 8_000);

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}
