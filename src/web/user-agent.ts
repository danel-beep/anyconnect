/** A browser as people name it ("Chrome · macOS"), from its User-Agent; null when there is none. */
export const agentName = (ua: string | null | undefined): string | null => {
  if (!ua) return null;
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Chrome\//.test(ua)
      ? 'Chrome'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'Browser';
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /Mac OS X/.test(ua)
      ? /iPhone|iPad/.test(ua)
        ? 'iOS'
        : 'macOS'
      : /Android/.test(ua)
        ? 'Android'
        : /Linux/.test(ua)
          ? 'Linux'
          : '';
  return os ? `${browser} · ${os}` : browser;
};
