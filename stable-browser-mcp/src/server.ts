import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { BrowserManager, type OperationOutcome } from './browserManager.js';
import { config } from './config.js';
import { resolveLocator } from './locator.js';
import { getLogPath, log } from './logger.js';

const browser = new BrowserManager();
const server = new McpServer({ name: 'stable-browser-mcp', version: '0.2.0' });

const locatorFields = {
  selector: z.string().min(1),
  by: z.enum(['css', 'text', 'role', 'label', 'placeholder', 'testid']).optional(),
  name: z.string().optional(),
  exact: z.boolean().optional()
};

const mutationFields = {
  operationKey: z.string().min(1).max(200).optional(),
  force: z.boolean().optional()
};

const postconditionSchema = z
  .object({
    urlContains: z.string().optional(),
    textContains: z.string().optional(),
    selectorVisible: z.string().optional(),
    timeoutMs: z.number().int().min(500).max(120_000).optional()
  })
  .optional();

const textResult = (value: unknown, isError = false) => ({
  content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
  ...(isError ? { isError: true } : {})
});

function outcomeResult<T>(outcome: OperationOutcome<T>) {
  return textResult(outcome, outcome.status === 'failed');
}

async function verifyPostcondition(
  page: import('playwright').Page,
  condition: z.infer<typeof postconditionSchema>
): Promise<void> {
  if (!condition) return;
  const timeout = condition.timeoutMs ?? config.actionTimeoutMs;
  if (condition.urlContains) {
    await page.waitForURL(url => url.toString().includes(condition.urlContains!), { timeout });
  }
  if (condition.textContains) {
    await page.getByText(condition.textContains, { exact: false }).first().waitFor({ state: 'visible', timeout });
  }
  if (condition.selectorVisible) {
    await page.locator(condition.selectorVisible).first().waitFor({ state: 'visible', timeout });
  }
}

server.registerTool(
  'browser_status',
  {
    description: 'Return browser health, current page, timeouts, profile lock and operation-ledger locations.',
    inputSchema: z.object({})
  },
  async () => textResult(await browser.status())
);

server.registerTool(
  'browser_health_check',
  {
    description: 'Run a non-mutating browser round-trip and report latency. Safe to call repeatedly.',
    inputSchema: z.object({})
  },
  async () => {
    const started = Date.now();
    const outcome = await browser.run({ tool: 'browser_health_check', safeToRetry: true }, async ({ page }) => ({
      url: page.url(),
      title: await page.title(),
      readyState: await page.evaluate(() => document.readyState),
      latencyMs: Date.now() - started
    }));
    return outcomeResult(outcome);
  }
);

server.registerTool(
  'browser_open',
  {
    description: 'Navigate the active page to a URL. Navigation is treated as retry-safe.',
    inputSchema: z.object({
      url: z.string().url(),
      waitUntil: z.enum(['commit', 'domcontentloaded', 'load', 'networkidle']).optional()
    })
  },
  async ({ url, waitUntil }) => {
    const outcome = await browser.run({ tool: 'browser_open', safeToRetry: true }, async ({ page }) => {
      const response = await page.goto(url, { waitUntil: waitUntil ?? 'domcontentloaded' });
      return { url: page.url(), title: await page.title(), status: response?.status() ?? null };
    });
    return outcomeResult(outcome);
  }
);

server.registerTool(
  'browser_snapshot',
  {
    description:
      'Read a chunked textual snapshot of the current page. Use offset/nextOffset to avoid oversized MCP transfers.',
    inputSchema: z.object({
      offset: z.number().int().min(0).optional(),
      maxChars: z.number().int().min(1_000).max(100_000).optional()
    })
  },
  async ({ offset, maxChars }) => {
    const limit = maxChars ?? config.snapshotMaxChars;
    const start = offset ?? 0;
    const outcome = await browser.run({ tool: 'browser_snapshot', safeToRetry: true }, async ({ page }) => {
      const data = await page.locator('body').innerText({ timeout: config.actionTimeoutMs });
      const end = Math.min(data.length, start + limit);
      return {
        url: page.url(),
        title: await page.title(),
        totalChars: data.length,
        offset: start,
        returnedChars: Math.max(0, end - start),
        nextOffset: end < data.length ? end : null,
        text: data.slice(start, end)
      };
    });
    return outcomeResult(outcome);
  }
);

