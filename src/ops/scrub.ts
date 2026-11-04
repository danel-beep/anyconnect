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
  // Email addresses.
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[email]'],
  // Long opaque strings (keys, hashes, base64 blobs).
  [/\b[A-Za-z0-9+_-]{40,}={0,2}/g, '[secret]'],
];

export function scrubSecrets(text: string, maxLength = 2000): string {
  let out = text;
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);
  return out.length > maxLength ? `${out.slice(0, maxLength)}…` : out;
}
