import { Module } from "@nestjs/common";
import { SocialController } from "./social.controller.js";
import { SocialService } from "./social.service.js";

@Module({
  controllers: [SocialController],
  providers: [SocialService],
})
export class SocialModule {}
