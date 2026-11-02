import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    // New headless Chromium: real GPU (WebGPU on Metal on macOS) and WebTransport.
    channel: "chromium",
    baseURL: "http://localhost:5173",
    viewport: { width: 1280, height: 720 },
    // E2E_SOFTWARE_GL=1 mimics CI runners (no GPU, software rendering).
    launchOptions: { args: process.env.E2E_SOFTWARE_GL ? ["--disable-gpu"] : [] },
  },
  webServer: {
    command: "node scripts/dev.ts",
    url: "http://localhost:5173",
    reuseExistingServer: true,
    timeout: 300_000,
  },
});
