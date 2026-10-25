# paper-snap

Headless Paper Snapshot: an Effect v4 CLI that captures a page with the Paper Snapshot extension's serializer and writes it into Paper through the Paper app's MCP relay.

- No Paper code lives in this repository. `src/extension.ts` downloads the extension from the Chrome Web Store, evaluates its scripts in a `node:vm` sandbox with an inert `chrome` stand-in, and selects the serializer by its marker strings, so new extension releases need no code change. Keep it that way: the repository is public.
- Every behaviour is reachable through a flag in `src/cli.ts`; new behaviour gets a flag with a default.
- Browser sources are CDP endpoints behind `Browser.Source` (launch, cdp, agent-browser, playwriter). Attached browsers are never closed: over CDP, `browser.close()` closes the user's Chrome.
- Stdout is reserved for `--out -` and `--json`; logs go to stderr.
- Use the local [Effect skill](.agents/skills/effect/SKILL.md) for Effect APIs; it is reviewed against Effect 4.0.0 and the pinned version here is 4.0.0-rc.112. Import Effect modules by namespace (`import * as Effect from "effect/Effect"`), never from the barrel.
- Lint and format config lives in `vite.config.ts`. Anti-slop provenance is in `tools/oxlint/anti-slop/UPSTREAM.md`; fix violations rather than suppressing them. Use the [install-anti-slop skill](.agents/skills/install-anti-slop/SKILL.md) to update it.
- `skills/paper-snap/SKILL.md` is the user-facing agent skill. Edit it when flags or workflows change.

After cloning, run `bun install && bun run setup` (patches TypeScript with Effect diagnostics, installs git hooks).

Run `bun run check` after changes: formatting, anti-slop lint, TypeScript with Effect diagnostics, and Knip. `dist/bin.mjs` is committed so `npm install -g https://github.com/jeremyosih/paper-snap/tarball/main` works without a build step: run `bun run build` and commit `dist/` with every source change. `bun run dev -- <args>` runs from source.
