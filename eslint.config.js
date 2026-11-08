import { defineConfig, globalIgnores } from 'eslint/config'
import { js, prettier, tseslint } from '@magus/eslint-config'

export default defineConfig(
    // `.claude/` holds agent worktrees, which are separate checkouts of this repo.
    globalIgnores(['**/dist/', '**/.wrangler/', '**/node_modules/', '.claude/']),
    js.configs.recommended,
    tseslint.configs.recommended,
    {
        rules: {
            // A leading underscore marks a binding as intentionally unused (a loop counter, an
            // omitted destructured key, a parameter that only gives a mock its signature).
            '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
        },
    },
    // Last, so it turns off every rule that would conflict with prettier.
    prettier,
)
