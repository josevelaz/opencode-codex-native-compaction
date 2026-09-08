---
title: Releases
description: Publish and maintain the npm package with the manual Release workflow.
---

# Releases

This guide is for the repository maintainer. Releases use one manual `Release` workflow, a main-only environment, immutable exact tags, and a movable major alias. There is no `semantic-release` path.

This is a solo-maintained project. The maintainer starts each operation; no second reviewer is required. Dry runs and explicit confirmation protect against unintended publication.

The workflow also publishes the npm package during `publish`, with provenance.

### Trunk and tag policy

- All changes land on `main` first. `main` is the only source of new work.
- Release branches (`release/vX.Y`) receive only approved squash backports of commits that already exist on `main`.
- Never merge a release branch back into `main`. Fix forward on `main` and backport the fix.
- Never delete a published release or its tag. Correct a bad release by publishing a new patch version.
- Exact version tags (`X.Y.Z`, `X.Y.Z-rc.N`) are immutable. Once pushed, a tag keeps its target commit forever.
- The major alias tag (`X`) is movable. It points at the highest stable release of that major line.

Versions are canonical SemVer with no leading `v`: `1.0.0` or `1.0.0-rc.1`.

### One-time repository setup

Complete this checklist before publishing. The guard enforces the environment restrictions; it does not verify npm setup or all repository settings.

