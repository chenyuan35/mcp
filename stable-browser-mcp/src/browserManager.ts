import crypto from 'node:crypto';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { config } from './config.js';
import { OperationLedger, type OperationRecord } from './ledger.js';
import { log } from './logger.js';
import { ProfileLock } from './profileLock.js';
import { classifyFailure, errorMessage } from './recovery.js';

export type Evidence = {
  generation: number;
  url: string | null;
  title: string | null;
  pageCount: number;
  bodyTextHash?: string | null;
  bodyTextSample?: string | null;
};

export type OperationOutcome<T> = {
  status: 'succeeded' | 'failed' | 'uncertain';
  tool: string;
  operationKey?: string;
  deduplicated?: boolean;
  attempts: number;
  result?: T;
  error?: string;
  failureKind?: string;
  evidence?: Evidence;
};

type RunOptions = {
  tool: string;
  operationKey?: string;
  force?: boolean;
  safeToRetry: boolean;
};

type ActionRuntime = {
  page: Page;
  attempt: number;
  markSideEffectStarted: () => void;
};

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class BrowserManager {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private generation = 0;
  private launching: Promise<void> | null = null;
  private readonly lock = new ProfileLock();
  private readonly ledger = new OperationLedger();

  async ensurePage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;
    await this.launch();
    if (!this.page || this.page.isClosed()) throw new Error('Browser page unavailable after launch');
    return this.page;
  }

  private async launch() {
    if (this.launching) return this.launching;
    this.launching = this.launchInternal();
    try {
      await this.launching;
    } finally {
      this.launching = null;
    }
  }

  private async launchInternal() {
    this.lock.acquire(config.userDataDir);
    await this.closeContext().catch(() => undefined);
    log('info', 'browser.launch.start', {
      userDataDir: config.userDataDir,
      channel: config.chromeChannel,
      headless: config.headless
    });

    try {
      const context = await chromium.launchPersistentContext(config.userDataDir, {
        channel: config.chromeChannel,
        headless: config.headless,
        viewport: null,
        args: ['--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage']
      });

      context.setDefaultTimeout(config.actionTimeoutMs);
      context.setDefaultNavigationTimeout(config.navTimeoutMs);
      this.context = context;
      const pages = context.pages().filter(p => !p.isClosed());
      this.page = pages.at(-1) || (await context.newPage());
      this.generation += 1;

      context.on('page', p => {
        this.page = p;
        log('info', 'browser.page.created', { generation: this.generation, url: p.url() });
      });

      context.on('close', () => {
        log('warn', 'browser.context.closed', { generation: this.generation });
        if (this.context === context) {
          this.context = null;
          this.page = null;
        }
      });

      log('info', 'browser.launch.ok', { generation: this.generation, pages: context.pages().length });
    } catch (error) {
      log('error', 'browser.launch.failed', { message: errorMessage(error) });
      throw error;
    }
  }

  private async closeContext() {
    const context = this.context;
    this.context = null;
    this.page = null;
    if (context) await context.close();
  }

  async shutdown() {
    await this.closeContext().catch(() => undefined);
    this.lock.release();
  }

  async reset() {
    log('warn', 'browser.reset.requested', { generation: this.generation });
    await this.closeContext();
    await this.launch();
  }

  setActivePage(page: Page) {
    if (page.isClosed()) throw new Error('Cannot select a closed page');
    this.page = page;
  }

  pages(): Page[] {
    return (this.context?.pages() ?? []).filter(page => !page.isClosed());
  }

  async captureEvidence(includeBody = false): Promise<Evidence> {
    const page = this.page && !this.page.isClosed() ? this.page : null;
    const evidence: Evidence = {
      generation: this.generation,
      url: page?.url() ?? null,
      title: page ? await page.title().catch(() => null) : null,
      pageCount: this.pages().length
    };

    if (includeBody && page) {
      const body = await page.locator('body').innerText({ timeout: Math.min(config.actionTimeoutMs, 5_000) }).catch(() => '');
      const bounded = body.slice(0, 50_000);
      evidence.bodyTextHash = bounded ? crypto.createHash('sha256').update(bounded).digest('hex') : null;
      evidence.bodyTextSample = body ? body.slice(0, config.evidenceSampleChars) : null;
    }
    return evidence;
  }

  private outcomeFromLedger<T>(record: OperationRecord, tool: string): OperationOutcome<T> {
    return {
      status: record.status === 'succeeded' ? 'succeeded' : record.status === 'uncertain' ? 'uncertain' : 'failed',
      tool,
      operationKey: record.operationKey,
      deduplicated: true,
      attempts: record.attempt,
      result: record.result as T | undefined,
      error: record.error,
      failureKind: record.failureKind,
      evidence: record.evidence as Evidence | undefined
    };
  }

  async run<T>(options: RunOptions, fn: (runtime: ActionRuntime) => Promise<T>): Promise<OperationOutcome<T>> {
    const prior = this.ledger.get(options.operationKey);
    if (!options.force && prior && (prior.status === 'succeeded' || prior.status === 'uncertain')) {
      log('info', 'operation.deduplicated', {
        tool: options.tool,
        operationKey: options.operationKey,
        priorStatus: prior.status
      });
      return this.outcomeFromLedger<T>(prior, options.tool);
    }

    let lastError: unknown;
    for (let attempt = 1; attempt <= config.maxRetries + 1; attempt++) {
      let sideEffectStarted = false;
      const operationKey = options.operationKey;
      if (operationKey) {
        this.ledger.append({
          operationKey,
          tool: options.tool,
          status: 'started',
          attempt,
          generation: this.generation
        });
      }

      try {
        const page = await this.ensurePage();
        const result = await fn({
          page,
          attempt,
          markSideEffectStarted: () => {
            sideEffectStarted = true;
          }
        });
        const evidence = await this.captureEvidence(false);
        if (operationKey) {
          this.ledger.append({
            operationKey,
            tool: options.tool,
            status: 'succeeded',
            attempt,
            generation: this.generation,
            result,
            evidence
          });
        }
        if (attempt > 1) log('info', 'operation.recovered', { tool: options.tool, attempt });
        return { status: 'succeeded', tool: options.tool, operationKey, attempts: attempt, result, evidence };
      } catch (error) {
        lastError = error;
        const failure = classifyFailure(error);
        const message = errorMessage(error);
        log('warn', 'operation.failed', {
          tool: options.tool,
          operationKey: options.operationKey ?? null,
          attempt,
          sideEffectStarted,
          failureKind: failure.kind,
          message
        });

        if (sideEffectStarted && failure.ambiguousAfterWrite) {
          const evidence = await this.captureEvidence(true).catch(() => ({
            generation: this.generation,
            url: null,
            title: null,
            pageCount: 0
          }));
          if (options.operationKey) {
            this.ledger.append({
              operationKey: options.operationKey,
              tool: options.tool,
              status: 'uncertain',
              attempt,
              generation: this.generation,
              error: message,
              failureKind: failure.kind,
              evidence
            });
          }
          return {
            status: 'uncertain',
            tool: options.tool,
            operationKey: options.operationKey,
            attempts: attempt,
            error: message,
            failureKind: failure.kind,
            evidence
          };
        }

        const canRetry =
          attempt <= config.maxRetries &&
          (options.safeToRetry || !sideEffectStarted) &&
          failure.retrySafeRead;

        if (!canRetry) {
          const evidence = await this.captureEvidence(false).catch(() => undefined);
          if (options.operationKey) {
            this.ledger.append({
              operationKey: options.operationKey,
              tool: options.tool,
              status: 'failed',
              attempt,
              generation: this.generation,
              error: message,
              failureKind: failure.kind,
              evidence
            });
          }
          return {
            status: 'failed',
            tool: options.tool,
            operationKey: options.operationKey,
            attempts: attempt,
            error: message,
            failureKind: failure.kind,
            evidence
          };
        }

        if (failure.recoverBrowser) {
          await this.reset().catch(resetError => {
            log('error', 'browser.reset.failed', { message: errorMessage(resetError) });
          });
        }
        await sleep(config.retryBackoffMs * attempt);
      }
    }

    return {
      status: 'failed',
      tool: options.tool,
      operationKey: options.operationKey,
      attempts: config.maxRetries + 1,
      error: errorMessage(lastError)
    };
  }

  async status() {
    const page = this.page && !this.page.isClosed() ? this.page : null;
    return {
      connected: Boolean(this.context && page),
      generation: this.generation,
      url: page?.url() ?? null,
      title: page ? await page.title().catch(() => null) : null,
      pages: this.pages().length,
      userDataDir: config.userDataDir,
      actionTimeoutMs: config.actionTimeoutMs,
      navTimeoutMs: config.navTimeoutMs,
      maxRetries: config.maxRetries,
      snapshotMaxChars: config.snapshotMaxChars,
      profileLock: this.lock.status(),
      operationLedger: this.ledger.path()
    };
  }

  recentOperations(limit: number) {
    return this.ledger.recent(limit);
  }
}
