# Azure OpenAI provider for Wardrobe

Date: 2026-07-30
Status: approved, implementing

## Goal

Let this fork run its AI stages against Azure OpenAI / Microsoft Foundry instead of
`api.openai.com`, without changing default behaviour for anyone using upstream's OpenAI
setup. Azure is opt-in through environment variables.

## Why this shape

Upstream is active (1.6k stars). This fork wants to track it. So the design optimises for
a small, well-isolated diff in `scripts/import-job-api.mjs` — the file upstream is most
likely to change — and puts all new logic in new files upstream does not have.

## Background: what the app calls today

All model access lives in `scripts/import-job-api.mjs`:

| Function | Endpoint | Purpose |
| --- | --- | --- |
| `openAIAnalyze` | `POST {base}/responses` | Detect garments, strict `json_schema` output |
| `openAIEdit` | `POST {base}/images/edits` | Garment cutout (1024x1024) and modeled photo (1536x1024, 2 input images) |

Three call sites: analyze on upload, `garment` stage, `modeled` stage.

## Verified Azure facts

Confirmed against Azure's published OpenAPI specs and Microsoft Learn:

- `gpt-image-2` is GA on Azure with no access application, supports edits, supports
  multiple input images, and documents "advanced face preservation". `gpt-image-1` is
  limited-access; we do not need it.
- Multipart field name for edits is **`image[]`**, repeated per image — identical to what
  `openAIEdit` already sends. Microsoft's own `curl` example uses this form.
- `1024x1024` and `1536x1024` are both valid sizes; `quality=high` is valid.
- GPT image models **always return base64**, so `response_format` must not be sent.
- The **GA** `v1` surface has `/responses` but **no `/images/*` paths at all**. Image edits
  live on the deployment-scoped path with `?api-version=2025-04-01-preview`.
- The `api-key` header authenticates **both** surfaces, so we use one auth scheme
  everywhere and avoid the `Authorization: Bearer` ambiguity.
- Azure's edits schema has no `model`, `output_format`, or `background` fields. The app
  always sends `output_format=png`; it must be omitted for Azure. PNG is the default, so
  nothing is lost. `background` is never sent by the call sites (the garment stage uses a
  chroma-key trick instead), so its absence is a non-issue.

### Known unknowns

Deliberately unresolved until a live request can settle them:

- Whether `/openai/v1/images/edits?api-version=preview` also works. It exists in the v1
  *preview* spec, which would allow one base URL for both calls. We target the documented
  deployment-scoped path and treat v1 images as a later simplification.
- Azure's default content filters are stricter than OpenAI's, and **input** images are
  filtered too. Clothed adults are fine; occasional `contentFilter` rejections are
  expected rather than systematic failure.

### Confirmed against a live resource (2026-07-30)

Probed with `scripts/ai/probe.mjs` against a Sweden Central `AIServices` resource
(`*.cognitiveservices.azure.com`, `gpt-image-2` + `gpt-5.6-luna` deployments). Every
assumption above held, so no code changed as a result:

| Question | Result |
| --- | --- |
| Auth header | `api-key` works; `Authorization: Bearer` also works |
| Image `api-version` | `2025-04-01-preview` works; `2024-02-01` returns 404 |
| Single-image field | `image[]` |
| **Two-image field** | **`image[]`** — the modeled stage is viable |
| `/openai/v1/responses` | reachable on the `cognitiveservices.azure.com` hostname |
| Vision + strict `json_schema` | correctly returned garments, hex colours, tags, bounding boxes |

The `cognitiveservices.azure.com` hostname serves both surfaces, so the classic
`openai.azure.com` hostname is not required.

Rate limiting was observed repeatedly at Tier 1: four probe calls in succession returned
`429 ... Please retry after 37 seconds`, and each successful edit took 10–13s. This is the
behaviour the limiter and backoff exist for.

## Design

### New: `scripts/ai/provider.mjs`

`createProvider(setting)` returns a transport descriptor. It owns *where* to send a
request and *how* to authenticate — never request bodies, which stay shared in
`import-job-api.mjs` so prompts and the JSON schema are not duplicated per provider.

Interface:

- `id`, `label`
- `missingConfig()` → array of human-readable missing settings, for the setup gate
- `visionModel()`, `imageModel(stage)`, `imageQuality()`
- `responsesRequest()` → `{ url, headers }`
- `imageEditRequest(model)` → `{ url, headers, includeModelField, includeOutputFormat }`

