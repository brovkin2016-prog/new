import { Injectable } from '@nestjs/common';
import { YandexSearchClient } from '../positions/yandex-search.client';
import { EmbeddingsClient, cosine } from './embeddings.client';
import { hostOf } from '../../common/url.util';
import { sleep } from '../../common/http.util';
import { estimateTraffic } from './ctr-model';
import { Intent } from '@prisma/client';

export interface KwInput {
  id: string;
  phrase: string;
  frequency: number;
}

export interface ClusterOut {
  name: string;
  intent: Intent;
  volume: number;
  difficulty: number;
  commercialValue: number;
  potentialTraffic: number;
  priority: number;
  competitorUrls: string[];
  keywordIds: string[];
}

const COMMERCIAL_MARKERS = ['купить', 'цена', 'заказать', 'стоимость', 'доставка', 'магазин', 'заказ', 'недорого', 'оптом', 'услуг'];

@Injectable()
export class ClusteringService {
  constructor(
    private readonly yandex: YandexSearchClient,
    private readonly embeddings: EmbeddingsClient,
  ) {}

  /** Кластеризация: hard по пересечению URL топ-10 + опц. semantic refine. */
  async cluster(keywords: KwInput[], lr: number, urlThreshold = 3): Promise<ClusterOut[]> {
    // 1) SERP топ-10 для каждой фразы
    const serp = new Map<string, string[]>();
    for (const kw of keywords) {
      try {
        const items = await this.yandex.topDomains(kw.phrase, lr, 10);
        serp.set(kw.id, items.map((i) => i.url));
      } catch {
        serp.set(kw.id, []);
      }
      await sleep(300);
    }

    // 2) union-find по пересечению URL
    const parent = new Map<string, string>();
    keywords.forEach((k) => parent.set(k.id, k.id));
    const find = (x: string): string => {
      while (parent.get(x) !== x) {
        parent.set(x, parent.get(parent.get(x)!)!);
        x = parent.get(x)!;
      }
      return x;
    };
    const union = (a: string, b: string) => parent.set(find(a), find(b));

    for (let i = 0; i < keywords.length; i++) {
      for (let j = i + 1; j < keywords.length; j++) {
        const a = new Set(serp.get(keywords[i].id) ?? []);
        const b = serp.get(keywords[j].id) ?? [];
        const inter = b.filter((u) => a.has(u)).length;
        if (inter >= urlThreshold) union(keywords[i].id, keywords[j].id);
      }
    }

    // 3) опц. semantic refine — слить кластеры с близкими названиями
    await this.semanticRefine(keywords, find, union);

    // 4) собрать кластеры
    const groups = new Map<string, KwInput[]>();
    for (const kw of keywords) {
      const root = find(kw.id);
      const arr = groups.get(root) ?? [];
      arr.push(kw);
      groups.set(root, arr);
    }

    const out: ClusterOut[] = [];
    for (const arr of groups.values()) {
      arr.sort((x, y) => y.frequency - x.frequency);
      const volume = arr.reduce((s, k) => s + (k.frequency || 0), 0);
      const intent = this.detectIntent(arr.map((k) => k.phrase));
      const commercialValue = intent === Intent.commercial ? 1 : intent === Intent.mixed ? 0.5 : 0.2;
      const urls = arr.flatMap((k) => serp.get(k.id) ?? []);
      const competitorUrls = this.topByFreq(urls.map(hostOf)).slice(0, 10);
      const difficulty = Math.min(1, competitorUrls.length / 10); // эвристика: заполненность топа сильными доменами
      const potentialTraffic = arr.reduce((s, k) => s + estimateTraffic(k.frequency || 0, 5), 0);
      out.push({
        name: arr[0].phrase,
        intent,
        volume,
        difficulty,
        commercialValue,
        potentialTraffic,
        priority: 0, // проставляется в prioritize()
        competitorUrls,
        keywordIds: arr.map((k) => k.id),
      });
    }
    return this.prioritize(out);
  }

  private async semanticRefine(
    keywords: KwInput[],
    find: (x: string) => string,
    union: (a: string, b: string) => void,
  ) {
    if (!this.embeddings.enabled || keywords.length < 2) return;
    const vecs = await this.embeddings.embed(keywords.map((k) => k.phrase));
    if (!vecs) return;
    for (let i = 0; i < keywords.length; i++) {
      for (let j = i + 1; j < keywords.length; j++) {
        if (find(keywords[i].id) === find(keywords[j].id)) continue;
        if (cosine(vecs[i], vecs[j]) >= 0.8) union(keywords[i].id, keywords[j].id);
      }
    }
  }

  private detectIntent(phrases: string[]): Intent {
    let commercial = 0;
    for (const p of phrases) {
      if (COMMERCIAL_MARKERS.some((m) => p.toLowerCase().includes(m))) commercial += 1;
    }
    const ratio = commercial / phrases.length;
    if (ratio >= 0.6) return Intent.commercial;
    if (ratio > 0) return Intent.mixed;
    return Intent.informational;
  }

  private topByFreq(items: string[]): string[] {
    const map = new Map<string, number>();
    for (const i of items) map.set(i, (map.get(i) ?? 0) + 1);
    return [...map.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]);
  }

  /** score = 0.4·volume + 0.3·commercial + 0.2·(1−difficulty) + 0.1·traffic. */
  private prioritize(clusters: ClusterOut[]): ClusterOut[] {
    const maxVol = Math.max(1, ...clusters.map((c) => c.volume));
    const maxTraf = Math.max(1, ...clusters.map((c) => c.potentialTraffic));
    for (const c of clusters) {
      c.priority =
        0.4 * (c.volume / maxVol) +
        0.3 * c.commercialValue +
        0.2 * (1 - c.difficulty) +
        0.1 * (c.potentialTraffic / maxTraf);
    }
    return clusters.sort((a, b) => b.priority - a.priority);
  }
}
