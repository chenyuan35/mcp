import fs from 'node:fs';
import path from 'node:path';
import { paths } from './config.js';

export type OperationStatus = 'started' | 'succeeded' | 'failed' | 'uncertain';

export type OperationRecord = {
  ts: string;
  operationKey: string;
  tool: string;
  status: OperationStatus;
  attempt: number;
  generation?: number;
  result?: unknown;
  error?: string;
  failureKind?: string;
  evidence?: unknown;
};

export class OperationLedger {
  private latest = new Map<string, OperationRecord>();

  constructor() {
    fs.mkdirSync(path.dirname(paths.operationLedger), { recursive: true });
    this.load();
    this.recoverInterruptedOperations();
  }

  private load() {
    if (!fs.existsSync(paths.operationLedger)) return;
    const lines = fs.readFileSync(paths.operationLedger, 'utf8').split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      try {
        const row = JSON.parse(line) as OperationRecord;
        if (row.operationKey) this.latest.set(row.operationKey, row);
      } catch {
        // One damaged line must not make the whole automation state unreadable.
      }
    }
  }

  private recoverInterruptedOperations() {
    const interrupted = [...this.latest.values()].filter(row => row.status === 'started');
    for (const row of interrupted) {
      this.append({
        operationKey: row.operationKey,
        tool: row.tool,
        status: 'uncertain',
        attempt: row.attempt,
        generation: row.generation,
        error: 'Previous process ended before a final operation receipt was recorded.',
        failureKind: 'interrupted_process',
        evidence: row.evidence
      });
    }
  }

  get(operationKey?: string): OperationRecord | undefined {
    if (!operationKey) return undefined;
    return this.latest.get(operationKey);
  }

  append(record: Omit<OperationRecord, 'ts'>): OperationRecord {
    const row: OperationRecord = { ts: new Date().toISOString(), ...record };
    fs.appendFileSync(paths.operationLedger, `${JSON.stringify(row)}\n`, 'utf8');
    this.latest.set(row.operationKey, row);
    return row;
  }

  recent(limit = 50): OperationRecord[] {
    if (!fs.existsSync(paths.operationLedger)) return [];
    const lines = fs.readFileSync(paths.operationLedger, 'utf8').split(/\r?\n/).filter(Boolean);
    const rows: OperationRecord[] = [];
    for (const line of lines.slice(-limit)) {
      try {
        rows.push(JSON.parse(line) as OperationRecord);
      } catch {
        // skip damaged row
      }
    }
    return rows;
  }

  path() {
    return paths.operationLedger;
  }
}
