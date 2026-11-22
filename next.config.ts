import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  serverExternalPackages: ['@msgpack/msgpack'],
  // The Lab reads the cached price/funding CSVs at runtime; make sure they ship with the function.
  outputFileTracingIncludes: {
    '/api/lab': ['./backtest/data/*.csv'],
  },
};

export default nextConfig;
