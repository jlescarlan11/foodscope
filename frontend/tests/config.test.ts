import { describe, expect, it } from 'vitest';
import { resolveApiUrl } from '../src/config';

describe('browser API configuration', () => {
  it('keeps the localhost default outside production', () => {
    expect(resolveApiUrl(undefined, 'development')).toBe('http://localhost:4000');
    expect(resolveApiUrl(undefined, 'test')).toBe('http://localhost:4000');
  });

  it('does not embed localhost when production configuration is absent', () => {
    expect(() => resolveApiUrl(undefined, 'production')).toThrow(
      'NEXT_PUBLIC_API_URL is required for production builds',
    );
  });

  it('requires one absolute HTTP(S) origin', () => {
    for (const value of [
      '*',
      'api.example',
      'ftp://api.example',
      'https://api.example/path',
      'https://user:secret@api.example',
    ]) {
      expect(() => resolveApiUrl(value, 'production')).toThrow(
        'NEXT_PUBLIC_API_URL must be an absolute HTTP(S) origin',
      );
    }

    expect(resolveApiUrl('https://api.example/', 'production')).toBe('https://api.example');
  });
});
