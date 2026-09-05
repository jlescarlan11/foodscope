import type { Server } from 'node:http';

type HttpApplication = {
  listen(port: number, hostname: string): Server;
};

export function configureHttpServer(server: Server) {
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.timeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;
}

export function startHttpServer(
  app: HttpApplication,
  port: number,
  host: string,
  onListening: () => void,
) {
  const server = app.listen(port, host);
  configureHttpServer(server);
  server.once('listening', onListening);
  return server;
}
