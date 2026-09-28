import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { requestWithRetry } from '../../../common/http.util';
import { CompetitorKeyword, CompetitorProvider, DomainVisibility } from './competitor-provider.interface';

/** Keys.so API. Док.: https://www.keys.so/ru/api */
@Injectable()
export class KeyssoProvider implements CompetitorProvider {
  readonly name = 'keysso';
  private readonly log = new Logger(KeyssoProvider.name);
  constructor(private readonly cfg: ConfigService) {}

  get enabled(): boolean {
    return Boolean(this.cfg.get('competitors.keysso'));
  }
  private get key() {
    return this.cfg.get<string>('competitors.keysso');
  }

  async domainKeywords(domain: string, regionCode = 213, limit = 100): Promise<CompetitorKeyword[]> {
    if (!this.enabled) return [];
    try {
      const res = await requestWithRetry<any>({
        method: 'GET',
        url: 'https://api.keys.so/report/simple/organic/keywords',
        headers: { 'X-Keyso-TOKEN': this.key },
        params: { base: `msk.yandex`, domain, per_page: limit },
      });
      const rows = res.data?.data ?? [];
      return rows.map((r: any) => ({ phrase: r.query, position: r.pos, url: r.url, volume: r.freq }));
    } catch (e: any) {
      this.log.warn(`Keys.so keywords ${domain}: ${e.message}`);
      return [];
    }
  }

  async domainVisibility(domain: string): Promise<DomainVisibility | null> {
    if (!this.enabled) return null;
    try {
      const res = await requestWithRetry<any>({
        method: 'GET',
        url: 'https://api.keys.so/report/simple/organic/info',
        headers: { 'X-Keyso-TOKEN': this.key },
        params: { base: 'msk.yandex', domain },
      });
      const d = res.data?.data;
      return d ? { domain, keywordsCount: d.total, traffic: d.traff } : null;
    } catch (e: any) {
      this.log.warn(`Keys.so visibility ${domain}: ${e.message}`);
      return null;
    }
  }
}
