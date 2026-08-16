import { Module } from '@nestjs/common';
import { SearchModule } from './modules/search.module.js';

@Module({
  imports: [SearchModule],
})
export class AppModule {}
