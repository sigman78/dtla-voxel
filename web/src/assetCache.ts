// Only content-addressed files may bypass freshness checks. Legacy/dev URLs stay mutable.
export const immutableAsset = (url: string) => /\/immutable\/[a-f0-9]{32}\.bin(?:[?#]|$)/.test(url);

export function fetchAsset(url: string, signal?: AbortSignal) {
  return fetch(url, { signal, cache: immutableAsset(url) ? 'force-cache' : 'default' });
}
