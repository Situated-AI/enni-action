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

describe("the job's summary page (Enni contract v9)", () => {
  const summaryFile = () => join(mkdtempSync(join(tmpdir(), "gate-sum-")), "summary.md");

  test("the verdict, the top three changes and the rewrite, with the untrusted tags dropped", async () => {
    const wrap = (text: string) => `<untrusted-excerpt source="github" url="u">${text}</untrusted-excerpt>`;
    serve([
      answer({
        status: "complete",
        ok: false,
        verdict: "not-ready",
        summary: "An open PR already works on this.",
        brief_url: "/briefs/b2",
        answer: {
          why: [
            { reason: "r", recommendation: wrap("Review or help with acme/web#12 instead.") },
            { reason: "Add acceptance criteria." },
            { reason: "r3", recommendation: "Name the files." },
            { reason: "r4", recommendation: "Not shown." },
          ],
          rewrite: { markdown: wrap("## Acceptance criteria\n- [ ] Proposed: x") },
        },
      }),
    ]);
    const file = summaryFile();
    await runGate({ GITHUB_STEP_SUMMARY: file, ENNI_FAIL_ON_NOT_READY: "false" });
    const md = readFileSync(file, "utf8");
    expect(md).toContain("## Enni: not-ready");
    expect(md).toContain("1. Review or help with acme/web#12 instead.");
    expect(md).toContain("2. Add acceptance criteria.");
    expect(md).toContain("3. Name the files.");
    expect(md).not.toContain("Not shown.");
    expect(md).toContain("## Acceptance criteria\n- [ ] Proposed: x");
    expect(md).not.toContain("untrusted-excerpt");
  });

  test("an older answer without why or rewrite still prints its verdict", async () => {
    serve([READY]);
    const file = summaryFile();
    expect((await runGate({ GITHUB_STEP_SUMMARY: file })).code).toBe(0);
    const md = readFileSync(file, "utf8");
    expect(md).toContain("## Enni: ready");
    expect(md).not.toContain("What to change first");
  });
});

