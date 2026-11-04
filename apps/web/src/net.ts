import type { ClientMessage, ServerMessage } from '@magus/engine/protocol'

export interface Socket {
    send(message: ClientMessage | string): void
    close(): void
}

interface Options<M> {
    url: () => string
    onMessage: (message: M) => void
    onStatus?: (status: 'connecting' | 'open' | 'reconnecting') => void
    /** Stop reconnecting when this returns true for a message (e.g. fatal errors). */
    isFatal?: (message: M) => boolean
}

/** WebSocket that reconnects with backoff until closed or a fatal message arrives. */
export const connect = <M = ServerMessage>({ url, onMessage, onStatus, isFatal }: Options<M>): Socket => {
    let ws: WebSocket | null = null
    let closed = false
    let attempt = 0
    let retry: ReturnType<typeof setTimeout> | null = null

    const open = () => {
        onStatus?.(attempt === 0 ? 'connecting' : 'reconnecting')
        ws = new WebSocket(url())
        ws.onopen = () => {
            attempt = 0
            onStatus?.('open')
        }
        ws.onmessage = event => {
            let message: M
            try {
                message = JSON.parse(event.data)
            } catch {
                return
            }
            if (isFatal?.(message)) closed = true
            onMessage(message)
        }
        ws.onclose = () => {
            ws = null
            if (closed) return
            attempt += 1
            onStatus?.('reconnecting')
            retry = setTimeout(open, Math.min(8000, 500 * 2 ** Math.min(attempt, 4)))
        }
    }
    open()

    return {
        send(message) {
            if (ws?.readyState === WebSocket.OPEN)
                ws.send(typeof message === 'string' ? message : JSON.stringify(message))
        },
        close() {
            closed = true
            if (retry) clearTimeout(retry)
            ws?.close()
        },
    }
}
