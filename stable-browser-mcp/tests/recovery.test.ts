import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyFailure } from '../src/recovery.js';

test('transport disconnect is recoverable but ambiguous after a write', () => {
  const c = classifyFailure(new Error('Target page, context or browser has been closed'));
  assert.equal(c.kind, 'transport_closed');
  assert.equal(c.recoverBrowser, true);
  assert.equal(c.ambiguousAfterWrite, true);
});

test('timeout is not a reason to blindly reset the browser', () => {
  const c = classifyFailure(new Error('Timeout 20000ms exceeded'));
  assert.equal(c.kind, 'timeout');
  assert.equal(c.recoverBrowser, false);
  assert.equal(c.retrySafeRead, true);
});

test('locator failures are deterministic and should not relaunch Chrome', () => {
  const c = classifyFailure(new Error('locator("#publish"): element is not visible'));
  assert.equal(c.kind, 'locator');
  assert.equal(c.recoverBrowser, false);
  assert.equal(c.retrySafeRead, false);
});
