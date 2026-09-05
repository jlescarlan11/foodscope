import type { Server } from 'node:http';

export function configureHttpServer(server: Server) {
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.timeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;
}
