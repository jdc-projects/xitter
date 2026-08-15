import { Module } from '@nestjs/common';
import { PostsModule } from './modules/posts.module.js';

@Module({
  imports: [PostsModule],
})
export class AppModule {}
