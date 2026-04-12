import { buildAuthHeaders, resolveAuthProvider, type Transport } from "@chats2md/sync-core";

import type { RequestLikeFn } from "./request-core";

let transportLoader: Promise<Transport> | null = null;

export function createObsidianTransport(requestUrl: RequestLikeFn): Transport {
  return async (request) => {
    const auth = await resolveAuthProvider(request.auth, {
      url: request.url,
      method: request.method,
      headers: { ...(request.headers ?? {}) },
      metadata: request.metadata,
    });

    return requestUrl({
      url: request.url,
      method: request.method,
      headers: buildAuthHeaders(request.headers ?? {}, auth),
      throw: false,
    });
  };
}

export async function loadObsidianTransport(): Promise<Transport> {
  if (!transportLoader) {
    transportLoader = import("./request-url-runtime").then((module) => {
      try {
        if (typeof module.default !== "function") {
          throw new Error("obsidian.requestUrl is unavailable.");
        }

        return createObsidianTransport(module.default as RequestLikeFn);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to load Obsidian requestUrl transport: ${message}`);
      }
    });
  }

  return transportLoader;
}
