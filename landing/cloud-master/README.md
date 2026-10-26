# Cloud Master

A Japanese, frontend-only cloud foundations game at `/cloud-master/`.
The landing page links here. No accounts, persistence, analytics, or remote APIs.

## Preview and test

From the repository root:

```sh
python3 -m http.server 4173 --directory landing
bun test scripts/landing/cloud-master.test.ts
make before-commit
```

Open `http://localhost:4173/cloud-master/` in a browser.
The static files need no build step and ship through the existing
`tenkacloud-www` Cloudflare Pages project (`wrangler.toml`, output `landing/`).
Use a branch preview to review changes; merging and production publication are
separate operations. Do not deploy this directory over the entire existing LP.

## Rules

- The timed mode has 75 seconds of active play. Reading explanations pauses time.
- Learning mode has all 20 scenarios, with no falling deadline or overall timer.
- Correct answers give 100 points plus 20 per consecutive correct answer,
  capped at a 100-point bonus. A mistake or missed card breaks the chain.
- Every third consecutive correct answer lights another point on the sky path.
  The longest chain keeps those points lit for the rest of the current playthrough.
- Wrong answers and missed cards explain the correct role before continuing.
- A hidden tab, unfocused window, or page navigation pauses play. Resume is manual.
- Keys 1–5 answer; P or Escape pauses/resumes. Buttons support touch and keyboard.
- Reduced motion keeps the scenario still; its deadline bar and timer remain.
- Scores describe only this playthrough and do not certify cloud skills.

`engine.js` contains the question bank and deterministic state transitions.
Seed 726 produces the same scenario order on every restart. `game.js` owns the DOM,
clock, focus, and browser lifecycle. `game.css` owns responsive presentation.

Browser QA should cover correct/wrong taps, repeated taps, keyboard answers,
missed cards, pause/resume, background pause, restart, timer completion, learning
completion, reduced motion, and question/control visibility on a 320px screen.
Real iOS Safari and physical-device testing remain separate from Chromium touch
emulation.
