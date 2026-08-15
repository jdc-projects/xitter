import { Module } from "@nestjs/common";
import { FeedModule } from "./modules/feed.module.js";

@Module({
  imports: [FeedModule],
})
export class AppModule {}
