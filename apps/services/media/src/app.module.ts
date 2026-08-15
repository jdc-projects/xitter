import { Module } from "@nestjs/common";
import { MediaModule } from "./modules/media.module.js";

@Module({
  imports: [MediaModule],
})
export class AppModule {}
