import {
  piAgentDiscover,
  piAgentGetStatus,
  piAgentStart,
  piAgentStop,
  type PiAgentStartOptions,
  type PiAgentStatus,
} from '@/lib/ipc/pi';
import { getServerApiKey } from '@/lib/ipc/server';

/**
 * Pi 内核的共享配置。
 *
 * Agent 页的 Pi 设置与 Chat 的 Pi 工作区共用这一份配置：
 * - 持久化在 localStorage；
 * - Chat 发送前用 `ensurePiForSession` 自动启动目标会话；
 * - 工作区由宿主派生为 `<根目录>/<Pi session>`，前端只保存根目录。
 */

export interface PiConfig extends PiAgentStartOptions {
  /** 技能库目录；宿主只读取元数据，正文按任务注入。 */
  skillsDir: string;
  /** 是否启用宿主技能路由。 */
  skillRoutingEnabled: boolean;
  /** 随应用启动 Pi：启动软件时自动拉起，关闭软件一并停止；关闭则完全不自动启动。 */
  autoStart: boolean;
}

export const PI_CONFIG_KEY = 'pi-agent-config-v1';
/** 配置变更事件：Agent 设置页保存后，全局 Pi runtime 重新读取。 */
export const PI_CONFIG_CHANGED_EVENT = 'pi-config-changed';

export function defaultPiConfig(): PiConfig {
  return {
    nodePath: 'node',
    cliPath: '',
    agentDir: '',
    workDir: '',
    provider: 'local-llama',
    model: '',
    baseUrl: 'http://127.0.0.1:8080/v1',
    apiKey: 'local',
    permissionMode: 'auto',
    sessionId: '',
    sessionDir: '',
    skillsDir: '',
    skillRoutingEnabled: true,
    // 默认开启：保持原有「Pi 随用随起」的体验；关掉后才是「不自动启动」。
    autoStart: true,
  };
}

