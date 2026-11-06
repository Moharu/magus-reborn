// Types `exports` from 'cloudflare:workers' in these tests. Only the tests use it, so it lives here rather than in src.
declare namespace Cloudflare {
    interface GlobalProps {
        mainModule: typeof import('../../src/index')
    }
}
