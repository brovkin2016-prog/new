import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { requestWithRetry } from '../../common/http.util';

export interface SpeedMetrics {
  lcpMs?: number;
  fcpMs?: number;
  ttiMs?: number;
  serverResponseMs?: number;
  performanceScore?: number;
}

/**
 * Google PageSpeed Insights (Lighthouse). Легальный источник LCP/FCP/TTI/TTFB.
 * Док.: https://developers.google.com/speed/docs/insights/v5/get-started
 */
@Injectable()
export class PageSpeedClient {
  private readonly log = new Logger(PageSpeedClient.name);
  constructor(private readonly cfg: ConfigService) {}

  get enabled(): boolean {
    return Boolean(this.cfg.get('pagespeed.apiKey'));
  }

  async measure(url: string, strategy: 'desktop' | 'mobile' = 'desktop'): Promise<SpeedMetrics> {
    if (!this.enabled) return {};
    try {
      const res = await requestWithRetry<any>({
        method: 'GET',
        url: this.cfg.get<string>('pagespeed.endpoint'),
        params: {
          url,
          key: this.cfg.get<string>('pagespeed.apiKey'),
          strategy,
          category: 'performance',
        },
        timeout: 60000,
      });
      const audits = res.data?.lighthouseResult?.audits ?? {};
      const num = (k: string): number | undefined => {
        const v = audits[k]?.numericValue;
        return typeof v === 'number' ? Math.round(v) : undefined;
      };
      return {
        lcpMs: num('largest-contentful-paint'),
        fcpMs: num('first-contentful-paint'),
        ttiMs: num('interactive'),
        serverResponseMs: num('server-response-time'),
        performanceScore: res.data?.lighthouseResult?.categories?.performance?.score,
      };
    } catch (e: any) {
      this.log.warn(`PageSpeed для ${url}: ${e.message}`);
      return {};
    }
  }
}