export function loadPiConfig(): PiConfig {
  const defaults = defaultPiConfig();
  try {
    const raw = localStorage.getItem(PI_CONFIG_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<PiConfig>;
    return {
      ...defaults,
      ...parsed,
      permissionMode:
        parsed.permissionMode === 'plan' ||
        parsed.permissionMode === 'auto' ||
        parsed.permissionMode === 'full'
          ? parsed.permissionMode
          : defaults.permissionMode,
      skillRoutingEnabled:
        typeof parsed.skillRoutingEnabled === 'boolean'
          ? parsed.skillRoutingEnabled
          : defaults.skillRoutingEnabled,
      autoStart:
        typeof parsed.autoStart === 'boolean' ? parsed.autoStart : defaults.autoStart,
    };
  } catch {
    return defaults;
  }
}

export function savePiConfig(config: PiConfig) {
  try {
    localStorage.setItem(PI_CONFIG_KEY, JSON.stringify(config));
    window.dispatchEvent(new Event(PI_CONFIG_CHANGED_EVENT));
  } catch {
    // 配额不足时静默；不影响当前运行
  }
}

/** 会话工作目录由宿主派生，这里只做展示/兜底。 */
export function isLoopbackBaseUrl(baseUrl: string): boolean {
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(baseUrl.trim());
}

/** 每个 Pi 会话一个独立工作区，避免会话 B 读到会话 A 的产物。 */
export function sessionWorkDir(root: string, piSessionId: string) {
  const safe = piSessionId.replace(/[^A-Za-z0-9._-]/g, '_');
  const separator = root.includes('\\') ? '\\' : '/';
  return `${root.replace(/[\\/]+$/, '')}${separator}${safe}`;
}

export function newPiSessionId() {
  return `pi-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 「随应用启动」使用的固定会话：工作区稳定为 <根目录>/pi-auto，不会每次开机换目录。 */
export const PI_AUTO_SESSION_ID = 'pi-auto';

const PI_RUN_SIGNATURE_KEY = 'pi-agent-run-signature';

/** 决定「需要重启 Pi 才能生效」的配置指纹（端点 / Provider / 模型 / Key）。 */
export function runSignature(config: PiConfig, model: string): string {
  return [
    config.baseUrl.trim(),
    config.provider.trim(),
    model.trim(),
    config.apiKey.trim(),
  ].join('\u0000');
}

function readRunSignature(): string | null {
  try {
    return localStorage.getItem(PI_RUN_SIGNATURE_KEY);
  } catch {
    return null;
  }
}

function writeRunSignature(signature: string) {
  try {
    localStorage.setItem(PI_RUN_SIGNATURE_KEY, signature);
  } catch {
    // 配额不足时忽略：只影响「改配置后自动重启」这一层优化
  }
}

/** 探测并补齐空白路径；不覆盖用户已经填过的值。 */
export async function hydratePiConfig(config: PiConfig): Promise<PiConfig> {
  if (config.cliPath.trim() && config.workDir.trim() && config.agentDir.trim()) {
    return config;
  }
  const discover = await piAgentDiscover().catch(() => null);
  if (!discover) return config;
  return {
    ...config,
    nodePath: config.nodePath.trim() || discover.node_path || 'node',
    cliPath: config.cliPath.trim() || discover.cli_path || '',
    agentDir: config.agentDir.trim() || discover.agent_dir || '',
    workDir: config.workDir.trim() || discover.work_dir || '',
    sessionDir: config.sessionDir.trim() || discover.session_dir || '',
    skillsDir: config.skillsDir.trim() || discover.skills_dir || '',
  };
}

async function probeModel(baseUrl: string, apiKey: string): Promise<string> {
  const url = `${baseUrl.replace(/\/+$/, '')}/models`;
  const headers: Record<string, string> = {};
  if (apiKey.trim()) headers.Authorization = `Bearer ${apiKey.trim()}`;
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`读取引擎模型失败：HTTP ${response.status}`);
  const body = (await response.json()) as {
    data?: Array<{ id?: string }>;
    models?: Array<{ name?: string }>;
  };
  const id = body.data?.[0]?.id ?? body.models?.[0]?.name ?? '';
  if (!id) throw new Error('引擎没有返回模型 ID，请到 Agent 页的 Pi 设置里填写模型 ID。');
  return id;
}

/**
 * 确保 Pi 以指定会话运行。
 *
 * - 已在同一会话：直接返回状态；
 * - 正在跑别的会话：先停止再启动（Pi 是单进程）；
 * - 未运行：按共享配置启动。
 *
 * `coldStart` 表示「没有实例时是否允许拉起」。用户手点启动、开关刚打开时传 true；
 * 普通发送 / 预启动传 false——否则「随应用启动」关掉后，发一条消息又会把 Pi 拉起来。
 */
export async function ensurePiForSession(
  piSessionId: string,
  coldStart = true,
): Promise<PiAgentStatus> {
  const config = await hydratePiConfig(loadPiConfig());
  // 本机端点：服务可能因为对外开放而启用鉴权，Pi 必须带同一把 Key。
  // 用户不需要知道这把 Key 是什么——直接从宿主当前运行的服务读出来。
  if (isLoopbackBaseUrl(config.baseUrl)) {
    const serverKey = await getServerApiKey().catch(() => null);
    const trimmed = serverKey?.trim();
    if (trimmed) config.apiKey = trimmed;
  }
  savePiConfig(config);
  if (!config.cliPath.trim()) {
    throw new Error('未找到 Pi CLI（cli.js）。请到 Agent 页的「Pi」设置里填写路径。');
  }
  if (!config.workDir.trim()) {
    throw new Error('Pi 工作目录为空。请到 Agent 页的「Pi」设置里检查。');
  }

  const current = await piAgentGetStatus().catch(() => null);
  // 端点 / 模型 / Key 变了，必须重启才能生效：旧进程不会自己换配置。
  const signature = runSignature(config, config.model);
  const needsRestart = current?.running && readRunSignature() !== signature;
  if (current?.running && current.session_id === piSessionId && !needsRestart) {
    return current;
  }
  if (!current?.running && !coldStart) {
    throw new Error(
      'Pi 没有在运行，且「随应用启动」已关闭。请到 Agent 页的「Pi」点「启动」，或打开「随应用启动」。',
    );
  }
  if (current?.running) {
    await piAgentStop();
  }

  let model = config.model.trim();
  // NiNfer / Strata 的模型 ID 会随所选变体变化（bonsai/saluki、gyro-s/gyro-m）。
  // 端点固定指向本机引擎端口时，以引擎实际 `/v1/models` 为准：旧配置里钉死的
  // `qwen3.8-27b` / `underdog-saluki-27b` 不会让 Pi 一直 404。
  const engineEndpoint = /:(8094|8082)(\/|$)/.test(config.baseUrl.trim());
  if (!model || engineEndpoint) {
    const probed = await probeModel(config.baseUrl, config.apiKey).catch((error) => {
      // 用户显式填了模型时，探测失败就沿用原值（远端/离线场景不该被这段逻辑改坏）。
      if (!model) throw error;
      return null;
    });
    if (probed && probed !== model) {
      model = probed;
      config.model = probed;
      savePiConfig(config);
    }
  }

  const next = await piAgentStart({
    ...config,
    model,
    workDir: config.workDir,
    sessionId: piSessionId,
    sessionDir: config.sessionDir,
  });
  if (!next) throw new Error('Pi 启动失败：宿主没有返回状态。');
  if (!next.running) {
    throw new Error(next.message || 'Pi 启动失败，请查看 Agent 页的运行日志。');
  }
  writeRunSignature(runSignature(config, model));
  return next;
}
