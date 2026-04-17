/** @type {import('next').NextConfig} */
const internalApiOrigin = process.env.NEXT_PUBLIC_API_URL || 'http://api:4000';

const nextConfig = {
  output: 'standalone',
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${internalApiOrigin}/api/:path*`,
      },
      {
        source: '/ws/:path*',
        destination: `${internalApiOrigin}/ws/:path*`,
      },
    ];
  },
};

export default nextConfig;
