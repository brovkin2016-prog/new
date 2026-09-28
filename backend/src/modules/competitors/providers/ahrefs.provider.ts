import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { requestWithRetry } from '../../../common/http.util';
import { CompetitorKeyword, CompetitorProvider, DomainVisibility } from './competitor-provider.interface';

/** Ahrefs API v3. Док.: https://docs.ahrefs.com/ */
@Injectable()
export class AhrefsProvider implements CompetitorProvider {
  readonly name = 'ahrefs';
  private readonly log = new Logger(AhrefsProvider.name);
  constructor(private readonly cfg: ConfigService) {}

  get enabled(): boolean {
    return Boolean(this.cfg.get('competitors.ahrefs'));
  }
  private get token() {
    return this.cfg.get<string>('competitors.ahrefs');
  }

  async domainKeywords(domain: string, _regionCode?: number, limit = 100): Promise<CompetitorKeyword[]> {
    if (!this.enabled) return [];
    try {
      const res = await requestWithRetry<any>({
        method: 'GET',
        url: 'https://api.ahrefs.com/v3/site-explorer/organic-keywords',
        headers: { Authorization: `Bearer ${this.token}` },
        params: { target: domain, country: 'ru', limit, select: 'keyword,best_position,url,volume' },
      });
      const rows = res.data?.keywords ?? res.data?.data ?? [];
      return rows.map((r: any) => ({ phrase: r.keyword, position: r.best_position, url: r.url, volume: r.volume }));
    } catch (e: any) {
      this.log.warn(`Ahrefs keywords ${domain}: ${e.message}`);
      return [];
    }
  }

  async domainVisibility(domain: string): Promise<DomainVisibility | null> {
    if (!this.enabled) return null;
    try {
      const res = await requestWithRetry<any>({
        method: 'GET',
        url: 'https://api.ahrefs.com/v3/site-explorer/metrics',
        headers: { Authorization: `Bearer ${this.token}` },
        params: { target: domain, country: 'ru' },
      });
      const m = res.data?.metrics ?? res.data;
      return m ? { domain, traffic: m.org_traffic, keywordsCount: m.org_keywords } : null;
    } catch (e: any) {
      this.log.warn(`Ahrefs visibility ${domain}: ${e.message}`);
      return null;
    }
  }
}
