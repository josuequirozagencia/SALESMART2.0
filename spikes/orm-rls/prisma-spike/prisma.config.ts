import { defineConfig } from 'prisma/config'
export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: { url: process.env.DATABASE_URL_OWNER ?? 'postgresql://app_owner:owner@localhost:5432/spike_prisma' },
})
