# Stable Browser MCP

A reliability layer for **Chrome + Playwright + MCP** built around one rule: **a timeout is not proof that a browser write failed**.

This MVP distills patterns repeatedly learned in real browser-automation pipelines: persistent logged-in sessions, safe retries for reads, conservative handling of writes, operation receipts, recovery after CDP/browser disconnects, chunked page snapshots, profile locking, and evidence capture when the final state is uncertain.

## Why it exists

Raw Playwright is capable. The expensive part is everything around it when an agent runs for hours:

- CDP/browser sessions close in the middle of a step.
- A click may succeed on the website while the tool call times out.
- Blind retries can publish, submit, pay, or send twice.
- Trackers can report failure after the website has already accepted an action.
- Multiple agents can fight over one Chrome profile.
- Huge page snapshots waste context and can break transport limits.

Stable Browser MCP does **not** replace Playwright. It adds a stateful reliability layer around it.

## Reliability rules in v0.2

1. **Reads and navigation may retry.**
2. **Writes do not blindly retry after the side effect starts.** A timeout/disconnect becomes `uncertain`.
3. **`operationKey` prevents duplicate replay.** A previously `succeeded` or `uncertain` operation is returned from the ledger instead of being executed again unless `force=true`.
4. **Uncertain writes capture evidence**: URL, title, page count and a bounded body-text sample/hash.
5. **Browser recovery is selective.** Transport-closed errors may relaunch Chrome; ordinary locator failures do not.
6. **Persistent profile + lock file** keeps sessions logged in and prevents two server processes from owning the same profile.
7. **Snapshots are chunked** with `offset` / `nextOffset` rather than forcing one giant MCP response.
8. **Postconditions are first-class** for click/type/press/upload so an agent can verify the expected page state without replaying the write.

## Requirements

- Windows 10/11, macOS, or Linux
- Node.js 22+
- Google Chrome installed

## Install

```powershell
npm install
npm run build
```

## Run on Windows

```powershell
$env:BROWSER_USER_DATA_DIR="$env:USERPROFILE\stable-browser-profile"
npm start
```

The first launch opens a persistent Chrome profile. Log into the sites you need once; later runs reuse that profile.

Do not point two running Stable Browser MCP processes at the same `BROWSER_USER_DATA_DIR`.

## MCP client config

```json
{
  "mcpServers": {
    "stable-browser": {
      "command": "node",
      "args": ["C:\\path\\to\\stable-browser-mcp\\dist\\src\\server.js"],
      "env": {
        "BROWSER_USER_DATA_DIR": "C:\\Users\\YOUR_NAME\\stable-browser-profile",
        "BROWSER_ACTION_TIMEOUT_MS": "20000",
        "BROWSER_NAV_TIMEOUT_MS": "45000",
        "BROWSER_MAX_RETRIES": "2",
        "BROWSER_SNAPSHOT_MAX_CHARS": "20000"
      }
    }
  }
}
```

## Tools

Read/safe tools:

- `browser_status`
- `browser_health_check`
- `browser_open`
- `browser_snapshot`
- `browser_tabs`
- `browser_select_tab`
- `browser_wait_for`
- `browser_screenshot`
- `browser_operations`
- `browser_logs`

Write tools:

- `browser_click`
- `browser_type`
- `browser_press`
- `browser_upload`
- `browser_evaluate`
- `browser_reset`

## The important write pattern

For anything that could cause a duplicate external action, provide an `operationKey` and a postcondition.

Example conceptually:

```json
{
  "selector": "发布",
  "by": "role",
  "name": "发布",
  "operationKey": "publish:article-20260909",
  "postcondition": {
    "textContains": "审核中",
    "timeoutMs": 15000
  }
}
```

If the click is dispatched but the browser connection dies before confirmation, the operation becomes `uncertain`. Calling the same operation key again does not click twice. The agent must inspect the website state first, then decide whether to use `force=true`.

## Snapshot transfer size

`browser_snapshot` defaults to `BROWSER_SNAPSHOT_MAX_CHARS` (20,000 characters here) and returns:

- `totalChars`
- `offset`
- `returnedChars`
- `nextOffset`

That makes transfer size explicit and testable instead of silently dumping an entire dashboard into model context.

## What comes next

The next product layer should be built from real failure history rather than more generic browser features:

- phase/checkpoint replay instead of whole-workflow replay
- website-specific acceptance receipts
- selector fallback registry learned from successful runs
- automatic success/false-negative classification
- run-level success rate and failure clustering
- replay simulator and regression suite against saved traces

The aim is not “another browser MCP.” The product is **reliability memory for long-running browser agents**.
