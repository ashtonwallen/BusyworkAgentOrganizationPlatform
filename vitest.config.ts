import { defineConfig } from "vitest/config";
export default defineConfig({ test: { env:{HIVE_COMPANY_NAME:'Example Company',HIVE_BUSINESS_EMAIL:'busywork@example.com'},include:["tests/**/*.test.ts"],testTimeout:60000,hookTimeout:60000,fileParallelism:false,pool:"forks",maxWorkers:1 } });
