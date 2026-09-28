import { Module } from '@nestjs/common';
import { RegionsController } from './regions.controller';

@Module({
  controllers: [RegionsController],
})
export class RegionsModule {}
