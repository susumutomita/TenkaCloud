import type { MDXComponents } from "mdx/types";

// Required by @next/mdx in the App Router. Shared MDX component overrides (callouts,
// code tabs, badges) plug in here so docs and examples render with the same chrome
// as the rest of the app (ADR-0003 §6: reusable MDX components from the shared ui).
export function useMDXComponents(components: MDXComponents): MDXComponents {
  return {
    ...components,
  };
}