| | OpenAI | Azure |
| --- | --- | --- |
| Responses URL | `{base}/responses` | `{endpoint}/openai/v1/responses` |
| Edits URL | `{base}/images/edits` | `{endpoint}/openai/deployments/{deployment}/images/edits?api-version=...` |
| Auth header | `Authorization: Bearer` | `api-key` |
| `model` in edit form | yes | no (deployment is in the URL) |
| `output_format=png` | yes | omitted |

### New: `scripts/ai/retry.mjs`

Azure starts at roughly 6 requests/min and each edit takes 10–30s. The app currently
fires every job's image call concurrently with no retry, so a bulk import would mostly
return 429 and surface as failed stages needing manual regeneration.

- `createLimiter(concurrency)` — caps in-flight model requests. Default 1 on Azure, 2 on
  OpenAI, overridable via `WARDROBE_AI_CONCURRENCY`.
- `fetchWithRetry(url, init, { attempts, limiter })` — retries 408/409/429/5xx with
  exponential backoff, honouring `Retry-After` in both seconds and HTTP-date form.
  Content-filter rejections are **not** retried; they are deterministic.

### Changes to `scripts/import-job-api.mjs`

Kept deliberately small:

1. Import the two new modules; build the provider once.
2. `openAIAnalyze` / `openAIEdit` keep their names and shapes but take `provider` instead
   of `key` + `baseUrl`, and route through `fetchWithRetry`.
3. `openAIEdit` conditionally omits `model` / `output_format`.
4. Error parsing handles Azure's shapes as well as OpenAI's.
5. `setupStatus()` reports provider-aware missing configuration instead of hardcoding
   `OPENAI_API_KEY`.

### Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `WARDROBE_AI_PROVIDER` | `openai` | `openai` or `azure` |
| `AZURE_OPENAI_ENDPOINT` | — | `https://<resource>.openai.azure.com` |
| `AZURE_OPENAI_API_KEY` | — | |
| `AZURE_OPENAI_VISION_DEPLOYMENT` | — | deployment name, not model name |
| `AZURE_OPENAI_IMAGE_DEPLOYMENT` | — | gpt-image-2 deployment |
| `AZURE_OPENAI_GARMENT_DEPLOYMENT` | image deployment | optional per-stage override |
| `AZURE_OPENAI_MODELED_DEPLOYMENT` | image deployment | optional per-stage override |
| `AZURE_OPENAI_IMAGE_API_VERSION` | `2025-04-01-preview` | |
| `WARDROBE_AI_CONCURRENCY` | 1 (azure) / 2 (openai) | |

`OPENAI_IMAGE_QUALITY` stays shared across providers.

## Azure setup

```bash
az cognitiveservices account create \
  --name wardrobe-ai --resource-group wardrobe-rg \
  --kind AIServices --sku S0 --location swedencentral

az cognitiveservices account deployment create \
  --name wardrobe-ai --resource-group wardrobe-rg \
  --deployment-name gpt-image-2 \
  --model-name gpt-image-2 --model-format OpenAI \
  --sku-name GlobalStandard --sku-capacity 1

az cognitiveservices account deployment create \
  --name wardrobe-ai --resource-group wardrobe-rg \
  --deployment-name gpt-5.4-mini \
  --model-name gpt-5.4-mini --model-format OpenAI \
  --sku-name GlobalStandard --sku-capacity 1
```

`kind=AIServices` is the current recommendation and still serves the
`*.openai.azure.com/openai/...` paths. Use `DataZoneStandard` instead of `GlobalStandard`
if EU data residency is required.

## Verification

No Azure resource exists yet, so correctness is established without one:

1. **Mock endpoint test** (`scripts/ai/provider.test.mjs`) — a local HTTP server stands in
   for Azure, and the real code path asserts URL, query string, auth header, and multipart
   fields including repeated `image[]`. This proves request construction, which is where
   nearly all provider risk lives.
2. `npm run check` (build) must pass.
3. **Live probe**, once the resource exists: run `node scripts/ai/probe.mjs` to confirm the
   auth header, api-version, and multipart field name against a real deployment. It stops
   as soon as each question is answered and backs off through rate limits.

## Out of scope

Containerising for Proxmox — the import API is an `apply: "serve"` Vite plugin and needs
separate work to run unattended. Tracked as a follow-up spec.
