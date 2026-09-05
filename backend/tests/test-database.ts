const disposableName = /(?:^|[_-])(?:test|ci)(?:[_-]|$)/i;
const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);

export function resolveTestDatabaseUrl(value: string | undefined) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const databaseName = decodeURIComponent(url.pathname.slice(1));
    if (
      url.protocol !== 'mysql:' ||
      !loopbackHosts.has(url.hostname) ||
      !disposableName.test(databaseName)
    ) {
      throw new Error();
    }
    return value;
  } catch {
    throw new Error('Refusing to run integration tests against a non-disposable database');
  }
}
