import { describe, expect, it } from 'vitest'
import { DEFAULT_SPELLS, LOADOUT_SIZE, parseClientMessage } from '../src'
import type { ClientMessage } from '../src/protocol'

describe('parseClientMessage', () => {
    it.each<[ClientMessage]>([
        [{ t: 'ready' }],
        [{ t: 'unready' }],
        [{ t: 'set_spells', spells: DEFAULT_SPELLS }],
        [{ t: 'start_cast', i: 0 }],
        [{ t: 'start_cast', i: LOADOUT_SIZE - 1 }],
        [{ t: 'stop_cast', i: 0 }],
        [{ t: 'stop_cast', i: LOADOUT_SIZE - 1 }],
        [{ t: 'settings', settings: {} }],
        [{ t: 'settings', settings: { bestOf: 1 } }],
        [{ t: 'settings', settings: { bestOf: 3 } }],
        [{ t: 'settings', settings: { bestOf: 5 } }],
        [{ t: 'settings', settings: { allowSpellChange: false } }],
        [{ t: 'settings', settings: { bestOf: 5, setupTime: 45, allowSpellChange: true, maxSpectators: 0 } }],
        // out of range but valid: the lobby clamps these
        [{ t: 'settings', settings: { setupTime: 0, maxSpectators: 99 } }],
        [{ t: 'ping', at: 0 }],
        [{ t: 'ping', at: 1234.5 }],
    ])('accepts %j', message => {
        expect(parseClientMessage(message)).toEqual(message)
        // decoded from a frame, as the server sees it
        expect(parseClientMessage(JSON.parse(JSON.stringify(message)))).toEqual(message)
    })

    it.each<[string, unknown]>([
        ['undefined', undefined],
        ['null', null],
        ['a number', 42],
        ['a string', 'ready'],
        ['a boolean', true],
        ['a list', [{ t: 'ready' }]],
        ['an object with no type', {}],
        ['an unknown type', { t: 'self_destruct' }],
        ['a type a server message uses', { t: 'pong', at: 1 }],
        ['a type that is not a string', { t: 1 }],
        ['a type that is a list', { t: ['ready'] }],
        ['a type every object inherits', { t: 'constructor' }],
        ['a type behind the prototype key', JSON.parse('{"__proto__":{"t":"ready"}}')],
    ])('rejects %s', (_, raw) => {
        expect(parseClientMessage(raw)).toBeNull()
    })

    const [first, ...rest] = DEFAULT_SPELLS
    it.each<[string, unknown]>([
        ['no spells', undefined],
        ['spells that are not a list', first],
        ['spells that only look like a list', { length: LOADOUT_SIZE }],
        ['too few spells', rest],
        ['too many spells', [...DEFAULT_SPELLS, 'SPELL_BLUR']],
        ['a repeated spell', [first, first, ...rest.slice(1)]],
        ['an unknown spell', ['SPELL_NOPE', ...rest]],
        ['a spell that is not a string', [1, ...rest]],
        ['a spell named after a property every object inherits', ['toString', ...rest]],
        ['a spell named after the prototype', ['__proto__', ...rest]],
    ])('rejects set_spells with %s', (_, spells) => {
        expect(parseClientMessage({ t: 'set_spells', spells })).toBeNull()
    })

    describe.each(['start_cast', 'stop_cast'] as const)('%s', t => {
        it.each<[string, unknown]>([
            ['no index', undefined],
            ['an index below the range', -1],
            ['an index just above the range', LOADOUT_SIZE],
            ['an index far above the range', 99],
            ['a fractional index', 1.5],
            ['a NaN index', Number.NaN],
            ['an infinite index', Number.POSITIVE_INFINITY],
            ['an index that is a numeric string', '0'],
            ['an index that is null', null],
            ['an index that is a boolean', true],
            ['an index that is a list', [0]],
        ])('rejects %s', (_, i) => {
            expect(parseClientMessage({ t, i })).toBeNull()
        })
    })

    it.each<[string, unknown]>([
        ['no settings', undefined],
        ['settings that are null', null],
        ['settings that are a string', 'x'],
        ['settings that are a number', 5],
        ['settings that are a list', [{ bestOf: 5 }]],
        ['settings that are an empty list', []],
        ['an unknown setting', { nope: 1 }],
        ['a setting named after a property every object inherits', { toString: 1 }],
        ['a setting behind the prototype key', JSON.parse('{"__proto__":{"bestOf":5}}')],
        ['a best-of that is not an option', { bestOf: 4 }],
        ['a best-of that is a numeric string', { bestOf: '3' }],
        ['a set up time that is a string', { setupTime: '60' }],
        ['a set up time that is NaN', { setupTime: Number.NaN }],
        ['a set up time that is infinite', { setupTime: Number.POSITIVE_INFINITY }],
        ['a set up time that is null', { setupTime: null }],
        ['a spell change flag that is not a boolean', { allowSpellChange: 'yes' }],
        ['a spell change flag that is a number', { allowSpellChange: 1 }],
        ['a spectator limit that is a string', { maxSpectators: '2' }],
        ['a spectator limit that is infinite', { maxSpectators: Number.NEGATIVE_INFINITY }],
        ['a good setting next to a bad one', { bestOf: 5, setupTime: '60' }],
    ])('rejects settings with %s', (_, settings) => {
        expect(parseClientMessage({ t: 'settings', settings })).toBeNull()
    })

    it.each<[string, unknown]>([
        ['no timestamp', undefined],
        ['a timestamp that is a string', 'soon'],
        ['a timestamp that is null', null],
        ['a NaN timestamp', Number.NaN],
        // what JSON.parse makes of 1e999
        ['an infinite timestamp', Number.POSITIVE_INFINITY],
    ])('rejects ping with %s', (_, at) => {
        expect(parseClientMessage({ t: 'ping', at })).toBeNull()
    })

    it('keeps only the fields the protocol defines', () => {
        expect(parseClientMessage({ t: 'ready', pad: 'xxx' })).toEqual({ t: 'ready' })
        expect(parseClientMessage({ t: 'start_cast', i: 1, extra: true })).toEqual({ t: 'start_cast', i: 1 })
        expect(parseClientMessage({ t: 'ping', at: 1, extra: true })).toEqual({ t: 'ping', at: 1 })
    })
})
