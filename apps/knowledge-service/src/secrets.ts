// Secret scan for knowledge ingest. Strong patterns only (assignment of
// credential-shaped values, private-key blocks, bearer tokens) — ordinary
// prose mentioning vendors is NOT a secret. Matches reject the proposal;
// logging/export paths redact via observability.redact.

// eslint-disable-next-line no-control-regex
const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA )?PRIVATE KEY-----/,
  /(api[_-]?key|api[_-]?secret|access[_-]?token|auth[_-]?token|password|passwd|client[_-]?secret)\s*[:=]\s*\S+/i,
  /\bbearer\s+[A-Za-z0-9\-._~+/=]{8,}/i,
  /\b(xox[bpas]-[A-Za-z0-9-]+|sk-(live|test)-[A-Za-z0-9]+|ghp_[A-Za-z0-9]+)\b/
];

export function isSecretString(s: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(s));
}

export function containsSecretPayload(value: unknown): boolean {
  if (typeof value === 'string') return isSecretString(value);
  if (Array.isArray(value)) return value.some(containsSecretPayload);
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(containsSecretPayload);
  }
  return false;
}
