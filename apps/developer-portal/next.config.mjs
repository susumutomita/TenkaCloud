import createMDX from "@next/mdx";

const withMDX = createMDX({
  extension: /\.mdx?$/,
});

/** @type {import('next').NextConfig} */
const nextConfig = {
  // The developer portal is a fully static export: public routes
  // (landing, product, docs, API reference, examples, changelog) are pre-rendered
  // and CDN-cached. The future authenticated /developers/sandbox/* segment will
  // flip this to the server runtime; that change is deferred to the sandbox PR.
  output: "export",
  pageExtensions: ["ts", "tsx", "mdx"],
  // Static export needs trailing-slash routing so nested routes resolve as
  // directories on the CDN.
  trailingSlash: true,
  reactStrictMode: true,
  // Legacy landing redirects are handled by the static `<meta http-equiv>` /
  // route stubs under src/app, because `redirects()` is not emitted by
  // `output: export`. See src/lib/redirects.ts (single source of truth).
};

export default withMDX(nextConfig);
