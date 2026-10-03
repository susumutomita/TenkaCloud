/**
 * [#2696 PR5] The platform's one fixed intro drill for local play. It must be a
 * real container problem because the local catalog excludes AWS-only problems.
 * `sqli-demo` is the documented reference container problem and works with the
 * default Docker runtime. A single named constant keeps the pin decision in one
 * place instead of being re-decided per caller / component.
 */
export const LOCAL_INTRO_DRILL_PROBLEM_ID = "sqli-demo";
