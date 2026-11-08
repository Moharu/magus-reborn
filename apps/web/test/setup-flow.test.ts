import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@magus/engine/protocol'
import { canSendLoadout, setupAccess } from '../src/ui/setup-flow'

const lobby = (round: number, allowSpellChange = true) => ({
    round,
    settings: { ...DEFAULT_SETTINGS, allowSpellChange },
})

describe('pre-game setup', () => {
    it('is round 1: element choosable, loadout editable', () => {
        const a = setupAccess(lobby(1), { ready: false })
        expect(a).toMatchObject({ flow: 'pregame', elementLocked: false, editable: true, lockedReason: null })
    })

    it('stays editable in round 1 even when spell changes between rounds are off', () => {
        expect(setupAccess(lobby(1, false), { ready: false }).editable).toBe(true)
    })
})

describe('between rounds', () => {
    it('locks the element and allows swaps when the lobby allows it', () => {
        const a = setupAccess(lobby(2), { ready: false })
        expect(a).toMatchObject({ flow: 'swap', elementLocked: true, editable: true })
    })

    it('is read-only when allowSpellChange is off', () => {
        const a = setupAccess(lobby(2, false), { ready: false })
        expect(a.editable).toBe(false)
        expect(a.lockedReason).toMatch(/off/)
    })

    it('is read-only once the player is ready', () => {
        const a = setupAccess(lobby(3), { ready: true })
        expect(a.editable).toBe(false)
        expect(a.lockedReason).toBe('Spells locked in.')
    })

    it('only sends set_spells when editable and valid', () => {
        const open = setupAccess(lobby(2), { ready: false })
        const shut = setupAccess(lobby(2, false), { ready: false })
        expect(canSendLoadout(open, true)).toBe(true)
        expect(canSendLoadout(open, false)).toBe(false)
        expect(canSendLoadout(shut, true)).toBe(false)
    })
})
