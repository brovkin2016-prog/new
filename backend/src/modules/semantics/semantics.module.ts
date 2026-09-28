import { Module } from '@nestjs/common';
import { PositionsModule } from '../positions/positions.module';
import { WordstatClient } from './wordstat.client';
import { EmbeddingsClient } from './embeddings.client';
import { ClusteringService } from './clustering.service';
import { SemanticsRunner } from './semantics.runner';
import { SemanticsService } from './semantics.service';
import { SemanticsController } from './semantics.controller';

@Module({
  imports: [PositionsModule],
  controllers: [SemanticsController],
  providers: [WordstatClient, EmbeddingsClient, ClusteringService, SemanticsRunner, SemanticsService],
  exports: [SemanticsRunner, SemanticsService, WordstatClient],
})
export class SemanticsModule {}
