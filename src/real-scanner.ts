import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { AppConfig } from "./config.js";
import { ScanError, type Scanner } from "./scanner.js";
import {
  listUsableHosts,
  type NormalizedHostObservation,
  type NormalizedScanResult,
} from "./state.js";

const execFileAsync = promisify(execFile);

const ARP_RESULT_LINE =
  /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\s+([0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5})\b/gm;

const PING_EXEC_BUFFER_MS = 2000;
const MIN_PING_TIMEOUT_SECONDS = 0.001;

export type RealScannerConfig = Pick<
  AppConfig,
  | "targetCidr"
  | "networkInterface"
  | "scanTimeoutMs"
  | "pingTimeoutMs"
  | "pingConcurrency"
>;

export interface ArpScanCommandInput {
  iface: string;
  cidr: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface PingCommandInput {
  ip: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface RealScannerDeps {
  runArpScan?: (input: ArpScanCommandInput) => Promise<{ stdout: string }>;
  runPing?: (input: PingCommandInput) => Promise<void>;
  now?: () => Date;
}

export type ClassifiedPingResult =
  | { status: "responded" }
  | { status: "no-reply" }
  | { status: "failure"; message: string };

interface ExecLike {
  code?: string | number | null;
  killed?: boolean;
  signal?: NodeJS.Signals | number | null;
  stderr?: string | Buffer;
}

export function parseArpScanOutput(stdout: string): NormalizedHostObservation[] {
  const observations: NormalizedHostObservation[] = [];
  const seenIps = new Set<string>();

  for (const match of stdout.matchAll(ARP_RESULT_LINE)) {
    const ipAddress = match[1];
    const macAddress = match[2];
    if (ipAddress === undefined || macAddress === undefined) {
      continue;
    }
    if (seenIps.has(ipAddress)) {
      continue;
    }
    seenIps.add(ipAddress);
    observations.push({
      ipAddress,
      responded: true,
      macAddress: macAddress.toLowerCase(),
    });
  }

  return observations;
}

export function classifyPingResult(error: unknown): ClassifiedPingResult {
  if (error === null || error === undefined) {
    return { status: "responded" };
  }

  const execError = asExecLike(error);
  if (execError === null) {
    return { status: "failure", message: "ping failed: process execution error" };
  }

  if (execError.code === "ENOENT") {
    return { status: "failure", message: "ping failed: executable not found" };
  }

  if (isCommandTimeout(execError)) {
    return { status: "failure", message: "ping timed out" };
  }

  if (execError.code === 1) {
    return { status: "no-reply" };
  }

  if (typeof execError.code === "number") {
    if (execError.code === 2) {
      return { status: "failure", message: "ping failed: permission denied" };
    }
    return { status: "failure", message: "ping failed: command exited with an error" };
  }

  return { status: "failure", message: "ping failed: process execution error" };
}

export function createRealScanner(
  config: RealScannerConfig,
  deps: RealScannerDeps = {},
): Scanner {
  const runArpScan = deps.runArpScan ?? defaultRunArpScan;
  const runPing = deps.runPing ?? defaultRunPing;
  const now = deps.now ?? (() => new Date());

  return {
    async scan(signal?: AbortSignal): Promise<NormalizedScanResult> {
      throwIfScanAborted(signal);
      const iface = config.networkInterface;
      if (iface === undefined) {
        throw new ScanError("arp-scan failed: network interface is not configured");
      }

      const usableHosts = listUsableHosts(config.targetCidr);
      const usableSet = new Set(usableHosts);

      let stdout: string;
      try {
        const arpResult = await runArpScan({
          iface,
          cidr: config.targetCidr,
          timeoutMs: config.scanTimeoutMs,
          ...(signal ? { signal } : {}),
        });
        stdout = arpResult.stdout;
      } catch (error) {
        throwIfScanAborted(signal);
        throw wrapArpScanError(error);
      }

      throwIfScanAborted(signal);

      const parsed = parseArpScanOutput(stdout);
      if (parsed.length === 0 && !looksLikeArpScanOutput(stdout)) {
        throw new ScanError("arp-scan failed: unparseable output");
      }

      const arpResponders = parsed.filter((observation) =>
        usableSet.has(observation.ipAddress),
      );
      const arpIps = new Set(arpResponders.map((observation) => observation.ipAddress));
      const pingTargets = usableHosts.filter((ip) => !arpIps.has(ip));

      const pingResponders: NormalizedHostObservation[] = [];
      await mapWithConcurrency(pingTargets, config.pingConcurrency, signal, async (ip) => {
        try {
          await runPing({
            ip,
            timeoutMs: config.pingTimeoutMs,
            ...(signal ? { signal } : {}),
          });
          pingResponders.push({
            ipAddress: ip,
            responded: true,
            macAddress: null,
          });
        } catch (error) {
          throwIfScanAborted(signal);
          const classified = classifyPingResult(error);
          if (classified.status === "no-reply") {
            return;
          }
          if (classified.status === "responded") {
            pingResponders.push({
              ipAddress: ip,
              responded: true,
              macAddress: null,
            });
            return;
          }
          throw new ScanError(classified.message, { cause: error });
        }
      });

      return {
        cidr: config.targetCidr,
        scannedAt: now().toISOString(),
        observations: [...arpResponders, ...pingResponders],
      };
    },
  };
}

async function defaultRunArpScan(
  input: ArpScanCommandInput,
): Promise<{ stdout: string }> {
  const result = await execFileAsync(
    "arp-scan",
    ["--interface", input.iface, input.cidr],
    {
      timeout: input.timeoutMs,
      encoding: "utf8",
      ...(input.signal ? { signal: input.signal } : {}),
    },
  );
  return { stdout: result.stdout };
}

async function defaultRunPing(input: PingCommandInput): Promise<void> {
  await execFileAsync(
    "ping",
    ["-c", "1", "-n", "-W", formatPingTimeoutSeconds(input.timeoutMs), input.ip],
    {
      timeout: input.timeoutMs + PING_EXEC_BUFFER_MS,
      encoding: "utf8",
      ...(input.signal ? { signal: input.signal } : {}),
    },
  );
}

function formatPingTimeoutSeconds(pingTimeoutMs: number): string {
  const seconds = pingTimeoutMs / 1000;
  return String(seconds < MIN_PING_TIMEOUT_SECONDS ? MIN_PING_TIMEOUT_SECONDS : seconds);
}

function wrapArpScanError(error: unknown): ScanError {
  if (error instanceof ScanError) {
    return error;
  }

  const execError = asExecLike(error);
  if (execError !== null) {
    if (execError.code === "ENOENT") {
      return new ScanError("arp-scan failed: executable not found", { cause: error });
    }
    if (isCommandTimeout(execError)) {
      return new ScanError("arp-scan timed out", { cause: error });
    }
    if (typeof execError.code === "number" && execError.code !== 0) {
      const detail = String(execError.stderr ?? "").trim();
      return new ScanError(
        detail
          ? `arp-scan failed: command exited with an error: ${detail}`
          : "arp-scan failed: command exited with an error",
        { cause: error },
      );
    }
  }

  return new ScanError("arp-scan failed: process execution error", { cause: error });
}

function looksLikeArpScanOutput(stdout: string): boolean {
  return (
    /^Interface:/m.test(stdout) ||
    /Starting arp-scan/i.test(stdout) ||
    /Ending arp-scan/i.test(stdout) ||
    /packets received by filter/i.test(stdout)
  );
}

function asExecLike(error: unknown): ExecLike | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }
  return error;
}

function isCommandTimeout(error: ExecLike): boolean {
  if (error.killed === true) {
    return true;
  }
  return typeof error.signal === "string" && error.signal.length > 0;
}

async function mapWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  signal: AbortSignal | undefined,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) {
    return;
  }

  let nextIndex = 0;
  let firstError: unknown;
  const workerCount = Math.min(Math.max(concurrency, 1), items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (firstError === undefined) {
        throwIfScanAborted(signal);
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) {
          return;
        }
        const item = items[index];
        if (item === undefined) {
          return;
        }
        try {
          await worker(item);
        } catch (error) {
          firstError = error;
          throw error;
        }
      }
    }),
  );
}

function throwIfScanAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new ScanError("scan cancelled");
  }
}
