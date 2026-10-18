/* Utility functions for API calls */
import { useApiMetricsStore } from "@/store/apiMetricsStore";
import {
  IdempotencyStore,
  IdempotentRunResult,
  createIdempotencyKey,
  executeIdempotent,
  fingerprintRequest,
} from "@/lib/idempotency";
import {
  CacheOptions,
  clearCachedValues,
  getOrFetchCachedValue,
  subscribeToCachedValue,
} from "@/lib/cache-manager";
import { ApiError, RetryScheduler, type RetryPolicy } from "@/lib/retry";
import {
  CSRF_HEADER_NAME,
  ensureCsrfToken,
  getClientCsrfToken,
  isCsrfProtectedMethod,
  isValidCsrfTokenFormat,
  verifyCsrfToken,
} from "@/lib/security/csrf";

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
const REQUEST_CACHE_TTL_MS = 60_000;

function normalizeHeaders(headers?: HeadersInit): Record<string, string> {
  if (!headers) return {};
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    const record: Record<string, string> = {};
    headers.forEach((value, key) => {
      record[key] = value;
    });
    return record;
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }
  return { ...(headers as Record<string, string>) };
}

function findHeaderKey(headers: Record<string, string>, target: string): string | undefined {
  const lower = target.toLowerCase();
  return Object.keys(headers).find((key) => key.toLowerCase() === lower);
}

/**
 * Reads an error body without letting a malformed payload mask the HTTP status.
 *
 * A 503 with an HTML error page is still a retryable 503, so a JSON parse failure
 * must not turn into the thrown error.
 */
async function readErrorBody(response: Response): Promise<unknown> {
  try {
    const text = await response.text();
    if (!text) return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text.slice(0, 500);
    }
  } catch {
    return undefined;
  }
}

const makeCacheKey = (endpoint: string, options: RequestInit) =>
  JSON.stringify({
    endpoint,
    method: (options.method || "GET").toUpperCase(),
    body: typeof options.body === "string" ? options.body : null,
  });

export function subscribeToApiResponse<T>(endpoint: string, listener: (value: T) => void): () => void {
  const cacheKey = `api:${makeCacheKey(endpoint, { method: 'GET' })}`;
  return subscribeToCachedValue(cacheKey, listener);
}

const reportRequest = (payload: { cacheHit: boolean; networkRequest: boolean; batched: boolean }) => {
  useApiMetricsStore.getState().recordRequest(payload);
};

export interface ApiCallRetryOptions {
  /** Merged over the `http_request` defaults. Pass `{ maxRetries: 0 }` to disable. */
  policy?: Partial<RetryPolicy> & { retryable?: boolean };
  /**
   * Whether to run the request through the retry scheduler. Defaults to true for
   * GET and false for everything else, because replaying a non-idempotent write
   * risks a duplicate side effect. `postIdempotent` opts in explicitly.
   */
  retry?: boolean;
}

