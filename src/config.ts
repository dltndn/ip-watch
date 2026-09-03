import { isIP } from "node:net";
import { isAbsolute } from "node:path";

import { CidrError, MAX_USABLE_HOSTS, countUsableHosts } from "./state.js";

const DEFAULTS = {
  NODE_ENV: "development",
  BIND_ADDRESS: "0.0.0.0",
  PORT: "3000",
  DATABASE_PATH: "/app/data/ip-watch.sqlite3",
  SCAN_INTERVAL_MS: "10000",
  SCAN_TIMEOUT_MS: "10000",
  PING_TIMEOUT_MS: "1000",
  PING_CONCURRENCY: "20",
  USE_MOCK_SCANNER: "false",
} as const;

const MAX_TIMER_MS = 2_147_483_647;
const MAX_TARGET_HOSTS = MAX_USABLE_HOSTS;
const MAX_STALE_THRESHOLD_DAYS = 36_500;

export type NodeEnvironment = "development" | "test" | "production";

export interface AppConfig {
  nodeEnv: NodeEnvironment;
  bindAddress: string;
  port: number;
  databasePath: string;
  targetCidr: string;
  targetHostCount: number;
  networkInterface?: string;
  scanIntervalMs: number;
  scanTimeoutMs: number;
  pingTimeoutMs: number;
  pingConcurrency: number;
  useMockScanner: boolean;
  staleThresholdDays: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(`Invalid configuration: ${message}`);
    this.name = "ConfigError";
  }
}

type Environment = Readonly<Record<string, string | undefined>>;

export function loadConfig(environment: Environment = process.env): AppConfig {
  const nodeEnv = parseNodeEnvironment(valueOrDefault(environment, "NODE_ENV"));
  const bindAddress = valueOrDefault(environment, "BIND_ADDRESS");
  if (isIP(bindAddress) !== 4) {
    throw new ConfigError("BIND_ADDRESS must be a valid IPv4 address");
  }

  const databasePath = valueOrDefault(environment, "DATABASE_PATH");
  if (!isAbsolute(databasePath)) {
    throw new ConfigError("DATABASE_PATH must be an absolute path");
  }

  const targetCidr = requiredValue(environment, "TARGET_CIDR");
  const targetHostCount = validateTargetCidr(targetCidr);
  const useMockScanner = parseBoolean(
    "USE_MOCK_SCANNER",
    valueOrDefault(environment, "USE_MOCK_SCANNER"),
  );

  const configuredInterface = environment.NETWORK_INTERFACE?.trim();
  if (!useMockScanner && !configuredInterface) {
    throw new ConfigError(
      "NETWORK_INTERFACE is required when USE_MOCK_SCANNER is false",
    );
  }
  if (configuredInterface && !/^[a-zA-Z0-9_.:-]{1,15}$/.test(configuredInterface)) {
    throw new ConfigError(
      "NETWORK_INTERFACE must be 1-15 characters using letters, numbers, '.', '_', ':' or '-'",
    );
  }

  return {
    nodeEnv,
    bindAddress,
    port: parsePositiveInteger("PORT", valueOrDefault(environment, "PORT"), 65_535),
    databasePath,
    targetCidr,
    targetHostCount,
    ...(configuredInterface ? { networkInterface: configuredInterface } : {}),
    scanIntervalMs: parsePositiveInteger(
      "SCAN_INTERVAL_MS",
      valueOrDefault(environment, "SCAN_INTERVAL_MS"),
      MAX_TIMER_MS,
    ),
    scanTimeoutMs: parsePositiveInteger(
      "SCAN_TIMEOUT_MS",
      valueOrDefault(environment, "SCAN_TIMEOUT_MS"),
      MAX_TIMER_MS,
    ),
    pingTimeoutMs: parsePositiveInteger(
      "PING_TIMEOUT_MS",
      valueOrDefault(environment, "PING_TIMEOUT_MS"),
      MAX_TIMER_MS,
    ),
    pingConcurrency: parsePositiveInteger(
      "PING_CONCURRENCY",
      valueOrDefault(environment, "PING_CONCURRENCY"),
      MAX_TARGET_HOSTS,
    ),
    useMockScanner,
    staleThresholdDays: parseStaleThresholdDays(environment.STALE_THRESHOLD_DAYS),
  };
}

function valueOrDefault(environment: Environment, name: keyof typeof DEFAULTS): string {
  return environment[name]?.trim() || DEFAULTS[name];
}

function requiredValue(environment: Environment, name: string): string {
  const value = environment[name]?.trim();
  if (!value) {
    throw new ConfigError(`${name} is required`);
  }
  return value;
}

function parseNodeEnvironment(value: string): NodeEnvironment {
  if (value === "development" || value === "test" || value === "production") {
    return value;
  }
  throw new ConfigError("NODE_ENV must be development, test or production");
}

function parsePositiveInteger(name: string, value: string, maximum: number): number {
  if (!/^\d+$/.test(value)) {
    throw new ConfigError(`${name} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new ConfigError(`${name} must be between 1 and ${maximum}`);
  }
  return parsed;
}

function parseStaleThresholdDays(value: string | undefined): number {
  const trimmed = value?.trim() ?? "";
  if (trimmed === "" || trimmed === "0") {
    return 0;
  }
  if (!/^\d+$/.test(trimmed)) {
    throw new ConfigError("STALE_THRESHOLD_DAYS must be a non-negative integer");
  }
  const parsed = Number(trimmed);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 1 ||
    parsed > MAX_STALE_THRESHOLD_DAYS
  ) {
    throw new ConfigError(
      `STALE_THRESHOLD_DAYS must be between 0 and ${MAX_STALE_THRESHOLD_DAYS}`,
    );
  }
  return parsed;
}

function parseBoolean(name: string, value: string): boolean {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new ConfigError(`${name} must be either true or false`);
}

function validateTargetCidr(value: string): number {
  try {
    return countUsableHosts(value);
  } catch (error) {
    if (error instanceof CidrError) {
      throw new ConfigError(configMessageForCidrError(error));
    }
    throw error;
  }
}

function configMessageForCidrError(error: CidrError): string {
  switch (error.code) {
    case "INVALID_FORMAT":
      return "TARGET_CIDR must be an IPv4 CIDR such as 192.168.1.0/24";
    case "INVALID_ADDRESS":
      return "TARGET_CIDR contains an invalid IPv4 address";
    case "UNSUPPORTED_PREFIX":
      return "TARGET_CIDR prefixes /31 and /32 are not supported";
    case "TOO_MANY_HOSTS":
      return `TARGET_CIDR supports at most ${MAX_TARGET_HOSTS} usable hosts; received ${error.usableHostCount}`;
    default: {
      const exhaustive: never = error.code;
      return exhaustive;
    }
  }
}
