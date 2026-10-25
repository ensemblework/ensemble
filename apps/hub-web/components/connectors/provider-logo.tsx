/** @jsxRuntime automatic */
/** @jsxImportSource react */
/** Vendor marks identify providers; the source assets and attribution live in public/providers/manifest.json. */
import { EnsembleMark } from "../brand/Logo";

const NAMES: Record<string, string> = { qwen: "Qwen", kimi: "Kimi", openrouter: "OpenRouter", openai: "OpenAI", claude: "Claude", cursor: "Cursor", copilot: "GitHub Copilot", google: "Google", gemini: "Gemini", microsoft: "Microsoft", github: "GitHub", deepseek: "DeepSeek", mistral: "Mistral AI", meta: "Meta", ollama: "Ollama", opencode: "OpenCode" };

export function modelBrand(model?: string | null, provider?: string | null): string | null {
  const value = (model ?? "").toLowerCase().split("::").at(-1)?.split("/").at(-1) ?? "";
  if (/claude|haiku|sonnet|opus/.test(value)) return "claude";
  if (/^(gpt-|chatgpt|o[1-9](?:-|$)|codex)/.test(value)) return "openai";
  if (/gemini|gemma/.test(value)) return "gemini";
  if (/^(mai-|phi-)/.test(value)) return "microsoft";
  if (/qwen|qwq/.test(value)) return "qwen";
  if (/kimi|moonshot/.test(value)) return "kimi";
  if (/deepseek/.test(value)) return "deepseek";
  if (/mistral|mixtral|codestral|devstral|ministral/.test(value)) return "mistral";
  if (/llama/.test(value)) return "meta";
  const key = (provider ?? (model?.includes("::") ? model.split("::")[0] : model) ?? "").toLowerCase();
  return ({ qwen: "qwen", kimi: "kimi", openrouter: "openrouter", anthropic: "claude", "claude-code": "claude", codex: "openai", openai: "openai", chatgpt: "openai", "cursor-agent": "cursor", cursor: "cursor", "copilot-cli": "copilot", copilot: "copilot", google: "gemini", gemini: "gemini", "gemini-cli": "gemini", antigravity: "google", opencode: "opencode", microsoft: "microsoft", github: "github", deepseek: "deepseek", mistral: "mistral", ollama: "ollama", ensemble: "ensemble" } as Record<string, string>)[key] ?? null;
}

export function ProviderLogo({ id, size = 16, decorative = true, className = "" }: { id: string; size?: number; decorative?: boolean; className?: string }) {
  const key = NAMES[id] ? id : modelBrand(null, id);
  if (!key) return null;
  // Included models: Ensemble's own mark, in its brand colours rather than masked to the text colour.
  if (key === "ensemble") return <EnsembleMark size={size} data-provider-logo="ensemble" title={decorative ? undefined : "Ensemble"} className={`inline-block shrink-0 align-middle ${className}`} />;
  const url = `url("/providers/${key}.svg")`;
  return <span data-provider-logo={key} aria-hidden={decorative || undefined} role={decorative ? undefined : "img"} aria-label={decorative ? undefined : NAMES[key]} className={`inline-block shrink-0 align-middle text-ink ${className}`} style={{ width: size, height: size, backgroundColor: "currentColor", maskImage: url, WebkitMaskImage: url, maskSize: "contain", WebkitMaskSize: "contain", maskPosition: "center", WebkitMaskPosition: "center", maskRepeat: "no-repeat", WebkitMaskRepeat: "no-repeat" }} />;
}

export function ModelLogo({ model, provider, size = 14 }: { model?: string | null; provider?: string | null; size?: number }) {
  const key = modelBrand(model, provider);
  return key ? <ProviderLogo id={key} size={size} /> : null;
}

export function SignInLogo({ provider }: { provider: string }) {
  return <img src={`/providers/${provider}.svg`} width={19} height={19} alt="" aria-hidden draggable={false} className={provider === "github" ? "vendor-signin-monochrome" : undefined} />;
}
