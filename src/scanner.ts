import type { AppConfig } from "./config.js";
import {
  listUsableHosts,
  type NormalizedHostObservation,
  type NormalizedScanResult,
} from "./state.js";

export interface Scanner {
  scan(signal?: AbortSignal): Promise<NormalizedScanResult>;
}

export class ScanError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ScanError";
  }
}

export type MockScanFrame =
  | {
      kind: "ok";
      observations: readonly NormalizedHostObservation[];
      gate?: () => Promise<void>;
    }
  | {
      kind: "error";
      message: string;
      cause?: unknown;
      gate?: () => Promise<void>;
    };

export interface MockScannerOptions {
  cidr: string;
  frames: readonly MockScanFrame[];
  now?: () => Date;
  repeatLast?: boolean;
  loop?: boolean;
}

export interface LifecycleScenario {
  cidr: string;
  hosts: {
    arp: string;
    ping: string;
  };
  macAddresses: {
    original: string;
    changed: string;
  };
  frames: readonly MockScanFrame[];
}

export class MockScanner implements Scanner {
  private readonly cidr: string;
  private readonly frames: readonly MockScanFrame[];
  private readonly now: () => Date;
  private readonly repeatLast: boolean;
  private readonly loop: boolean;
  private frameIndex = 0;
  private lastOkObservations: readonly NormalizedHostObservation[] | null = null;

  constructor(options: MockScannerOptions) {
    if (options.frames.length === 0) {
      throw new ScanError("Mock scanner requires at least one frame");
    }

    this.cidr = options.cidr;
    this.frames = options.frames;
    this.now = options.now ?? (() => new Date());
    this.repeatLast = options.repeatLast ?? true;
    this.loop = options.loop ?? false;
  }

  async scan(signal?: AbortSignal): Promise<NormalizedScanResult> {
    throwIfScanAborted(signal);
    const frame = this.takeFrame();
    if (frame.gate) {
      await waitForGate(frame.gate(), signal);
    }
    throwIfScanAborted(signal);

    if (frame.kind === "error") {
      if (frame.cause !== undefined) {
        throw new ScanError(frame.message, { cause: frame.cause });
      }
      throw new ScanError(frame.message);
    }

    this.lastOkObservations = frame.observations;
    return {
      cidr: this.cidr,
      scannedAt: this.now().toISOString(),
      observations: frame.observations,
    };
  }

  private takeFrame(): MockScanFrame {
    if (this.frameIndex < this.frames.length) {
      const frame = this.frames[this.frameIndex];
      this.frameIndex += 1;
      if (frame === undefined) {
        throw new ScanError("Mock scanner frame is missing");
      }
      return frame;
    }

    if (this.loop) {
      this.frameIndex = 0;
      const frame = this.frames[this.frameIndex];
      this.frameIndex += 1;
      if (frame === undefined) {
        throw new ScanError("Mock scanner frame is missing");
      }
      return frame;
    }

    if (this.repeatLast && this.lastOkObservations !== null) {
      return { kind: "ok", observations: this.lastOkObservations };
    }

    throw new ScanError("Mock scanner has no remaining frames");
  }
}

function throwIfScanAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new ScanError("scan cancelled");
  }
}

async function waitForGate(
  gate: Promise<void>,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal === undefined) {
    await gate;
    return;
  }

  throwIfScanAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      reject(new ScanError("scan cancelled"));
    };
    const cleanUp = () => {
      signal.removeEventListener("abort", onAbort);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void gate.then(
      () => {
        cleanUp();
        resolve();
      },
      (error: unknown) => {
        cleanUp();
        reject(error);
      },
    );
  });
}

export function arpObservation(
  ipAddress: string,
  macAddress: string,
): NormalizedHostObservation {
  return { ipAddress, responded: true, macAddress };
}

export function pingObservation(ipAddress: string): NormalizedHostObservation {
  return { ipAddress, responded: true, macAddress: null };
}

export function silentObservation(ipAddress: string): NormalizedHostObservation {
  return { ipAddress, responded: false, macAddress: null };
}

export function okFrame(
  observations: readonly NormalizedHostObservation[],
  gate?: () => Promise<void>,
): MockScanFrame {
  return gate ? { kind: "ok", observations, gate } : { kind: "ok", observations };
}

export function errorFrame(message: string, gate?: () => Promise<void>): MockScanFrame {
  return gate ? { kind: "error", message, gate } : { kind: "error", message };
}

export function createLifecycleScenario(cidr: string): LifecycleScenario {
  const hosts = pickHosts(cidr, 2);
  const arp = hosts[0];
  const ping = hosts[1];
  if (arp === undefined || ping === undefined) {
    throw new ScanError(`CIDR ${cidr} needs at least 2 usable hosts for the lifecycle scenario`);
  }

  const macAddresses = {
    original: "aa:bb:cc:dd:ee:01",
    changed: "aa:bb:cc:dd:ee:02",
  };

  return {
    cidr,
    hosts: { arp, ping },
    macAddresses,
    frames: [
      okFrame([]),
      okFrame([arpObservation(arp, macAddresses.original)]),
      okFrame([
        arpObservation(arp, macAddresses.original),
        pingObservation(ping),
      ]),
      okFrame([silentObservation(arp), pingObservation(ping)]),
      okFrame([arpObservation(arp, macAddresses.changed)]),
      errorFrame("mock scan failed"),
    ],
  };
}

export function createMockScanner(
  config: Pick<AppConfig, "targetCidr">,
  options?: { now?: () => Date },
): MockScanner {
  const scannerOptions: MockScannerOptions = {
    cidr: config.targetCidr,
    frames: buildDefaultDevFrames(config.targetCidr),
    loop: true,
    repeatLast: true,
  };
  if (options?.now) {
    scannerOptions.now = options.now;
  }
  return new MockScanner(scannerOptions);
}

function buildDefaultDevFrames(cidr: string): MockScanFrame[] {
  const hosts = pickHosts(cidr, 4);
  const a = hosts[0];
  const b = hosts[1] ?? a;
  const c = hosts[2] ?? b;
  const d = hosts[3] ?? c;
  if (a === undefined || b === undefined || c === undefined || d === undefined) {
    throw new ScanError(`CIDR ${cidr} has no usable hosts for the mock scanner`);
  }

  const macA = "aa:bb:cc:10:00:01";
  const macAChanged = "aa:bb:cc:10:00:11";
  const macC = "aa:bb:cc:10:00:03";

  return [
    okFrame([]),
    okFrame([arpObservation(a, macA)]),
    okFrame([arpObservation(a, macA), pingObservation(b)]),
    okFrame([pingObservation(b), arpObservation(c, macC)]),
    okFrame([arpObservation(a, macAChanged), pingObservation(b)]),
    okFrame([arpObservation(a, macAChanged), pingObservation(d)]),
  ];
}

function pickHosts(cidr: string, count: number): string[] {
  const usable = listUsableHosts(cidr);
  if (usable.length === 0) {
    return [];
  }

  const selected: string[] = [];
  const lastIndex = usable.length - 1;
  for (let index = 0; index < Math.min(count, usable.length); index += 1) {
    const hostIndex =
      usable.length === 1 ? 0 : Math.round((index * lastIndex) / Math.max(count - 1, 1));
    const host = usable[Math.min(hostIndex, lastIndex)];
    if (host !== undefined && !selected.includes(host)) {
      selected.push(host);
    }
  }

  for (const host of usable) {
    if (selected.length >= Math.min(count, usable.length)) {
      break;
    }
    if (!selected.includes(host)) {
      selected.push(host);
    }
  }

  return selected;
}
