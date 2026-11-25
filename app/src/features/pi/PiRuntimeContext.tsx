import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ShieldAlert, X } from 'lucide-react';
import ConfirmDialog from '@/components/ConfirmDialog';
import { useApp } from '@/context/AppContext';
import { judgeArtifactDelivery } from '@/features/chat/artifactGate';
import { buildAgentArtifacts, inferArtifactKind } from '@/features/chat/artifacts';
import {
  piAgentCancel,
  piAgentGetStatus,
  piAgentPermissionAnswer,
  piAgentRun,
  piAgentSelectSkills,
  piAgentSetPermissionMode,
  piAgentStop,
  piResolveArtifacts,
  subscribePiAgent,
  type PiAgentEventPayload,
  type PiAgentStatus,
  type PiPermissionMode,
  type PiPermissionRequest,
} from '@/lib/ipc/pi';
import {
  describePiFailure,
  piFailureMessage,
  piTextDelta,
  piThinkingDelta,
  piToolStep,
} from '@/lib/piEvents';
import {
  PI_AUTO_SESSION_ID,
  PI_CONFIG_CHANGED_EVENT,
  ensurePiForSession,
  hydratePiConfig,
  isNoEngineError,
  loadPiConfig,
  savePiConfig,
  sessionWorkDir,
  type PiConfig,
} from '@/lib/piConfig';
import type { MessageStats, PiFileChange, PiStep } from '@/types';
import { AGENT_SCOPE_MODEL_ID } from '@/types';

/**
 * Pi 的全局运行时。
 *
 * 之前事件订阅和 run 状态挂在 ChatPage：离开对话工作区就丢流式更新，
 * 权限弹窗也收不到。这里把订阅、run 状态、消息回写和权限弹窗提到 App 层，
 * 页面只负责渲染和发起任务。
 */

type PiRunState = {
  runId: string;
  messageId: string;
  sessionId: string;
  sessionModelId: string;
  piSessionId: string;
  prompt: string;
  workDir: string;
  steps: PiStep[];
  /** 本轮 Pi 落盘的文件改动（pi:file-changes 累积，随消息持久化）。 */
  changes: PiFileChange[];
  artifactPaths: string[];
  toolPaths: Record<string, string>;
  assistantText: string;
  reasoningText: string;
  /** 本轮性能指标：prompt 发出时刻，用于 TTFT。 */
  promptSentTs: number;
  /** 首个 / 最后一个增量事件时刻，用于生成耗时与 tok/s。 */
  firstDeltaTs: number | null;
  lastDeltaTs: number | null;
  /** Pi message_update 自带的累计 usage（provider 上报）。 */
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number } | null;
  /** 本轮失败原因（Pi 用 turn_end/message_end 的 stopReason 表达，没有 error 事件）。 */
  failure: string | null;
  /** 本轮使用的模型端点，用于把失败原因写成可操作提示。 */
  baseUrl: string;
};

export interface PiTaskInput {
  text: string;
  sessionId: string;
  sessionModelId: string;
  piSessionId: string;
  messageId: string;
  /** 该会话绑定的工作区目录（真实本地文件夹）；缺省走旧会话子目录。 */
  workspaceDir?: string;
}

interface PiRuntimeValue {
  status: PiAgentStatus | null;
  config: PiConfig | null;
  error: string | null;
  /** 正在预启动的目标 Pi session；Chat 用它禁用发送。 */
  startingSessionId: string | null;
  sendTask: (input: PiTaskInput) => Promise<void>;
  cancelTask: () => Promise<void>;
  prewarm: (piSessionId: string, workspaceDir?: string) => Promise<void>;
  startSession: (piSessionId: string, coldStart?: boolean, workspaceDir?: string) => Promise<PiAgentStatus>;
  refreshStatus: () => Promise<void>;
  reloadConfig: () => Promise<void>;
  /** 切换权限档：写入共享配置，运行中立即生效。 */
  setPermissionMode: (mode: PiPermissionMode) => Promise<void>;
}

const PiRuntimeContext = createContext<PiRuntimeValue | null>(null);

/** 权限档的中文名：弹窗里直接给用户看，不暴露内部 plan/auto/full。 */
const PERMISSION_MODE_LABELS: Record<string, string> = {
  plan: '只读',
  auto: '守门',
  full: '放行',
};

// eslint-disable-next-line react-refresh/only-export-components
export function usePiRuntime() {
  const value = useContext(PiRuntimeContext);
  if (!value) throw new Error('usePiRuntime 必须在 PiRuntimeProvider 内使用');
  return value;
}

