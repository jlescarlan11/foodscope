import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { configureHttpServer } from '../src/http-server.js';

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
});
