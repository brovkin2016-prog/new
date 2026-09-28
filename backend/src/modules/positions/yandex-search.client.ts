import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { XMLParser } from 'fast-xml-parser';
import { requestWithRetry } from '../../common/http.util';
import { hostOf, matchesDomain } from '../../common/url.util';

export interface SerpItem {
  position: number;
  url: string;
  domain: string;
  title?: string;
}

export interface PositionLookup {
  position: number | null;
  url: string | null;
  inTop30: boolean;
}

/**
 * Клиент официального Yandex Search API v2 (Yandex Cloud).
 * Отдаёт выдачу легально, без обхода антибота. Ответ приходит как base64(XML),
 * который парсится в упорядоченный список результатов.
 * Док.: https://yandex.cloud/ru/docs/search-api/
 */
@Injectable()
export class YandexSearchClient {
  private readonly log = new Logger(YandexSearchClient.name);
  private readonly parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' });

  constructor(private readonly cfg: ConfigService) {}

  get enabled(): boolean {
    return Boolean(this.cfg.get('yandexSearch.apiKey') && this.cfg.get('yandexSearch.folderId'));
  }

  /** Получить топ выдачи по запросу для региона lr. page — с нуля. */
  async search(query: string, lr: number, page = 0, device = 'desktop'): Promise<SerpItem[]> {
    if (!this.enabled) throw new Error('Yandex Search API не сконфигурирован (нет ключа/folderId)');

    const body = {
      query: {
        searchType: 'SEARCH_TYPE_RU',
        queryText: query,
        familyMode: 'FAMILY_MODE_NONE',
        page: String(page),
      },
      // регион задаётся через lr (Yandex region id); поле подтвердите по актуальной доке
      region: String(lr),
      groupSpec: { groupMode: 'GROUP_MODE_FLAT', groupsOnPage: '30', docsInGroup: '1' },
      l10n: 'LOCALIZATION_RU',
      folderId: this.cfg.get<string>('yandexSearch.folderId'),
      responseFormat: 'FORMAT_XML',
      userAgent: device === 'mobile' ? 'Mozilla/5.0 (mobile)' : 'Mozilla/5.0',
    };

    const res = await requestWithRetry<{ rawData?: string }>({
      method: 'POST',
      url: this.cfg.get<string>('yandexSearch.endpoint'),
      headers: {
        Authorization: `Api-Key ${this.cfg.get<string>('yandexSearch.apiKey')}`,
        'Content-Type': 'application/json',
      },
      data: body,
    });

    const raw = res.data?.rawData;
    if (!raw) return [];
    const xml = Buffer.from(raw, 'base64').toString('utf-8');
    return this.parseSerp(xml);
  }

  /** Разбор Yandex XML выдачи в упорядоченный список. */
  private parseSerp(xml: string): SerpItem[] {
    const doc = this.parser.parse(xml);
    const groups =
      doc?.yandexsearch?.response?.results?.grouping?.group ??
      doc?.yandexsearch?.response?.results?.grouping?.[0]?.group ??
      [];
    const arr = Array.isArray(groups) ? groups : [groups];
    const items: SerpItem[] = [];
    let pos = 0;
    for (const g of arr) {
      const d = g?.doc;
      const first = Array.isArray(d) ? d[0] : d;
      const url: string | undefined = first?.url;
      if (!url) continue;
      pos += 1;
      items.push({
        position: pos,
        url,
        domain: hostOf(url),
        title: typeof first?.title === 'string' ? first.title : first?.title?.['#text'],
      });
    }
    return items;
  }

  /**
   * Позиция целевого домена по запросу. Проверяет до `depth` результатов
   * (по умолчанию топ-30). Возвращает точную позицию и флаг вхождения в топ-30.
   */
  async findPosition(
    query: string,
    lr: number,
    domain: string,
    depth = 30,
    device = 'desktop',
  ): Promise<PositionLookup> {
    const perPage = 30;
    const pages = Math.ceil(depth / perPage);
    let scanned = 0;
    for (let p = 0; p < pages; p++) {
      const serp = await this.search(query, lr, p, device);
      for (const item of serp) {
        scanned += 1;
        if (scanned > depth) break;
        if (matchesDomain(item.url, domain)) {
          return { position: item.position + p * perPage, url: item.url, inTop30: item.position + p * perPage <= 30 };
        }
      }
      if (serp.length < perPage) break;
    }
    return { position: null, url: null, inTop30: false };
  }

  /** Домены топ-N по запросу (для определения конкурентов и кластеризации). */
  async topDomains(query: string, lr: number, n = 10): Promise<SerpItem[]> {
    const serp = await this.search(query, lr, 0);
    return serp.slice(0, n);
  }
}
