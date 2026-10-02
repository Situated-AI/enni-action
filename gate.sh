#!/usr/bin/env bash
# The gate's loop: call check_readiness over MCP, and while the answer is pending, wait
# retry_after_ms and ask again — which joins the same check, so six attempts are never six checks.
#
# Deliberately NOT `curl --fail-with-body`: a refused answer arrives as 200 with ok=false, and a curl
# that treated the HTTP status as the verdict would report a server problem as a passing gate the
# day that changed. The verdict is `ok` in the body. A body with no answer in it is a failure,
# whatever the status code says.
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
  if [[ "$ok" != "true" && "${ENNI_FAIL_ON_NOT_READY:-true}" == "true" ]]; then
    echo "::error::Not ready: $(jq -r '.summary' <<<"$answer")"
    exit 1
  fi
  exit 0
done

echo "::error::Still checking after $attempts attempts. Re-run the job; it will join the same check."
exit 1
