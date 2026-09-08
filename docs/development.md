---
title: Development
description: Validate the plugin, inspect its package, and maintain the documentation site.
---

# Development

## Install and validate

Use Bun 1.4 or later for lockfile v2 support and Node.js 24 or later for package tooling. CI uses the latest Bun release.

```sh
bun install --frozen-lockfile
bun run validate
bun run pack:check
```

`validate` runs `bun test` and both TypeScript checks: plugin code and the release CLI. `pack:check` runs `npm pack --dry-run` to show what npm would ship. It does not publish anything.

To run checks separately:

```sh
bun test
bun run typecheck
```

The npm package ships TypeScript source, its license, and README. Tests, documentation source, and release tooling are excluded by the `files` allowlist in `package.json`.

## Source map

| File | Responsibility |
| --- | --- |
| `src/index.ts` | Plugin options, hooks, request interception, and checkpoint lifecycle. |
| `src/protocol.ts` | Codex request encoding, marker parsing, and image limits. |
| `src/pending.ts` | Compaction attempt retry vs cleanup decisions. |
| `src/history.ts` | Retained text selection and checkpoint replacement history. |
| `src/sse.ts` | Native response validation and transcript-marker response. |
| `src/state.ts` | Stored checkpoint validation and model compatibility. |
| `.github/scripts/release/` | Manual release operations and version rules. |

## Verify compatibility changes

The package pins OpenCode's plugin, AI, and core packages to one beta build. It also imports OpenCode's durable-history projection code. Do not assume that matching hook names alone ensure compatibility.

Before claiming support for a newer OpenCode release, validate the package and test the installed package in a disposable session. Check a normal request, native compaction, checkpoint replay, model switching, and service restart. Unit tests alone do not prove that the subscription endpoint still accepts the protocol.

## Documentation site

The site lives in `docs/`. It uses Markdown, a small Jekyll layout, and CSS with no client-side JavaScript or external fonts.

- Edit page content in `docs/*.md`.
- Edit navigation and the repository URL prefix in `docs/_config.yml`.
- Edit layout and styles in `docs/_layouts/default.html` and `docs/assets/style.css`.
- Keep internal page links relative so they work under the repository's GitHub Pages path.

The `Documentation` workflow builds pull requests without deploying them. Pushes to `main` that change the site build and deploy to GitHub Pages. You can also run the workflow manually from `main`.

The build uses `actions/jekyll-build-pages`; the deploy job uses the `github-pages` environment with `pages: write` and `id-token: write`. Repository **Settings → Pages → Source** must be **GitHub Actions**. No separate `gh-pages` branch is needed.

For a local preview with a compatible Jekyll installation:

```sh
jekyll serve --source docs --destination _site
```

Open the repository path under the local server: `http://127.0.0.1:4000/opencode-codex-native-compaction/`. The generated `_site` directory is ignored by Git.

## Publish

Use the [release guide](releases.html). Package publication is separate from documentation deployment. The manual `Release` workflow owns release branches, tags, GitHub Releases, and npm publication.
