import { describe, expect, it } from 'vitest';
import nextConfig from '../next.config';

describe('Next.js image cost boundaries', () => {
  it('bounds each remote image response before optimization', () => {
    expect(nextConfig.images).toMatchObject({ maximumResponseBody: 5_000_000 });
  });
});
