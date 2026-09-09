export type FailureKind =
  | 'timeout'
  | 'transport_closed'
  | 'locator'
  | 'profile_locked'
  | 'navigation'
  | 'unknown';

export type FailureClass = {
  kind: FailureKind;
  recoverBrowser: boolean;
  retrySafeRead: boolean;
  ambiguousAfterWrite: boolean;
};

function messageOf(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export function classifyFailure(error: unknown): FailureClass {
  const message = messageOf(error);

  if (/profile.*(in use|lock)|ProcessSingleton|user data directory.*already in use/i.test(message)) {
    return {
      kind: 'profile_locked',
      recoverBrowser: false,
      retrySafeRead: false,
      ambiguousAfterWrite: false
    };
  }

  if (
    /Target page, context or browser has been closed|Target closed|browser has been closed|page has been closed|context has been closed|Session closed|Connection closed|WebSocket.*closed|ECONNRESET|EPIPE|ERR_CONNECTION_CLOSED|Protocol error.*closed|Browser disconnected|CDP.*closed/i.test(
      message
    )
  ) {
    return {
      kind: 'transport_closed',
      recoverBrowser: true,
      retrySafeRead: true,
      ambiguousAfterWrite: true
    };
  }

  if (/TimeoutError|Timeout .* exceeded|timed out/i.test(message)) {
    return {
      kind: 'timeout',
      recoverBrowser: false,
      retrySafeRead: true,
      ambiguousAfterWrite: true
    };
  }

  if (
    /strict mode violation|not visible|not attached|not enabled|not editable|element.*not found|waiting for locator|locator\(/i.test(
      message
    )
  ) {
    return {
      kind: 'locator',
      recoverBrowser: false,
      retrySafeRead: false,
      ambiguousAfterWrite: false
    };
  }

  if (/net::ERR_|Navigation failed|frame was detached|interrupted by another navigation/i.test(message)) {
    return {
      kind: 'navigation',
      recoverBrowser: false,
      retrySafeRead: true,
      ambiguousAfterWrite: false
    };
  }

  return {
    kind: 'unknown',
    recoverBrowser: false,
    retrySafeRead: false,
    ambiguousAfterWrite: true
  };
}

export function errorMessage(error: unknown): string {
  return messageOf(error);
}
