# Enni readiness gate

Ask [Enni](https://enni.vibana.com) whether a ticket, change or document is ready — and fail the job unless it is.

## Try it on a public repo — no account

Check every issue as it is opened or edited. Save this as `.github/workflows/enni.yml`:

```yaml
name: Enni readiness
on:
  issues:
    types: [opened, edited, reopened]
jobs:
  readiness:
    runs-on: ubuntu-latest
    steps:
      - uses: situated-ai/enni-action@v1
        with:
          token: public
          subject-url: ${{ github.event.issue.html_url }}
          intent: implement
```

No signup: `token: public` asks Enni's public check, which runs the same rules over any public GitHub issue or pull request and stores nothing. The job fails until the issue is ready, and its summary page shows what to change first. **Read-only:** it never comments, labels or merges.

`public` has to be written out: an empty token (a missing or misnamed secret) is never taken as the public check, and fails. The job also fails, and the log says why, when the public check is busy (it is rate-limited — try again in a few minutes) or can't read the link publicly (a private repository — use a token).

Each public-mode run ends with one line on what an Enni space adds — private repos, and checks that learn your team — and where to [get started](https://enni.vibana.com/get-started?ref=action).

## With an Enni space

A token checks private repos too, through everything your space knows. Check every pull request before review:

```yaml
name: Enni readiness
on:
  pull_request:
    types: [opened, edited, synchronize, reopened]
jobs:
  readiness:
    runs-on: ubuntu-latest
    steps:
      - uses: situated-ai/enni-action@v1
        with:
          token: ${{ secrets.ENNI_CI_TOKEN }}
          subject-url: ${{ github.event.pull_request.html_url }}
          intent: review
```

The job fails until Enni says the work behind the pull request is ready, so reviewers see the gap before they read the diff. Free while Enni is in beta, and a free tier stays after.

No Enni account yet? [Get started](https://enni.vibana.com/get-started?ref=action), then follow Setup.

### Setup

1. **Make a CI token in Enni** (an admin of your space):
   1. In the sidebar, under **Settings**, open **Let a tool ask Enni**.
   2. Pick the **GitHub Actions** chip.
   3. Press **Make a CI token**, then **Copy**.

   The token can run readiness checks and nothing else, for that space only. **It is shown once** — if you lose it, make another.
2. **Save it in GitHub**: your repository → **Settings → Secrets and variables → Actions → New repository secret**, named `ENNI_CI_TOKEN`.
3. Add the step above. Pin `@v1`: fixes reach you without editing the workflow.

## Inputs

| Input | Required | Default | |
|---|---|---|---|
| `enni-url` | no | `https://enni.vibana.com` | The Enni origin to ask |
| `token` | yes | | A CI token (`check_readiness` only), or `public` for the public check: public GitHub issues and pull requests, no account |
| `subject-url` | yes | | The link to judge |
| `intent` | no | | `implement`, `review`, `deploy`, `approve` or `publish`. An unknown value is ignored, never refused |
| `wait-ms` | no | `20000` | How long Enni waits for a running check, per attempt (max 25000). Token only |
| `attempts` | no | `6` | How many times to ask. Asking again joins the same check — it never starts a second. Token only: the public check answers at once |
| `fail-on-not-ready` | no | `true` | Set `false` to report without failing |

## The job's summary

Each run writes Enni's verdict to the job's summary page, with the three things to change first and a suggested rewrite of the issue's missing sections (acceptance criteria, steps, expected and actual) you can paste back into the issue.

## Outputs

`ok` (`"true"` when ready), `verdict`, `brief-url`, and `receipt` — a signed receipt a later step can verify at `<enni-url>/api/gate/verify`. With `token: public`, `brief-url` and `receipt` are empty; when the public check refuses (busy, or a link it can't read), every output is and the job fails.

## How it decides

The job passes only when Enni's answer says `ok: true` (with `token: public`: when the verdict is `ready`). **It never reads the HTTP status as the verdict**: a server error, a refusal, or a body without an answer fails the job — a problem on Enni's side is never a passing gate. That holds for the public check too: busy, or a link it can't read publicly, fails the job. An empty token fails as well; it never falls back to the public check.

## Releasing

Push a version tag (`git tag v1.2.1 && git push origin v1.2.1`). The `release` workflow runs the tests, creates the GitHub release with generated notes and moves `v1` to it, so everyone pinned to `@v1` gets it. GitHub only publishes to the Marketplace from the release page's checkbox; tick it now and then to refresh the listing.

## Development

```sh
bun test   # runs gate.sh against a scripted server; needs bash, curl and jq
```

## License

[MIT](LICENSE)
