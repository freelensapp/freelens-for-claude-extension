# github-workflows

This directory is a staging area for GitHub Actions workflow changes that the
Claude GitHub App cannot commit directly. The App backing the `@claude`
workflow lacks the `workflows` permission, so any push that touches
`.github/workflows/**` is rejected.

Files here are meant to be moved into `.github/workflows/` manually.

## claude.yaml

Full copy of `.github/workflows/claude.yaml` with a new `report-failure` job
added. This "last resort" job runs only when the main `claude` job did not
succeed (`failure` or `cancelled` — the latter is what a 60-minute
`timeout-minutes` cancellation produces). It re-invokes `claude-code-action` to:

- diagnose the root cause of the failure via `gh run view --log-failed`,
- post a concise status comment on the triggering PR or issue,
- fix any stalled tracking comment left by the interrupted run (remove the
  in-progress spinner and unchecked todos).

The job is scoped to feedback only — its prompt forbids attempting the original
requested work. It fires via `needs: [parse, claude]` with `always()` and has
its own `timeout-minutes: 15` to keep the fallback bounded.

To apply:

```bash
mv github-workflows/claude.yaml .github/workflows/claude.yaml
rmdir github-workflows 2>/dev/null || true
```
