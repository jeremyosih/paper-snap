# paper-snapshot

Headless Paper Snapshot: an Effect v4 CLI that captures a page with the Paper Snapshot extension's serializer and writes it into Paper through the Paper app's MCP relay.

- No Paper code lives in this repository. `src/extension.ts` downloads the extension from the Chrome Web Store, evaluates its scripts in a `node:vm` sandbox with an inert `chrome` stand-in, and selects the serializer by its marker strings, so new extension releases need no code change. Keep it that way: the repository is public.
- Every behaviour is reachable through a flag in `src/cli.ts`; new behaviour gets a flag with a default.
- Browser sources are CDP endpoints behind `Browser.Source` (launch, chrome, agent-browser, playwriter, cdp). Attached browsers are never closed: over CDP, `browser.close()` closes the user's Chrome.
- Stdout is reserved for `--out -` and `--json`; logs go to stderr.
- Use the local [Effect skill](.agents/skills/effect/SKILL.md) for Effect APIs; it is reviewed against Effect 4.0.0 and the pinned version here is 4.0.6. The CLI, process, HTTP, FileSystem and Path modules are marked unstable in Effect 4; this tool is built on them, so the `unstableApiUsage` diagnostic is off in `tsconfig.json`. Import core Effect modules by namespace (`import * as Effect from "effect/Effect"`), never from the `effect` barrel; `cli`, `process` and `http` only have entry points like `import { Command } from "effect/cli"`.
- Lint and format config lives in `vite.config.ts`. Anti-slop provenance is in `tools/oxlint/anti-slop/UPSTREAM.md`; fix violations rather than suppressing them. Use the [install-anti-slop skill](.agents/skills/install-anti-slop/SKILL.md) to update it.
- `skills/paper-snapshot/SKILL.md` is the user-facing agent skill. Edit it when flags or workflows change.

After cloning, run `bun install && bun run setup && bun run hooks:setup` (patches TypeScript with Effect diagnostics, installs git hooks).

Releases: bump `version` in package.json and the version strings in `src/bin.ts` and `src/paper.ts`, rebuild and commit `dist/`, then push a `v<version>` tag. `.github/workflows/release.yml` checks, publishes to npm with provenance through trusted publishing, and creates the GitHub release.

Run `bun run check` after changes: formatting, anti-slop lint, TypeScript with Effect diagnostics, and Knip. `dist/bin.mjs` is committed so installs from GitHub work without a build step: run `bun run build` and commit `dist/` with every source change. The npm package is `paper-snapshot-cli`; its command is `paper-snapshot`. `bun run dev -- <args>` runs from source.
