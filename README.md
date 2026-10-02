# Enni readiness gate

Ask [Enni](https://enni.vibana.com) whether a ticket, change or document is ready — and fail the job unless it is.

```yaml
- uses: situated-ai/enni-action@v1
  with:
    enni-url: https://your-enni.example.com
    token: ${{ secrets.ENNI_CI_TOKEN }}
    subject-url: ${{ github.event.pull_request.html_url }}
    intent: review
```

## Setup

1. In Enni, an admin of your space makes a **CI token** (*Settings → Tools → GitHub Actions*). It can run readiness checks and nothing else, for that space only, and is shown once.
2. Save it as a repository secret, e.g. `ENNI_CI_TOKEN`.
3. Add the step above. Pin `@v1`: fixes reach you without editing the workflow.

## Inputs

| Input | Required | Default | |
|---|---|---|---|
| `enni-url` | yes | | Your Enni origin |
| `token` | yes | | A CI token (`check_readiness` only) |
| `subject-url` | yes | | The link to judge |
| `intent` | no | | `implement`, `review`, `deploy`, `approve` or `publish`. An unknown value is ignored, never refused |
| `wait-ms` | no | `20000` | How long Enni waits for a running check, per attempt (max 25000) |
| `attempts` | no | `6` | How many times to ask. Asking again joins the same check — it never starts a second |
| `fail-on-not-ready` | no | `true` | Set `false` to report without failing |

## Outputs

`ok` (`"true"` when ready), `verdict`, `brief-url`, and `receipt` — a signed receipt a later step can verify at `<enni-url>/api/gate/verify`.

## How it decides

The job passes only when Enni's answer says `ok: true`. **It never reads the HTTP status as the verdict**: a server error, a refusal, or a body without an answer fails the job — a problem on Enni's side is never a passing gate.

## Development

```sh
bun test   # runs gate.sh against a scripted server; needs bash, curl and jq
```
