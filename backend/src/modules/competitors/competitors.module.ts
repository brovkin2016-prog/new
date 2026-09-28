import { Module } from '@nestjs/common';
import { PositionsModule } from '../positions/positions.module';
import { SerpstatProvider } from './providers/serpstat.provider';
import { KeyssoProvider } from './providers/keysso.provider';
import { AhrefsProvider } from './providers/ahrefs.provider';
import { ProviderRegistry } from './provider-registry.service';
import { CompetitorsRunner } from './competitors.runner';
import { CompetitorsService } from './competitors.service';
import { CompetitorsController } from './competitors.controller';

@Module({
  imports: [PositionsModule],
  controllers: [CompetitorsController],
  providers: [
    SerpstatProvider,
    KeyssoProvider,
    AhrefsProvider,
    ProviderRegistry,
    CompetitorsRunner,
    CompetitorsService,
  ],
  exports: [CompetitorsRunner, CompetitorsService],
})
export class CompetitorsModule {}
