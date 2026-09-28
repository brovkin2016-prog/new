export default () => ({
  port: parseInt(process.env.PORT ?? '3000', 10),
  jwtSecret: process.env.JWT_SECRET ?? 'change-me',
  redis: {
    host: process.env.REDIS_HOST ?? 'localhost',
    port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
  },
  yandexSearch: {
    apiKey: process.env.YANDEX_SEARCH_API_KEY ?? '',
    folderId: process.env.YANDEX_SEARCH_FOLDER_ID ?? '',
    endpoint:
      process.env.YANDEX_SEARCH_ENDPOINT ??
      'https://searchapi.api.cloud.yandex.net/v2/web/search',
  },
  pagespeed: {
    apiKey: process.env.PAGESPEED_API_KEY ?? '',
    endpoint:
      'https://www.googleapis.com/pagespeedonline/v5/runPagespeed',
  },
  wordstat: {
    token: process.env.WORDSTAT_OAUTH_TOKEN ?? '',
  },
  competitors: {
    serpstat: process.env.SERPSTAT_API_KEY ?? '',
    keysso: process.env.KEYSSO_API_KEY ?? '',
    ahrefs: process.env.AHREFS_API_TOKEN ?? '',
  },
  embeddings: {
    url: process.env.EMBEDDINGS_URL ?? '',
  },
  crawler: {
    userAgent:
      process.env.CRAWLER_USER_AGENT ??
      'PF-SiteAudit/1.0 (+https://pf.sites-s.ru/bot)',
    maxPages: parseInt(process.env.CRAWLER_MAX_PAGES ?? '15', 10),
    maxDepth: parseInt(process.env.CRAWLER_MAX_DEPTH ?? '3', 10),
    delayMs: parseInt(process.env.CRAWLER_DELAY_MS ?? '1500', 10),
    concurrency: parseInt(process.env.CRAWLER_CONCURRENCY ?? '2', 10),
  },
});
