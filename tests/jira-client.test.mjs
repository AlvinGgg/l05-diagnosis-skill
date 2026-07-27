import assert from "node:assert/strict";
import test from "node:test";
import {JiraClient} from "../scripts/vendor/jira-collector/jira-client.mjs";

function transportError(code, hostname = "jira.example.test") {
  const cause = new Error(`${code} ${hostname}`);
  cause.code = code;
  cause.hostname = hostname;
  return new TypeError("fetch failed", {cause});
}

test("transient transport failures are retried up to the configured limit", async () => {
  let calls = 0;
  const sleeps = [];
  const client = new JiraClient({
    baseUrl: "https://jira.example.test",
    maxRetries: 3,
    sleep: async (ms) => sleeps.push(ms),
    request: async () => {
      calls += 1;
      if (calls < 4) throw transportError("ENOTFOUND");
      return {status: 200, json: {ok: true}};
    },
  });

  assert.deepEqual(await client.issue("DEMO-1"), {ok: true});
  assert.equal(calls, 4);
  assert.deepEqual(sleeps, [250, 500, 1000]);
});

test("exhausted transport retries retain safe troubleshooting metadata", async () => {
  let calls = 0;
  const client = new JiraClient({
    baseUrl: "https://jira.example.test",
    maxRetries: 2,
    sleep: async () => {},
    request: async () => {
      calls += 1;
      throw transportError("ECONNRESET");
    },
  });

  await assert.rejects(
    client.issue("DEMO-1"),
    (error) => error.code === "ECONNRESET"
      && error.hostname === "jira.example.test"
      && error.attempts === 3
      && /after 3 attempts/.test(error.message),
  );
  assert.equal(calls, 3);
});

test("non-retryable HTTP failures exit without repeated requests", async () => {
  let calls = 0;
  const client = new JiraClient({
    baseUrl: "https://jira.example.test",
    maxRetries: 3,
    sleep: async () => {},
    request: async () => {
      calls += 1;
      return {status: 401, headers: {}, text: ""};
    },
  });

  await assert.rejects(client.issue("DEMO-1"), (error) => error.status === 401);
  assert.equal(calls, 1);
});
