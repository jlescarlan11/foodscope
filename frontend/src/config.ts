export function resolveApiUrl(value: string | undefined, environment: string | undefined) {
  if (!value && environment !== 'production') return 'http://localhost:4000';
  if (!value) throw new Error('NEXT_PUBLIC_API_URL is required for production builds');

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('NEXT_PUBLIC_API_URL must be an absolute HTTP(S) origin');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('NEXT_PUBLIC_API_URL must be an absolute HTTP(S) origin');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (environment === 'production' && url.protocol !== 'https:' && !loopback) {
    throw new Error('NEXT_PUBLIC_API_URL must use HTTPS in production');
  }
  return url.origin;
}
