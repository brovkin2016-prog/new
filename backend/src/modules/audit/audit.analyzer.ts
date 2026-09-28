import * as cheerio from 'cheerio';

export interface PageMeta {
  title?: string;
  description?: string;
  headings: Record<string, string[]>;
  links: string[];
  issues: string[];
}

const TITLE_MIN = 10;
const TITLE_MAX = 70;
const DESC_MIN = 50;
const DESC_MAX = 160;

/** Извлекает meta/H1–H6/ссылки и выявляет типовые SEO-проблемы страницы. */
export function analyzeHtml(html: string): PageMeta {
  const $ = cheerio.load(html);
  const title = $('head > title').first().text().trim() || undefined;
  const description = $('meta[name="description"]').attr('content')?.trim() || undefined;

  const headings: Record<string, string[]> = {};
  for (const tag of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']) {
    headings[tag] = $(tag)
      .map((_, el) => $(el).text().trim())
      .get()
      .filter(Boolean);
  }

  const links = $('a[href]')
    .map((_, el) => $(el).attr('href') as string)
    .get()
    .filter(Boolean);

  const issues: string[] = [];
  if (!title) issues.push('title_missing');
  else if (title.length < TITLE_MIN) issues.push('title_too_short');
  else if (title.length > TITLE_MAX) issues.push('title_too_long');

  if (!description) issues.push('description_missing');
  else if (description.length < DESC_MIN) issues.push('description_too_short');
  else if (description.length > DESC_MAX) issues.push('description_too_long');

  if (headings.h1.length === 0) issues.push('h1_missing');
  else if (headings.h1.length > 1) issues.push('h1_multiple');

  if ($('meta[name="robots"]').attr('content')?.includes('noindex')) issues.push('noindex');
  if (!$('link[rel="canonical"]').attr('href')) issues.push('canonical_missing');

  return { title, description, headings, links, issues };
}
