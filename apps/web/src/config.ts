const server = (import.meta.env.VITE_SERVER_URL as string | undefined) ?? 'http://localhost:8787'

export const SERVER_URL = server.replace(/\/+$/, '')
export const WS_URL = SERVER_URL.replace(/^http/, 'ws')