server.registerTool(
  'browser_tabs',
  {
    description: 'List open browser tabs and indicate the active tab.',
    inputSchema: z.object({})
  },
  async () => {
    const outcome = await browser.run({ tool: 'browser_tabs', safeToRetry: true }, async ({ page }) => {
      const pages = browser.pages();
      return Promise.all(
        pages.map(async (p, index) => ({
          index,
          active: p === page,
          url: p.url(),
          title: await p.title().catch(() => null)
        }))
      );
    });
    return outcomeResult(outcome);
  }
);

server.registerTool(
  'browser_select_tab',
  {
    description: 'Select an existing tab by index without changing page content.',
    inputSchema: z.object({ index: z.number().int().min(0) })
  },
  async ({ index }) => {
    const pages = browser.pages();
    const page = pages[index];
    if (!page) return textResult({ status: 'failed', error: `No tab at index ${index}` }, true);
    browser.setActivePage(page);
    await page.bringToFront();
    return textResult({ status: 'succeeded', index, url: page.url(), title: await page.title().catch(() => null) });
  }
);

server.registerTool(
  'browser_click',
  {
    description:
      'Click a locator. Mutating clicks are never blindly replayed after a timeout/disconnect. Supply operationKey for duplicate protection.',
    inputSchema: z.object({
      ...locatorFields,
      ...mutationFields,
      timeoutMs: z.number().int().min(500).max(120_000).optional(),
      postcondition: postconditionSchema
    })
  },
  async ({ selector, by, name, exact, operationKey, force, timeoutMs, postcondition }) => {
    const outcome = await browser.run(
      { tool: 'browser_click', operationKey, force, safeToRetry: false },
      async ({ page, markSideEffectStarted }) => {
        const locator = resolveLocator(page, { selector, by, name, exact }).first();
        await locator.waitFor({ state: 'visible', timeout: timeoutMs ?? config.actionTimeoutMs });
        markSideEffectStarted();
        await locator.click({ timeout: timeoutMs ?? config.actionTimeoutMs });
        await verifyPostcondition(page, postcondition);
        return { ok: true, url: page.url(), selector, by: by ?? 'css' };
      }
    );
    return outcomeResult(outcome);
  }
);

server.registerTool(
  'browser_type',
  {
    description:
      'Fill or append text. Plain replacement fill is retry-safe; append and pressEnter are treated as writes and are not replayed after uncertainty.',
    inputSchema: z.object({
      ...locatorFields,
      ...mutationFields,
      value: z.string(),
      append: z.boolean().optional(),
      pressEnter: z.boolean().optional(),
      timeoutMs: z.number().int().min(500).max(120_000).optional(),
      postcondition: postconditionSchema
    })
  },
  async ({ selector, by, name, exact, operationKey, force, value, append, pressEnter, timeoutMs, postcondition }) => {
    const unsafe = Boolean(append || pressEnter);
    const outcome = await browser.run(
      { tool: 'browser_type', operationKey, force, safeToRetry: !unsafe },
      async ({ page, markSideEffectStarted }) => {
        const locator = resolveLocator(page, { selector, by, name, exact }).first();
        await locator.waitFor({ state: 'visible', timeout: timeoutMs ?? config.actionTimeoutMs });
        if (unsafe) markSideEffectStarted();
        if (append) await locator.pressSequentially(value, { delay: 10 });
        else await locator.fill(value, { timeout: timeoutMs ?? config.actionTimeoutMs });
        if (pressEnter) await locator.press('Enter');
        await verifyPostcondition(page, postcondition);
        return { ok: true, url: page.url(), selector, chars: value.length, append: Boolean(append), pressEnter: Boolean(pressEnter) };
      }
    );
    return outcomeResult(outcome);
  }
);

server.registerTool(
  'browser_press',
  {
    description: 'Press a keyboard key. Supply operationKey for keys that can submit or mutate state.',
    inputSchema: z.object({
      key: z.string().min(1),
      ...mutationFields,
      postcondition: postconditionSchema
    })
  },
  async ({ key, operationKey, force, postcondition }) => {
    const outcome = await browser.run(
      { tool: 'browser_press', operationKey, force, safeToRetry: false },
      async ({ page, markSideEffectStarted }) => {
        markSideEffectStarted();
        await page.keyboard.press(key);
        await verifyPostcondition(page, postcondition);
        return { ok: true, key, url: page.url() };
      }
    );
    return outcomeResult(outcome);
  }
);

