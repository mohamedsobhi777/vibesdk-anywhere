import type { ConnectionLike } from 'worker/agents/core/websocket';

export interface RealtimeChannelLike {
    on(type: 'broadcast', filter: { event: string }, cb: (msg: { payload: Record<string, unknown> }) => void): RealtimeChannelLike;
    subscribe(cb?: (status: string) => void): RealtimeChannelLike;
    send(msg: { type: 'broadcast'; event: string; payload: Record<string, unknown> }): Promise<unknown>;
    unsubscribe(): Promise<unknown>;
}

export type ChannelFactory = (topic: string) => RealtimeChannelLike;

export interface AgentTransport {
    ready(): Promise<void>;
    broadcast(message: Record<string, unknown>): void;
    connection: ConnectionLike;
    close(): Promise<void>;
}

export function createRealtimeTransport(options: {
    channelFactory: ChannelFactory;
    sessionId: string;
    onClientMessage: (raw: string, connection: ConnectionLike) => void;
}): AgentTransport {
    const topic = `session:${options.sessionId}`;
    const channel = options.channelFactory(topic);

    let resolveReady: () => void;
    let rejectReady: (err: Error) => void;
    const readyPromise = new Promise<void>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
    });

    const broadcast = (message: Record<string, unknown>): void => {
        void channel.send({ type: 'broadcast', event: 'message', payload: message }).catch((error) => {
            console.error(`realtime broadcast failed: ${error instanceof Error ? error.message : String(error)}`);
        });
    };

    const connection: ConnectionLike = {
        id: `realtime:${options.sessionId}`,
        send(data: string) {
            broadcast(JSON.parse(data) as Record<string, unknown>);
        },
        url: null,
    };

    channel
        .on('broadcast', { event: 'client' }, ({ payload }) => {
            const raw = typeof payload.raw === 'string' ? payload.raw : JSON.stringify(payload);
            options.onClientMessage(raw, connection);
        })
        .subscribe((status) => {
            if (status === 'SUBSCRIBED') resolveReady();
            if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
                rejectReady(new Error(`realtime channel ${topic} failed to subscribe: ${status}`));
            }
        });

    return {
        ready: () => readyPromise,
        broadcast,
        connection,
        close: async () => { await channel.unsubscribe(); },
    };
}
