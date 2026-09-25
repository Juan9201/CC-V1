/** @type {import('next').NextConfig} */
const nextConfig = {
  // 3001 y 3002 comparten este código. Cada uno usa su propia carpeta para poder estar abiertos a la vez.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  experimental: {
    middlewareClientMaxBodySize: "2048mb",
  },
  async rewrites() {
    return [{ source: "/api/:path*", destination: "http://127.0.0.1:8001/api/:path*" }];
  },
};

export default nextConfig;
