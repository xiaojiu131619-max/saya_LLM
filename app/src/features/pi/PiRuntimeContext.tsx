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
  piResolveArtifacts,
  piTextDelta,
  piThinkingDelta,
  piToolStep,
  subscribePiAgent,
  type PiAgentEventPayload,
  type PiAgentStatus,
  type PiPermissionRequest,
} from '@/lib/ipc/pi';
import {
  PI_CONFIG_CHANGED_EVENT,
  ensurePiForSession,
  hydratePiConfig,
  loadPiConfig,
  savePiConfig,
  sessionWorkDir,
  type PiConfig,
} from '@/lib/piConfig';
import type { MessageStats, PiStep } from '@/types';

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
};

export interface PiTaskInput {
  text: string;
  sessionId: string;
  sessionModelId: string;
  piSessionId: string;
  messageId: string;
}

interface PiRuntimeValue {
  status: PiAgentStatus | null;
  config: PiConfig | null;
  error: string | null;
  /** 正在预启动的目标 Pi session；Chat 用它禁用发送。 */
  startingSessionId: string | null;
  sendTask: (input: PiTaskInput) => Promise<void>;
  cancelTask: () => Promise<void>;
  prewarm: (piSessionId: string) => Promise<void>;
  startSession: (piSessionId: string) => Promise<PiAgentStatus>;
  refreshStatus: () => Promise<void>;
  reloadConfig: () => Promise<void>;
}

const PiRuntimeContext = createContext<PiRuntimeValue | null>(null);

// eslint-disable-next-line react-refresh/only-export-components
export function usePiRuntime() {
  const value = useContext(PiRuntimeContext);
  if (!value) throw new Error('usePiRuntime 必须在 PiRuntimeProvider 内使用');
  return value;
}

