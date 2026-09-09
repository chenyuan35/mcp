import fs from 'node:fs';
import path from 'node:path';
import { paths } from './config.js';

const MAX_LOG_BYTES = 5 * 1024 * 1024;

fs.mkdirSync(path.dirname(paths.logFile), { recursive: true });

function rotateIfNeeded() {
  try {
    const stat = fs.statSync(paths.logFile);
    if (stat.size < MAX_LOG_BYTES) return;
    const previous = `${paths.logFile}.1`;
    if (fs.existsSync(previous)) fs.rmSync(previous, { force: true });
    fs.renameSync(paths.logFile, previous);
  } catch {
    // No file yet or rotation is temporarily unavailable. Logging should never stop the browser.
  }
}

export type LogLevel = 'info' | 'warn' | 'error';

export function log(level: LogLevel, event: string, data: Record<string, unknown> = {}) {
  rotateIfNeeded();
  const row = { ts: new Date().toISOString(), level, event, ...data };
  try {
    fs.appendFileSync(paths.logFile, `${JSON.stringify(row)}\n`, 'utf8');
  } catch {
    // MCP stdout is protocol traffic. Diagnostics stay on stderr and must not crash the server.
  }
  process.stderr.write(`[${level}] ${event} ${JSON.stringify(data)}\n`);
}

export function getLogPath() {
  return paths.logFile;
}