export async function apiCall(
  endpoint: string,
  options: RequestInit = {},
  cacheOptions: CacheOptions = {},
  retryOptions: ApiCallRetryOptions = {},
) {
  const method = (options.method || "GET").toUpperCase();

  const url = `${API_URL}${endpoint}`;
  const fetchData = async () => {
    const callerHeaders = normalizeHeaders(options.headers);
    const csrfKey = findHeaderKey(callerHeaders, CSRF_HEADER_NAME);

    if (isCsrfProtectedMethod(method)) {
      if (csrfKey !== undefined) {
        const providedToken = callerHeaders[csrfKey];
        const cookieToken = getClientCsrfToken();
        const effectiveCookie =
          cookieToken ?? (isValidCsrfTokenFormat(providedToken) ? providedToken : null);
        const validation = verifyCsrfToken(providedToken, effectiveCookie);
        if (!validation.valid) {
          throw new ApiError(
            `API error 403: ${validation.message || 'Forbidden'}`,
            {
              status: 403,
              statusText: 'Forbidden',
              body: { error: validation.message, code: validation.reason },
              url,
            },
          );
        }
        if (csrfKey !== CSRF_HEADER_NAME) {
          delete callerHeaders[csrfKey];
        }
        callerHeaders[CSRF_HEADER_NAME] = providedToken;
      } else {
        callerHeaders[CSRF_HEADER_NAME] = ensureCsrfToken();
      }
    }

    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...callerHeaders,
      },
    });

    if (!response.ok) {
      // Carry the status and body so `classifyError` can separate a retryable
      // 503 from a permanent 422. A plain `Error` here made both look identical.
      throw new ApiError(
        `API error ${response.status}: ${response.statusText || 'request failed'}`,
        {
          status: response.status,
          statusText: response.statusText,
          body: await readErrorBody(response),
          url,
        },
      );
    }

    const data = await response.json();
    reportRequest({ cacheHit: false, networkRequest: true, batched: false });
    return data;
  };

  // GET is safe to replay. Writes default to no retry so this stays
  // backward-compatible for every existing call site.
  const shouldRetry = retryOptions.retry ?? method === "GET";
  const run = () => fetchData();

  if (method !== "GET") {
    if (!shouldRetry) return run();
    return new RetryScheduler().execute(run, {
      operationClass: 'http_request',
      operationId: `${method} ${endpoint}`,
      policy: retryOptions.policy,
      context: { endpoint, method },
    });
  }

  const execute = (fetcher: () => Promise<unknown>) => {
    if (!shouldRetry) return fetcher();
    return new RetryScheduler().execute(fetcher, {
      operationClass: 'http_request',
      operationId: `GET ${endpoint}`,
      policy: retryOptions.policy,
      context: { endpoint, method },
    });
  };

  const cacheKey = `api:${makeCacheKey(endpoint, options)}`;
  return getOrFetchCachedValue(cacheKey, () => execute(run), {
    staleTime: cacheOptions.staleTime ?? REQUEST_CACHE_TTL_MS,
    cacheTime: cacheOptions.cacheTime ?? REQUEST_CACHE_TTL_MS * 5,
    onCacheHit: () => reportRequest({ cacheHit: true, networkRequest: false, batched: false }),
  });
}

export interface IdempotentPostOptions {
  /**
   * Explicit key. Omit it and one is derived from the endpoint and payload, so
   * a repeated attempt at the same request reuses the same key with no caller
   * bookkeeping. Pass a key when "the same body" is a new intent — see
   * `beginIdempotentAttempt` for that case.
   */
  key?: string;
  /** How long a stored outcome may be replayed (default 24h). */
  ttlMs?: number;
  store?: IdempotencyStore;
  /** Groups derived keys; defaults to the endpoint. */
  scope?: string;
}

export const apiClient = {
  get: (endpoint: string, cacheOptions?: CacheOptions) => apiCall(endpoint, { method: 'GET' }, cacheOptions),
  subscribe: subscribeToApiResponse,
  post: (endpoint: string, data: any) =>
    apiCall(endpoint, { method: 'POST', body: JSON.stringify(data) }),
  put: (endpoint: string, data: any) =>
    apiCall(endpoint, { method: 'PUT', body: JSON.stringify(data) }),
  delete: (endpoint: string) => apiCall(endpoint, { method: 'DELETE' }),

  /**
   * POST an operation that must not be applied twice (payments, claims,
   * payouts). Sends the key as `Idempotency-Key` so the server can recognise
   * the retry, and returns whether the result was replayed from a stored
   * outcome instead of a second request reaching the network.
   *
   * Network retries are enabled here because the idempotency key makes a repeat
   * safe — a replayed request returns the stored outcome rather than performing
   * the side effect twice. `post` deliberately does not do this.
   */
  postIdempotent: async <T = unknown>(
    endpoint: string,
    data: unknown,
    options: IdempotentPostOptions = {},
  ): Promise<IdempotentRunResult<T>> => {
    const body = JSON.stringify(data);
    const fingerprint = fingerprintRequest({ endpoint, method: 'POST', body });
    const key =
      options.key ?? (await createIdempotencyKey(options.scope ?? endpoint, { endpoint, data }));

    return executeIdempotent<T>(
      { key, fingerprint, ttlMs: options.ttlMs, store: options.store },
      () =>
        apiCall(
          endpoint,
          {
            method: 'POST',
            body,
            headers: { 'Idempotency-Key': key },
          },
          {},
          { retry: true },
        ) as Promise<T>,
    );
  },

  batchGet: async (endpoints: string[]) => {
    const uniqueEndpoints = Array.from(new Set(endpoints));
    const requests = uniqueEndpoints.map((endpoint) => apiClient.get(endpoint));
    const responses = await Promise.all(requests);
    uniqueEndpoints.forEach(() =>
      reportRequest({ cacheHit: false, networkRequest: false, batched: true })
    );
    return responses;
  },
  clearCache: () => clearCachedValues('api:'),
};
