import { enemyOf, SPELLS, type LogEntry, type PlayerKey, type SpellId } from '@magus/engine'
import { sidesFor, type Side } from './layout'

export interface SpellLogRow {
    text: string
    side: Side
    label: string
}
export interface SpellLogState {
    casts: Partial<Record<PlayerKey, SpellId>>
    rows: SpellLogRow[]
}
export const emptySpellLog = (): SpellLogState => ({ casts: {}, rows: [] })

/** Only public cast events enter this projection. No snapshot or loadout is accepted. */
export function mapSpellLog(state: SpellLogState, entries: readonly LogEntry[], me: PlayerKey | null) {
    const casts = { ...state.casts }
    const added: SpellLogRow[] = []
    const append = (caster: PlayerKey, spell: SpellId, prefix = '') => {
        const side = sidesFor(me).left === caster ? 'left' : 'right'
        const text = `${prefix}${SPELLS[spell].label}`
        const who = me === null ? (caster === 'player1' ? 'PLAYER 1' : 'PLAYER 2') : side === 'left' ? 'YOU' : 'RIVAL'
        added.push({ text, side, label: `${who}: ${text}` })
    }
    for (const [index, entry] of entries.entries()) {
        switch (entry.type) {
            case 'START_CAST':
                casts[entry.caster] = entry.spellId
                break
            case 'SPELL_RELEASE':
                append(entry.caster, entry.spellId)
                delete casts[entry.caster]
                break
            case 'CANCEL_CAST':
                append(entry.caster, entry.spellId, 'CANCELLED ')
                delete casts[entry.caster]
                break
            case 'STOP_CAST':
                if (
                    entries[index + 1]?.type === 'SPELL_RELEASE' &&
                    (entries[index + 1] as Extract<LogEntry, { type: 'SPELL_RELEASE' }>).caster === entry.caster
                )
                    break
                if (casts[entry.caster]) append(entry.caster, casts[entry.caster]!, 'CANCELLED ')
                delete casts[entry.caster]
                break
            case 'INTERRUPTED':
                append(enemyOf(entry.player), entry.spellId, 'INTERRUPTED ')
                delete casts[entry.player]
                break
        }
    }
    return { casts, rows: [...state.rows, ...added].slice(-4), added }
}

/** Fixed destinations for reduced motion; ordinary rows approach their new slot in 150ms. */
export const logRowY = (current: number, target: number, dt: number, reduced: boolean) =>
    reduced ? target : current + (target - current) * Math.min(1, dt / 0.15)
