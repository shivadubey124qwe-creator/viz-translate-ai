/**
 * Multi-provider translation router (server only).
 *
 * Preference order: Bytez #1-#4, NVIDIA NIM #1-#2, then the Lovable AI Gateway
 * as the always-available baseline. A provider is kept in use while it succeeds
 * and only put on a cooldown when it legitimately reports rate limiting, quota
 * exhaustion, a timeout or a transient upstream failure.
 *
 * API keys are read from server env only. They are never returned, logged, or
 * included in error messages.
 */

export interface ProviderCall {
  system: string;
  userText: string;
  imageDataUrl: string;
  schema: unknown;
  schemaName: string;
}

export interface ProviderResult {
  content: string;
  provider: string;
}

export interface ProviderHealth {
  provider: string;
  /** Non-secret identifier, e.g. "bytez#1". */
  keyId: string;
  configured: boolean;
  available: boolean;
  requests: number;
  successes: number;
  failures: number;
  rateLimits: number;
  quotaErrors: number;
  lastSuccessAt: number | null;
  cooldownUntil: number | null;
}

interface ProviderDef {
  name: string;
  keyId: string;
  envVar: string;
  endpoint: string;
  model: string;
  /** Bearer vs. Lovable-API-Key header style. */
  auth: "bearer" | "lovable";
}

const COOLDOWN_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 90_000;

const DEFS: ProviderDef[] = [
  ...[1, 2, 3, 4].map((n) => ({
    name: "bytez",
    keyId: `bytez#${n}`,
    envVar: `BYTEZ_API_KEY_${n}`,
    endpoint: "https://api.bytez.com/models/v2/openai/v1/chat/completions",
    model: "google/gemma-3-27b-it",
    auth: "bearer" as const,
  })),
  ...[1, 2].map((n) => ({
    name: "nvidia-nim",
    keyId: `nim#${n}`,
    envVar: `NVIDIA_NIM_API_KEY_${n}`,
    endpoint: "https://integrate.api.nvidia.com/v1/chat/completions",
    model: "meta/llama-4-maverick-17b-128e-instruct",
    auth: "bearer" as const,
  })),
  {
    name: "lovable",
    keyId: "lovable",
    envVar: "LOVABLE_API_KEY",
    endpoint: "https://ai.gateway.lovable.dev/v1/chat/completions",
    model: "google/gemini-3.6-flash",
    auth: "lovable",
  },
];

interface State {
  requests: number;
  successes: number;
  failures: number;
  rateLimits: number;
  quotaErrors: number;
  lastSuccessAt: number | null;
  cooldownUntil: number | null;
}

const states = new Map<string, State>();

function stateFor(keyId: string): State {
  let s = states.get(keyId);
  if (!s) {
    s = {
      requests: 0,
      successes: 0,
      failures: 0,
      rateLimits: 0,
      quotaErrors: 0,
      lastSuccessAt: null,
      cooldownUntil: null,
    };
    states.set(keyId, s);
  }
  return s;
}

function keyOf(def: ProviderDef) {
  const value = process.env[def.envVar];
  return value && value.trim() ? value.trim() : null;
}

function available(def: ProviderDef) {
  const s = stateFor(def.keyId);
  return !s.cooldownUntil || s.cooldownUntil < Date.now();
}

/** Non-secret health snapshot, safe to expose to the UI. */
export function providerHealth(): ProviderHealth[] {
  return DEFS.map((def) => {
    const s = stateFor(def.keyId);
    return {
      provider: def.name,
      keyId: def.keyId,
      configured: Boolean(keyOf(def)),
      available: available(def),
      requests: s.requests,
      successes: s.successes,
      failures: s.failures,
      rateLimits: s.rateLimits,
      quotaErrors: s.quotaErrors,
      lastSuccessAt: s.lastSuccessAt,
      cooldownUntil: s.cooldownUntil,
    };
  });
}

function isRetryable(status: number) {
  return status === 402 || status === 408 || status === 409 || status === 429 || status >= 500;
}

async function callProvider(def: ProviderDef, key: string, call: ProviderCall) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(def.endpoint, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(def.auth === "lovable"
          ? { "Lovable-API-Key": key }
          : { Authorization: `Bearer ${key}` }),
      },
      body: JSON.stringify({
        model: def.model,
        messages: [
          { role: "system", content: call.system },
          {
            role: "user",
            content: [
              { type: "text", text: call.userText },
              { type: "image_url", image_url: { url: call.imageDataUrl } },
            ],
          },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: call.schemaName, strict: true, schema: call.schema },
        },
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return { ok: false as const, status: res.status, detail: redact(detail, key) };
    }
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = json.choices?.[0]?.message?.content ?? "";
    if (!content.trim()) return { ok: false as const, status: 502, detail: "Empty response" };
    return { ok: true as const, content };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      ok: false as const,
      status: aborted ? 408 : 503,
      detail: aborted ? "Timed out" : "Network error",
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Never let a key echo back through an upstream error body. */
function redact(text: string, key: string) {
  const cleaned = key ? text.split(key).join("***") : text;
  return cleaned.replace(/(sk|nvapi|BYTEZ)[-_A-Za-z0-9]{8,}/g, "***").slice(0, 300);
}

/**
 * Runs the page call through the provider chain, moving on only when a provider
 * legitimately fails. Returns the raw model content plus which provider served
 * it, or throws a user-safe error when every provider is unavailable.
 */
export async function routeTranslation(call: ProviderCall): Promise<ProviderResult> {
  const errors: string[] = [];
  let sawConfigured = false;

  for (const def of DEFS) {
    const key = keyOf(def);
    if (!key) continue;
    sawConfigured = true;
    if (!available(def)) continue;

    const s = stateFor(def.keyId);
    s.requests++;
    const result = await callProvider(def, key, call);

    if (result.ok) {
      s.successes++;
      s.lastSuccessAt = Date.now();
      s.cooldownUntil = null;
      return { content: result.content, provider: def.keyId };
    }

    s.failures++;
    if (result.status === 429) s.rateLimits++;
    if (result.status === 402) s.quotaErrors++;
    if (isRetryable(result.status)) {
      s.cooldownUntil = Date.now() + COOLDOWN_MS;
      errors.push(`${def.keyId}: ${result.status}`);
      continue;
    }
    // A non-retryable error (bad request/auth) means this key stays skipped for
    // the cooldown too, but the request itself is still worth trying elsewhere.
    s.cooldownUntil = Date.now() + COOLDOWN_MS;
    errors.push(`${def.keyId}: ${result.status} ${result.detail}`);
  }

  if (!sawConfigured) throw new Error("No translation provider is configured for this project.");
  throw new Error(
    `All translation providers are temporarily unavailable (${errors.slice(0, 4).join("; ")}).`,
  );
}
