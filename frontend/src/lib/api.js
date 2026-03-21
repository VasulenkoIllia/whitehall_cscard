export const API_BASE = '/admin/api';

async function readJsonSafe(response) {
  try {
    return await response.json();
  } catch (_error) {
    return null;
  }
}

export async function apiFetch(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    },
    ...options
  });

  const json = await readJsonSafe(response);
  if (!response.ok) {
    const message = json?.error || `${response.status} ${response.statusText}`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return json;
}

export function isRetryableApiError(error) {
  if (!error) {
    return false;
  }
  const status = Number(error.status);
  if (Number.isFinite(status)) {
    return status === 408 || status === 429 || status >= 500;
  }
  const message = String(error.message || error).toLowerCase();
  if (!message) {
    return false;
  }
  return (
    message.includes('failed to fetch') ||
    message.includes('network') ||
    message.includes('timeout') ||
    message.includes('temporarily unavailable')
  );
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function apiFetchWithRetry(path, options = {}, retryOptions = {}) {
  const retries = Number.isFinite(Number(retryOptions.retries))
    ? Math.max(0, Math.trunc(Number(retryOptions.retries)))
    : 1;
  const delayMs = Number.isFinite(Number(retryOptions.delayMs))
    ? Math.max(0, Math.trunc(Number(retryOptions.delayMs)))
    : 700;
  const backoffMultiplier = Number.isFinite(Number(retryOptions.backoffMultiplier))
    ? Math.max(1, Number(retryOptions.backoffMultiplier))
    : 1.8;

  let attempt = 0;
  let currentDelay = delayMs;
  while (attempt <= retries) {
    try {
      return await apiFetch(path, options);
    } catch (error) {
      if (attempt >= retries || !isRetryableApiError(error)) {
        throw error;
      }
      await sleep(currentDelay);
      currentDelay = Math.trunc(currentDelay * backoffMultiplier);
    }
    attempt += 1;
  }
  throw new Error('api_retry_exhausted');
}

export function formatError(error) {
  if (!error) {
    return '';
  }
  return error instanceof Error ? error.message : String(error);
}

export function toJsonString(value) {
  return JSON.stringify(value, null, 2);
}
