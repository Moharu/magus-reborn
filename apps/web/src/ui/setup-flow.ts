import type { LobbyInfo, LobbyPlayerInfo } from '@magus/engine/protocol'

/** Pre-game setup is round 1; every later set up is the quick swap between rounds. */
export type SetupFlow = 'pregame' | 'swap'

export interface SetupAccess {
    flow: SetupFlow
    /** The element can only be chosen before the match. */
    elementLocked: boolean
    /** Whether the loadout can be changed right now. */
    editable: boolean
    /** Why it can't, for the hint line. Null when editable. */
    lockedReason: string | null
}

/**
 * What a player may do on the set up screen. Between rounds the loadout is editable only when the
 * lobby allows spell changes, and never once the player is ready.
 */
export const setupAccess = (
    lobby: Pick<LobbyInfo, 'round' | 'settings'> & { countdown?: number | null },
    me: Pick<LobbyPlayerInfo, 'ready'> | null,
): SetupAccess => {
    const flow: SetupFlow = lobby.round <= 1 ? 'pregame' : 'swap'
    const allowed = flow === 'pregame' || lobby.settings.allowSpellChange
    const expired = lobby.countdown === 0
    const editable = allowed && !me?.ready && !expired
    return {
        flow,
        elementLocked: flow === 'swap',
        editable,
        lockedReason: editable ? null : !allowed ? 'Spell changes are off in this lobby.' : 'Spells locked in.',
    }
}

/** Whether a set_spells message may be sent: the player may still edit and the loadout is valid. */
export const canSendLoadout = (access: SetupAccess, valid: boolean) => access.editable && valid
