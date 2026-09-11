import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Deterministic: unit tests never talk to network / DB / SMTP.
    env: {
      NODE_ENV: "test",
      SESSION_SECRET: "test-session-secret-test-session-secret",
      TOKEN_ENCRYPTION_KEY: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      APP_URL: "http://localhost:3000",
      DATABASE_URL: "postgresql://test:test@localhost:5432/test",
      META_APP_ID: "test-fb-app-id",
      META_APP_SECRET: "test-fb-app-secret",
      // Instagram Login credentials are deliberately DIFFERENT from the Facebook
      // ones so tests catch any code path that mixes them up.
      META_INSTAGRAM_APP_ID: "test-ig-app-id",
      META_INSTAGRAM_APP_SECRET: "test-ig-app-secret",
      META_REDIRECT_URI: "http://localhost:3000/api/meta/oauth/callback",
      META_WEBHOOK_VERIFY_TOKEN: "test-verify-token",
      META_GRAPH_VERSION: "v25.0",
      LEAD_NOTIFICATION_EMAIL: "leads@test.local",
    },
  },
});
