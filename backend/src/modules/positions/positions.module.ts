import { Module } from '@nestjs/common';
import { YandexSearchClient } from './yandex-search.client';
import { PositionsRunner } from './positions.runner';
import { PositionsService } from './positions.service';
import { PositionsController } from './positions.controller';

@Module({
  controllers: [PositionsController],
  providers: [YandexSearchClient, PositionsRunner, PositionsService],
  exports: [YandexSearchClient, PositionsRunner, PositionsService],
})
export class PositionsModule {}