export function PiRuntimeProvider({ children }: { children: ReactNode }) {
  const { dispatch } = useApp();
  const [status, setStatus] = useState<PiAgentStatus | null>(null);
  const [config, setConfig] = useState<PiConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingPermission, setPendingPermission] = useState<PiPermissionRequest | null>(null);
  const [startingSessionId, setStartingSessionId] = useState<string | null>(null);
  const runRef = useRef<PiRunState | null>(null);
  const eventBufferRef = useRef<PiAgentEventPayload[]>([]);
  const cancelRequestedRef = useRef(false);
  const statusRef = useRef<PiAgentStatus | null>(null);
  const ensureChainRef = useRef<Promise<unknown>>(Promise.resolve());
  const prewarmSeqRef = useRef(0);
  const pendingPrewarmRef = useRef<string | null>(null);

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

  const startSession = useCallback(async (piSessionId: string) => {
    const next = ensureChainRef.current
      .catch(() => undefined)
      .then(() => ensurePiForSession(piSessionId));
    ensureChainRef.current = next;
    const result = await next;
    setStatus(result);
    return result;
  }, []);

  const prewarm = useCallback(
    async (piSessionId: string) => {
      if (!piSessionId.trim()) return;
      const active = runRef.current;
      if (active) {
        if (active.piSessionId !== piSessionId) pendingPrewarmRef.current = piSessionId;
        return;
      }
      const current = statusRef.current;
      if (current?.running && current.session_id === piSessionId) return;

      const seq = prewarmSeqRef.current + 1;
      prewarmSeqRef.current = seq;
      setStartingSessionId(piSessionId);
      setError(null);
      try {
        await startSession(piSessionId);
      } catch (reason) {
        if (prewarmSeqRef.current === seq) {
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
      const genTime =
        run.firstDeltaTs !== null && run.lastDeltaTs !== null
          ? Math.max(0, (run.lastDeltaTs - run.firstDeltaTs) / 1000)
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
        } catch {
          // 产物解析失败不阻塞收尾；气泡仍保留步骤记录。
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

      dispatch({
        type: 'UPDATE_MESSAGE',
        payload: {
          modelId: run.sessionModelId,
          sessionId: run.sessionId,
          messageId: run.messageId,
          piState: gateWarning ? 'aborted' : state,
          ...(stats ? { stats } : {}),
          ...(gateWarning ? { warnings: [gateWarning] } : {}),
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
      if (pending) void prewarm(pending);
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
        };
        if (index >= 0) {
          run.steps[index] = { ...run.steps[index], ...step, repeat: run.steps[index].repeat };
        } else {
          run.steps.push(step);
        }
        if (tool.path) run.toolPaths[tool.id] = tool.path;
        const artifactPath = tool.path || run.toolPaths[tool.id];
        const canvasArtifact = tool.canvasArtifact;
        if (
          tool.state === 'done' &&
          tool.ok &&
          ((tool.tool === 'write_file' || tool.tool === 'edit_file') && artifactPath ||
            tool.tool === 'canvas_run' && canvasArtifact)
        ) {
          run.artifactPaths.push(canvasArtifact ?? artifactPath!);
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

      if (type === 'agent_settled' || type === 'agent_end') {
        const state = cancelRequestedRef.current ? 'aborted' : 'done';
        cancelRequestedRef.current = false;
        void finalizeRun(state);
        return;
      }

      if (type === 'error') {
        const detail = event.message ?? event.error ?? '未知错误';
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
        void finalizeRun('aborted');
      },
      onExit: () => {
        setStatus((prev) => (prev ? { ...prev, running: false, pid: null } : prev));
        void finalizeRun('aborted');
      },
      onError: ({ message }) => {
        setError(message ?? 'Pi 运行出错');
        const run = runRef.current;
        if (run) pushStep(run, `Pi 错误：${message ?? '未知错误'}`, 'err', 'error');
        void finalizeRun('aborted');
      },
      onPermission: (request) => setPendingPermission(request),
    });
    return dispose;
  }, [applyEvent, finalizeRun, pushStep]);

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
        artifactPaths: [],
        toolPaths: {},
        assistantText: '',
        reasoningText: '',
        promptSentTs: Date.now(),
        firstDeltaTs: null,
        lastDeltaTs: null,
        usage: null,
      };
      cancelRequestedRef.current = false;
      pendingPrewarmRef.current = null;
      try {
        const next = await startSession(input.piSessionId);
        setStatus(next);
        const cfg = await hydratePiConfig(loadPiConfig());
        savePiConfig(cfg);
        setConfig(cfg);

        let skillContext = '';
        let selectedSkills: string[] = [];
        if (cfg.skillRoutingEnabled && cfg.skillsDir.trim()) {
          try {
            const selection = await piAgentSelectSkills(cfg.skillsDir, input.text, 2, 8000);
            skillContext = selection.context;
            selectedSkills = selection.skills.map((skill) => skill.name);
            if (selectedSkills.length > 0) {
              pushStep(run, `技能路由：${selectedSkills.join('、')}`, 'info', 'skills');
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
    try {
      await piAgentCancel();
    } catch {
      // Pi 可能已经退出；仍然把本地消息收尾
    }
    const run = runRef.current;
    runRef.current = null;
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
    if (pending) void prewarm(pending);
  }, [dispatch, finalizeStats, prewarm]);

  const answerPermission = useCallback(
    async (allow: boolean) => {
      const request = pendingPermission;
      setPendingPermission(null);
      if (!request) return;
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
    [pendingPermission, pushStep],
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
    }),
    [
      cancelTask,
      config,
      error,
      prewarm,
      refreshStatus,
      reloadConfig,
      sendTask,
      startSession,
      startingSessionId,
      status,
    ],
  );

  return (
    <PiRuntimeContext.Provider value={value}>
      {children}
      <ConfirmDialog
        open={Boolean(pendingPermission)}
        title="Pi 请求权限"
        description={
          pendingPermission
            ? `${pendingPermission.title || '工具调用'}\n${pendingPermission.detail}`
            : ''
        }
        bullets={pendingPermission ? [`当前权限档：${pendingPermission.mode}`] : undefined}
        confirmLabel="允许"
        cancelLabel="拒绝"
        tone="warning"
        onConfirm={() => answerPermission(true)}
        onCancel={() => void answerPermission(false)}
      />
    </PiRuntimeContext.Provider>
  );
}
