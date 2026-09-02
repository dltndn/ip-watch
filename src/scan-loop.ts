import { listIpRecords, upsertScanRecords, type SqliteDatabase } from "./db.js";
import type { Scanner } from "./scanner.js";
import { calculateCidrState, type CidrStateSnapshot } from "./state.js";

export interface ScanStatus {
  isScanning: boolean;
  lastSuccessfulScanAt: string | null;
  lastError: { message: string; occurredAt: string } | null;
}

export type ScanOutcome =
  | {
      status: "success";
      snapshot: CidrStateSnapshot;
      scannedAt: string;
      recovered: boolean;
    }
  | { status: "failed"; error: string }
  | { status: "skipped" };

export interface ScanLoopDeps {
  scanner: Scanner;
  db: SqliteDatabase;
  cidr: string;
  intervalMs: number;
  now?: () => Date;
  logger?: { log: (msg: string) => void; error: (msg: string) => void };
  onScanSettled?: (outcome: ScanOutcome) => void;
}

export interface ScanLoop {
  start(): void;
  stop(): void;
  triggerScan(): Promise<ScanOutcome>;
  getStatus(): ScanStatus;
}

export function createScanLoop(deps: ScanLoopDeps): ScanLoop {
  const now = deps.now ?? (() => new Date());
  const logger = deps.logger ?? console;

  let isScanning = false;
  let lastSuccessfulScanAt: string | null = null;
  let lastError: ScanStatus["lastError"] = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  async function triggerScan(): Promise<ScanOutcome> {
    if (isScanning) {
      logger.log(`Scan skipped for ${deps.cidr}: already in progress`);
      return { status: "skipped" };
    }

    isScanning = true;
    logger.log(`Scan starting for ${deps.cidr}`);

    try {
      const result = await deps.scanner.scan();
      const existing = listIpRecords(deps.db, deps.cidr);
      const snapshot = calculateCidrState(existing, result);
      upsertScanRecords(deps.db, snapshot.records);

      const recovered = lastError !== null;
      lastSuccessfulScanAt = result.scannedAt;
      lastError = null;
      logger.log(
        `Scan succeeded for ${deps.cidr}: total=${snapshot.summary.total} active=${snapshot.summary.active} inactive=${snapshot.summary.inactive} available=${snapshot.summary.available}`,
      );

      const outcome: ScanOutcome = {
        status: "success",
        snapshot,
        scannedAt: result.scannedAt,
        recovered,
      };
      deps.onScanSettled?.(outcome);
      return outcome;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastError = { message, occurredAt: now().toISOString() };
      logger.error(`Scan failed for ${deps.cidr}: ${message}`);

      const outcome: ScanOutcome = { status: "failed", error: message };
      deps.onScanSettled?.(outcome);
      return outcome;
    } finally {
      isScanning = false;
    }
  }

  function start(): void {
    if (running) {
      return;
    }

    running = true;
    void triggerScan().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Scan loop failed for ${deps.cidr}: ${message}`);
    });

    timer = setInterval(() => {
      void triggerScan().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`Scan loop failed for ${deps.cidr}: ${message}`);
      });
    }, deps.intervalMs);
  }

  function stop(): void {
    running = false;
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  function getStatus(): ScanStatus {
    return {
      isScanning,
      lastSuccessfulScanAt,
      lastError,
    };
  }

  return {
    start,
    stop,
    triggerScan,
    getStatus,
  };
}
