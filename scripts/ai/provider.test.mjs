// Verifies provider request construction against a local stand-in server, so the Azure
// wire format can be checked without an Azure resource. Run: node scripts/ai/provider.test.mjs
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createProvider, isContentFilterError, providerErrorMessage } from "./provider.mjs";
import { createLimiter, fetchWithRetry } from "./retry.mjs";

const PNG = Buffer.from("89504e470d0a1a0a", "hex");

function settingsFrom(env) {
  return (name, fallback = "") => env[name] || fallback;
}

async function withServer(handler, run) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const record = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) };
    requests.push(record);
    handler(record, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await run(base, requests);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const okImage = (_record, res) => {
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ data: [{ b64_json: PNG.toString("base64") }] }));
};

async function postEdit(provider, base, model) {
  // Mirrors how import-job-api.mjs builds the multipart edit request.
  const request = provider.imageEditRequest(model);
  const form = new FormData();
  if (request.includeModelField) form.set("model", model);
  form.set("prompt", "a garment");
  form.set("size", "1536x1024");
  form.set("quality", "high");
  if (request.includeImageExtras) form.set("output_format", "png");
  form.append("image[]", new Blob([PNG], { type: "image/png" }), "model.png");
  form.append("image[]", new Blob([PNG], { type: "image/png" }), "garment.png");
  const url = request.url.replace(/^https?:\/\/[^/]+/, base);
  return fetchWithRetry(url, { method: "POST", headers: request.headers, body: form });
}

async function testAzureImageEdit() {
  const provider = createProvider(settingsFrom({
    WARDROBE_AI_PROVIDER: "azure",
    AZURE_OPENAI_ENDPOINT: "https://example.openai.azure.com/",
    AZURE_OPENAI_API_KEY: "azure-secret",
    AZURE_OPENAI_VISION_DEPLOYMENT: "vision-dep",
    AZURE_OPENAI_IMAGE_DEPLOYMENT: "gpt-image-2-dep",
  }));

  assert.equal(provider.imageModel("garment"), "gpt-image-2-dep");
  assert.equal(provider.visionModel(), "vision-dep");
  assert.deepEqual(provider.missingConfig(), []);

  const request = provider.imageEditRequest(provider.imageModel("modeled"));
  assert.equal(
    request.url,
    "https://example.openai.azure.com/openai/deployments/gpt-image-2-dep/images/edits?api-version=2025-04-01-preview",
    "azure edits must use the deployment-scoped path with an explicit api-version",
  );

  await withServer(okImage, async (base, requests) => {
    const response = await postEdit(provider, base, provider.imageModel("modeled"));
    assert.equal(response.status, 200);
    const [record] = requests;
    assert.equal(record.url, "/openai/deployments/gpt-image-2-dep/images/edits?api-version=2025-04-01-preview");
    assert.equal(record.headers["api-key"], "azure-secret");
    assert.equal(record.headers.authorization, undefined, "azure must not send a bearer header");

    const body = record.body.toString("latin1");
    const imageParts = body.match(/name="image\[\]"/g) || [];
    assert.equal(imageParts.length, 2, "both reference images must be sent as repeated image[] fields");
    assert.ok(!/name="model"/.test(body), "azure takes the deployment from the URL, not a model field");
    assert.ok(!/name="output_format"/.test(body), "output_format is not in azure's edits schema");
    assert.ok(!/name="response_format"/.test(body), "gpt-image models always return base64");
    assert.ok(/name="size"[\s\S]*?1536x1024/.test(body));
    assert.ok(/name="quality"[\s\S]*?high/.test(body));
  });
}

async function testAzureResponses() {
  const provider = createProvider(settingsFrom({
    WARDROBE_AI_PROVIDER: "azure",
    AZURE_OPENAI_ENDPOINT: "https://example.openai.azure.com",
    AZURE_OPENAI_API_KEY: "azure-secret",
    AZURE_OPENAI_VISION_DEPLOYMENT: "vision-dep",
    AZURE_OPENAI_IMAGE_DEPLOYMENT: "gpt-image-2-dep",
  }));
  const request = provider.responsesRequest();
  assert.equal(request.url, "https://example.openai.azure.com/openai/v1/responses", "responses uses the GA v1 surface");
  assert.equal(request.headers["api-key"], "azure-secret");
}

async function testOpenAIUnchanged() {
  const provider = createProvider(settingsFrom({ OPENAI_API_KEY: "sk-test" }));
  assert.equal(provider.id, "openai");
  assert.equal(provider.responsesRequest().url, "https://api.openai.com/v1/responses");
  assert.equal(provider.responsesRequest().headers.Authorization, "Bearer sk-test");
  assert.equal(provider.imageModel("garment"), "gpt-image-2");
  assert.equal(provider.visionModel(), "gpt-5.4-mini");

  await withServer(okImage, async (base, requests) => {
    await postEdit(provider, base, provider.imageModel("garment"));
    const body = requests[0].body.toString("latin1");
    assert.equal(requests[0].url, "/v1/images/edits");
    assert.equal(requests[0].headers.authorization, "Bearer sk-test");
    assert.ok(/name="model"/.test(body), "openai still receives the model field");
    assert.ok(/name="output_format"/.test(body), "openai still receives output_format");
  });
}

