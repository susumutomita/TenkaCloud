// web-kit ships a component (ConsoleAuthShell) that imports a co-located stylesheet
// (`import "./console-auth.css"`). The consuming app's Vite bundles the CSS; for
// `tsc --noEmit` we declare side-effect CSS imports as a typeless module.
declare module "*.css";
