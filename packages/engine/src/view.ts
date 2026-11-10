import { CLASS_RESOURCE_KEYS } from './catalog'
import type { BattleSnapshot, PlayerKey, PlayerView, SnapshotView } from './types'

/**
 * `snap` as `viewer` may see it: a player sees their own loadout and class resources (#171, `CLASS_RESOURCES`) and
 * not their opponent's; a spectator sees both. The one place they are redacted, and the server sends every battle
 * snapshot through it. The spell being cast stays visible as `casting`. Pure: `snap` is left as it is.
 */
export const viewSnapshot = (snap: BattleSnapshot, viewer: PlayerKey | 'spectator'): SnapshotView => {
    const player = (key: PlayerKey): PlayerView => {
        const { spells, ...rest } = snap[key]
        const casting = snap[key].cast === null ? null : (spells[snap[key].cast] ?? null)
        if (viewer === 'spectator' || viewer === key) return { ...rest, spells, casting }
        const hidden: PlayerView = { ...rest, casting }
        for (const resource of CLASS_RESOURCE_KEYS) delete hidden[resource]
        // Haste's `backup` is every slot's original cast time: the loadout's order and kinds
        hidden.effects = rest.effects.map(effect => {
            if (effect.id !== 'BUFF_HASTE') return effect
            const { backup: _backup, ...visible } = effect
            return visible
        })
        return hidden
    }
    return { ...snap, player1: player('player1'), player2: player('player2') }
}
