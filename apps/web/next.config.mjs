/**
 * The standalone output is what the Docker image runs, but producing it requires
 * creating symlinks, which is not permitted for an unprivileged user on Windows.
 * It is therefore enabled explicitly in the Dockerfile, so a build on the host
 * still compiles and type-checks the whole application.
 */
const standalone = process.env.NEXT_STANDALONE === "1";

/** @type {import('next').NextConfig} */
const nextConfig = {
  ...(standalone ? { output: "standalone" } : {}),
  reactStrictMode: true,
  // noVNC ships untranspiled ES modules.
  transpilePackages: ["@novnc/novnc"],
  eslint: { ignoreDuringBuilds: true }
};

export default nextConfig;
