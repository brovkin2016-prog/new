import { Injectable } from '@nestjs/common';
import { CompetitorProvider } from './providers/competitor-provider.interface';
import { SerpstatProvider } from './providers/serpstat.provider';
import { KeyssoProvider } from './providers/keysso.provider';
import { AhrefsProvider } from './providers/ahrefs.provider';

@Injectable()
export class ProviderRegistry {
  constructor(
    private readonly serpstat: SerpstatProvider,
    private readonly keysso: KeyssoProvider,
    private readonly ahrefs: AhrefsProvider,
  ) {}

  get active(): CompetitorProvider[] {
    return [this.serpstat, this.keysso, this.ahrefs].filter((p) => p.enabled);
  }

  get primary(): CompetitorProvider | null {
    return this.active[0] ?? null;
  }
}
