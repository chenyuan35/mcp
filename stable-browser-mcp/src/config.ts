import path from 'node:path';

function numberEnv(name: string, fallback: number, min = 0): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min) {
    throw new Error(`${name} must be a number >= ${min}`);
  }
  return value;
}

export const config = {
  userDataDir: path.resolve(process.env.BROWSER_USER_DATA_DIR || '.browser-profile'),
  headless: process.env.BROWSER_HEADLESS === '1',
  actionTimeoutMs: numberEnv('BROWSER_ACTION_TIMEOUT_MS', 20_000, 500),
  navTimeoutMs: numberEnv('BROWSER_NAV_TIMEOUT_MS', 45_000, 1_000),
  maxRetries: numberEnv('BROWSER_MAX_RETRIES', 2, 0),
  retryBackoffMs: numberEnv('BROWSER_RETRY_BACKOFF_MS', 600, 0),
  snapshotMaxChars: numberEnv('BROWSER_SNAPSHOT_MAX_CHARS', 20_000, 1_000),
  evidenceSampleChars: numberEnv('BROWSER_EVIDENCE_SAMPLE_CHARS', 2_000, 0),
  logDir: path.resolve(process.env.BROWSER_LOG_DIR || '.stable-browser/logs'),
  stateDir: path.resolve(process.env.BROWSER_STATE_DIR || '.stable-browser/state'),
  chromeChannel: process.env.BROWSER_CHANNEL || 'chrome'
};

export const paths = {
  operationLedger: path.join(config.stateDir, 'operations.jsonl'),
  profileLock: `${config.userDataDir}.stable-browser-mcp.lock`,
  logFile: path.join(config.logDir, 'browser-mcp.jsonl')
};
