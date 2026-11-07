import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

/**
 * Runs `test/worker/**` inside workerd against the real Worker and Durable Objects from wrangler.toml.
 * The root vitest.config.ts includes this as a project, so `npm test` runs it.
 */
export default defineConfig({
    plugins: [
        cloudflareTest({
            wrangler: { configPath: './wrangler.toml' },
            miniflare: {
                // Keeps the tests independent of what wrangler.toml allows. Keep in sync with the origins in helpers.ts.
                bindings: { ALLOWED_ORIGINS: 'https://allowed.example, https://also-allowed.example' },
            },
        }),
    ],
    test: {
        name: 'worker',
        include: ['test/worker/**/*.test.ts'],
    },
})
