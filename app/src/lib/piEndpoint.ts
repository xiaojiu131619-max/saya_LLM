import { fast27bGetStatus } from '@/lib/ipc/fast27b';
import { strataGetStatus } from '@/lib/ipc/strata';
import { getDesktopConfig } from '@/lib/ipc/config';
import { getDesktopServerStatus, getServerApiKey } from '@/lib/ipc/server';

/**
 * Pi 的模型端点自动对接。
 *
 * Pi 不需要用户手动填「引擎地址 / 模型 ID / API Key」：三个本机后端
 * （NiNfer / Strata / 主模型 llama-server）在显存上互斥，任选「正在跑的那个」
 * 即可。优先级对齐产品默认：NiNfer 优先，llama 兜底。
 *
 * 只返回已经「可对话」的后端；引擎在加载中时宁可回退到下一个，
 * 也不要把 Pi 指向一个发请求会挂起的端口。
 */

export interface PiAutoEndpoint {
  /** OpenAI 兼容基址，以 /v1 结尾。 */
  baseUrl: string;
  apiKey: string;
  /** 展示名：NiNfer / Strata / 主模型。 */
  label: string;
  /** 已知的模型 ID；为空时由 Pi 启动前探测 /v1/models。 */
  model?: string;
  /** 上下文窗口，用于写 models.json。 */
  contextWindow?: number;
}

export async function resolveAutoPiEndpoint(): Promise<PiAutoEndpoint | null> {
  // 1. NiNfer（fast27b）：api_ready = 进程存活 + /v1/models 在线。
  const fast = await fast27bGetStatus().catch(() => null);
  if (fast?.running && fast.api_ready && fast.port) {
    return {
      baseUrl: `http://127.0.0.1:${fast.port}/v1`,
      apiKey: fast.api_key?.trim() || 'local',
      label: 'NiNfer',
      model: fast.model_id?.trim() || undefined,
      contextWindow: fast.context_window_effective || fast.context_window || undefined,
    };
  }

  // 2. Strata：api_ready = 进程存活 + 权重已加载。
  const strata = await strataGetStatus().catch(() => null);
  if (strata?.running && strata.api_ready) {
    return {
      baseUrl: strata.base_url,
      apiKey: strata.api_key?.trim() || 'local',
      label: 'Strata',
      model: strata.model_name?.trim() || undefined,
      contextWindow: strata.max_context || undefined,
    };
  }

  // 3. 主模型 llama-server 兜底。
  const mainRunning = await getDesktopServerStatus().catch(() => false);
  if (!mainRunning) return null;
  const [config, serverKey] = await Promise.all([
    getDesktopConfig().catch(() => null),
    getServerApiKey().catch(() => null),
  ]);
  const port = config?.default_port || 8080;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: serverKey?.trim() || 'local',
    label: '主模型',
  };
}

/** 当前是否指向本机回环端点（决定是否需要宿主服务的 API Key）。 */
export function isLoopbackPiEndpoint(baseUrl: string): boolean {
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(baseUrl.trim());
}
