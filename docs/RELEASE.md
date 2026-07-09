# Release process

This document describes how a release of `@freelensapp/for-claude-extension`
is cut. It relies entirely on the GitHub Actions automation already present
in the repository — no manual `npm publish` or `git tag` is needed.

## Mechanics

The release chain is three workflows that hand off to one another.

1. **Bump the version.** Run the **Automated npm version**
   (`npm-version.yaml`) workflow from the Actions tab (`workflow_dispatch`),
   passing the target version in the `newversion` input:
   - an exact `X.Y.Z` for a real release;
   - the default `prerelease` for a development pack (this is what runs
     automatically after each published release to reopen the dev cycle).

   The workflow bumps `package.json` via `pnpm bump-version` and opens (or
   updates) a pull request titled `Automated npm version vX.Y.Z` on the
   `automated/npm-version` branch.

2. **Merge the version PR.** Review the `Automated npm version vX.Y.Z` PR
   and merge it. On merge, the **tag** workflow (`tag.yaml`) creates the
   `vX.Y.Z` tag from `main` — only for stable `X.Y.Z` versions; prerelease
   versions never tag. (Commenting `/tag` on the closed PR's issue triggers
   the same tagging.)

3. **Publish on tag push.** The `vX.Y.Z` tag push triggers the **release**
   workflow (`release.yaml`), which:
   - guards that the tag matches the `package.json` version;
   - builds and packs the extension;
   - publishes to npm (with provenance or `NPM_TOKEN`) — dist-tag `next` for
     hyphenated prerelease versions, `latest` otherwise;
   - generates an SPDX SBOM and sha256 checksums;
   - creates the GitHub release with the `.tgz` and checksum assets.

4. **Dev cycle reopens.** After the GitHub release is published, the
   version workflow auto-runs once more with `prerelease` to bump into the
   next development version.

The integration-tests workflow (`integration-tests.yaml`) builds Freelens
from `freelensapp/freelens` and installs the packed `.tgz` at runtime,
failing on any renderer or main-process error output — the automated install
smoke test that runs per pull request and on `main`.

Note: the workflow files under `.github/workflows/` cannot be edited through
the Claude GitHub App. Any change there must be applied by a maintainer;
none is required to cut a release.

## Pre-release checklist

Before cutting a stable `X.Y.Z` release:

- [ ] `pnpm lint:check && pnpm type:check && pnpm test:unit && pnpm build`
      pass on `main`; integration tests are green.
- [ ] Manual smoke test in a real Freelens:
  - onboarding panel appears when Claude Code is absent;
  - a read-only question is answered from tool calls;
  - one approved mutation succeeds;
  - one denied mutation is refused;
  - restart Freelens and confirm the transcript resumes.
- [ ] README claims are still accurate — the Freelens version floor and the
      feature/tool list match the shipped code.
- [ ] **Anthropic terms-of-service contact (D2 gate).** Before any public
      announcement or marketplace submission, contact Anthropic to confirm
      the terms-of-service posture recorded in
      [PLAN.md D2](./PLAN.md#d2-authentication-and-terms-of-service-posture-approved).
      Publishing the GitHub release itself is fine — the project has been
      public throughout; it is the announcement that the maintainer
      deferred until after legal review.
