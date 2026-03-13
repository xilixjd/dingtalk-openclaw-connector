const monitorState = new Map<string, { running: boolean; abortController?: AbortController }>();

export function setDingtalkMonitorState(accountId: string, state: { running: boolean; abortController?: AbortController }): void {
  monitorState.set(accountId, state);
}

export function getDingtalkMonitorState(accountId: string): { running: boolean; abortController?: AbortController } | undefined {
  return monitorState.get(accountId);
}

export function stopDingtalkMonitorState(accountId?: string): void {
  if (accountId) {
    const state = monitorState.get(accountId);
    if (state?.abortController) {
      state.abortController.abort();
    }
    monitorState.delete(accountId);
  } else {
    // Stop all monitors
    for (const [id, state] of monitorState.entries()) {
      if (state.abortController) {
        state.abortController.abort();
      }
    }
    monitorState.clear();
  }
}

// Test utilities
export function clearDingtalkWebhookRateLimitStateForTest(): void {
  // DingTalk doesn't use webhook rate limiting
}

export function getDingtalkWebhookRateLimitStateSizeForTest(): number {
  return 0;
}

export function isWebhookRateLimitedForTest(): boolean {
  return false;
}
