import { describe, expect, it } from 'bun:test';
import { createRealtimeTransport } from '../src/transport';

function fakeChannel() {
    const sent: Array<Record<string, unknown>> = [];
    const handlers = new Map<string, (msg: { payload: Record<string, unknown> }) => void>();
    let subscribed: ((status: string) => void) | undefined;
    const channel = {
        on(_type: 'broadcast', filter: { event: string }, cb: (msg: { payload: Record<string, unknown> }) => void) {
            handlers.set(filter.event, cb);
            return channel;
        },
        subscribe(cb?: (status: string) => void) { subscribed = cb; return channel; },
        send: async (msg: { type: 'broadcast'; event: string; payload: Record<string, unknown> }) => { sent.push(msg); return 'ok'; },
        unsubscribe: async () => 'ok',
    };
    return {
        channel,
        sent,
        emitClient: (payload: Record<string, unknown>) => handlers.get('client')?.({ payload }),
        connect: () => subscribed?.('SUBSCRIBED'),
    };
}

describe('createRealtimeTransport', () => {
    it('subscribes to the session topic and resolves ready() on SUBSCRIBED', async () => {
        const fake = fakeChannel();
        let topic = '';
        const transport = createRealtimeTransport({
            channelFactory: (t) => { topic = t; return fake.channel; },
            sessionId: 's-1',
            onClientMessage: () => {},
        });
        const ready = transport.ready();
        fake.connect();
        await ready;
        expect(topic).toBe('session:s-1');
    });

    it('broadcast sends on the "message" event with the payload unwrapped', async () => {
        const fake = fakeChannel();
        const transport = createRealtimeTransport({
            channelFactory: () => fake.channel, sessionId: 's-1', onClientMessage: () => {},
        });
        const ready = transport.ready();
        fake.connect();
        await ready;
        transport.broadcast({ type: 'file_generated', file: { filePath: 'a.ts', fileContents: 'x' } });
        await new Promise((r) => setTimeout(r, 0));
        expect(fake.sent).toHaveLength(1);
        expect(fake.sent[0]).toMatchObject({ type: 'broadcast', event: 'message', payload: { type: 'file_generated' } });
    });

    it('routes inbound "client" events to onClientMessage with the raw string and a sendable connection', async () => {
        const fake = fakeChannel();
        const received: string[] = [];
        const transport = createRealtimeTransport({
            channelFactory: () => fake.channel,
            sessionId: 's-1',
            onClientMessage: (raw, connection) => {
                received.push(raw);
                connection.send(JSON.stringify({ type: 'ack' }));
            },
        });
        const ready = transport.ready();
        fake.connect();
        await ready;
        fake.emitClient({ raw: JSON.stringify({ type: 'generate_all' }) });
        await new Promise((r) => setTimeout(r, 0));
        expect(received).toEqual([JSON.stringify({ type: 'generate_all' })]);
        expect(fake.sent.some((m) => (m.payload as { type?: string })?.type === 'ack')).toBe(true);
    });
});
