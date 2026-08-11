# Publishing the pkgwarden companion extension

The companion ships to **Microsoft Marketplace** and **Open VSX**. Open VSX publication is
load-bearing: gate's catalog crawl is Open VSX–sourced, which feeds the scanner and the
`pkgwarden.companion` self-allow pin-map injection.

Development stays in this monorepo. Publishing happens from the public mirror repo
**[pkgwarden/companion](https://github.com/pkgwarden/companion)** so the marketplace artifact
provably builds from public source — the same pattern used for `pkgwarden/pkgwarden_cli`
(see `.github/workflows/mirror-pkgwarden-cli.yml`).

## One-time setup (manual, JP)

1. **Mirror token** — create a fine-grained PAT scoped to `pkgwarden/companion` with
   **Contents (Read and write)**, **Workflows (Read and write)**, and **Actions
   (Read and write)** (the last is needed to dispatch the public repo's release workflow).
   Store it as secret `PKGWARDEN_COMPANION_MIRROR_TOKEN` **on the pkgwarden development
   monorepo** (where this file is edited), not on the public mirror.
2. **Microsoft Marketplace** — create publisher `pkgwarden` and a Personal Access Token with
   **Marketplace → Manage** scope. Store it as secret `VSCE_PAT` **on `pkgwarden/companion`**.
3. **Open VSX** — register namespace `pkgwarden` at [open-vsx.org](https://open-vsx.org/) and
   create an access token. Store it as secret `OVSX_PAT` **on `pkgwarden/companion`**.
4. **Flip `pkgwarden/companion` public** — the repo is created but stays **private** until JP
   reviews the first mirrored snapshot (run the mirror with `skip_release_build: true`,
   inspect the pushed commit and tag, then flip repo visibility to public by hand).

No runtime env vars are added for end users; only these CI secrets are required.

## Release flow

1. Bump `version` in `vscode-companion/package.json` on the monorepo `main` branch.
2. From the monorepo, run **workflow_dispatch** on `.github/workflows/mirror-companion.yml`.
   It snapshots `vscode-companion/` (via `git archive`) into a fresh single-commit history,
   generates a standalone `pnpm-lock.yaml` for it (`pnpm install --lockfile-only`, because the
   monorepo keeps the companion's dependencies in the workspace-root lockfile), force-pushes
   `main` and the tag `companion-v<version>` to `pkgwarden/companion`, then
   dispatches that repo's `release.yml` on the pushed tag. Pass `skip_release_build: true` to
   push the snapshot **without** publishing (the first-ever review before flipping the repo
   public, or any re-mirror you do not want released).
3. `pkgwarden/companion`'s in-tree workflow (`vscode-companion/.github/workflows/release.yml`
   here, `release.yml` once mirrored) runs: `pnpm install --frozen-lockfile` → typecheck →
   vitest → `vsce package` → `vsce publish` (if `VSCE_PAT` set) → `ovsx publish` (if `OVSX_PAT`
   set). Missing secrets skip the corresponding registry with a logged message rather than
   failing the run.

`release.yml` is **workflow_dispatch only**. The mirror force-pushes tags on every run,
including snapshot-review runs, so a tag-push trigger would publish work that was never meant
to ship; the mirror's explicit dispatch is the single path to a publish.

Re-running a release for a version that is already live **fails** at `vsce publish` /
`ovsx publish` (registries reject a duplicate version). Bump the version and re-mirror rather
than re-releasing the same tag.

The public repo also runs `vscode-companion/.github/workflows/ci.yml` (`ci.yml` once mirrored:
typecheck + vitest + package) on every push/PR to its `main`. It never runs the `uat` harness
(`pnpm run uat`), which needs a live editor and a local gate stack; the harness's own pure unit
tests run with the rest of the vitest suite.

Publishing itself remains **held** behind the companion UAT campaign (phase 5 of its tracking
issue in the development monorepo) regardless of whether these secrets exist.

## Bootstrap note for new companion versions

A brand-new companion version enters customer pin maps only after **Open VSX crawl + clean
scan** (self-allow skips quarantine aging only; malicious/withheld verdicts are never
admitted). Users already syncing via `pw vscode sync-policy` get `pkgwarden.companion` pinned
automatically once gate PR 1 is deployed, so marketplace install works without hand-editing
`extensions.allowed`.

## Local dry run

```bash
just companion-package
# VSIX: vscode-companion/dist/pkgwarden-companion.vsix
code --install-extension vscode-companion/dist/pkgwarden-companion.vsix
```
