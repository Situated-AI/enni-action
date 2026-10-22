#!/usr/bin/env bash
# The gate's loop: call check_readiness over MCP, and while the answer is pending, wait
# retry_after_ms and ask again — which joins the same check, so six attempts are never six checks.
#
# Deliberately NOT `curl --fail-with-body`: a refused answer arrives as 200 with ok=false, and a curl
# that treated the HTTP status as the verdict would report a server problem as a passing gate the
# day that changed. The verdict is `ok` in the body. A body with no answer in it is a failure,
# whatever the status code says.
#
# With `token: public`, the gate asks Enni's public check instead: one GET, no account, public GitHub
# issues and pull requests only, the rules' answer (no pending, so no loop). See `public_check`.
# An empty token is not the public check: a missing secret goes to MCP as before, and fails.
set -uo pipefail

url="${ENNI_URL%/}/api/mcp"
attempts="${ENNI_ATTEMPTS:-6}"
out="${GITHUB_OUTPUT:-/dev/null}"

request() {
  jq -cn --arg s "$ENNI_SUBJECT_URL" --arg i "${ENNI_INTENT:-}" --argjson w "${ENNI_WAIT_MS:-20000}" \
    '{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"check_readiness",
      arguments:({subject_url:$s,wait_ms:$w} + (if $i == "" then {} else {intent:$i} end))}}'
}

ask() {
  curl -sS -X POST "$url" \
    -H "authorization: Bearer $ENNI_TOKEN" \
    -H "content-type: application/json" \
    -H "user-agent: enni-gate-action/1" \
    --data "$(request)"
}

# The job's summary page: the verdict, the top three things to change, and the paste-ready rewrite
# (Enni contract v9, enni-v2 #647). Every field is optional, so an older answer prints what it has.
# Quotes and recommendations arrive wrapped as untrusted excerpts; the tags are dropped for reading.
write_summary() {
  [[ -n "${GITHUB_STEP_SUMMARY:-}" ]] || return 0
  jq -r '
    def plain: tostring | gsub("<untrusted-excerpt[^>]*>|</untrusted-excerpt>"; "");
    "## Enni: \(.verdict // "no verdict")\n\n\(.summary // "" | plain)\n",
    (if ((.answer.why // []) | length) > 0 then
      "### What to change first\n",
      ((.answer.why // [])[:3] | to_entries[] | "\(.key + 1). \((.value.recommendation // .value.reason // .value.text // "") | plain)"),
      "" else empty end),
    (if .answer.rewrite.markdown then
      "<details><summary>Suggested rewrite (paste into the issue)</summary>\n\n```markdown\n\(.answer.rewrite.markdown | plain)\n```\n</details>\n"
      else empty end),
    (if .brief_url then "[The full answer](\(.brief_url))" else empty end)
  ' <<<"$1" >>"$GITHUB_STEP_SUMMARY" 2>/dev/null || true
}

# Value first: what an account adds, and where to get one. Printed on every public-mode run.
upgrade_line() {
  local line="Checked without an account: the public rules only. With an Enni space it also checks private repos and learns your team: ${ENNI_URL%/}/get-started?ref=action"
  echo "$line"
  [[ -z "${GITHUB_STEP_SUMMARY:-}" ]] || printf '\n%s\n' "$line" >>"$GITHUB_STEP_SUMMARY"
}

# The public path: `GET /api/public/check` (the same rubric, public GitHub only, nothing stored).
# Its answer has no `ok`; it is `verdict == "ready"`, exactly as Enni derives `ok` for a token.
# A refusal is problem+json with a `code`. Every refusal fails the job, as on the token path: Enni
# being busy, or the link not being public, is a problem on Enni's side, never a passing gate.
public_check() {
  trap upgrade_line EXIT
  local query=(--data-urlencode "url=$ENNI_SUBJECT_URL")
  # The public check refuses an unknown intent; the action promises to ignore one.
  case "${ENNI_INTENT:-}" in
    implement | review | deploy | approve | publish) query+=(--data-urlencode "intent=$ENNI_INTENT") ;;
  esac
  local body
  # -L: Enni answers a link in any spelling but its own with a 308 to the canonical one.
  body="$(curl -sS -L --get "${ENNI_URL%/}/api/public/check" "${query[@]}" \
    -H "user-agent: enni-gate-action/1")" || { echo "::error::Enni did not answer."; exit 1; }
  local verdict
  verdict="$(jq -r '.verdict // empty' <<<"$body" 2>/dev/null)"
  if [[ -z "$verdict" ]]; then
    local code detail
    code="$(jq -r '.code // empty' <<<"$body" 2>/dev/null)"
    detail="$(jq -r '.detail // empty' <<<"$body" 2>/dev/null)"
    case "$code" in
      rate_limited)
        echo "::error::Enni's public check is busy, so this run has no answer: try again in a few minutes.${detail:+ ($detail)}"
        ;;
      forbidden | not_found)
        # GitHub shows a private repository to a stranger as not found, so both mean the same here.
        echo "::error::Enni's public check can't read that link: it isn't a public issue or pull request.${detail:+ ($detail)} For a private repo, use a token."
        ;;
      *) echo "::error::Enni refused: ${detail:-$body}" ;;
    esac
    exit 1
  fi
  local ok summary
  ok="$([[ "$verdict" == "ready" ]] && echo true || echo false)"
  summary="$(jq -r '.answer.sentence // ""' <<<"$body")"
  {
    echo "ok=$ok"
    echo "verdict=$verdict"
    echo "brief-url="
    echo "receipt="
  } >>"$out"
  echo "Enni: $verdict — $summary"
  write_summary "$(jq -c '{verdict, summary: .answer.sentence, answer}' <<<"$body")"
  if [[ "$ok" != "true" && "${ENNI_FAIL_ON_NOT_READY:-true}" == "true" ]]; then
    echo "::error::Not ready: $(jq -r '[.answer.why[]?.text][0] // .answer.sentence // ""' <<<"$body")"
    exit 1
  fi
  exit 0
}

