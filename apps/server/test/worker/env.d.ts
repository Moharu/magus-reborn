// Types `exports` from 'cloudflare:workers' in these tests. Only the tests use it, so it lives here rather than in src.
declare namespace Cloudflare {
    interface GlobalProps {
        mainModule: typeof import('../../src/index')
    }
    // Types `env` from 'cloudflare:test' with the Worker's bindings. It has to be an interface to merge with the
    // runtime's own `Cloudflare.Env`.
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface Env extends ServerEnv {}
}

type ServerEnv = import('../../src/env').Env