server.registerTool(
  'browser_upload',
  {
    description: 'Upload one or more local files via Playwright setInputFiles. Treated as a non-replayable write.',
    inputSchema: z.object({
      ...locatorFields,
      ...mutationFields,
      files: z.array(z.string().min(1)).min(1),
      postcondition: postconditionSchema
    })
  },
  async ({ selector, by, name, exact, operationKey, force, files, postcondition }) => {
    const outcome = await browser.run(
      { tool: 'browser_upload', operationKey, force, safeToRetry: false },
      async ({ page, markSideEffectStarted }) => {
        const locator = resolveLocator(page, { selector, by, name, exact }).first();
        await locator.waitFor({ state: 'attached', timeout: config.actionTimeoutMs });
        markSideEffectStarted();
        await locator.setInputFiles(files);
        await verifyPostcondition(page, postcondition);
        return { ok: true, files, selector, url: page.url() };
      }
    );
    return outcomeResult(outcome);
  }
);

server.registerTool(
  'browser_wait_for',
  {
    description: 'Wait for a non-mutating page condition.',
    inputSchema: z.object({
      urlContains: z.string().optional(),
      textContains: z.string().optional(),
      selectorVisible: z.string().optional(),
      timeoutMs: z.number().int().min(500).max(120_000).optional()
    })
  },
  async input => {
    const outcome = await browser.run({ tool: 'browser_wait_for', safeToRetry: true }, async ({ page }) => {
      await verifyPostcondition(page, input);
      return { ok: true, url: page.url(), title: await page.title() };
    });
    return outcomeResult(outcome);
  }
);

server.registerTool(
  'browser_evaluate',
  {
    description:
      'Run JavaScript in the page. This can mutate state, so it is never auto-replayed after uncertainty. Prefer dedicated tools when possible.',
    inputSchema: z.object({
      expression: z.string().min(1),
      ...mutationFields
    })
  },
  async ({ expression, operationKey, force }) => {
    const outcome = await browser.run(
      { tool: 'browser_evaluate', operationKey, force, safeToRetry: false },
      async ({ page, markSideEffectStarted }) => {
        markSideEffectStarted();
        const result = await page.evaluate(expression => {
          return (0, eval)(expression);
        }, expression);
        return { result, url: page.url() };
      }
    );
    return outcomeResult(outcome);
  }
);

server.registerTool(
  'browser_screenshot',
  {
    description: 'Save a screenshot locally and return the path.',
    inputSchema: z.object({ fullPage: z.boolean().optional() })
  },
  async ({ fullPage }) => {
    const outcome = await browser.run({ tool: 'browser_screenshot', safeToRetry: true }, async ({ page }) => {
      const dir = path.resolve('.stable-browser/screenshots');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${Date.now()}.png`);
      await page.screenshot({ path: file, fullPage: Boolean(fullPage) });
      return { ok: true, path: file, url: page.url() };
    });
    return outcomeResult(outcome);
  }
);

server.registerTool(
  'browser_reset',
  {
    description:
      'Force-close and relaunch the persistent browser context. Do not use this to resolve an uncertain write until the page/platform state has been verified.',
    inputSchema: z.object({})
  },
  async () => {
    await browser.reset();
    return textResult({ ok: true, ...(await browser.status()) });
  }
);

server.registerTool(
  'browser_operations',
  {
    description: 'Read recent operation-ledger records, including succeeded/failed/uncertain writes.',
    inputSchema: z.object({ limit: z.number().int().min(1).max(500).optional() })
  },
  async ({ limit }) => textResult({ records: browser.recentOperations(limit ?? 50) })
);

server.registerTool(
  'browser_logs',
  {
    description: 'Read the latest JSONL diagnostic log lines.',
    inputSchema: z.object({ lines: z.number().int().min(1).max(500).optional() })
  },
  async ({ lines }) => {
    const file = getLogPath();
    const n = lines ?? 50;
    if (!fs.existsSync(file)) return textResult({ path: file, lines: [] });
    const rows = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean).slice(-n);
    return textResult({ path: file, lines: rows });
  }
);

async function shutdown(signal: string) {
  log('info', 'mcp.shutdown', { signal });
  await browser.shutdown().catch(() => undefined);
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('exit', () => {
  // Best-effort lock cleanup for normal exits; async browser close is handled above.
});

async function main() {
  log('info', 'mcp.start', {
    version: '0.2.0',
    userDataDir: config.userDataDir,
    actionTimeoutMs: config.actionTimeoutMs,
    navTimeoutMs: config.navTimeoutMs,
    maxRetries: config.maxRetries,
    snapshotMaxChars: config.snapshotMaxChars
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(async error => {
  log('error', 'mcp.fatal', { message: error instanceof Error ? error.stack || error.message : String(error) });
  await browser.shutdown().catch(() => undefined);
  process.exit(1);
});
