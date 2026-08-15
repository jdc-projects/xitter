import { Module } from "@nestjs/common";
import { SocialModule } from "./modules/social/social.module.js";

@Module({
  imports: [SocialModule],
})
export class AppModule {}
