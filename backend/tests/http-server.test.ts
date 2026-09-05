import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureHttpServer, startHttpServer } from '../src/http-server.js';

describe('HTTP server resource limits', () => {
  const servers: ReturnType<typeof createServer>[] = [];
  afterEach(() => servers.splice(0).forEach((server) => server.close()));

  it('bounds slow requests and connection reuse', () => {
    const server = createServer();
    servers.push(server);

    configureHttpServer(server);

    expect(server.headersTimeout).toBe(10_000);
    expect(server.requestTimeout).toBe(15_000);
    expect(server.timeout).toBe(30_000);
    expect(server.keepAliveTimeout).toBe(5_000);
    expect(server.maxRequestsPerSocket).toBe(100);
  });

  it('announces success only from the server listening event', () => {
    const server = createServer();
    servers.push(server);
    const app = { listen: vi.fn(() => server) };
    const onListening = vi.fn();

    const started = startHttpServer(app, 4000, '127.0.0.1', onListening);

    expect(started).toBe(server);
    expect(app.listen).toHaveBeenCalledWith(4000, '127.0.0.1');
    expect(onListening).not.toHaveBeenCalled();
    server.emit('listening');
    expect(onListening).toHaveBeenCalledOnce();
  });
});
