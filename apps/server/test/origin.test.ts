import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { unstable_readConfig } from 'wrangler'
import { allowedOrigin, corsHeaders } from '../src/origin'
import packageJson from '../package.json'

const PAGES_URL = 'https://magus-reborn.pages.dev'
const VITE_URLS = ['http://localhost:5173', 'http://127.0.0.1:5173']

describe('allowedOrigin', () => {
    const LIST = 'https://a.example, https://b.example'

    it.each(['https://a.example', 'https://b.example'])('allows %s, which is on the list', origin => {
        expect(allowedOrigin(origin, LIST)).toBe(origin)
    })

    it.each([
        ['a missing origin', null],
        ['an empty origin', ''],
        ['an origin not on the list', 'https://evil.example'],
        ['a different scheme', 'http://a.example'],
        ['a different port', 'https://a.example:8443'],
        ['a subdomain', 'https://sub.a.example'],
        ['a longer domain', 'https://a.example.evil.example'],
        ['a trailing slash', 'https://a.example/'],
        ['different case', 'https://A.example'],
        ['the whole list', LIST],
        ['the opaque origin', 'null'],
    ])('refuses %s', (_, origin) => {
        expect(allowedOrigin(origin, LIST)).toBeNull()
    })

    it.each([
        ['a list of only *', '*'],
        ['a list with * in it', 'https://a.example, *'],
    ])('treats * as nothing in %s', (_, list) => {
        expect(allowedOrigin('https://evil.example', list)).toBeNull()
        expect(allowedOrigin('*', list)).toBeNull()
    })

    it.each([
        ['an empty list', ''],
        ['a trailing comma', 'https://a.example,'],
        ['a blank entry', 'https://a.example, ,https://b.example'],
    ])('refuses an empty origin with %s', (_, list) => {
        expect(allowedOrigin('', list)).toBeNull()
    })
})

describe('corsHeaders', () => {
    it('allows only the given origin', () => {
        expect(corsHeaders('https://a.example')).toMatchObject({
            'Access-Control-Allow-Origin': 'https://a.example',
            Vary: 'Origin',
        })
    })

    it('has nothing but Vary when the origin is not allowed', () => {
        expect(corsHeaders(null)).toEqual({ Vary: 'Origin' })
    })
})

const WRANGLER_TOML = fileURLToPath(new URL('../wrangler.toml', import.meta.url).href)
// An empty env is the top level, as in the deploy script. Leaving it undefined would read CLOUDFLARE_ENV instead.
const config = (env = '') => unstable_readConfig({ config: WRANGLER_TOML, env })
const originsOf = (env = '') => String(config(env).vars.ALLOWED_ORIGINS)

describe('wrangler.toml', () => {
    describe('production', () => {
        it('allows only the Pages URL', () => {
            expect(originsOf()).toBe(PAGES_URL)
        })

        it.each([
            ['the local Vite server', VITE_URLS[0]],
            ['a per-deployment Pages URL', 'https://0123abcd.magus-reborn.pages.dev'],
        ])('refuses %s', (_, origin) => {
            expect(allowedOrigin(origin, originsOf())).toBeNull()
        })
    })

    describe('dev', () => {
        it('allows only the Vite dev server', () => {
            expect(originsOf('dev').split(', ')).toEqual(VITE_URLS)
        })

        it.each(VITE_URLS)('allows %s through allowedOrigin', origin => {
            expect(allowedOrigin(origin, originsOf('dev'))).toBe(origin)
        })

        it('refuses the production client', () => {
            expect(allowedOrigin(PAGES_URL, originsOf('dev'))).toBeNull()
        })

        it('has the same Durable Objects as production, or the local server would not start', () => {
            expect(config('dev').durable_objects.bindings).toEqual(config().durable_objects.bindings)
            expect(config('dev').migrations).toEqual(config().migrations)
        })
    })
})

describe('package scripts', () => {
    it('runs local development against the dev environment', () => {
        expect(packageJson.scripts.dev).toBe('wrangler dev --env dev')
    })

    it('deploys the top-level production environment', () => {
        expect(packageJson.scripts.deploy).toBe('wrangler deploy --env=""')
    })
})
