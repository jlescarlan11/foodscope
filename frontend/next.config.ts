import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  async headers() {
    return [{
      source: '/:path*',
      headers: [
        { key: 'Content-Security-Policy', value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'" },
        { key: 'Permissions-Policy', value: 'camera=(), geolocation=(), microphone=()' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'X-Frame-Options', value: 'DENY' },
      ],
    }];
  },
  images: {
    maximumResponseBody: 5_000_000,
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'images.openfoodfacts.org',
        pathname: '/images/products/**',
        search: '',
      },
    ],
  },
};

export default nextConfig;
