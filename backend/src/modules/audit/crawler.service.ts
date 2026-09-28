import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import robotsParser from 'robots-parser';
import { analyzeHtml } from './audit.analyzer';
import { resolveUrl, matchesDomain } from '../../common/url.util';
import { sleep } from '../../common/http.util';

export interface CrawledPage {
  url: string;
  statusCode: number;
  responseMs: number;
  title?: string;
  description?: string;
  headings: Record<string, string[]>;
  issues: string[];
  depth: number;
}

export interface BrokenLinkRec {
  fromUrl: string;
  toUrl: string;
  statusCode: number;
}

export interface CrawlResult {
  pages: CrawledPage[];
  brokenLinks: BrokenLinkRec[];
  technical: string[]; // robots/sitemap/дубли и пр.
}

export interface CrawlOptions {
  maxPages?: number;
  maxDepth?: number;
  delayMs?: number;
  checkExternal?: boolean;
}

@Injectable()
export class CrawlerService {
  private readonly log = new Logger(CrawlerService.name);
  constructor(private readonly cfg: ConfigService) {}

  private get ua(): string {
    return this.cfg.get<string>('crawler.userAgent')!;
  }

  private headers() {
    // Идентифицируемый UA + маркер → легко отфильтровать в Метрике.
    return { 'User-Agent': this.ua, 'X-PF-Audit': '1', Accept: 'text/html' };
  }

  /** Гибкий, «вежливый» краул своего сайта с лимитами. */
  async crawl(
    domain: string,
    startUrl: string,
    opts: CrawlOptions,
    isStopping: () => boolean,
  ): Promise<CrawlResult> {
    const maxPages = opts.maxPages ?? this.cfg.get<number>('crawler.maxPages')!;
    const maxDepth = opts.maxDepth ?? this.cfg.get<number>('crawler.maxDepth')!;
    const delay = opts.delayMs ?? this.cfg.get<number>('crawler.delayMs')!;

    const robots = await this.loadRobots(domain);
    const technical = await this.technicalChecks(domain, robots.sitemaps);

    const visited = new Set<string>();
    const queue: { url: string; depth: number }[] = [{ url: startUrl, depth: 0 }];
    const pages: CrawledPage[] = [];
    const outLinks = new Map<string, string>(); // toUrl -> fromUrl (первое вхождение)
    const titles = new Map<string, string[]>(); // title -> urls (дубли)

    while (queue.length && pages.length < maxPages && !isStopping()) {
      const { url, depth } = queue.shift()!;
      if (visited.has(url)) continue;
      visited.add(url);

      if (robots.checker && robots.checker.isDisallowed(url, this.ua)) {
        continue; // соблюдаем robots.txt
      }

      const t0 = Date.now();
      let status = 0;
      let html = '';
      try {
        const res = await axios.get(url, {
          headers: this.headers(),
          timeout: 20000,
          maxRedirects: 5,
          validateStatus: () => true,
        });
        status = res.status;
        html = typeof res.data === 'string' ? res.data : '';
      } catch (e: any) {
        status = e?.response?.status ?? 0;
      }
      const responseMs = Date.now() - t0;

      const isHtml = html.startsWith('<') || html.includes('<html');
      const meta = isHtml ? analyzeHtml(html) : { headings: {}, issues: [], links: [], title: undefined, description: undefined };

      if (meta.title) {
        const list = titles.get(meta.title) ?? [];
        list.push(url);
        titles.set(meta.title, list);
      }

      pages.push({
        url,
        statusCode: status,
        responseMs,
        title: meta.title,
        description: meta.description,
        headings: meta.headings,
        issues: meta.issues,
        depth,
      });

      if (status >= 200 && status < 300 && isHtml && depth < maxDepth) {
        for (const href of meta.links) {
          const abs = resolveUrl(url, href);
          if (!abs) continue;
          if (!outLinks.has(abs)) outLinks.set(abs, url);
          if (matchesDomain(abs, domain) && !visited.has(abs)) {
            queue.push({ url: abs, depth: depth + 1 });
          }
        }
      }
      await sleep(delay);
    }

    // Дубли title
    for (const [title, urls] of titles) {
      if (urls.length > 1) technical.push(`duplicate_title: "${title}" (${urls.length})`);
    }

    const brokenLinks = await this.checkLinks(outLinks, domain, opts.checkExternal ?? false, delay, isStopping);
    return { pages, brokenLinks, technical };
  }

  /** Проверка ссылок на 4xx/5xx (мягко, с лимитом и задержкой). */
  private async checkLinks(
    links: Map<string, string>,
    domain: string,
    checkExternal: boolean,
    delay: number,
    isStopping: () => boolean,
  ): Promise<BrokenLinkRec[]> {
    const broken: BrokenLinkRec[] = [];
    const cap = 100; // без агрессивного сканирования
    let n = 0;
    for (const [toUrl, fromUrl] of links) {
      if (n >= cap || isStopping()) break;
      if (!checkExternal && !matchesDomain(toUrl, domain)) continue;
      n += 1;
      try {
        const res = await axios.head(toUrl, {
          headers: this.headers(),
          timeout: 10000,
          maxRedirects: 5,
          validateStatus: () => true,
        });
        if (res.status >= 400) broken.push({ fromUrl, toUrl, statusCode: res.status });
      } catch (e: any) {
        broken.push({ fromUrl, toUrl, statusCode: e?.response?.status ?? 0 });
      }
      await sleep(Math.min(delay, 500));
    }
    return broken;
  }

  private async loadRobots(domain: string) {
    const url = `https://${domain}/robots.txt`;
    try {
      const res = await axios.get(url, { headers: this.headers(), timeout: 10000, validateStatus: () => true });
      if (res.status === 200 && typeof res.data === 'string') {
        const checker = robotsParser(url, res.data);
        return { checker, sitemaps: checker.getSitemaps() ?? [] };
      }
    } catch {
      /* нет robots.txt — не блокируем */
    }
    return { checker: null as any, sitemaps: [] as string[] };
  }

  private async technicalChecks(domain: string, sitemaps: string[]): Promise<string[]> {
    const issues: string[] = [];
    // robots.txt
    try {
      const r = await axios.get(`https://${domain}/robots.txt`, {
        headers: this.headers(),
        timeout: 10000,
        validateStatus: () => true,
      });
      if (r.status !== 200) issues.push('robots_txt_missing');
    } catch {
      issues.push('robots_txt_unreachable');
    }
    // sitemap.xml
    const smCandidates = sitemaps.length ? sitemaps : [`https://${domain}/sitemap.xml`];
    let smOk = false;
    for (const sm of smCandidates) {
      try {
        const r = await axios.get(sm, { headers: this.headers(), timeout: 10000, validateStatus: () => true });
        if (r.status === 200) { smOk = true; break; }
      } catch { /* skip */ }
    }
    if (!smOk) issues.push('sitemap_missing');
    return issues;
  }
}
