export const MAX_USABLE_HOSTS = 254;

export type ObservedStatus = "ACTIVE" | "INACTIVE" | "AVAILABLE";
export type CidrErrorCode =
  | "INVALID_FORMAT"
  | "INVALID_ADDRESS"
  | "UNSUPPORTED_PREFIX"
  | "TOO_MANY_HOSTS";

export class CidrError extends Error {
  readonly code: CidrErrorCode;
  readonly usableHostCount?: number;

  constructor(code: CidrErrorCode, message: string, usableHostCount?: number) {
    super(message);
    this.name = "CidrError";
    this.code = code;
    if (usableHostCount !== undefined) {
      this.usableHostCount = usableHostCount;
    }
  }
}

export class ScanStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScanStateError";
  }
}

export interface ParsedIpv4Cidr {
  cidr: string;
  prefixLength: number;
  networkAddress: string;
  broadcastAddress: string;
  usableHostCount: number;
  usableHosts: string[];
}

export interface IpRecord {
  cidr: string;
  ipAddress: string;
  observedStatus: ObservedStatus;
  isReserved: boolean;
  macAddress: string | null;
  note: string;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  lastCheckedAt: string | null;
}

export interface NormalizedHostObservation {
  ipAddress: string;
  responded: boolean;
  macAddress: string | null;
}

export interface NormalizedScanResult {
  cidr: string;
  scannedAt: string;
  observations: readonly NormalizedHostObservation[];
}

export interface StatusSummary {
  total: number;
  active: number;
  inactive: number;
  available: number;
  reserved: number;
  allocationCandidates: number;
}

export interface CidrStateSnapshot {
  records: IpRecord[];
  summary: StatusSummary;
}

const CIDR_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d|[12]\d|3[0-2])$/;
const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const MAC_PATTERN = /^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/;
const UTC_ISO_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/;