async function testMissingConfig() {
  const provider = createProvider(settingsFrom({ WARDROBE_AI_PROVIDER: "azure" }));
  assert.deepEqual(provider.missingConfig(), [
    "AZURE_OPENAI_ENDPOINT in .env",
    "AZURE_OPENAI_API_KEY in .env",
    "AZURE_OPENAI_VISION_DEPLOYMENT in .env",
    "AZURE_OPENAI_IMAGE_DEPLOYMENT in .env",
  ]);
  assert.throws(() => createProvider(settingsFrom({ WARDROBE_AI_PROVIDER: "bedrock" })), /Unknown WARDROBE_AI_PROVIDER/);
}

// A lone per-stage override must not pass setup, or the other stage builds a URL with an
// empty deployment segment and fails only after the first stage has already spent quota.
async function testPartialStageDeployment() {
  const provider = createProvider(settingsFrom({
    WARDROBE_AI_PROVIDER: "azure",
    AZURE_OPENAI_ENDPOINT: "https://example.openai.azure.com",
    AZURE_OPENAI_API_KEY: "azure-secret",
    AZURE_OPENAI_VISION_DEPLOYMENT: "vision-dep",
    AZURE_OPENAI_GARMENT_DEPLOYMENT: "garment-dep",
  }));
  assert.deepEqual(provider.missingConfig(), ["AZURE_OPENAI_MODELED_DEPLOYMENT in .env"]);

  const complete = createProvider(settingsFrom({
    WARDROBE_AI_PROVIDER: "azure",
    AZURE_OPENAI_ENDPOINT: "https://example.openai.azure.com",
    AZURE_OPENAI_API_KEY: "azure-secret",
    AZURE_OPENAI_VISION_DEPLOYMENT: "vision-dep",
    AZURE_OPENAI_IMAGE_DEPLOYMENT: "shared-dep",
    AZURE_OPENAI_MODELED_DEPLOYMENT: "modeled-dep",
  }));
  assert.deepEqual(complete.missingConfig(), []);
  assert.equal(complete.imageModel("garment"), "shared-dep");
  assert.equal(complete.imageModel("modeled"), "modeled-dep", "per-stage override wins over the shared deployment");
}

async function testLimiterSurvivesSyncThrow() {
  const limiter = createLimiter(1);
  await assert.rejects(limiter(() => { throw new Error("sync boom"); }), /sync boom/);
  assert.equal(await limiter(async () => "still alive"), "still alive", "a sync throw must not leak the only slot");
}

async function testRetryAfterIsClamped() {
  let calls = 0;
  await withServer((_record, res) => {
    calls += 1;
    if (calls === 1) {
      res.statusCode = 429;
      res.setHeader("Retry-After", "3600");
      return res.end("{}");
    }
    okImage(_record, res);
  }, async (base) => {
    const started = Date.now();
    const response = await fetchWithRetry(`${base}/x`, { method: "POST" }, { baseDelayMs: 1, maxBackoffMs: 5 });
    assert.equal(response.status, 200);
    assert.ok(Date.now() - started < 2000, "a huge Retry-After must be clamped, not slept through");
  });
}

async function testRetryOn429() {
  let calls = 0;
  await withServer((_record, res) => {
    calls += 1;
    if (calls === 1) {
      res.statusCode = 429;
      res.setHeader("Retry-After", "0");
      return res.end(JSON.stringify({ error: { code: "429", message: "Too many requests" } }));
    }
    okImage(_record, res);
  }, async (base) => {
    const response = await fetchWithRetry(`${base}/images/edits`, { method: "POST" }, { baseDelayMs: 1 });
    assert.equal(response.status, 200);
    assert.equal(calls, 2, "a 429 must be retried once Retry-After elapses");
  });
}

async function testLimiterSerialises() {
  const limiter = createLimiter(1);
  let active = 0;
  let peak = 0;
  await Promise.all(Array.from({ length: 5 }, () => limiter(async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
  })));
  assert.equal(peak, 1, "concurrency 1 must serialise model requests");
}

async function testErrorShapes() {
  assert.equal(providerErrorMessage({ error: { message: "openai style" } }, 400, "fallback"), "openai style");
  assert.equal(providerErrorMessage({ message: "azure v1 style" }, 400, "fallback"), "azure v1 style");
  assert.equal(providerErrorMessage({}, 500, "fallback"), "fallback (500)");
  assert.ok(isContentFilterError({ error: { code: "contentFilter" } }));
  assert.ok(isContentFilterError({ code: "content_filter" }), "responses surface uses snake_case");
  assert.ok(!isContentFilterError({ error: { code: "DeploymentNotFound" } }));
}

const tests = [
  testAzureImageEdit,
  testAzureResponses,
  testOpenAIUnchanged,
  testMissingConfig,
  testPartialStageDeployment,
  testRetryOn429,
  testRetryAfterIsClamped,
  testLimiterSerialises,
  testLimiterSurvivesSyncThrow,
  testErrorShapes,
];

let failed = 0;
for (const test of tests) {
  try {
    await test();
    console.log(`ok - ${test.name}`);
  } catch (error) {
    failed += 1;
    console.error(`not ok - ${test.name}\n  ${error.message}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
