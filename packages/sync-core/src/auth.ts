export interface ResolvedAuth {
  bearerToken?: string;
  headers?: Record<string, string>;
  cookie?: string;
}

export interface AuthProviderContext {
  url: string;
  method: string;
  headers: Record<string, string>;
  metadata?: Record<string, unknown>;
}

export type AuthProvider = ResolvedAuth | ((context: AuthProviderContext) => ResolvedAuth | Promise<ResolvedAuth>);

function mergeCookieHeader(existingCookie?: string, nextCookie?: string): string | undefined {
  const left = existingCookie?.trim() ?? "";
  const right = nextCookie?.trim() ?? "";

  if (!left) {
    return right || undefined;
  }

  if (!right || left === right) {
    return left;
  }

  return `${left}; ${right}`;
}

export function createStaticAuthProvider(auth: ResolvedAuth): AuthProvider {
  return auth;
}

export async function resolveAuthProvider(
  authProvider: AuthProvider | undefined,
  context: AuthProviderContext,
): Promise<ResolvedAuth | undefined> {
  if (!authProvider) {
    return undefined;
  }

  if (typeof authProvider === "function") {
    return await authProvider(context);
  }

  return authProvider;
}

export function buildAuthHeaders(baseHeaders: Record<string, string>, auth?: ResolvedAuth): Record<string, string> {
  const headers: Record<string, string> = {
    ...baseHeaders,
  };

  if (auth?.headers) {
    Object.assign(headers, auth.headers);
  }

  if (auth?.bearerToken) {
    headers.Authorization = `Bearer ${auth.bearerToken}`;
  }

  const mergedCookie = mergeCookieHeader(headers.Cookie, auth?.cookie);
  if (mergedCookie) {
    headers.Cookie = mergedCookie;
  }

  return headers;
}
