import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
    test: {
        projects: [
            {
                test: {
                    name: 'unit',
                    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
                    exclude: [...configDefaults.exclude, 'apps/server/test/worker/**'],
                },
            },
            'apps/server/vitest.config.ts',
        ],
    },
})
