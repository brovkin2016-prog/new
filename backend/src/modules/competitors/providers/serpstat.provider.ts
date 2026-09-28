import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { requestWithRetry } from '../../../common/http.util';
import { CompetitorKeyword, CompetitorProvider, DomainVisibility } from './competitor-provider.interface';

/** Serpstat API. Док.: https://serpstat.com/api/ */
@Injectable()
export class SerpstatProvider implements CompetitorProvider {
  readonly name = 'serpstat';
  private readonly log = new Logger(SerpstatProvider.name);
  constructor(private readonly cfg: ConfigService) {}

  get enabled(): boolean {
    return Boolean(this.cfg.get('competitors.serpstat'));
  }

  private get token() {
    return this.cfg.get<string>('competitors.serpstat');
  }

  async domainKeywords(domain: string, regionCode?: number, limit = 100): Promise<CompetitorKeyword[]> {
    if (!this.enabled) return [];
    try {
      const res = await requestWithRetry<any>({
        method: 'POST',
        url: 'https://api.serpstat.com/v4/',
        params: { token: this.token },
        data: {
          id: 1,
          method: 'SerpstatDomainProcedure.getDomainKeywords',
          params: { domain, se: 'y_213', page_size: limit },
        },
      });
      const rows = res.data?.result?.data ?? [];
      return rows.map((r: any) => ({
        phrase: r.keyword,
        position: r.position,
        url: r.url,
        volume: r.region_queries_count,
      }));
    } catch (e: any) {
      this.log.warn(`Serpstat keywords ${domain}: ${e.message}`);
      return [];
    }
  }

  async domainVisibility(domain: string): Promise<DomainVisibility | null> {
    if (!this.enabled) return null;
    try {
      const res = await requestWithRetry<any>({
        method: 'POST',
        url: 'https://api.serpstat.com/v4/',
        params: { token: this.token },
        data: {
          id: 1,
          method: 'SerpstatDomainProcedure.getDomainsInfo',
          params: { domains: [domain], se: 'y_213' },
        },
      });
      const d = res.data?.result?.data?.[0];
      return d ? { domain, keywordsCount: d.keywords, visibility: d.visible, traffic: d.traff } : null;
    } catch (e: any) {
      this.log.warn(`Serpstat visibility ${domain}: ${e.message}`);
      return null;
    }
  }
}
