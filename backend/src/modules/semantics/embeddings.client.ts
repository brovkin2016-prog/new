import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { requestWithRetry } from '../../common/http.util';

/** Клиент embeddings-микросервиса (Python/FastAPI + sentence-transformers). */
@Injectable()
export class EmbeddingsClient {
  private readonly log = new Logger(EmbeddingsClient.name);
  constructor(private readonly cfg: ConfigService) {}

  get enabled(): boolean {
    return Boolean(this.cfg.get('embeddings.url'));
  }

  async embed(texts: string[]): Promise<number[][] | null> {
    if (!this.enabled || texts.length === 0) return null;
    try {
      const res = await requestWithRetry<{ vectors: number[][] }>({
        method: 'POST',
        url: `${this.cfg.get('embeddings.url')}/embed`,
        data: { texts },
        timeout: 60000,
      });
      return res.data.vectors;
    } catch (e: any) {
      this.log.warn(`Embeddings недоступны: ${e.message}`);
      return null;
    }
  }
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}
