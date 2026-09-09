import fs from 'node:fs';
import path from 'node:path';
import { paths } from './config.js';
import { log } from './logger.js';

type LockRow = {
  pid: number;
  startedAt: string;
  userDataDir: string;
};

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class ProfileLock {
  private acquired = false;

  acquire(userDataDir: string) {
    if (this.acquired) return;
    fs.mkdirSync(path.dirname(paths.profileLock), { recursive: true });

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = fs.openSync(paths.profileLock, 'wx');
        const row: LockRow = { pid: process.pid, startedAt: new Date().toISOString(), userDataDir };
        fs.writeFileSync(fd, JSON.stringify(row, null, 2), 'utf8');
        fs.closeSync(fd);
        this.acquired = true;
        log('info', 'profile.lock.acquired', { path: paths.profileLock, pid: process.pid });
        return;
      } catch (error) {
        if (!fs.existsSync(paths.profileLock)) throw error;
        let existing: Partial<LockRow> = {};
        try {
          existing = JSON.parse(fs.readFileSync(paths.profileLock, 'utf8')) as Partial<LockRow>;
        } catch {
          // A malformed lock is treated as stale.
        }
        if (typeof existing.pid === 'number' && pidAlive(existing.pid)) {
          throw new Error(
            `Browser profile is already owned by PID ${existing.pid}. Use a different BROWSER_USER_DATA_DIR or stop that server first.`
          );
        }
        fs.rmSync(paths.profileLock, { force: true });
        log('warn', 'profile.lock.stale_removed', { path: paths.profileLock, previousPid: existing.pid ?? null });
      }
    }

    throw new Error(`Could not acquire profile lock: ${paths.profileLock}`);
  }

  release() {
    if (!this.acquired) return;
    this.acquired = false;
    try {
      const row = JSON.parse(fs.readFileSync(paths.profileLock, 'utf8')) as Partial<LockRow>;
      if (row.pid === process.pid) fs.rmSync(paths.profileLock, { force: true });
    } catch {
      fs.rmSync(paths.profileLock, { force: true });
    }
    log('info', 'profile.lock.released', { path: paths.profileLock, pid: process.pid });
  }

  status() {
    return { acquired: this.acquired, path: paths.profileLock };
  }
}
