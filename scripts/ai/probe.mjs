// Diagnostic probe: settles the Azure wire-format questions against a real resource.
// Run: node scripts/ai/probe.mjs
//
// It tries the variants that documentation leaves ambiguous and reports which combination
// works, so .env can be configured from evidence rather than assumption.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { createLimiter, fetchWithRetry } from "./retry.mjs";

const root = path.resolve(import.meta.dirname, "../..");
// One at a time, with long backoff: a Tier-1 deployment allows only a few calls per minute.
const limiter = createLimiter(1);

async function loadEnv() {
  try {
    process.loadEnvFile(path.join(root, ".env"));
  } catch {
    const raw = await readFile(path.join(root, ".env"), "utf8").catch(() => "");
    for (const line of raw.split("\n")) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
  }
}

const label = (ok) => (ok ? "PASS" : "FAIL");

async function testImage(size = 512) {
  return sharp({ create: { width: size, height: size, channels: 3, background: { r: 90, g: 120, b: 200 } } })
    .png()
    .toBuffer();
}

async function readBody(response) {
  const text = await response.text();
  try { return JSON.parse(text); } catch { return { raw: text.slice(0, 400) }; }
}

function describeError(body, status) {
  return body?.error?.message || body?.message || body?.error?.code || body?.raw || `HTTP ${status}`;
}

async function probeEdit({ endpoint, key, deployment, apiVersion, authStyle, fieldName, imageCount }) {
  const form = new FormData();
  const image = await testImage();
  for (let i = 0; i < imageCount; i += 1) {
    form.append(fieldName, new Blob([image], { type: "image/png" }), `image-${i + 1}.png`);
  }
  form.set("prompt", "Make the background pure white.");
  form.set("size", "1024x1024");
  form.set("quality", "low");
  const headers = authStyle === "api-key" ? { "api-key": key } : { Authorization: `Bearer ${key}` };
  const url = `${endpoint}/openai/deployments/${deployment}/images/edits?api-version=${apiVersion}`;
  const started = Date.now();
  try {
    const response = await fetchWithRetry(url, { method: "POST", headers, body: form }, {
      limiter,
      attempts: 5,
      baseDelayMs: 5000,
      maxBackoffMs: 90_000,
      onRetry: ({ status, delay }) => console.log(`      (${status}, waiting ${Math.round(delay / 1000)}s)`),
    });
    const body = await readBody(response);
    return {
      ok: response.ok && Boolean(body?.data?.[0]?.b64_json),
      status: response.status,
      ms: Date.now() - started,
      detail: response.ok ? "returned b64_json" : describeError(body, response.status),
      b64: body?.data?.[0]?.b64_json,
    };
  } catch (error) {
    return { ok: false, status: 0, ms: Date.now() - started, detail: error.message };
  }
}

async function probeResponses({ endpoint, key, deployment, authStyle }) {
  const headers = { "Content-Type": "application/json", ...(authStyle === "api-key" ? { "api-key": key } : { Authorization: `Bearer ${key}` }) };
  const url = `${endpoint}/openai/v1/responses`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: deployment,
        input: [{ role: "user", content: [{ type: "input_text", text: "Reply with the single word: ok" }] }],
      }),
    });
    const body = await readBody(response);
    return { ok: response.ok, status: response.status, detail: response.ok ? "responses API reachable" : describeError(body, response.status) };
  } catch (error) {
    return { ok: false, status: 0, detail: error.message };
  }
}

await loadEnv();

const endpoint = (process.env.AZURE_OPENAI_ENDPOINT || "").replace(/\/+$/, "");
const key = (process.env.AZURE_OPENAI_API_KEY || "").trim();
const imageDeployment = (process.env.AZURE_OPENAI_IMAGE_DEPLOYMENT || "").trim();
const visionDeployment = (process.env.AZURE_OPENAI_VISION_DEPLOYMENT || "").trim();

if (!endpoint || !key || key === "PASTE_YOUR_KEY_HERE") {
  console.error("Set AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY in .env first.");
  process.exit(1);
}

console.log(`endpoint:   ${endpoint}`);
console.log(`image dep:  ${imageDeployment || "(unset)"}`);
console.log(`vision dep: ${visionDeployment || "(unset)"}\n`);

const findings = {};

console.log("1. Auth header + api-version (single image, field name \"image[]\")");
outer:
for (const authStyle of ["api-key", "bearer"]) {
  for (const apiVersion of ["2025-04-01-preview", "2024-02-01"]) {
    const result = await probeEdit({ endpoint, key, deployment: imageDeployment, apiVersion, authStyle, fieldName: "image[]", imageCount: 1 });
    console.log(`   ${label(result.ok)}  auth=${authStyle.padEnd(7)} api-version=${apiVersion.padEnd(19)} ${result.status} ${result.detail} (${result.ms}ms)`);
    if (result.ok) {
      findings.auth = { authStyle, apiVersion };
      // This call already proves single-image image[] works; stop spending quota.
      findings.field = "image[]";
      break outer;
    }
  }
}

if (!findings.auth) {
  console.error("\nNo working auth/api-version combination. Stopping.");
  process.exit(1);
}

const { authStyle, apiVersion } = findings.auth;
console.log(`\n   -> using auth=${authStyle} api-version=${apiVersion}`);
console.log(`   -> single-image field "image[]" confirmed by the call above\n`);

console.log("2. Two input images (the modeled stage needs this)");
for (const fieldName of ["image[]", "image"]) {
  const result = await probeEdit({ endpoint, key, deployment: imageDeployment, apiVersion, authStyle, fieldName, imageCount: 2 });
  console.log(`   ${label(result.ok)}  ${fieldName.padEnd(8)} ${result.status} ${result.detail} (${result.ms}ms)`);
  if (result.ok) {
    findings.multi = fieldName;
    if (result.b64) {
      await writeFile(path.join(root, "probe-output.png"), Buffer.from(result.b64, "base64"));
      findings.wrote = true;
    }
    break;
  }
}

console.log("\n3. Responses API (garment detection)");
if (visionDeployment) {
  const result = await probeResponses({ endpoint, key, deployment: visionDeployment, authStyle });
  console.log(`   ${label(result.ok)}  /openai/v1/responses ${result.status} ${result.detail}`);
  findings.responses = result.ok;
} else {
  console.log("   SKIP  AZURE_OPENAI_VISION_DEPLOYMENT is unset - deploy a vision model to test this");
}

console.log("\n--- summary ---");
console.log(`auth header:        ${authStyle}`);
console.log(`image api-version:  ${apiVersion}`);
console.log(`single-image field: ${findings.field || "none worked"}`);
console.log(`two-image field:    ${findings.multi || "none worked"}`);
if (findings.wrote) console.log("wrote probe-output.png from the two-image edit");
if (findings.multi && findings.multi !== "image[]") {
  console.log("\nNOTE: the code sends image[]. Update openAIEdit in scripts/import-job-api.mjs.");
}
if (authStyle !== "api-key") {
  console.log("NOTE: the code sends api-key. Update azureProvider in scripts/ai/provider.mjs.");
}
if (apiVersion !== "2025-04-01-preview") {
  console.log(`NOTE: set AZURE_OPENAI_IMAGE_API_VERSION=${apiVersion} in .env`);
}
