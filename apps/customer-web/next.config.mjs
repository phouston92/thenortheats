export default (phase) => ({
  distDir: phase === "phase-development-server" ? ".next-dev" : ".next",
  transpilePackages: [],
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: "http://127.0.0.1:3001/api/:path*",
      },
    ];
  },
});