describe("with token: public — Enni's public check (enni-v2 #736)", () => {
  const PUBLIC_NOT_READY = {
    key: "https://github.com/acme/web/issues/7",
    verdict: "not-ready",
    checks: [],
    caveats: [],
    answer: {
      state: "answer",
      sentence: "4 of 14 checks passed.",
      why: [{ text: "It is closed as done.", recommendation: "Reopen it first." }, { text: "No done-check." }],
      rewrite: { markdown: "## Acceptance criteria\n- [ ] x" },
    },
  };
  const problem = (status: number, code: string, detail: string): Reply => ({
    status,
    body: { type: "about:blank", title: "t", status, detail, code },
  });

  /** Serve `reply` to every GET, and record each request's path and query. */
  function servePublic(reply: Reply) {
    const seen: { url: URL; auth: string | null }[] = [];
    server = Bun.serve({
      port: 0,
      fetch(request) {
        seen.push({ url: new URL(request.url), auth: request.headers.get("authorization") });
        return Response.json(reply.body, { status: reply.status ?? 200 });
      },
    });
    return seen;
  }
  const subject = "https://github.com/acme/web/issues/7";
  const tokenless = (extra: Record<string, string> = {}) =>
    runGate({ ENNI_TOKEN: "public", ENNI_SUBJECT_URL: subject, ...extra });

  test("one GET of the public check, no credential, the verdict mapped onto the outputs", async () => {
    const seen = servePublic({ body: { ...PUBLIC_NOT_READY, verdict: "ready" } });
    const { code, outputs, log } = await tokenless();
    expect(code).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.auth).toBeNull();
    expect(seen[0]?.url.pathname).toBe("/api/public/check");
    expect(seen[0]?.url.searchParams.get("url")).toBe(subject);
    expect(seen[0]?.url.searchParams.get("intent")).toBe("deploy");
    expect(outputs).toContain("ok=true");
    expect(outputs).toContain("verdict=ready");
    expect(log).toContain("/get-started?ref=action");
  });

  test("a verdict short of ready fails the job, and the summary page has its why and rewrite", async () => {
    servePublic({ body: PUBLIC_NOT_READY });
    const file = join(mkdtempSync(join(tmpdir(), "gate-pub-")), "summary.md");
    const { code, outputs } = await tokenless({ GITHUB_STEP_SUMMARY: file });
    expect(code).toBe(1);
    expect(outputs).toContain("ok=false");
    const md = readFileSync(file, "utf8");
    expect(md).toContain("## Enni: not-ready");
    expect(md).toContain("1. Reopen it first.");
    expect(md).toContain("2. No done-check.");
    expect(md).toContain("## Acceptance criteria");
    expect(md).toContain("/get-started?ref=action");
  });

  test("ready-with-caveats is not ok, as with a token", async () => {
    servePublic({ body: { ...PUBLIC_NOT_READY, verdict: "ready-with-caveats" } });
    const { code, outputs } = await tokenless({ ENNI_FAIL_ON_NOT_READY: "false" });
    expect(code).toBe(0);
    expect(outputs).toContain("ok=false");
  });

  test("an unknown intent is left out, never sent to be refused", async () => {
    const seen = servePublic({ body: PUBLIC_NOT_READY });
    await tokenless({ ENNI_INTENT: "ship-it", ENNI_FAIL_ON_NOT_READY: "false" });
    expect(seen[0]?.url.searchParams.has("intent")).toBe(false);
  });

  test("busy fails the job, says so, and writes no verdict", async () => {
    servePublic(problem(429, "rate_limited", "A lot of people are checking right now."));
    const { code, outputs, log } = await tokenless();
    expect(code).toBe(1);
    expect(outputs).not.toContain("ok=");
    expect(log).toContain("::error::Enni's public check is busy");
    expect(log).toContain("try again in a few minutes");
    expect(log).toContain("/get-started?ref=action");
  });

  test("private or not found fails the job, and points to a token", async () => {
    for (const [status, code] of [
      [403, "forbidden"],
      [404, "not_found"],
    ] as const) {
      servePublic(problem(status, code, "That repository is private."));
      const run = await tokenless();
      expect(run.code).toBe(1);
      expect(run.outputs).not.toContain("ok=");
      expect(run.log).toContain("::error::");
      expect(run.log).toContain("isn't a public issue or pull request");
      expect(run.log).toContain("use a token");
      expect(run.log).toContain("/get-started?ref=action");
      server?.stop(true);
    }
  });

  test("an empty token (a missing secret) is never the public check: it asks MCP, and fails", async () => {
    const seen: { method: string; path: string; auth: string | null }[] = [];
    server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        seen.push({ method: request.method, path: url.pathname, auth: request.headers.get("authorization") });
        if (url.pathname === "/api/public/check") return Response.json({ ...PUBLIC_NOT_READY, verdict: "ready" });
        return Response.json(
          { jsonrpc: "2.0", id: 1, error: { code: -32001, message: "Unauthorized" } },
          { status: 401 },
        );
      },
    });
    const { code, log } = await runGate({ ENNI_TOKEN: "", ENNI_SUBJECT_URL: subject });
    expect(code).toBe(1);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s.method === "POST" && s.path === "/api/mcp")).toBe(true);
    expect(log).not.toContain("/get-started?ref=action");
  });

  test("a link it cannot read, or a server problem, still fails", async () => {
    servePublic(problem(400, "invalid_request", "That isn't a link to a GitHub issue."));
    const refused = await tokenless();
    expect(refused.code).toBe(1);
    expect(refused.log).toContain("That isn't a link to a GitHub issue.");
    server?.stop(true);
    servePublic({ status: 500, body: { ok: true, verdict: undefined } });
    expect((await tokenless()).code).toBe(1);
  });

  test("follows the 308 to the canonical query", async () => {
    let hops = 0;
    server = Bun.serve({
      port: 0,
      fetch(request) {
        hops++;
        const url = new URL(request.url);
        if (!url.searchParams.has("canonical")) {
          return new Response(null, { status: 308, headers: { location: `${url.pathname}?canonical=1` } });
        }
        return Response.json({ ...PUBLIC_NOT_READY, verdict: "ready" });
      },
    });
    expect((await tokenless()).code).toBe(0);
    expect(hops).toBe(2);
  });
});
