import { Module } from '@nestjs/common';
import { KeywordsController } from './keywords.controller';

@Module({
  controllers: [KeywordsController],
})
export class KeywordsModule {}
