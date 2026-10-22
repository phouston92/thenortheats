export default (phase) => ({
  distDir:
    process.env.NEXT_DIST_DIR ||
    (phase === "phase-development-server" ? ".next-dev" : ".next"),
  transpilePackages: [],
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${process.env.API_ORIGIN || "http://127.0.0.1:3001"}/api/:path*`,
      },
    ];
  },
});