export function PiRuntimeProvider({ children }: { children: ReactNode }) {
  const { dispatch, state } = useApp();
  const [status, setStatus] = useState<PiAgentStatus | null>(null);
  const [config, setConfig] = useState<PiConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 权限请求必须排队而不是单槽覆盖：canvas_run 等工具在独立线程等待确认时，
  // 工具桥事件循环仍会继续处理下一个调用并再次弹出确认。单槽会让先到的请求
  // 被顶掉、120 秒后静默拒绝，用户也可能批准错对象。
  const [permissionQueue, setPermissionQueue] = useState<PiPermissionRequest[]>([]);
  const pendingPermission = permissionQueue[0] ?? null;
  // 权限请求所属轮次的上下文（任务摘要 / 工作区）。在事件回调里取快照，
  // 避免渲染期直接读 runRef。
  const [permissionContext, setPermissionContext] = useState<{
    task: string;
    workDir: string;
  } | null>(null);
  const [startingSessionId, setStartingSessionId] = useState<string | null>(null);
  const runRef = useRef<PiRunState | null>(null);
  const eventBufferRef = useRef<PiAgentEventPayload[]>([]);
  const cancelRequestedRef = useRef(false);
  const statusRef = useRef<PiAgentStatus | null>(null);
  const ensureChainRef = useRef<Promise<unknown>>(Promise.resolve());
  const prewarmSeqRef = useRef(0);
  const pendingPrewarmRef = useRef<{ piSessionId: string; workspaceDir?: string } | null>(null);
  // 自动启动优先复用最近一次 Pi 会话，避免开机先起 pi-auto、进对话又重启一次。
  const chatSessionsRef = useRef(state.chatSessions);
  useEffect(() => {
    chatSessionsRef.current = state.chatSessions;
  }, [state.chatSessions]);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const refreshStatus = useCallback(async () => {
    try {
      const next = await piAgentGetStatus();
      if (next) setStatus(next);
    } catch {
      // 状态轮询失败不打扰用户
    }
  }, []);

  const reloadConfig = useCallback(async () => {
    try {
      const next = await hydratePiConfig(loadPiConfig());
      savePiConfig(next);
      setConfig(next);
    } catch {
      setConfig(loadPiConfig());
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reloadConfig();
    void refreshStatus();
    const timer = window.setInterval(() => void refreshStatus(), 3000);
    const onConfigChanged = () => setConfig(loadPiConfig());
    window.addEventListener(PI_CONFIG_CHANGED_EVENT, onConfigChanged);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener(PI_CONFIG_CHANGED_EVENT, onConfigChanged);
    };
  }, [refreshStatus, reloadConfig]);

  const startSession = useCallback(async (piSessionId: string, coldStart = true, workspaceDir?: string) => {
    const next = ensureChainRef.current
      .catch(() => undefined)
      .then(() => ensurePiForSession(piSessionId, coldStart, workspaceDir));
    ensureChainRef.current = next;
    const result = await next;
    setStatus(result);
    return result;
  }, []);

  /**
   * 随应用启动 Pi。
   *
   * 开关打开：应用启动时拉起一个常驻实例（固定 pi-auto 会话，工作区稳定）；
   * 开关在运行中打开/关闭也即时生效——打开就启动，关闭就停止，之后不再自动拉起。
   * 关闭状态下手动点「启动」仍然可用（那是用户的显式动作）。
   */
  const autoStartPrevRef = useRef<boolean | null>(null);

  /** 自动启动用的会话：最近一次 Pi 对话；没有历史时退回到固定的 pi-auto。 */
  const autoSessionId = useCallback(() => {
    const bucket = chatSessionsRef.current[AGENT_SCOPE_MODEL_ID.pi] ?? [];
    const latest = [...bucket]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .find((session) => Boolean(session.piSessionId));
    return latest?.piSessionId || PI_AUTO_SESSION_ID;
  }, []);

  useEffect(() => {
    let disposed = false;

    const apply = async (enabled: boolean) => {
      if (disposed) return;
      if (enabled) {
        try {
          await startSession(autoSessionId(), true);
          if (!disposed) setError(null);
        } catch (reason) {
          if (disposed) return;
          // 没加载模型时自动启动失败是常态，不当错误弹横幅。
          if (isNoEngineError(reason)) return;
          setError(
            `Pi 自动启动失败：${String(reason instanceof Error ? reason.message : reason)}`,
          );
        }
        return;
      }
      try {
        await piAgentStop();
      } catch {
        // 没在运行时停止会报错，忽略即可
      }
      if (disposed) return;
      setStatus((prev) => (prev ? { ...prev, running: false, pid: null } : prev));
    };

    const sync = () => {
      const enabled = loadPiConfig().autoStart;
      const previous = autoStartPrevRef.current;
      autoStartPrevRef.current = enabled;
      // 启动时本来就是关闭状态：按「关闭不启动 Pi」处理，什么都不做。
      if (previous === null && !enabled) return;
      if (previous === enabled) return;
      void apply(enabled);
    };

    const timer = window.setTimeout(sync, 0);
    window.addEventListener(PI_CONFIG_CHANGED_EVENT, sync);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      window.removeEventListener(PI_CONFIG_CHANGED_EVENT, sync);
    };
  }, [autoSessionId, startSession]);

  const prewarm = useCallback(
    async (piSessionId: string, workspaceDir?: string) => {
      if (!piSessionId.trim()) return;
      const active = runRef.current;
      if (active) {
        if (active.piSessionId !== piSessionId) pendingPrewarmRef.current = { piSessionId, workspaceDir };
        return;
      }
      const current = statusRef.current;
      if (current?.running && current.session_id === piSessionId) return;
      // 「随应用启动」关掉后，切会话不应该把 Pi 偷偷拉起来。
      if (!current?.running && !loadPiConfig().autoStart) return;

      const seq = prewarmSeqRef.current + 1;
      prewarmSeqRef.current = seq;
      setStartingSessionId(piSessionId);
      setError(null);
      try {
        await startSession(piSessionId, loadPiConfig().autoStart, workspaceDir);
      } catch (reason) {
        if (prewarmSeqRef.current === seq && !isNoEngineError(reason)) {
          setError(
            `Pi 预启动失败：${String(reason instanceof Error ? reason.message : reason)}`,
          );
        }
      } finally {
        if (prewarmSeqRef.current === seq) setStartingSessionId(null);
      }
    },
    [startSession],
  );

  const pushStep = useCallback(
    (run: PiRunState, text: string, tone: PiStep['tone'], point = 'event') => {
      const last = run.steps[run.steps.length - 1];
      if (last && last.point === point && last.text === text) {
        run.steps[run.steps.length - 1] = { ...last, repeat: (last.repeat ?? 1) + 1 };
      } else {
        run.steps.push({ ts: Date.now(), point, text, tone, repeat: 1 });
      }
      dispatch({
        type: 'UPDATE_MESSAGE',
        payload: {
          modelId: run.sessionModelId,
          sessionId: run.sessionId,
          messageId: run.messageId,
          piSteps: [...run.steps],
        },
      });
    },
    [dispatch],
  );

  /** 记录 provider 上报的累计 usage（任何 message_update 都可能带，最终值常在无增量的更新上）。 */
  const recordUsage = useCallback((run: PiRunState, usage: unknown) => {
    if (!usage || typeof usage !== 'object') return;
    const num = (value: unknown) =>
      typeof value === 'number' && Number.isFinite(value) ? value : 0;
    const record = usage as Record<string, unknown>;
    run.usage = {
      input: num(record.input),
      output: num(record.output),
      cacheRead: num(record.cacheRead),
      cacheWrite: num(record.cacheWrite),
      totalTokens: num(record.totalTokens),
    };
  }, []);

  /** 记录增量事件时刻（TTFT / 生成耗时用）。 */
  const recordDelta = useCallback(
    (run: PiRunState, event: Record<string, unknown>) => {
      const now = Date.now();
      if (run.firstDeltaTs === null) run.firstDeltaTs = now;
      run.lastDeltaTs = now;
      recordUsage(run, event.usage);
    },
    [recordUsage],
  );

  /** 把本轮采集到的性能指标写进消息；llama-server 不上报 usage 时留空。 */
  const finalizeStats = useCallback(
    (run: PiRunState): MessageStats | undefined => {
      const usage = run.usage;
      const outputTokens = usage?.output ?? 0;
      const firstTokenDelay =
        run.firstDeltaTs !== null ? (run.firstDeltaTs - run.promptSentTs) / 1000 : 0;
      // 生成耗时从「发出 prompt」算到「最后一个增量」，与主对话的 elapsedRequestStats
      // 同一口径（都含首字延迟与工具执行间隙）。
      // 之前只算首末增量之间的差：整轮只有一次增量时差值为 0，
      // 界面上 TTFT / tok/s / 生成耗时三格会一起变成「--」。
      const genTime =
        run.lastDeltaTs !== null
          ? Math.max(0, (run.lastDeltaTs - run.promptSentTs) / 1000)
          : 0;
      const tokensPerSec = genTime > 0 && outputTokens > 0 ? outputTokens / genTime : 0;
      const ctxUsed = (usage?.input ?? 0) + (usage?.cacheRead ?? 0);
      if (outputTokens <= 0 && firstTokenDelay <= 0) return undefined;
      return {
        ctxUsed,
        ctxTotal: 0,
        outputTokens,
        firstTokenDelay,
        tokensPerSec,
        genTime,
      };
    },
    [],
  );

  const finalizeRun = useCallback(
    async (state: 'done' | 'aborted') => {
      const run = runRef.current;
      if (!run) return;
      runRef.current = null;
      cancelRequestedRef.current = false;
      const paths = Array.from(new Set(run.artifactPaths));
      let artifacts: ReturnType<typeof buildAgentArtifacts> = [];
      if (paths.length > 0) {
        try {
          const normalized = paths.map((path) => ({
            name: path,
            kind: inferArtifactKind(path),
            title: path.split(/[\\/]+/).filter(Boolean).pop() || path,
          }));
          const resolved = await piResolveArtifacts(paths, run.workDir);
          artifacts = buildAgentArtifacts(normalized, resolved);
          if (artifacts.length > 0) {
            dispatch({
              type: 'UPDATE_MESSAGE',
              payload: {
                modelId: run.sessionModelId,
                sessionId: run.sessionId,
                messageId: run.messageId,
                artifacts,
              },
            });
          }
        } catch (reason) {
          // 产物解析失败不阻塞收尾；但原因要写进步骤，不能静默吞掉。
          const detail = reason instanceof Error ? reason.message : String(reason);
          pushStep(run, `产物解析失败：${detail}`, 'warn', 'artifacts');
        }
      }

      // 产物门：任务类型白名单 + 创建意图 + 扩展名 + 非空 + 文件头魔数。
      const verdict = judgeArtifactDelivery(run.prompt, artifacts);
      let gateWarning: string | null = null;
      if (verdict.gated) {
        if (verdict.ok) {
          pushStep(
            run,
            `产物校验通过：${verdict.matched.join('、')}`,
            'ok',
            'artifact_gate',
          );
        } else {
          gateWarning = `产物校验未通过：${verdict.detail}`;
          pushStep(run, gateWarning, 'err', 'artifact_gate');
        }
      }

      // 性能指标：usage 由 provider 上报（llama-server 流式结尾会给），
      // TTFT/生成耗时由增量事件时刻推算；生成耗时包含工具执行间隙。
      const stats = finalizeStats(run);

      // 失败但一个字都没吐：把原因写进气泡。否则用户只看到一条空白回复，
      // 以为「发了没反应」，而真正的原因（多半是连不上模型端点）被丢掉了。
      const failure = run.failure;
      if (failure && !run.assistantText.trim()) {
        dispatch({
          type: 'UPDATE_MESSAGE',
          payload: {
            modelId: run.sessionModelId,
            sessionId: run.sessionId,
            messageId: run.messageId,
            content: describePiFailure(failure, run.baseUrl),
          },
        });
      }

      const warnings = [gateWarning, failure].filter(
        (item): item is string => Boolean(item),
      );

      dispatch({
        type: 'UPDATE_MESSAGE',
        payload: {
          modelId: run.sessionModelId,
          sessionId: run.sessionId,
          messageId: run.messageId,
          piState: gateWarning || failure ? 'aborted' : state,
          ...(stats ? { stats } : {}),
          ...(warnings.length > 0 ? { warnings } : {}),
        },
      });
      dispatch({
        type: 'SET_MESSAGE_STREAMING',
        payload: {
          modelId: run.sessionModelId,
          sessionId: run.sessionId,
          messageId: run.messageId,
          streaming: false,
        },
      });

      const pending = pendingPrewarmRef.current;
      pendingPrewarmRef.current = null;
      if (pending) void prewarm(pending.piSessionId, pending.workspaceDir);
    },
    [dispatch, finalizeStats, prewarm, pushStep],
  );

  const applyEvent = useCallback(
    (run: PiRunState, payload: PiAgentEventPayload) => {
      const event = payload.event;
      const type = String(event.type ?? '');

      // usage 先记：最终累计值常在「没有增量」的 message_update 上到达。
      if (type === 'message_update') {
        recordUsage(run, event.usage);
      }

      // Pi 自动重试：失败一轮会先 agent_end(willRetry=true) 再 auto_retry_start。
      // 这里必须显式记下「还在重试」，否则会被当成正常收尾提前结束。
      if (type === 'auto_retry_start') {
        const attempt = Number(event.attempt ?? 0);
        const maxAttempts = Number(event.maxAttempts ?? 0);
        const reason = String(event.errorMessage ?? '模型请求失败');
        run.failure = reason;
        pushStep(
          run,
          `模型请求失败（${reason}），正在重试 ${attempt}/${maxAttempts}…`,
          'warn',
          `retry:${attempt}`,
        );
        return;
      }

      // 重试成功必须清掉上一轮记下的失败，否则本轮会被误判成 aborted。
      // Pi 的事件顺序是 message_end → auto_retry_end → turn_end → agent_end，
      // 清在这里能赶在 agent_end 收尾之前生效。
      if (type === 'auto_retry_end') {
        const attempt = Number(event.attempt ?? 0);
        if (event.success === true) {
          run.failure = null;
          pushStep(run, `重试成功（第 ${attempt} 次）`, 'ok', `retry:end:${attempt}`);
        } else {
          const detail = String(event.finalError ?? run.failure ?? '模型请求失败');
          run.failure = detail;
          pushStep(run, `重试失败：${detail}`, 'err', `retry:end:${attempt}`);
        }
        return;
      }

      const failure = piFailureMessage(event);
      if (failure) {
        run.failure = failure;
      }

      // Pi 拒收 prompt 时（例如上一轮尚未真正收尾、或正在压缩上下文），
      // response(success=false) 是唯一会到达的终态事件。这里必须收尾，
      // 否则新气泡会一直停在「执行中」，用户只能再点一次停止。
      if (type === 'response') {
        if (event.success === false && String(event.id ?? '') === run.runId) {
          const raw = String(event.error ?? '未知原因');
          const detail = /already processing|compaction is in progress/i.test(raw)
            ? 'Pi 仍在上一个任务里，或正在压缩上下文；这次任务没有开始，请等当前轮收尾后再发。'
            : raw;
          run.failure = detail;
          pushStep(run, `任务未开始：${detail}`, 'err', 'response');
          void finalizeRun('aborted');
        }
        return;
      }

      if (type === 'agent_settled' || (type === 'agent_end' && event.willRetry !== true)) {
        // 失败也算收尾：finalizeRun 会把原因写进气泡。
        const state = cancelRequestedRef.current || run.failure ? 'aborted' : 'done';
        cancelRequestedRef.current = false;
        void finalizeRun(state);
        return;
      }

      const text = piTextDelta(event);
      if (text !== null) {
        run.assistantText += text;
        recordDelta(run, event);
        dispatch({
          type: 'UPDATE_MESSAGE',
          payload: {
            modelId: run.sessionModelId,
            sessionId: run.sessionId,
            messageId: run.messageId,
            content: run.assistantText,
          },
        });
        return;
      }
      const thinking = piThinkingDelta(event);
      if (thinking !== null) {
        run.reasoningText += thinking;
        recordDelta(run, event);
        dispatch({
          type: 'UPDATE_MESSAGE',
          payload: {
            modelId: run.sessionModelId,
            sessionId: run.sessionId,
            messageId: run.messageId,
            reasoningContent: run.reasoningText,
          },
        });
        return;
      }

      const tool = piToolStep(event);
      if (tool) {
        const point = `tool:${tool.id}`;
        const label = tool.state === 'running'
          ? `调用 ${tool.tool}`
          : `${tool.ok ? '✓' : '✗'} ${tool.tool}`;
        const index = run.steps.findIndex((step) => step.point === point);
        const step: PiStep = {
          ts: Date.now(),
          point,
          text: label,
          tone: tool.state === 'running' ? 'info' : tool.ok ? 'ok' : 'err',
          repeat: 1,
          tool: tool.tool,
          path: tool.path,
          toolState: tool.state,
        };
        if (index >= 0) {
          run.steps[index] = { ...run.steps[index], ...step, repeat: run.steps[index].repeat };
        } else {
          run.steps.push(step);
        }
        if (tool.path) run.toolPaths[tool.id] = tool.path;
        // 产物路径优先用工具返回的 meta.artifact（相对工作区，所有写文件工具统一提供）；
        // 旧版 write_file / edit_file 没有该字段时退回工具参数里的 path。
        const legacyWritePath =
          tool.tool === 'write_file' || tool.tool === 'edit_file'
            ? tool.path ?? run.toolPaths[tool.id]
            : undefined;
        const artifactPath = tool.canvasArtifact ?? legacyWritePath;
        if (tool.state === 'done' && tool.ok && artifactPath) {
          run.artifactPaths.push(artifactPath);
        }
        dispatch({
          type: 'UPDATE_MESSAGE',
          payload: {
            modelId: run.sessionModelId,
            sessionId: run.sessionId,
            messageId: run.messageId,
            piSteps: [...run.steps],
          },
        });
        return;
      }

      if (type === 'error') {
        const detail = event.message ?? event.error ?? '未知错误';
        run.failure = String(detail);
        pushStep(run, `错误：${String(detail)}`, 'err', 'error');
        void finalizeRun('aborted');
      }
    },
    [dispatch, finalizeRun, pushStep, recordDelta, recordUsage],
  );

  useEffect(() => {
    const dispose = subscribePiAgent({
      onEvent: (payload) => {
        const run = runRef.current;
        if (!run) {
          eventBufferRef.current.push(payload);
          if (eventBufferRef.current.length > 200) eventBufferRef.current.shift();
          return;
        }
        if (payload.runId && run.runId && payload.runId !== run.runId) return;
        applyEvent(run, payload);
      },
      onLog: () => {},
      onReady: (next) => setStatus(next),
      onStopped: () => {
        setStatus((prev) => (prev ? { ...prev, running: false, pid: null } : prev));
        // 停止后所有挂起确认一并失效（后端 drain 也会补发过期事件，这里兜底清空）。
        setPermissionQueue([]);
        void finalizeRun('aborted');
      },
      onExit: () => {
        setStatus((prev) => (prev ? { ...prev, running: false, pid: null } : prev));
        setPermissionQueue([]);
        void finalizeRun('aborted');
      },
      onError: ({ message }) => {
        setError(message ?? 'Pi 运行出错');
        setPermissionQueue([]);
        const run = runRef.current;
        if (run) pushStep(run, `Pi 错误：${message ?? '未知错误'}`, 'err', 'error');
        void finalizeRun('aborted');
      },
      onPermission: (request) => {
        const run = runRef.current;
        setPermissionContext(run ? { task: run.prompt, workDir: run.workDir } : null);
        setPermissionQueue((prev) =>
          prev.some((item) => item.id === request.id) ? prev : [...prev, request],
        );
      },
      // write_file / edit_file 落盘后的检查点事件：累积进本轮 run 并实时写进
      // 消息（气泡里的「文件改动」卡片）。没有活动 run 时丢弃——事件属于某轮任务。
      onFileChanges: (change) => {
        const run = runRef.current;
        if (!run) return;
        run.changes.push(change);
        dispatch({
          type: 'UPDATE_MESSAGE',
          payload: {
            modelId: run.sessionModelId,
            sessionId: run.sessionId,
            messageId: run.messageId,
            piChanges: [...run.changes],
          },
        });
      },
      // 后端超时或取消后会按「拒绝」处理并回一条失效事件：弹窗要自己关掉，
      // 否则用户点「允许」只会得到一句「权限回传失败」。
      onPermissionExpired: ({ id, tool }) => {
        setPermissionQueue((prev) => prev.filter((item) => item.id !== id));
        setError(`Pi 的「${tool}」权限请求已失效（取消或超时），已自动拒绝。`);
      },
    });
    return dispose;
  }, [applyEvent, dispatch, finalizeRun, pushStep]);

  const sendTask = useCallback(
    async (input: PiTaskInput) => {
      const run: PiRunState = {
        runId: '',
        messageId: input.messageId,
        sessionId: input.sessionId,
        sessionModelId: input.sessionModelId,
        piSessionId: input.piSessionId,
        prompt: input.text,
        workDir: '',
        steps: [],
        changes: [],
        artifactPaths: [],
        toolPaths: {},
        assistantText: '',
        reasoningText: '',
        promptSentTs: Date.now(),
        firstDeltaTs: null,
        lastDeltaTs: null,
        usage: null,
        failure: null,
        baseUrl: '',
      };
      cancelRequestedRef.current = false;
      pendingPrewarmRef.current = null;
      try {
        const next = await startSession(input.piSessionId, loadPiConfig().autoStart, input.workspaceDir);
        setStatus(next);
        const cfg = await hydratePiConfig(loadPiConfig());
        savePiConfig(cfg);
        setConfig(cfg);
        run.baseUrl = cfg.baseUrl;

        let skillContext = '';
        let selectedSkills: string[] = [];
        if (cfg.skillRoutingEnabled && cfg.skillsDir.trim()) {
          try {
            const selection = await piAgentSelectSkills(cfg.skillsDir, input.text, 2, 8000);
            skillContext = selection.context;
            selectedSkills = selection.skills.map((skill) => skill.name);
            if (selectedSkills.length > 0) {
              run.steps.push({
                ts: Date.now(),
                point: 'skills',
                text: `技能路由：${selectedSkills.join('、')}`,
                tone: 'info',
                repeat: 1,
                skills: selectedSkills,
              });
            }
          } catch (reason) {
            pushStep(
              run,
              `技能路由失败，按无技能发送：${String(reason instanceof Error ? reason.message : reason)}`,
              'warn',
              'skills',
            );
          }
        }

        const runId = await piAgentRun(input.text, skillContext);
        if (!runId) throw new Error('Pi 没有返回 run id。');
        run.runId = runId;
        run.workDir = next.work_dir || sessionWorkDir(cfg.workDir, input.piSessionId);
        runRef.current = run;
        dispatch({
          type: 'UPDATE_MESSAGE',
          payload: {
            modelId: run.sessionModelId,
            sessionId: run.sessionId,
            messageId: run.messageId,
            piTurnId: runId,
            piSteps: [...run.steps],
          },
        });
        const buffered = eventBufferRef.current.filter(
          (payload) => !payload.runId || payload.runId === runId,
        );
        eventBufferRef.current = [];
        buffered.forEach((payload) => applyEvent(run, payload));
      } catch (reason) {
        const message = `Pi 任务下发失败：${String(reason instanceof Error ? reason.message : reason)}`;
        setError(message);
        dispatch({
          type: 'UPDATE_MESSAGE',
          payload: {
            modelId: input.sessionModelId,
            sessionId: input.sessionId,
            messageId: input.messageId,
            content: message,
            piState: 'aborted',
            piSteps: [
              { ts: Date.now(), point: 'send_error', text: message, tone: 'err', repeat: 1 },
            ],
          },
        });
        dispatch({
          type: 'SET_MESSAGE_STREAMING',
          payload: {
            modelId: input.sessionModelId,
            sessionId: input.sessionId,
            messageId: input.messageId,
            streaming: false,
          },
        });
      }
    },
    [applyEvent, dispatch, pushStep, startSession],
  );

  const cancelTask = useCallback(async () => {
    cancelRequestedRef.current = true;
    // 弹窗立即失效：后端 cancel 也会拒绝挂起的确认，但先清本地队列，
    // 避免用户在取消后继续点「允许」把写文件/命令真的放行。
    setPermissionQueue([]);
    const cancellingRun = runRef.current;
    try {
      await piAgentCancel();
    } catch {
      // Pi 可能已经退出；仍然把本地消息收尾
    }
    // 取消请求返回前如果已经开始新一轮（取消后立刻重发），不能把新 run 收掉。
    if (runRef.current !== cancellingRun) return;
    runRef.current = null;
    const run = cancellingRun;
    if (run) {
      // 中止也保留已产生的部分测量值（与普通对话的 terminated 口径一致）。
      const stats = finalizeStats(run);
      dispatch({
        type: 'UPDATE_MESSAGE',
        payload: {
          modelId: run.sessionModelId,
          sessionId: run.sessionId,
          messageId: run.messageId,
          piState: 'aborted',
          ...(stats ? { stats } : {}),
        },
      });
      dispatch({
        type: 'SET_MESSAGE_STREAMING',
        payload: {
          modelId: run.sessionModelId,
          sessionId: run.sessionId,
          messageId: run.messageId,
          streaming: false,
        },
      });
    }
    const pending = pendingPrewarmRef.current;
    pendingPrewarmRef.current = null;
    if (pending) void prewarm(pending.piSessionId, pending.workspaceDir);
  }, [dispatch, finalizeStats, prewarm]);

  /** 切换权限档：写共享配置；运行中立即同步到 Pi 进程。 */
  const setPermissionMode = useCallback(
    async (mode: PiPermissionMode) => {
      const next = { ...loadPiConfig(), permissionMode: mode };
      savePiConfig(next);
      setConfig(next);
      if (!statusRef.current?.running) return;
      try {
        await piAgentSetPermissionMode(mode);
        await refreshStatus();
      } catch (reason) {
        setError(`切换权限失败：${String(reason instanceof Error ? reason.message : reason)}`);
      }
    },
    [refreshStatus],
  );

  const answerPermission = useCallback(
    async (allow: boolean) => {
      // 只回答队首；答完出队，下一条自动成为弹窗内容。
      const request = permissionQueue[0] ?? null;
      if (!request) return;
      setPermissionQueue((prev) => prev.filter((item) => item.id !== request.id));
      try {
        await piAgentPermissionAnswer(request.id, allow);
        const run = runRef.current;
        if (run) {
          pushStep(
            run,
            `${allow ? '允许' : '拒绝'} ${request.tool}`,
            allow ? 'ok' : 'warn',
            `permission:${request.id}`,
          );
        }
      } catch (reason) {
        setError(`权限回传失败：${String(reason instanceof Error ? reason.message : reason)}`);
      }
    },
    [permissionQueue, pushStep],
  );

  const value = useMemo<PiRuntimeValue>(
    () => ({
      status,
      config,
      error,
      startingSessionId,
      sendTask,
      cancelTask,
      prewarm,
      startSession,
      refreshStatus,
      reloadConfig,
      setPermissionMode,
    }),
    [
      cancelTask,
      config,
      error,
      prewarm,
      refreshStatus,
      reloadConfig,
      sendTask,
      setPermissionMode,
      startSession,
      startingSessionId,
      status,
    ],
  );

  // 权限弹窗的补充上下文：让用户知道这是哪一档权限、哪个任务的请求。
  const pendingModeLabel = pendingPermission
    ? PERMISSION_MODE_LABELS[pendingPermission.mode] ?? pendingPermission.mode
    : '';
  const pendingTask = (permissionContext?.task ?? '').replace(/\s+/g, ' ').trim();
  const pendingPermissionBullets = pendingPermission
    ? [
        `当前权限档：${pendingModeLabel}（${pendingPermission.mode}）`,
        ...(pendingTask
          ? [`任务：${pendingTask.length > 80 ? `${pendingTask.slice(0, 80)}…` : pendingTask}`]
          : []),
        ...(permissionContext?.workDir ? [`工作区：${permissionContext.workDir}`] : []),
        ...(permissionQueue.length > 1
          ? [`排队中还有 ${permissionQueue.length - 1} 个请求`]
          : []),
      ]
    : undefined;

  return (
    <PiRuntimeContext.Provider value={value}>
      {children}
      <ConfirmDialog
        open={Boolean(pendingPermission)}
        title="Pi 请求权限"
        description={
          pendingPermission ? (
            // 命令/代码/写入内容预览必须完整可读：等宽 + 滚动渲染，
            // 预览上限与超限说明由后端统一生成，前端不做二次截断。
            <div className="mono-font max-h-64 overflow-y-auto whitespace-pre-wrap break-words">
              {pendingPermission.title || '工具调用'}
              {'\n'}
              {pendingPermission.detail}
            </div>
          ) : (
            ''
          )
        }
        bullets={pendingPermissionBullets}
        confirmLabel="允许"
        cancelLabel="拒绝"
        tone="warning"
        onConfirm={() => answerPermission(true)}
        onCancel={() => void answerPermission(false)}
      />
      {/* Pi 运行期错误的唯一出口：自动启动失败、预启动失败、权限回传失败、运行出错等
          都写在这个 error 里。以前没人渲染它，失败信息全被吞掉，界面只剩「没反应」。 */}
      {error ? (
        <div
          role="alert"
          className="fixed right-4 top-12 z-[100] flex max-w-md items-start gap-2 rounded-[var(--radius-panel)] border border-[var(--state-danger-border)] bg-[var(--surface)] px-3 py-2 shadow-[var(--shadow-card)]"
        >
          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-[var(--state-danger)]" />
          <p className="min-w-0 flex-1 text-[length:var(--font-caption)] leading-relaxed text-[var(--text-primary)]">
            {error}
          </p>
          <button
            type="button"
            onClick={() => setError(null)}
            aria-label="关闭 Pi 错误提示"
            title="关闭"
            className="flex-shrink-0 rounded p-0.5 text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-secondary)]"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : null}
    </PiRuntimeContext.Provider>
  );
}
