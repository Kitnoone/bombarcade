// getRandomValues is available on local HTTP, unlike randomUUID.
export function randomToken(bytes = 24) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
}
export function sessionValue(key, create = randomToken) {
  try {
    const value = sessionStorage.getItem(key) || create();
    sessionStorage.setItem(key, value);
    return value;
  } catch { return create(); }
}
