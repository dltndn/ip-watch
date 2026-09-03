import Database from "better-sqlite3";

import {
  compareIpv4Addresses,
  effectiveStatus,
  summarizeRecords,
  type DashboardRecord,
  type IpRecord,
  type ObservedStatus,
  type StatusSummary,
} from "./state.js";

export type SqliteDatabase = Database.Database;

export interface IpRecordPatch {
  note?: string;
  isReserved?: boolean;
}

export interface DashboardSnapshot {
  records: DashboardRecord[];
  summary: StatusSummary;
}

interface IpRecordRow {
  cidr: string;
  ip_address: string;
  observed_status: ObservedStatus;
  is_reserved: number;
  mac_address: string | null;
  note: string;
  first_seen_at: string | null;
  last_seen_at: string | null;
  last_checked_at: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ip_records (
  cidr TEXT NOT NULL,
  ip_address TEXT NOT NULL,
  observed_status TEXT NOT NULL CHECK (observed_status IN ('ACTIVE', 'INACTIVE', 'AVAILABLE')),
  is_reserved INTEGER NOT NULL CHECK (is_reserved IN (0, 1)),
  mac_address TEXT,
  note TEXT NOT NULL CHECK (length(note) <= 1000),
  first_seen_at TEXT,
  last_seen_at TEXT,
  last_checked_at TEXT,
  PRIMARY KEY (cidr, ip_address)
);
`;

const SELECT_COLUMNS = `
  cidr,
  ip_address,
  observed_status,
  is_reserved,
  mac_address,
  note,
  first_seen_at,
  last_seen_at,
  last_checked_at
`;

export function openDatabase(databasePath: string): SqliteDatabase {
  const db = new Database(databasePath);

  try {
    const journalMode = db.pragma("journal_mode = WAL", { simple: true });
    if (typeof journalMode !== "string" || journalMode.toLowerCase() !== "wal") {
      throw new Error(
        `Failed to enable SQLite WAL mode (journal_mode=${String(journalMode)})`,
      );
    }

    db.pragma("busy_timeout = 5000");
    const busyTimeout = db.pragma("busy_timeout", { simple: true });
    if (busyTimeout !== 5000) {
      throw new Error(
        `Failed to set SQLite busy_timeout to 5000 (busy_timeout=${String(busyTimeout)})`,
      );
    }

    db.exec(SCHEMA);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function listIpRecords(db: SqliteDatabase, cidr: string): IpRecord[] {
  const rows = db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM ip_records WHERE cidr = ?`)
    .all(cidr) as IpRecordRow[];

  return rows.map(mapRow).sort((left, right) =>
    compareIpv4Addresses(left.ipAddress, right.ipAddress),
  );
}

export function upsertScanRecords(
  db: SqliteDatabase,
  records: readonly IpRecord[],
): void {
  const statement = db.prepare(`
    INSERT INTO ip_records (
      cidr,
      ip_address,
      observed_status,
      is_reserved,
      mac_address,
      note,
      first_seen_at,
      last_seen_at,
      last_checked_at
    ) VALUES (
      @cidr,
      @ipAddress,
      @observedStatus,
      @isReserved,
      @macAddress,
      @note,
      @firstSeenAt,
      @lastSeenAt,
      @lastCheckedAt
    )
    ON CONFLICT(cidr, ip_address) DO UPDATE SET
      observed_status = excluded.observed_status,
      mac_address = excluded.mac_address,
      first_seen_at = excluded.first_seen_at,
      last_seen_at = excluded.last_seen_at,
      last_checked_at = excluded.last_checked_at
  `);

  const insertAll = db.transaction((rows: readonly IpRecord[]) => {
    for (const row of rows) {
      statement.run({
        cidr: row.cidr,
        ipAddress: row.ipAddress,
        observedStatus: row.observedStatus,
        isReserved: row.isReserved ? 1 : 0,
        macAddress: row.macAddress,
        note: row.note,
        firstSeenAt: row.firstSeenAt,
        lastSeenAt: row.lastSeenAt,
        lastCheckedAt: row.lastCheckedAt,
      });
    }
  });

  insertAll(records);
}

export function updateIpRecord(
  db: SqliteDatabase,
  cidr: string,
  ipAddress: string,
  patch: IpRecordPatch,
): IpRecord {
  const assignments: string[] = [];
  const values: unknown[] = [];

  if (Object.prototype.hasOwnProperty.call(patch, "note")) {
    assignments.push("note = ?");
    values.push(patch.note);
  }

  if (Object.prototype.hasOwnProperty.call(patch, "isReserved")) {
    assignments.push("is_reserved = ?");
    values.push(patch.isReserved ? 1 : 0);
  }

  if (assignments.length === 0) {
    throw new Error("IP record update requires note and/or isReserved");
  }

  const result = db
    .prepare(
      `UPDATE ip_records SET ${assignments.join(", ")} WHERE cidr = ? AND ip_address = ?`,
    )
    .run(...values, cidr, ipAddress);

  if (result.changes === 0) {
    throw new Error(`IP record not found: ${cidr} ${ipAddress}`);
  }

  const updated = db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM ip_records WHERE cidr = ? AND ip_address = ?`,
    )
    .get(cidr, ipAddress) as IpRecordRow | undefined;

  if (updated === undefined) {
    throw new Error(`IP record not found after update: ${cidr} ${ipAddress}`);
  }

  return mapRow(updated);
}

export function getDashboardSnapshot(
  db: SqliteDatabase,
  cidr: string,
  nowMs?: number,
  thresholdMs?: number,
): DashboardSnapshot {
  return db.transaction((): DashboardSnapshot => {
    const records = listIpRecords(db, cidr);
    const resolvedNowMs = nowMs ?? 0;
    const resolvedThresholdMs = thresholdMs ?? 0;
    return {
      records: records.map((record) => ({
        ...record,
        effectiveStatus: effectiveStatus(record, resolvedNowMs, resolvedThresholdMs),
      })),
      summary: summarizeRecords(records, nowMs, thresholdMs),
    };
  })();
}

function mapRow(row: IpRecordRow): IpRecord {
  return {
    cidr: row.cidr,
    ipAddress: row.ip_address,
    observedStatus: row.observed_status,
    isReserved: row.is_reserved === 1,
    macAddress: row.mac_address,
    note: row.note,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    lastCheckedAt: row.last_checked_at,
  };
}
