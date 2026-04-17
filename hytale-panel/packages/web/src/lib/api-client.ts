const API_BASE = '';

let csrfToken = '';

function extractStructuredError(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') {
    return undefined;
  }

  const record = body as { error?: unknown; data?: unknown };
  if (typeof record.error === 'string' && record.error.trim()) {
    return record.error;
  }

  if (
    record.data &&
    typeof record.data === 'object' &&
    'message' in record.data &&
    typeof (record.data as { message?: unknown }).message === 'string'
  ) {
    return ((record.data as { message: string }).message || '').trim() || undefined;
  }

  return undefined;
}

export function setCsrfToken(token: string) {
  csrfToken = token;
}

export async function apiRequest<T = unknown>(
  path: string,
  options: RequestInit = {}
): Promise<{ success: boolean; data?: T; error?: string }> {
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string>),
  };

  if (options.body !== undefined && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  if (csrfToken && options.method && options.method !== 'GET') {
    headers['X-CSRF-Token'] = csrfToken;
  }

  try {
    const res = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers,
      credentials: 'include',
    });

    const contentType = res.headers.get('content-type') || '';
    const rawBody = await res.text();
    const trimmedBody = rawBody.trim();
    const looksLikeJson =
      contentType.includes('application/json') ||
      trimmedBody.startsWith('{') ||
      trimmedBody.startsWith('[');

    if (!trimmedBody) {
      if (!res.ok) {
        return { success: false, error: `HTTP ${res.status}` };
      }

      return { success: false, error: 'Empty response from backend' };
    }

    if (!looksLikeJson) {
      console.error('Unexpected non-JSON API response', {
        path,
        status: res.status,
        contentType,
        bodyPreview: trimmedBody.slice(0, 200),
      });

      if (res.status >= 500) {
        return { success: false, error: 'Backend proxy failed' };
      }

      return { success: false, error: 'Unexpected non-JSON response from backend' };
    }

    let json: { success: boolean; data?: T; error?: string };
    try {
      json = JSON.parse(trimmedBody) as { success: boolean; data?: T; error?: string };
    } catch (error) {
      console.error('Failed to parse JSON API response', {
        path,
        status: res.status,
        contentType,
        bodyPreview: trimmedBody.slice(0, 200),
        error,
      });

      return { success: false, error: 'Unexpected non-JSON response from backend' };
    }

    if (!res.ok) {
      return { success: false, error: extractStructuredError(json) ?? `HTTP ${res.status}` };
    }

    return json;
  } catch (err) {
    console.error('API request failed', { path, error: err });
    return { success: false, error: 'Internal API is unreachable' };
  }
}

export async function apiGet<T = unknown>(path: string) {
  return apiRequest<T>(path, { method: 'GET' });
}

export async function apiPost<T = unknown>(path: string, body?: unknown) {
  return apiRequest<T>(path, {
    method: 'POST',
    body: JSON.stringify(body === undefined ? {} : body),
  });
}

export async function apiPut<T = unknown>(path: string, body?: unknown) {
  return apiRequest<T>(path, {
    method: 'PUT',
    body: JSON.stringify(body === undefined ? {} : body),
  });
}

export async function apiDelete<T = unknown>(path: string) {
  return apiRequest<T>(path, { method: 'DELETE' });
}
