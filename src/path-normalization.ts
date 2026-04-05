type NormalizePathFn = (path: string) => string;

let normalizePathImpl: NormalizePathFn | null = null;

export function configureNormalizePath(impl: NormalizePathFn): void {
  normalizePathImpl = impl;
}

function fallbackNormalizePath(path: string): string {
  return path
    .replace(/[\\/]+/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/^\.\/+/, "")
    .replace(/\u00A0/g, " ")
    .normalize();
}

export function normalizeObsidianPath(path: string): string {
  const trimmed = path.trim();

  if (!trimmed) {
    return "";
  }

  if (normalizePathImpl) {
    return normalizePathImpl(trimmed);
  }

  return fallbackNormalizePath(trimmed);
}
