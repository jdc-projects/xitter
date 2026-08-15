import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

process.env.DATABASE_URL ??= `postgresql://social:social-local@localhost:5532/social`;

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
