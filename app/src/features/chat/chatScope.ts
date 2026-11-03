import { AGENT_SCOPE_MODEL_ID, type ChatScope } from '@/types';
import { CHAT_HISTORY_MODEL_ID, compactModelName } from './chatUtils';

/**
 * 对话归属（主对话 / Pi 工作区）的会话桶与身份描述。
 *
 * 轴的分工：
 * - `ChatEngineId` 只回答「主对话用哪个补全后端」（llama / NiNfer / Strata）；
 * - `ChatScope` 回答「这段对话属于谁」，决定会话桶、侧边栏、输入入口和身份文案。
 */

/** 引擎摘要：只暴露 profile 需要的字段，避免把 ChatPage 的引擎类型带进来。 */
export interface ChatScopeEngine {
  label: string;
  /** 给人看的完整名称（引擎 + 模型），用于空状态说明。 */
  displayName?: string;
  serviceable: boolean;
}

/** 计算「当前 scope 能不能发消息」所需的运行时快照。 */
export interface ChatScopeRuntime {
  desktopReady: boolean;
  serverRunning: boolean;
  /** 主模型是否已经加载（filePath 存在）。 */
  modelReady: boolean;
  /** Pi CLI 是否可用（配置已探测到 cli.js）。 */
  piReady: boolean;
  /** Pi 进程是否在运行。 */
  piRunning: boolean;
  /** 当前 Chat 会话是否就是 Pi 正在跑的会话。 */
  piSessionReady: boolean;
  /** 正在切换到目标 Pi 会话（启动期间禁止发送）。 */
  piStarting: boolean;
  engine: ChatScopeEngine | null;
  /** 当前会话 / 模型的展示名，仅用于主对话的身份文案。 */
  modelName?: string;
}

export interface ChatScopeProfile {
  scope: ChatScope;
  /** 完整名称（侧边栏身份区、入口提示）。 */
  label: string;
  /** 一句话说明这段对话是什么。 */
  description: string;
  /** 该 scope 在 `state.chatSessions` 里的桶键。 */
  historyKey: string;
  /** 发送入口：普通补全流，还是 Pi 任务流。 */
  sendRoute: 'completion' | 'agent';
  /** 可对话判据。 */
  canChat: (runtime: ChatScopeRuntime) => boolean;
  /** 页头第一行身份。 */
  eyebrow: (runtime: ChatScopeRuntime) => string;
  /** 页头第三行的模型 / 内核说明。 */
  subtitle: (runtime: ChatScopeRuntime) => string;
  /** 页头运行状态。 */
  statusText: (runtime: ChatScopeRuntime) => string;
  /** 输入框占位符。 */
  placeholder: (runtime: ChatScopeRuntime) => string;
  /** 空会话说明。 */
  emptyMessage: (runtime: ChatScopeRuntime) => string;
  /** 空会话顶部的身份小标题。 */
  emptyEyebrow: string;
}

/** 主对话的桶键保持旧值，现有数据零迁移。 */
export function historyKeyOf(scope: ChatScope): string {
  if (scope === 'main') return CHAT_HISTORY_MODEL_ID;
  return AGENT_SCOPE_MODEL_ID[scope];
}

function mainCanChat(runtime: ChatScopeRuntime): boolean {
  return runtime.engine
    ? runtime.engine.serviceable
    : Boolean(runtime.desktopReady && runtime.modelReady && runtime.serverRunning);
}

const MAIN_PROFILE: ChatScopeProfile = {
  scope: 'main',
  label: '主对话',
  description: '本地模型 · 普通对话',
  historyKey: historyKeyOf('main'),
  sendRoute: 'completion',
  canChat: mainCanChat,
  eyebrow: (runtime) => (runtime.engine ? `本地对话 / ${runtime.engine.label}` : '本地对话 / 主模型'),
  subtitle: (runtime) => compactModelName(
    runtime.modelName ?? runtime.engine?.displayName ?? runtime.engine?.label,
  ),
  statusText: (runtime) => {
    if (runtime.engine) {
      return mainCanChat(runtime)
        ? `${runtime.engine.label} 已连接`
        : `${runtime.engine.label} 未启动`;
    }
    return mainCanChat(runtime) ? 'llama-server 已连接' : '历史对话可查看';
  },
  placeholder: (runtime) => {
    if (runtime.engine) {
      return mainCanChat(runtime)
        ? '输入消息...'
        : `请先到 NiNfer 页启动 ${runtime.engine.label} 引擎`;
    }
    if (runtime.modelName) {
      return mainCanChat(runtime) ? '输入消息...' : '请先从模型管理加载本地模型';
    }
    return '加载模型后可继续发送，历史对话仍可查看';
  },
  emptyMessage: (runtime) => {
    if (runtime.engine) {
      const name = runtime.engine.displayName ?? runtime.engine.label;
      return mainCanChat(runtime)
        ? `${name} · 引擎已连接，可上传照片、视频和文本文件（视频仅分析画面；已连接的 MCP 工具可参与调用）`
        : `${runtime.engine.label} 引擎未运行：到 NiNfer 页启动引擎后再对话`;
    }
    if (runtime.modelName) {
      return mainCanChat(runtime)
        ? `${runtime.modelName} · llama-server 已连接`
        : '请先从模型管理加载模型，连接真实 llama-server 后再开始对话';
    }
    return '历史对话会独立保存。加载本地 GGUF 模型后即可继续发送。';
  },
  emptyEyebrow: 'LOCAL LLM',
};

const PI_PROFILE: ChatScopeProfile = {
  scope: 'pi',
  label: 'Pi 工作区',
  description: 'Pi 内核 · 连续执行 · 沙箱内操控文件',
  historyKey: historyKeyOf('pi'),
  sendRoute: 'agent',
  canChat: (runtime) => runtime.desktopReady && runtime.piReady && !runtime.piStarting,
  eyebrow: () => '助手 / Pi',
  subtitle: () => 'Pi 内核 · 连续执行 · 沙箱内操控文件',
  statusText: (runtime) => {
    if (runtime.piStarting) return 'Pi 正在切换会话…';
    if (runtime.piSessionReady) return 'Pi 已连接';
    if (runtime.piRunning) return 'Pi 正在运行其他会话';
    if (!runtime.piReady) return 'Pi 未配置 — 到 Agent 页填写 CLI 路径';
    return 'Pi 未启动 — 发送时自动启动';
  },
  placeholder: (runtime) => {
    if (runtime.piStarting) return 'Pi 正在启动，稍等即可发送';
    if (!runtime.piReady) return '请先到 Agent 页的 Pi 设置里填写 CLI 路径';
    return '输入消息...';
  },
  emptyMessage: (runtime) => {
    if (!runtime.piReady) return 'Pi 未配置：到 Agent 页的 Pi 设置里填写 Node / CLI 路径后再对话。';
    return 'Pi 已就绪：说一句话，它会自己连续执行、验证产物。';
  },
  emptyEyebrow: 'PI WORKSPACE',
};

const PROFILES: Record<ChatScope, ChatScopeProfile> = {
  main: MAIN_PROFILE,
  pi: PI_PROFILE,
};

export function chatScopeProfile(scope: ChatScope): ChatScopeProfile {
  return PROFILES[scope];
}
