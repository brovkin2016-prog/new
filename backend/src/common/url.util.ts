/** Нормализация домена: убирает схему, www, путь, регистр. */
export function normalizeDomain(input: string): string {
  let s = input.trim().toLowerCase();
  s = s.replace(/^https?:\/\//, '');
  s = s.replace(/^www\./, '');
  s = s.split('/')[0];
  return s;
}

export function hostOf(url: string): string {
  try {
    return normalizeDomain(new URL(url).host);
  } catch {
    return normalizeDomain(url);
  }
}

/** Совпадает ли URL с целевым доменом (включая поддомены при needSub). */
export function matchesDomain(url: string, domain: string, includeSubdomains = true): boolean {
  const h = hostOf(url);
  const d = normalizeDomain(domain);
  return includeSubdomains ? h === d || h.endsWith('.' + d) : h === d;
}

/** Абсолютный URL из base + href, либо null если невалиден/не http(s). */
export function resolveUrl(base: string, href: string): string | null {
  try {
    const u = new URL(href, base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}