1. Create a `release` environment with no required reviewers, administrator bypass disabled, and a sole custom deployment branch policy of `main`.
2. Confirm that the maintainer can dispatch Actions workflows. Run every release operation from `main`.
3. Enable npm [trusted publishing](https://docs.npmjs.com/trusted-publishers) for `@josevelaz/opencode-codex-native-compaction`: GitHub owner `josevelaz`, repository `opencode-codex-native-compaction`, workflow filename `release.yml`, environment `release`, permission `npm publish`. Do not store an `NPM_TOKEN`. The package must exist before you can configure a trusted publisher; see the bootstrap procedure below.
4. Enable auto-merge and squash merge. The `backport` operation opens squash-merge pull requests.
5. Enable Immutable Releases so published release tags cannot be moved or deleted.
6. Keep the existing validation workflows enabled. Release execution runs validation before it plans mutations.
7. Keep branch rules compatible with workflow-created version commits and branch deletion. The workflow uses only `GITHUB_TOKEN`, with no bypass token.
8. Do not require another person's approval for this solo-maintained release process.
9. Do not create a ruleset that targets release tags or major aliases. The workflow moves only the major alias `X`.
10. Do not pre-create release branches or tags. The workflow creates every line it owns.

### Bootstrap the npm package once

Skip this procedure if the package already exists. This is the one-time exception to workflow-based publication: npm requires an existing package before it accepts a trusted publisher.

1. Sign in to npm, verify your email, and enable account-level two-factor authentication (2FA).
2. In your own terminal, run `npm login` and complete its browser and 2FA prompts. Confirm the account with `npm whoami`. Keep credentials out of the repository and issue reports.
3. From the clean, reviewed checkout, run `bun run validate` and `bun run pack:check`. Confirm that `package.json` names `@josevelaz/opencode-codex-native-compaction`, is version `0.0.0`, and that this version has never been published.
4. Publish under a non-default tag:

   ```sh
   npm publish --access public --tag bootstrap --provenance=false
   ```

   **This permanently uses version `0.0.0`.** Local publication cannot produce GitHub Actions provenance. The `bootstrap` tag avoids assigning this version to `latest`.

5. Configure the GitHub Actions trusted publisher in npm package settings using the values above. With npm 11.15.0 or later, you can also run:

   ```sh
   npm trust github @josevelaz/opencode-codex-native-compaction \
     --repo josevelaz/opencode-codex-native-compaction \
     --file release.yml \
     --env release \
     --allow-publish
   ```

6. In npm publishing-access settings, require 2FA and disallow tokens. Trusted publishing still works with this setting. Remove the temporary CLI credential with `npm logout` when setup is complete.
7. Use the workflow below to cut, draft, and publish `0.1.0`. Later releases use GitHub Actions OIDC and provenance, not the bootstrap procedure.

See npm's [trusted publisher prerequisites](https://docs.npmjs.com/cli/v12/commands/npm-trust#prerequisites). A saved binding is not proof that OIDC works: the owner, repository, workflow filename, and environment must all match the actual run.

### Operations

Every operation accepts `dry_run`. A dry run plans the work, writes artifacts, and does not mutate repository or registry state. `dry_run` defaults to `true`. Every run uses the main-only `release` environment without a reviewer gate.

The examples below use `1.0.0` to show the version format, not to claim that version is published. Use the intended release version; `0.1.0` is suitable for the first experimental release.

Always pass `--ref main`. The guard rejects any other ref.

Each operation accepts only its own fields plus `dry_run`. A populated field that the operation does not use is a hard input error.

```bash
gh workflow run Release --ref main \
  -f operation=cut \
  -f version=1.0.0 \
  -f dry_run=true
```

From the Actions UI, open **Actions → Release → Run workflow**, select `main`, choose the operation, fill that operation's fields, and leave `dry_run` checked. Read the plan, then re-run with `-f dry_run=false`.

#### cut

Creates `release/vX.Y` from `main`. `version` must be an initial line version with patch `0`.

```bash
gh workflow run Release --ref main \
  -f operation=cut \
  -f version=1.0.0 \
  -f dry_run=true
```

#### backport

Opens a squash-merge pull request that replays trunk commits onto an existing release line, in the order given.

```bash
gh workflow run Release --ref main \
  -f operation=backport \
  -f release_line=release/v1.0 \
  -f commits=1111111111111111111111111111111111111111 \
  -f dry_run=true
```

#### draft

Sets `package.json` on the release line, pushes the exact version tag, and creates a draft GitHub Release. `version` must belong to `release_line`.

```bash
gh workflow run Release --ref main \
  -f operation=draft \
  -f release_line=release/v1.0 \
  -f version=1.0.0 \
  -f dry_run=true
```

#### publish

Moves the major alias `X` when this is the highest stable tag of that major line, publishes the existing GitHub draft, then publishes to npm with provenance. RC releases use the npm dist-tag `next` and do not move a major alias.

> **Partial-publication limit:** npm publication runs after the GitHub Release becomes public. If npm fails, the GitHub Release remains published and this operation cannot simply be rerun because it requires a draft. Confirm npm setup before running live. If publication fails, inspect both registries and preserve the published tag; do not delete a published release to retry.

`confirmation` must be exactly `publish <version>`.

```bash
gh workflow run Release --ref main \
  -f operation=publish \
  -f version=1.0.0 \
  -f confirmation='publish 1.0.0' \
  -f dry_run=true
```

#### cancel

Deletes an unpublished draft and its exact version tag. Use it only before publication.

`confirmation` must be exactly `cancel <version>`.

```bash
gh workflow run Release --ref main \
  -f operation=cancel \
  -f version=1.0.0 \
  -f confirmation='cancel 1.0.0' \
  -f dry_run=true
```

If a cancel run stops partway through, inspect its artifacts and the live tag before taking further action. The CLI accepts a `resume_proof` field for recovery, but the workflow does not generate that proof automatically. Do not assume a normal rerun can finish every partial cancellation.

#### retire

Deletes a release branch. Published tags and releases are never touched.

`confirmation` must be exactly `retire <release_line>`.

```bash
gh workflow run Release --ref main \
  -f operation=retire \
  -f release_line=release/v1.0 \
  -f confirmation='retire release/v1.0' \
  -f dry_run=true
```

#### restore

Recreates a retired release branch at its highest stable-version tag, excluding RC tags. The planner selects by tag version, not GitHub publication state. Before running it, confirm that the highest stable-version tag has a published release rather than an unpublished draft.

```bash
gh workflow run Release --ref main \
  -f operation=restore \
  -f release_line=release/v1.0 \
  -f dry_run=true
```

### How a run proceeds

1. **Guard.** A job with only `actions: read` checks that the ref is `refs/heads/main` and that the `release` environment disables administrator bypass and has a sole deployment branch policy named `main`. It never declares the environment itself, because referencing a missing environment would create it without restrictions.
2. **Execution.** The `Execute` job targets the main-only `release` environment. The maintainer's manual dispatch starts the run without a second reviewer.
3. **Serialization.** The workflow uses the concurrency group `release` with `cancel-in-progress: false`. Running operations do not overlap or cancel each other. GitHub can replace a pending run when another is queued, so dispatch one operation at a time and wait for its result.
4. **Exact-SHA checkout.** Execute checks out the dispatch SHA, not a moving `main` ref, then validates the package before it plans mutations.
5. **Artifacts.** Every run writes `release-plan.json` and `release-result.json`. Draft runs also write `release-notes.md`.
