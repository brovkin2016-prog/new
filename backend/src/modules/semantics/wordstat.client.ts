import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { requestWithRetry } from '../../common/http.util';

/**
 * Адаптер Yandex Wordstat API (частотность запросов).
 * Док.: https://yandex.ru/dev/wordstat/  — токен OAuth хранится в ENV.
 * При отсутствии токена возвращает пустые данные (graceful degradation).
 */
@Injectable()
export class WordstatClient {
  private readonly log = new Logger(WordstatClient.name);
  constructor(private readonly cfg: ConfigService) {}

  get enabled(): boolean {
    return Boolean(this.cfg.get('wordstat.token'));
  }

  /** Базовая частотность фразы (широкое соответствие). */
  async frequency(phrase: string, regionCode?: number): Promise<number | null> {
    if (!this.enabled) return null;
    try {
      const res = await requestWithRetry<any>({
        method: 'POST',
        url: 'https://api.wordstat.yandex.net/v1/topRequests',
        headers: { Authorization: `Bearer ${this.cfg.get('wordstat.token')}`, 'Content-Type': 'application/json' },
        data: { phrase, regions: regionCode ? [regionCode] : undefined },
      });
      return res.data?.totalCount ?? res.data?.count ?? null;
    } catch (e: any) {
      this.log.warn(`Wordstat "${phrase}": ${e.message}`);
      return null;
    }
  }

  /** Расширение ядра: фразы, содержащие маркер (associations/including). */
  async expand(marker: string, regionCode?: number): Promise<{ phrase: string; count: number }[]> {
    if (!this.enabled) return [];
    try {
      const res = await requestWithRetry<any>({
        method: 'POST',
        url: 'https://api.wordstat.yandex.net/v1/topRequests',
        headers: { Authorization: `Bearer ${this.cfg.get('wordstat.token')}`, 'Content-Type': 'application/json' },
        data: { phrase: marker, regions: regionCode ? [regionCode] : undefined },
      });
      const rows = res.data?.topRequests ?? res.data?.including ?? [];
      return rows.map((r: any) => ({ phrase: r.phrase ?? r.text, count: r.count ?? r.number ?? 0 }));
    } catch (e: any) {
      this.log.warn(`Wordstat expand "${marker}": ${e.message}`);
      return [];
    }
  }
}
