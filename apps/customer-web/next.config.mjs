import { fileURLToPath } from "node:url";
export default (phase) => ({
  distDir:
    process.env.NEXT_DIST_DIR ||
    (phase === "phase-development-server" ? ".next-dev" : ".next"),
  transpilePackages: [],
  logging: { incomingRequests: false },
  output: "standalone",
  outputFileTracingExcludes: {
    "/*": [
      "**/node_modules/typescript/**",
      "**/node_modules/.pnpm/typescript@*/**",
    ],
  },
  outputFileTracingRoot: fileURLToPath(new URL("../../", import.meta.url)),
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
          { key: "X-Frame-Options", value: "DENY" },
          ...(process.env.COOKIE_SECURE === "true"
            ? [{ key: "Strict-Transport-Security", value: "max-age=31536000" }]
            : []),
        ],
      },
    ];
  },
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${process.env.API_ORIGIN || "http://127.0.0.1:3001"}/api/:path*`,
      },
    ];
  },
});
