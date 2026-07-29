<div align="center">

# Wardrobe

Your clothes, extracted and organized with gpt-image.

[![License: MIT](https://img.shields.io/badge/license-MIT-191919?style=flat-square)](LICENSE)
[![Node 22+](https://img.shields.io/badge/node-22%2B-191919?style=flat-square)](package.json)

[See the original post →](https://x.com/cdngdev/status/2076812846793650485)

</div>

![Wardrobe gallery](docs/screenshots/gallery.png)

![Modeled wardrobe editor](docs/screenshots/editor.png)

## Quick start

```bash
git clone https://github.com/tandpfun/wardrobe.git
cd wardrobe
npm install
cp .env.example .env
npm run dev
```

⚠️ The importer stays disabled until you add `OPENAI_API_KEY` to `.env` and place a PNG reference photo of yourself at `data/model-reference.png`.

Open [localhost:5173](http://localhost:5173).

## Import with Codex

This repo includes two Codex skills: one imports clothes and generates modeled item photos; the other styles complete outfits and generates a modeled lookbook.

```text
$import-clothes Import the clothes from ~/Pictures/outfits, create modeled photos, and add them to this wardrobe.
$generate-outfits Create modeled outfit ideas from my wardrobe.
```

Open the cloned repo in Codex and run either prompt. The import skill asks for a local model-reference PNG when needed, reviews every cutout and modeled photo, then writes to `data/library.json` and `data/imported/`. The outfit skill asks how many looks to create, then curates, generates, verifies, and saves the complete collection under `data/`.

### For agents

If you are setting up Wardrobe for a user, ask how they want to import their clothes:

- **Codex:** Ask for a folder or camera-roll location and a model-reference PNG, then extract, model, and import the individual pieces by following [the bundled import skill](.agents/skills/import-clothes/SKILL.md). Afterward, offer to create a requested number of modeled looks with [the outfit-generation skill](.agents/skills/generate-outfits/SKILL.md).
- **Web UI:** Help the user configure their own `OPENAI_API_KEY` and `data/model-reference.png`, then let them import through the app.

## What it does

- Detects every garment in a photo with the OpenAI Responses API
- Extracts clean product cutouts with the OpenAI Images API
- Generates an optional modeled editorial preview
- Keeps originals, jobs, generated images, and the JSON database local in `data/`
- Supports drag, drop, paste, editing, review, regeneration, and approval

## Configuration

| Variable | Default |
| --- | --- |
| `WARDROBE_AI_PROVIDER` | `openai` (or `azure`) |
| `OPENAI_API_KEY` | Required for `openai` |
| `OPENAI_VISION_MODEL` | `gpt-5.4-mini` |
| `OPENAI_IMAGE_MODEL` | `gpt-image-2` |
| `OPENAI_IMAGE_QUALITY` | `high` |
| `WARDROBE_MODEL_REFERENCE` | `data/model-reference.png` |
| `WARDROBE_DATA_DIR` | `data` |
| `WARDROBE_AI_CONCURRENCY` | `1` on Azure, `2` on OpenAI |

### Azure OpenAI

Set `WARDROBE_AI_PROVIDER=azure` to run against Azure OpenAI / Microsoft Foundry instead.
Azure identifies models by **deployment name**, so these values are the names you chose
when deploying, not model ids.

| Variable | Default |
| --- | --- |
| `AZURE_OPENAI_ENDPOINT` | Required, e.g. `https://<resource>.openai.azure.com` |
| `AZURE_OPENAI_API_KEY` | Required |
| `AZURE_OPENAI_VISION_DEPLOYMENT` | Required |
| `AZURE_OPENAI_IMAGE_DEPLOYMENT` | Required, a `gpt-image-2` deployment |
| `AZURE_OPENAI_GARMENT_DEPLOYMENT` | Falls back to `AZURE_OPENAI_IMAGE_DEPLOYMENT` |
| `AZURE_OPENAI_MODELED_DEPLOYMENT` | Falls back to `AZURE_OPENAI_IMAGE_DEPLOYMENT` |
| `AZURE_OPENAI_IMAGE_API_VERSION` | `2025-04-01-preview` |

`gpt-image-2` is generally available on Azure with no access application. New
subscriptions start near 6 requests per minute, so imports are queued and retried with
backoff; raise `WARDROBE_AI_CONCURRENCY` once your quota allows.

See [the design doc](docs/superpowers/specs/2026-07-30-azure-provider-design.md) for
provisioning commands and the verified API details.

## License

[MIT](LICENSE)
