import { test, expect } from '@playwright/test';
import { createServer } from './grade-notifications';
import type { AddressInfo } from 'net';
import EventSource from 'eventsource';

const startServer = async () => {
  const app = createServer();
  /* Listen on a random available port */
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  /* Fastify returns address string; resolve port via server */
  const info = app.server.address() as AddressInfo | null;
  if (!info || typeof info.port !== 'number') {
    throw new Error(`Could not determine server port from address: ${address}`);
  }
  const baseURL = `http://127.0.0.1:${info.port}`;
  return { app, baseURL };
};

const stopServer = async (app: ReturnType<typeof createServer>) => {
  await app.close();
};

const onceMessage = (es: EventSource, predicate: (data: any) => boolean, timeoutMs = 2000): Promise<any> => {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for SSE message'));
    }, timeoutMs);
    const onMessage = (evt: MessageEvent) => {
      try {
        const data = JSON.parse((evt as any).data);
        if (predicate(data)) {
          cleanup();
          resolve(data);
        }
      } catch {}
    };
    const onError = (err: any) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      clearTimeout(timer);
      es.removeEventListener('message', onMessage as any);
      es.removeEventListener('error', onError as any);
    };
    es.addEventListener('message', onMessage as any);
    es.addEventListener('error', onError as any);
  });
};

test('Student receives notification when connected', async ({ request }) => {
  const { app, baseURL } = await startServer();
  try {
    const es = new EventSource(`${baseURL}/sse?studentId=student-1`);
    const waitLive = onceMessage(es, (d) => d.type === 'live');
    const res = await request.post(`${baseURL}/publish`, { data: { studentId: 'student-1', message: 'New grade posted' } });
    expect(res.ok()).toBeTruthy();
    const data = await waitLive;
    expect(data.message).toBe('New grade posted');
    es.close();
  } finally {
    await stopServer(app);
  }
});

test('Student receives missed notifications on reconnect', async ({ request }) => {
  const { app, baseURL } = await startServer();
  try {
    /* publish while disconnected */
    const res1 = await request.post(`${baseURL}/publish`, { data: { studentId: 'student-2', message: 'Grade A on Math' } });
    expect(res1.ok()).toBeTruthy();

    /* connect and expect a missed notification */
    const es = new EventSource(`${baseURL}/sse?studentId=student-2`);
    const missed = await onceMessage(es, (d) => d.type === 'missed');
    expect(missed.message).toBe('Grade A on Math');
    es.close();
  } finally {
    await stopServer(app);
  }
});

test('Batch publish sends to multiple students', async ({ request }) => {
  const { app, baseURL } = await startServer();
  try {
    const es1 = new EventSource(`${baseURL}/sse?studentId=s3`);
    const es2 = new EventSource(`${baseURL}/sse?studentId=s4`);
    const wait1 = onceMessage(es1, (d) => d.type === 'live');
    const wait2 = onceMessage(es2, (d) => d.type === 'live');

    const res = await request.post(`${baseURL}/publish/batch`, {
      data: {
        notifications: [
          { studentId: 's3', message: 'Science grade updated' },
          { studentId: 's4', message: 'History grade updated' },
        ],
      },
    });
    expect(res.ok()).toBeTruthy();

    const d1 = await wait1;
    const d2 = await wait2;
    expect(d1.message).toContain('Science');
    expect(d2.message).toContain('History');
    es1.close();
    es2.close();
  } finally {
    await stopServer(app);
  }
});

test('Connection cleanup after disconnect', async ({ request }) => {
  const { app, baseURL } = await startServer();
  try {
    const es = new EventSource(`${baseURL}/sse?studentId=cleanup-1`);
    /* ensure connection established by waiting for any event (a ping may not show as message, so wait a short time) */
    await new Promise((r) => setTimeout(r, 100));
    es.close();
    await new Promise((r) => setTimeout(r, 100));
    const metrics = await (await request.get(`${baseURL}/metrics`)).json();
    expect(metrics.connectionsActive).toBeGreaterThanOrEqual(0);
    /* expect no active connections for this student specifically by publishing and ensuring no send occurs */
    const before = metrics.notificationsSent;
    await request.post(`${baseURL}/publish`, { data: { studentId: 'cleanup-1', message: 'test' } });
    const metrics2 = await (await request.get(`${baseURL}/metrics`)).json();
    expect(metrics2.notificationsSent).toBe(before); // no active connections should receive
  } finally {
    await stopServer(app);
  }
});
