// StudyGoose Personal AI Relay
// Keep provider API keys only in Cloudflare Worker Secrets, never in GitHub or the browser.

const DEFAULT_ALLOWED_ORIGIN = "https://jhen-1993.github.io";
const MAX_PROMPT_CHARS = 24000;
const MAX_IMAGE_BASE64_CHARS = 7 * 1024 * 1024;
const MAX_OUTPUT_TOKENS = 1600;
const SUPPORTED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif"
]);

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGIN || DEFAULT_ALLOWED_ORIGIN)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  if (origin && !allowedOrigins(env).includes(origin)) return null;

  const headers = {
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400"
  };
  if (origin) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function jsonResponse(request, env, body, status = 200) {
  const headers = corsHeaders(request, env);
  if (!headers) {
    return new Response(JSON.stringify({ error: "This origin is not allowed." }), {
      status: 403,
      headers: { "Content-Type": "application/json; charset=utf-8" }
    });
  }
  headers["Content-Type"] = "application/json; charset=utf-8";
  headers["Cache-Control"] = "no-store";
  return new Response(JSON.stringify(body), { status, headers });
}

function isAuthorized(request, env) {
  if (!env.RELAY_ACCESS_TOKEN) return true;
  return request.headers.get("Authorization") === `Bearer ${env.RELAY_ACCESS_TOKEN}`;
}

function requireText(value, fieldName, limit) {
  if (typeof value !== "string") throw new Error(`${fieldName} is required.`);
  const text = value.trim();
  if (!text) throw new Error(`${fieldName} is required.`);
  if (text.length > limit) throw new Error(`${fieldName} is too long.`);
  return text;
}

function readImage(value) {
  if (value == null) return null;
  if (!value || typeof value !== "object") throw new Error("image must be an object.");
  const mediaType = typeof value.mediaType === "string" ? value.mediaType.toLowerCase() : "";
  const data = typeof value.data === "string" ? value.data.replace(/\s/g, "") : "";

  if (!SUPPORTED_IMAGE_TYPES.has(mediaType)) {
    throw new Error("Only JPEG, PNG, WebP, and GIF images are supported.");
  }
  if (!data || data.length > MAX_IMAGE_BASE64_CHARS || !/^[a-z0-9+/=]+$/i.test(data)) {
    throw new Error("The image data is missing, invalid, or too large.");
  }
  return { mediaType, data };
}

function outputTokenLimit(value) {
  const requested = Number(value);
  if (!Number.isFinite(requested)) return 1000;
  return Math.max(100, Math.min(Math.floor(requested), MAX_OUTPUT_TOKENS));
}

async function upstreamJson(response) {
  const raw = await response.text();
  let parsed = {};
  try { parsed = raw ? JSON.parse(raw) : {}; } catch (_) {}
  if (!response.ok) {
    const providerMessage = parsed?.error?.message || parsed?.message || "";
    const detail = providerMessage ? `: ${providerMessage}` : "";
    throw new Error(`AI provider request failed (HTTP ${response.status})${detail}`);
  }
  return parsed;
}

function contentToText(content) {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter((item) => item && (item.type === "text" || typeof item.text === "string"))
      .map((item) => item.text || "")
      .join("")
      .trim();
  }
  return "";
}

async function callOpenAI(env, prompt, maxTokens, image) {
  if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured in this Relay.");
  if (!env.AI_MODEL) throw new Error("AI_MODEL is not configured in this Relay.");

  const content = image
    ? [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: `data:${image.mediaType};base64,${image.data}` } }
      ]
    : prompt;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: env.AI_MODEL,
      messages: [{ role: "user", content }],
      max_completion_tokens: maxTokens
    })
  });

  const data = await upstreamJson(response);
  const text = contentToText(data?.choices?.[0]?.message?.content);
  if (!text) throw new Error("The AI provider returned an empty response.");
  return text;
}

async function callAnthropic(env, prompt, maxTokens, image) {
  if (!env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not configured in this Relay.");
  if (!env.AI_MODEL) throw new Error("AI_MODEL is not configured in this Relay.");

  const content = image
    ? [
        { type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } },
        { type: "text", text: prompt }
      ]
    : prompt;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: env.AI_MODEL,
      max_tokens: maxTokens,
      messages: [{ role: "user", content }]
    })
  });

  const data = await upstreamJson(response);
  const text = (data?.content || [])
    .filter((block) => block?.type === "text")
    .map((block) => block.text || "")
    .join("")
    .trim();
  if (!text) throw new Error("The AI provider returned an empty response.");
  return text;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = corsHeaders(request, env);
    if (!headers) return jsonResponse(request, env, { error: "This origin is not allowed." }, 403);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });

    const provider = env.AI_PROVIDER === "anthropic" ? "anthropic" : "openai";

    if (url.pathname === "/health" && request.method === "GET") {
      if (!isAuthorized(request, env)) {
        return jsonResponse(request, env, { error: "Relay access token is missing or incorrect." }, 401);
      }
      return jsonResponse(request, env, {
        ok: true,
        app: "studygoose",
        provider,
        accessTokenRequired: Boolean(env.RELAY_ACCESS_TOKEN)
      });
    }

    if (url.pathname !== "/study" || request.method !== "POST") {
      return jsonResponse(request, env, { error: "Not found." }, 404);
    }
    if (!isAuthorized(request, env)) {
      return jsonResponse(request, env, { error: "Relay access token is missing or incorrect." }, 401);
    }

    try {
      const payload = await request.json();
      const prompt = requireText(payload?.prompt, "prompt", MAX_PROMPT_CHARS);
      const image = readImage(payload?.image);
      const maxTokens = outputTokenLimit(payload?.maxTokens);
      const text = provider === "anthropic"
        ? await callAnthropic(env, prompt, maxTokens, image)
        : await callOpenAI(env, prompt, maxTokens, image);
      return jsonResponse(request, env, { text });
    } catch (error) {
      const message = error?.message || "Unexpected Relay error.";
      const status = message.startsWith("prompt") || message.startsWith("image") || message.startsWith("Only ")
        ? 400
        : 502;
      return jsonResponse(request, env, { error: message }, status);
    }
  }
};
