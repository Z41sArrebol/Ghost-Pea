import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    environment: "jsdom",
    restoreMocks: true,
    clearMocks: true,
    // 存在若干逐帧断言的重型用例（如 orchestrator 的 1800 帧边界测试），
    // 全量并发运行时会受 CPU 争用影响超过默认 5s，这里放宽到 20s。
    testTimeout: 20000,
  },
});
