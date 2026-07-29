const DEFAULT_IMAGE_API_VERSION = "2025-04-01-preview";
const DEFAULT_VISION_MODEL = "gpt-5.4-mini";
const DEFAULT_IMAGE_MODEL = "gpt-image-2";

function trimSlashes(value) {
  return value.trim().replace(/\/+$/, "");
}

function openAIProvider(setting) {
  const key = () => setting("OPENAI_API_KEY").trim();
  const baseUrl = () => trimSlashes(setting("OPENAI_API_BASE_URL", "https://api.openai.com/v1"));
  return {
    id: "openai",
    label: "OpenAI",
    defaultConcurrency: 2,
    missingConfig() {
      return key() ? [] : ["OPENAI_API_KEY in .env"];
    },
    visionModel() {
      return setting("OPENAI_VISION_MODEL", DEFAULT_VISION_MODEL);
    },
    imageModel(stage) {
      const override = stage === "garment" ? "OPENAI_GARMENT_MODEL" : "OPENAI_MODELED_MODEL";
      return setting(override, setting("OPENAI_IMAGE_MODEL", DEFAULT_IMAGE_MODEL));
    },
    responsesRequest() {
      return {
        url: `${baseUrl()}/responses`,
        headers: { Authorization: `Bearer ${key()}`, "Content-Type": "application/json" },
      };
    },
    imageEditRequest() {
      return {
        url: `${baseUrl()}/images/edits`,
        headers: { Authorization: `Bearer ${key()}` },
        includeModelField: true,
        includeImageExtras: true,
      };
    },
  };
}

// Azure splits across two API surfaces: the GA v1 surface serves /responses, while image
// edits exist only on the deployment-scoped path with an explicit api-version. The api-key
// header authenticates both.
function azureProvider(setting) {
  const key = () => setting("AZURE_OPENAI_API_KEY").trim();
  const endpoint = () => trimSlashes(setting("AZURE_OPENAI_ENDPOINT"));
  const visionDeployment = () => setting("AZURE_OPENAI_VISION_DEPLOYMENT").trim();
  const imageDeployment = (stage) => {
    const override = stage === "garment" ? "AZURE_OPENAI_GARMENT_DEPLOYMENT" : "AZURE_OPENAI_MODELED_DEPLOYMENT";
    return setting(override, setting("AZURE_OPENAI_IMAGE_DEPLOYMENT")).trim();
  };
  return {
    id: "azure",
    label: "Azure OpenAI",
    defaultConcurrency: 1,
    missingConfig() {
      const missing = [];
      if (!endpoint()) missing.push("AZURE_OPENAI_ENDPOINT in .env");
      if (!key()) missing.push("AZURE_OPENAI_API_KEY in .env");
      if (!visionDeployment()) missing.push("AZURE_OPENAI_VISION_DEPLOYMENT in .env");
      // Each stage resolves independently, so a lone per-stage override must not pass setup.
      const unresolved = ["garment", "modeled"].filter((stage) => !imageDeployment(stage));
      if (unresolved.length === 2) missing.push("AZURE_OPENAI_IMAGE_DEPLOYMENT in .env");
      else for (const stage of unresolved) missing.push(`AZURE_OPENAI_${stage.toUpperCase()}_DEPLOYMENT in .env`);
      return missing;
    },
    visionModel() {
      return visionDeployment();
    },
    imageModel(stage) {
      return imageDeployment(stage);
    },
    responsesRequest() {
      return {
        url: `${endpoint()}/openai/v1/responses`,
        headers: { "api-key": key(), "Content-Type": "application/json" },
      };
    },
    imageEditRequest(model) {
      const apiVersion = setting("AZURE_OPENAI_IMAGE_API_VERSION", DEFAULT_IMAGE_API_VERSION);
      return {
        url: `${endpoint()}/openai/deployments/${encodeURIComponent(model)}/images/edits?api-version=${encodeURIComponent(apiVersion)}`,
        headers: { "api-key": key() },
        includeModelField: false,
        includeImageExtras: false,
      };
    },
  };
}

export function createProvider(setting) {
  const id = setting("WARDROBE_AI_PROVIDER", "openai").trim().toLowerCase();
  if (id === "azure") return azureProvider(setting);
  if (id === "openai" || id === "") return openAIProvider(setting);
  throw new Error(`Unknown WARDROBE_AI_PROVIDER "${id}". Use "openai" or "azure".`);
}

// OpenAI returns {error:{message}}. Azure uses that shape on the deployment-scoped path,
// but the v1 surface returns {code, message} at the top level.
export function providerErrorMessage(result, status, fallback) {
  const message = result?.error?.message || result?.message;
  if (message) return message;
  const code = result?.error?.code || result?.code;
  if (code) return `${fallback} (${status}: ${code})`;
  return `${fallback} (${status})`;
}

export function isContentFilterError(result) {
  const code = result?.error?.code || result?.code;
  return typeof code === "string" && code.toLowerCase().replace(/[_-]/g, "").includes("contentfilter");
}
