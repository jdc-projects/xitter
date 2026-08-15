import { parseEnv } from "@xitter/config";
import { z } from "zod";

export const env = parseEnv(
  z.object({
    PAYLOAD_SECRET: z.string().min(16),
    DATABASE_URL: z.string().min(1),
    WEB_URL: z.string().url().default("http://localhost:8080"),
  }),
);
