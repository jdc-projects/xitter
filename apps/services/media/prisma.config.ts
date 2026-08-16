import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

// Offset-aware local fallback (mirrors @xitter/config serviceDbUrl; kept
// inline because prisma loads this config before workspace builds).
const port = 5532 + (Number.parseInt(process.env.XITTER_PORT_OFFSET ?? '0', 10) || 0);
process.env.DATABASE_URL ??= `postgresql://media:media-local@localhost:${port}/media`;

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
