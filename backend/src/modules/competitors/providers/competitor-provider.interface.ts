export interface CompetitorKeyword {
  phrase: string;
  position: number;
  url: string;
  volume?: number;
}

export interface DomainVisibility {
  domain: string;
  keywordsCount?: number;
  visibility?: number;
  traffic?: number;
}

/** Единый интерфейс провайдера конкурентных данных (Serpstat/Keys.so/Ahrefs). */
export interface CompetitorProvider {
  readonly name: string;
  readonly enabled: boolean;
  /** Ключи, по которым ранжируется домен. */
  domainKeywords(domain: string, regionCode?: number, limit?: number): Promise<CompetitorKeyword[]>;
  /** Сводная видимость домена. */
  domainVisibility(domain: string, regionCode?: number): Promise<DomainVisibility | null>;
}
