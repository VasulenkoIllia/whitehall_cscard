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
    throw new Error(message);
  }
  return json;
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
