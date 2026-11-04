import type { LobbyRegistry } from './registry'
import type { LobbyRoom } from './lobby-room'

export interface Env {
    LOBBY: DurableObjectNamespace<LobbyRoom>
    REGISTRY: DurableObjectNamespace<LobbyRegistry>
    ALLOWED_ORIGINS: string
}

export const registryOf = (env: Env) => env.REGISTRY.get(env.REGISTRY.idFromName('global'))
export const lobbyOf = (env: Env, code: string) => env.LOBBY.get(env.LOBBY.idFromName(code))
