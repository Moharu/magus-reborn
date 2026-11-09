import { defineConfig } from '@playwright/test'

export default defineConfig({
    testDir: './apps/web/browser',
    workers: 1,
    use: {
        baseURL: 'http://127.0.0.1:5178',
        actionTimeout: 5000,
        hasTouch: true,
        launchOptions: { args: ['--no-sandbox'] },
    },
    webServer: {
        command: 'npm run dev -w @magus/web -- --host 127.0.0.1 --port 5178 --strictPort',
        url: 'http://127.0.0.1:5178',
    },
})
