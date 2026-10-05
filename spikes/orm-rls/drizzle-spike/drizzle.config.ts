import { defineConfig } from 'drizzle-kit';
export default defineConfig({ dialect: 'postgresql', schema: './schema.ts', out: './drizzle-out',
  dbCredentials: { url: 'postgresql://app_owner:owner@localhost:5432/'+(process.env.DB||'spike_drizzle') } });
