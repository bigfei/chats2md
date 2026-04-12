import { buildAuthHeaders, resolveAuthProvider, type AuthProvider } from "./auth";

export interface TransportRequest {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: BodyInit | null;
  signal?: AbortSignal;
  auth?: AuthProvider;
  metadata?: Record<string, unknown>;
}

export interface TransportResponse {
  status: number;
  headers: Record<string, string>;
  arrayBuffer: ArrayBuffer;
  json: unknown;
  text: string;
}

export type Transport = (request: TransportRequest) => Promise<TransportResponse>;

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function headersToObject(headers: Headers): Record<string, string> {
  const normalized: Record<string, string> = {};

  headers.forEach((value, key) => {
    normalized[key] = value;
  });

  return normalized;
}

function decodeText(arrayBuffer: ArrayBuffer): string {
  try {
    return new TextDecoder().decode(new Uint8Array(arrayBuffer));
  } catch {
    return "";
  }
}

function parseJson(text: string): unknown {
  if (text.trim().length === 0) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function createFetchTransport(fetchLike: FetchLike = globalThis.fetch.bind(globalThis)): Transport {
  return async (request) => {
    const auth = await resolveAuthProvider(request.auth, {
      url: request.url,
      method: request.method,
      headers: { ...(request.headers ?? {}) },
      metadata: request.metadata,
    });

    const headers = buildAuthHeaders(request.headers ?? {}, auth);
    const response = await fetchLike(request.url, {
      method: request.method,
      headers,
      body: request.body ?? undefined,
      signal: request.signal,
    });
    const arrayBuffer = await response.arrayBuffer();
    const text = decodeText(arrayBuffer);

    return {
      status: response.status,
      headers: headersToObject(response.headers),
      arrayBuffer,
      text,
      json: parseJson(text),
    };
  };
}