[[ "${ENNI_TOKEN:-}" != "public" ]] || public_check

for ((attempt = 1; attempt <= attempts; attempt++)); do
  body="$(ask)" || { echo "::error::Enni did not answer (attempt $attempt)."; exit 1; }
  answer="$(jq -c '.result.structuredContent // empty' <<<"$body" 2>/dev/null)"
  if [[ -z "$answer" ]]; then
    said="$(jq -r '.result.content[0].text // .error.message // .detail // "no answer"' <<<"$body" 2>/dev/null)"
    echo "::error::Enni refused: ${said:-$body}"
    exit 1
  fi
  status="$(jq -r '.status' <<<"$answer")"
  if [[ "$status" == "pending" ]]; then
    wait_ms="$(jq -r '.retry_after_ms // 2000' <<<"$answer")"
    echo "Still checking (attempt $attempt of $attempts); asking again in ${wait_ms} ms."
    sleep "$(awk "BEGIN { print $wait_ms / 1000 }")"
    continue
  fi
  ok="$(jq -r 'if .ok == true then "true" else "false" end' <<<"$answer")"
  {
    echo "ok=$ok"
    echo "verdict=$(jq -r '.verdict // ""' <<<"$answer")"
    echo "brief-url=$(jq -r '.brief_url // ""' <<<"$answer")"
    echo "receipt=$(jq -r '.receipt // ""' <<<"$answer")"
  } >>"$out"
  echo "Enni: $(jq -r '.verdict' <<<"$answer") — $(jq -r '.summary' <<<"$answer")"
  write_summary "$answer"
  if [[ "$ok" != "true" && "${ENNI_FAIL_ON_NOT_READY:-true}" == "true" ]]; then
    echo "::error::Not ready: $(jq -r '.summary' <<<"$answer")"
    exit 1
  fi
  exit 0
done

echo "::error::Still checking after $attempts attempts. Re-run the job; it will join the same check."
exit 1