export function parseIpv4Cidr(cidr: string): ParsedIpv4Cidr {
  const match = CIDR_PATTERN.exec(cidr);
  if (!match) {
    throw new CidrError(
      "INVALID_FORMAT",
      "CIDR must be an IPv4 CIDR such as 192.168.1.0/24",
    );
  }

  const octets = parseOctets(match.slice(1, 5), "INVALID_ADDRESS");
  const prefixToken = match[5];
  if (prefixToken === undefined) {
    throw new CidrError(
      "INVALID_FORMAT",
      "CIDR must be an IPv4 CIDR such as 192.168.1.0/24",
    );
  }

  const prefixLength = Number(prefixToken);
  if (prefixLength >= 31) {
    throw new CidrError(
      "UNSUPPORTED_PREFIX",
      "CIDR prefixes /31 and /32 are not supported",
    );
  }

  const ipNumber = octetsToNumber(octets);
  const hostBits = 32 - prefixLength;
  const mask = hostBits >= 32 ? 0 : (0xffffffff << hostBits) >>> 0;
  const network = (ipNumber & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  const usableHostCount = broadcast - network - 1;

  if (usableHostCount > MAX_USABLE_HOSTS) {
    throw new CidrError(
      "TOO_MANY_HOSTS",
      `CIDR supports at most ${MAX_USABLE_HOSTS} usable hosts; received ${usableHostCount}`,
      usableHostCount,
    );
  }

  const usableHosts: string[] = [];
  for (let address = network + 1; address < broadcast; address += 1) {
    usableHosts.push(numberToIpv4(address >>> 0));
  }

  return {
    cidr,
    prefixLength,
    networkAddress: numberToIpv4(network),
    broadcastAddress: numberToIpv4(broadcast),
    usableHostCount,
    usableHosts,
  };
}

export function listUsableHosts(cidr: string): string[] {
  return parseIpv4Cidr(cidr).usableHosts;
}

export function countUsableHosts(cidr: string): number {
  return parseIpv4Cidr(cidr).usableHostCount;
}

export function ipv4AddressToNumber(address: string): number {
  return octetsToNumber(parseIpv4Address(address));
}

export function compareIpv4Addresses(left: string, right: string): number {
  return ipv4AddressToNumber(left) - ipv4AddressToNumber(right);
}

export function summarizeRecords(records: readonly IpRecord[]): StatusSummary {
  let active = 0;
  let inactive = 0;
  let available = 0;
  let reserved = 0;
  let allocationCandidates = 0;

  for (const record of records) {
    if (record.observedStatus === "ACTIVE") {
      active += 1;
    } else if (record.observedStatus === "INACTIVE") {
      inactive += 1;
    } else {
      available += 1;
    }

    if (record.isReserved) {
      reserved += 1;
    }

    if (record.observedStatus === "AVAILABLE" && !record.isReserved) {
      allocationCandidates += 1;
    }
  }

  return {
    total: records.length,
    active,
    inactive,
    available,
    reserved,
    allocationCandidates,
  };
}

export function calculateCidrState(
  existingRecords: readonly IpRecord[],
  scan: NormalizedScanResult,
): CidrStateSnapshot {
  if (!isUtcIso8601Timestamp(scan.scannedAt)) {
    throw new ScanStateError("Scan timestamp must be a UTC ISO 8601 string");
  }

  const parsedCidr = parseIpv4Cidr(scan.cidr);
  const hostSet = new Set(parsedCidr.usableHosts);
  const observationsByIp = indexObservations(scan.observations, hostSet);
  const existingByIp = new Map<string, IpRecord>();

  for (const record of existingRecords) {
    if (record.cidr === scan.cidr) {
      existingByIp.set(record.ipAddress, record);
    }
  }

  const records = parsedCidr.usableHosts.map((ipAddress) =>
    nextRecordForHost({
      cidr: scan.cidr,
      ipAddress,
      scannedAt: scan.scannedAt,
      existing: existingByIp.get(ipAddress),
      observation: observationsByIp.get(ipAddress),
    }),
  );

  return {
    records,
    summary: summarizeRecords(records),
  };
}

function indexObservations(
  observations: readonly NormalizedHostObservation[],
  hostSet: ReadonlySet<string>,
): Map<string, NormalizedHostObservation> {
  const observationsByIp = new Map<string, NormalizedHostObservation>();

  for (const observation of observations) {
    let ipAddress: string;
    try {
      ipAddress = numberToIpv4(ipv4AddressToNumber(observation.ipAddress));
    } catch (error) {
      if (error instanceof CidrError) {
        throw new ScanStateError(
          `Scan observation IP is invalid: ${observation.ipAddress}`,
        );
      }
      throw error;
    }

    if (!hostSet.has(ipAddress)) {
      throw new ScanStateError(
        `Scan observation IP is outside the target CIDR: ${observation.ipAddress}`,
      );
    }

    if (observationsByIp.has(ipAddress)) {
      throw new ScanStateError(
        `Scan observations contain a duplicate IP: ${observation.ipAddress}`,
      );
    }

    const macAddress = normalizeObservedMac(observation);
    observationsByIp.set(ipAddress, {
      ipAddress,
      responded: observation.responded,
      macAddress,
    });
  }

  return observationsByIp;
}

function normalizeObservedMac(
  observation: NormalizedHostObservation,
): string | null {
  if (observation.macAddress === null) {
    return null;
  }

  if (!observation.responded) {
    throw new ScanStateError(
      `Scan observation for ${observation.ipAddress} cannot include a MAC without a response`,
    );
  }

  if (!MAC_PATTERN.test(observation.macAddress)) {
    throw new ScanStateError(
      `Scan observation MAC is invalid: ${observation.macAddress}`,
    );
  }

  return observation.macAddress.toLowerCase();
}

function nextRecordForHost(input: {
  cidr: string;
  ipAddress: string;
  scannedAt: string;
  existing: IpRecord | undefined;
  observation: NormalizedHostObservation | undefined;
}): IpRecord {
  const responded = input.observation?.responded === true;
  const observedMac = input.observation?.macAddress ?? null;
  const note = input.existing?.note ?? "";
  const isReserved = input.existing?.isReserved ?? false;
  const priorMac = input.existing?.macAddress ?? null;

  if (responded) {
    return {
      cidr: input.cidr,
      ipAddress: input.ipAddress,
      observedStatus: "ACTIVE",
      isReserved,
      macAddress: observedMac ?? priorMac,
      note,
      firstSeenAt: input.existing?.firstSeenAt ?? input.scannedAt,
      lastSeenAt: input.scannedAt,
      lastCheckedAt: input.scannedAt,
    };
  }

  const lastSeenAt = input.existing?.lastSeenAt ?? null;
  return {
    cidr: input.cidr,
    ipAddress: input.ipAddress,
    observedStatus: lastSeenAt === null ? "AVAILABLE" : "INACTIVE",
    isReserved,
    macAddress: priorMac,
    note,
    firstSeenAt: input.existing?.firstSeenAt ?? null,
    lastSeenAt,
    lastCheckedAt: input.scannedAt,
  };
}

function parseIpv4Address(address: string): [number, number, number, number] {
  const match = IPV4_PATTERN.exec(address);
  if (!match) {
    throw new CidrError("INVALID_ADDRESS", "CIDR contains an invalid IPv4 address");
  }
  return parseOctets(match.slice(1, 5), "INVALID_ADDRESS");
}

function parseOctets(
  tokens: readonly string[],
  invalidCode: CidrErrorCode,
): [number, number, number, number] {
  if (tokens.length !== 4) {
    throw new CidrError(invalidCode, "CIDR contains an invalid IPv4 address");
  }

  const octets = tokens.map((token) => {
    if (token === undefined) {
      throw new CidrError(invalidCode, "CIDR contains an invalid IPv4 address");
    }
    const parsed = Number(token);
    if (!Number.isInteger(parsed) || parsed > 255 || String(parsed) !== token) {
      throw new CidrError(invalidCode, "CIDR contains an invalid IPv4 address");
    }
    return parsed;
  });

  return [octets[0]!, octets[1]!, octets[2]!, octets[3]!];
}

function octetsToNumber(octets: readonly [number, number, number, number]): number {
  return (
    ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0
  );
}

function numberToIpv4(value: number): string {
  return [
    (value >>> 24) & 255,
    (value >>> 16) & 255,
    (value >>> 8) & 255,
    value & 255,
  ].join(".");
}

function isUtcIso8601Timestamp(value: string): boolean {
  if (typeof value !== "string") {
    return false;
  }

  const match = UTC_ISO_PATTERN.exec(value);
  if (!match) {
    return false;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    !Number.isInteger(second) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return false;
  }

  const utcMillis = Date.UTC(year, month - 1, day, hour, minute, second);
  const roundTrip = new Date(utcMillis);
  return (
    roundTrip.getUTCFullYear() === year &&
    roundTrip.getUTCMonth() === month - 1 &&
    roundTrip.getUTCDate() === day &&
    roundTrip.getUTCHours() === hour &&
    roundTrip.getUTCMinutes() === minute &&
    roundTrip.getUTCSeconds() === second
  );
}
