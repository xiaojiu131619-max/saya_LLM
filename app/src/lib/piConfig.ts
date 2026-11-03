import {
  piAgentDiscover,
  piAgentGetStatus,
  piAgentStart,
  piAgentStop,
  type PiAgentStartOptions,
  type PiAgentStatus,
} from '@/lib/ipc/pi';

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

/** 每个 Pi 会话一个独立工作区，避免会话 B 读到会话 A 的产物。 */
export function sessionWorkDir(root: string, piSessionId: string) {
  const safe = piSessionId.replace(/[^A-Za-z0-9._-]/g, '_');
  const separator = root.includes('\\') ? '\\' : '/';
  return `${root.replace(/[\\/]+$/, '')}${separator}${safe}`;
}

export function newPiSessionId() {
  return `pi-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
 */
export async function ensurePiForSession(piSessionId: string): Promise<PiAgentStatus> {
  const config = await hydratePiConfig(loadPiConfig());
  savePiConfig(config);
  if (!config.cliPath.trim()) {
    throw new Error('未找到 Pi CLI（cli.js）。请到 Agent 页的「Pi」设置里填写路径。');
  }
  if (!config.workDir.trim()) {
    throw new Error('Pi 工作目录为空。请到 Agent 页的「Pi」设置里检查。');
  }

  const current = await piAgentGetStatus().catch(() => null);
  if (current?.running && current.session_id === piSessionId) {
    return current;
  }
  if (current?.running) {
    await piAgentStop();
  }

  const model = config.model.trim() || (await probeModel(config.baseUrl, config.apiKey));
  if (!config.model.trim()) {
    config.model = model;
    savePiConfig(config);
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
  return next;
}
