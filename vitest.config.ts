import { cloudflareTest } from "@cloudflare/vitest-plugin"
import { defineConfig } from "vitest/config"

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          SLACK_TEAM_ID: "T123",
          SOURCE_CHANNEL_IDS: "C123,G123",
          SLACK_SIGNING_SECRET: "test-signing-secret",
          SLACK_BOT_TOKEN: "test-bot-token",
        },
      },
    }),
  ],
  test: { include: ["test/**/*.test.ts"] },
})
