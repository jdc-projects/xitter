import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

process.env.DATABASE_URL ??= `postgresql://posts:posts-local@localhost:5532/posts`;

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
