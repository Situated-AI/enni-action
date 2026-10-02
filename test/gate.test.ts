/**
 * The action's loop, run for real against a scripted MCP server: six attempts at most,
 * each one the same `check_readiness` call — which joins the run in flight — and the verdict
 * read from `ok` in the body, **never from the HTTP status**.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GATE = join(import.meta.dir, "..", "gate.sh");

type Reply = { readonly status?: number; readonly body: unknown };

const answer = (content: Record<string, unknown>): Reply => ({
  body: { jsonrpc: "2.0", id: 1, result: { structuredContent: content } },
});
const PENDING = answer({ status: "pending", run_id: "r1", retry_after_ms: 10, ok: false });
const READY = answer({
  status: "complete",
  ok: true,
  verdict: "ready",
  summary: "Every check passed.",
  brief_url: "/briefs/b1",
  receipt: "enni_r2.x.y",
});

let server: ReturnType<typeof Bun.serve> | undefined;
afterEach(() => server?.stop(true));

/** Serve `replies` in order (the last repeats), and record every request body. */
function serve(replies: readonly Reply[]) {
  const seen: { body: unknown; auth: string | null }[] = [];
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      seen.push({ body: await request.json(), auth: request.headers.get("authorization") });
      const reply = replies[Math.min(seen.length - 1, replies.length - 1)] as Reply;
      return Response.json(reply.body, { status: reply.status ?? 200 });
    },
  });
  return seen;
}

async function runGate(extra: Record<string, string> = {}) {
  const output = join(mkdtempSync(join(tmpdir(), "gate-")), "out");
  const proc = Bun.spawn(["bash", GATE], {
    env: {
      PATH: process.env.PATH ?? "",
      ENNI_URL: `http://localhost:${server?.port}`,
      ENNI_TOKEN: "enni_at_ci",
      ENNI_SUBJECT_URL: "https://linear.app/enni/issue/ENG-1",
      ENNI_INTENT: "deploy",
      ENNI_WAIT_MS: "20000",
      ENNI_ATTEMPTS: "6",
      ENNI_FAIL_ON_NOT_READY: "true",
      GITHUB_OUTPUT: output,
      ...extra,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  const outputs = (() => {
    try {
      return readFileSync(output, "utf8");
    } catch {
      return "";
    }
  })();
  return { code, outputs, log: await new Response(proc.stdout).text() };
}

describe("the gate's loop", () => {
  test("pending, pending, ready: three asks of the same call, then the outputs", async () => {
    const seen = serve([PENDING, PENDING, READY]);
    const { code, outputs } = await runGate();
    expect(code).toBe(0);
    expect(seen).toHaveLength(3);
    expect(new Set(seen.map((s) => JSON.stringify(s.body))).size).toBe(1);
    expect(seen[0]).toEqual({
      auth: "Bearer enni_at_ci",
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "check_readiness",
          arguments: {
            subject_url: "https://linear.app/enni/issue/ENG-1",
            wait_ms: 20000,
            intent: "deploy",
          },
        },
      },
    });
    expect(outputs).toContain("ok=true");
    expect(outputs).toContain("receipt=enni_r2.x.y");
    expect(outputs).toContain("brief-url=/briefs/b1");
  });

  test("six attempts at most — still pending fails, and asks no seventh time", async () => {
    const seen = serve([PENDING]);
    expect((await runGate()).code).toBe(1);
    expect(seen).toHaveLength(6);
  });

  test("a 200 answering ok=false fails the job: the verdict is ok, not the status", async () => {
    serve([answer({ status: "complete", ok: false, verdict: "needs-work", summary: "No owner." })]);
    const { code, outputs } = await runGate();
    expect(code).toBe(1);
    expect(outputs).toContain("ok=false");
  });

  test("a server problem is never a passing gate — whatever its body or status says", async () => {
    serve([{ status: 500, body: { ok: true, verdict: "ready" } }]);
    expect((await runGate()).code).toBe(1);
  });

  test("a refusal (a JSON-RPC error) fails, and says why", async () => {
    serve([{ body: { jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Unknown tool" } } }]);
    const { code, log } = await runGate();
    expect(code).toBe(1);
    expect(log).toContain("Unknown tool");
  });

  test("fail-on-not-ready=false reports without failing", async () => {
    serve([answer({ status: "complete", ok: false, verdict: "needs-work", summary: "s" })]);
    expect((await runGate({ ENNI_FAIL_ON_NOT_READY: "false" })).code).toBe(0);
  });

  test("no --fail-with-body anywhere in the action", () => {
    expect(readFileSync(GATE, "utf8").replace(/^#.*$/gm, "")).not.toContain("--fail");
  });
});
