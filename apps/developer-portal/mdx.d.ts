// MDX modules compile to a React component. Typing them keeps `import Page from
// "./page.mdx"` strongly typed across the docs content layer.
declare module "*.mdx" {
  import type { ComponentType } from "react";

  export const frontmatter: Record<string, unknown>;
  const MDXComponent: ComponentType<Record<string, unknown>>;
  export default MDXComponent;
}
