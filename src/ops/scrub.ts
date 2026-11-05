/**
 * Removes things that look like secrets or personal data from free text before it is stored or
 * sent anywhere (error tracker, Sentry, job status). Error messages come from many libraries and
 * services, and some echo a header, a URL with a token or an email address; the hub never keeps
 * those. Conservative by design: a little over-redaction is fine, a leaked token is not.
 */
const RULES: Array<[RegExp, string]> = [
  // Authorization headers and bearer tokens.
  [/\b(bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]'],
  // key=value pairs whose key names a secret (query strings, form bodies, log-style text).
  [
    /\b([a-z0-9_-]*(?:token|secret|password|passwd|pwd|api[_-]?key|apikey|authorization|signature|session|cookie|credential)s?[a-z0-9_-]*)(["']?\s*[=:]\s*["']?)([^\s"'&,;}]+)/gi,
    '$1$2[redacted]',
  ],
  // OAuth authorization codes and signatures in query strings.
  [/([?&](?:code|sig|auth)=)[^\s&#]+/gi, '$1[redacted]'],
  // Credentials embedded in URLs: scheme://user:password@host
  [/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[redacted]@'],
  // Well-known token formats: JWTs, the hub's own tokens, provider keys.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[jwt]'],
  [/\bac_[a-z]{2,4}_[A-Za-z0-9_-]{8,}/g, '[token]'],
  [/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}/g, '[key]'],
  [/\b(?:xox[abposr]|ghp|gho|ghu|ghs|github_pat|glpat|ya29)[-_.][A-Za-z0-9_.-]{8,}/g, '[token]'],
  // Telegram bot tokens (also inside https://api.telegram.org/bot<token>/…) and Google API keys.
  [/(?<!\d)\d{6,12}:[A-Za-z0-9_-]{30,}/g, '[token]'],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, '[key]'],
  // Email addresses.
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[email]'],
  // Long opaque strings (keys, hashes, base64 blobs) and hex keys (32+ digits).
  [/\b[A-Za-z0-9+_-]{40,}={0,2}/g, '[secret]'],
  [/\b[0-9a-f]{32,}\b/gi, '[secret]'],
];

export function scrubSecrets(text: string, maxLength = 2000): string {
  let out = text;
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);
  return out.length > maxLength ? `${out.slice(0, maxLength)}…` : out;
}

/**
 * Error fields a log line may keep besides the type, message and stack: codes and names, never
 * values. Libraries hang much more on errors (request configs with headers, response bodies,
 * Postgres `detail` with row values), so everything else is left out.
 */
const SAFE_ERROR_FIELDS = ['code', 'kind', 'status', 'statusCode', 'errno', 'syscall', 'constraint'];

/**
 * The `err` serializer of the hub's logger: an error as a log line may show it, i.e. its type, the
 * scrubbed message and stack, the fields above and its causes. Every `logger.x({ err })` goes
 * through it, so no call site has to remember.
 */
export function scrubError(value: unknown, depth = 0): unknown {
  if (value === undefined || value === null) return value;
  if (typeof value === 'string') return scrubSecrets(value, 1000);
  if (!(value instanceof Error)) {
    let text: string;
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
    return scrubSecrets(text, 1000);
  }
  const out: Record<string, unknown> = {
    type: value.name || 'Error',
    message: scrubSecrets(value.message ?? '', 1000),
  };
  if (value.stack) out.stack = scrubSecrets(value.stack, 4000);
  const fields = value as unknown as Record<string, unknown>;
  for (const key of SAFE_ERROR_FIELDS) {
    const field = fields[key];
    if (typeof field === 'number' || typeof field === 'boolean') out[key] = field;
    else if (typeof field === 'string') out[key] = scrubSecrets(field, 200);
  }
  if (depth < 3) {
    if (value.cause !== undefined) out.cause = scrubError(value.cause, depth + 1);
    if (value instanceof AggregateError) {
      out.errors = value.errors.slice(0, 5).map((e) => scrubError(e, depth + 1));
    }
  }
  return out;
}
