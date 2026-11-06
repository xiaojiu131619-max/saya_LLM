import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Check,
  ChevronDown,
  Copy,
  Cpu,
  Download,
  Info,
  Pause,
  Play,
  RefreshCw,
  Save,
  Square,
  Terminal,
  Trash2,
} from "lucide-react";
import ToggleSwitch from "@/components/ToggleSwitch";
import ConfirmDialog from "@/components/ConfirmDialog";
import WorkingBadge from "@/components/WorkingBadge";
import Fast27bPerformance from "@/features/fast27b/Fast27bPerformance";
import { useFast27bMetrics } from "@/hooks/useFast27bMetrics";
import { refreshEngineStatus, useEngineStatuses } from "@/hooks/useEngineStatuses";
import "@/features/fast27b/fast27b.css";
import {
  isDesktopRuntime,
  listenDesktopEvent,
} from "@/lib/desktop";
import {
  fast27bClearLogs,
  fast27bGetLogs,
  fast27bGetStatus,
  fast27bSelectModel,
  fast27bRestart,
  fast27bSaveConfig,
  fast27bSetEnabled,
  fast27bStart,
  fast27bStop,
  type Fast27bStatus,
  type Fast27bModelVariant,
} from "@/lib/desktop";

type LogTone = "error" | "warn" | "accent" | "default";

const TONE_CLASS: Record<LogTone, string> = {
  error: "text-[var(--state-danger)]",
  warn: "text-[var(--state-warning)]",
  accent: "text-[var(--state-success)]",
  default: "text-[var(--text-secondary)]",
};

function classifyLogLine(line: string): LogTone {
  const lower = line.toLowerCase();
  if (
    lower.includes("error") ||
    lower.includes("failed") ||
    lower.includes("失败") ||
    lower.includes("panic") ||
    lower.includes("fatal")
  ) {
    return "error";
  }
  if (
    lower.includes("warn") ||
    lower.includes("占用") ||
    lower.includes("exited")
  )
    return "warn";
  if (line.startsWith("[fast27b]") || lower.includes("listening on http"))
    return "accent";
  return "default";
}

export default function Fast27bPage() {
  const busyRef = useRef(false);
  const editorsInitializedRef = useRef(false);
  const logViewportRef = useRef<HTMLDivElement>(null);
  const engineStatuses = useEngineStatuses();
  const status = engineStatuses.fast27b;
  const metrics = useFast27bMetrics();
  const [activeTab, setActiveTab] = useState<"overview" | "performance">("overview");
  const [progressMessage, setProgressMessage] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [runtimeMessage, setRuntimeMessage] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [switchingModel, setSwitchingModel] = useState(false);

  const [saving, setSaving] = useState(false);
  const [fast27bLogs, setFast27bLogs] = useState<string[]>([]);
  const [logsLive, setLogsLive] = useState(true);
  const [logCopied, setLogCopied] = useState(false);

  // 可编辑配置（从 status 初始化；「保存配置」落盘）。
  const [enginePath, setEnginePath] = useState("");
  const [selectedModel, setSelectedModel] =
    useState<Fast27bModelVariant>("bonsai");
  const [modelPaths, setModelPaths] = useState<
    Record<Fast27bModelVariant, string>
  >({ bonsai: "", saluki: "" });
  const modelPath = modelPaths[selectedModel];
  const [port, setPort] = useState("8094");
  const [lan, setLan] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [contextWindow, setContextWindow] = useState("262144");
  const [draftTokens, setDraftTokens] = useState("6");
  const [defaultMaxTokens, setDefaultMaxTokens] = useState("10240");
  const [thinkingBudget, setThinkingBudget] = useState("1024");
  const [bridgePort, setBridgePort] = useState("8095");
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  // 「工作中」计时起点：进入加载态时定一次，之后交给 WorkingBadge 走表。
  const [loadStartedAt, setLoadStartedAt] = useState<number | null>(null);

  // 应用内确认对话框（替代原生 window.confirm）：待执行动作挂在 pendingConfirm 上。
  const [pendingConfirm, setPendingConfirm] = useState<{
    title: string;
    description?: string;
    confirmLabel: string;
    tone: "warning" | "danger";
    action: () => Promise<void> | void;
  } | null>(null);

  const running = status?.running ?? false;
  const apiReady = status?.api_ready ?? false;
  // 引擎失效：进程还在、/v1/models 也可能还是 200，但引擎日志已判 worker 崩溃 / 连续 503。
  const degraded = status?.degraded ?? false;
  const needsRestart = status?.requires_restart ?? false;
  const engineEnabled = status?.enabled ?? true;
  // 加载态：引擎在跑但接口还没就绪，或者刚点了启动。
  const loading = (running && !apiReady) || starting;
  useEffect(() => {
    // 起点在定时回调里落状态：effect 体内同步 setState 会触发级联渲染（lint 也会拦）。
    const start = loading ? Date.now() : null;
    const timer = window.setTimeout(() => setLoadStartedAt(start), 0);
    return () => window.clearTimeout(timer);
  }, [loading]);

  const applyStatusToEditors = useCallback((next: Fast27bStatus) => {
    setEnginePath(next.engine_path);
    setSelectedModel(next.selected_model);
    setModelPaths({
      bonsai:
        next.model_presets.find((preset) => preset.id === "bonsai")
          ?.model_path ?? "",
      saluki:
        next.model_presets.find((preset) => preset.id === "saluki")
          ?.model_path ?? "",
    });
    setPort(String(next.port ?? 8094));
    setLan(next.lan ?? false);
    setApiKey(next.api_key);
    setContextWindow(String(next.context_window));
    setDraftTokens(String(next.draft_tokens));
    setDefaultMaxTokens(String(next.default_max_tokens ?? 0));
    setThinkingBudget(String(next.default_thinking_budget ?? 8192));
    setBridgePort(String(next.bridge_port ?? 8095));
    setSettingsDirty(false);
  }, []);

  const refreshStatusOnly = refreshEngineStatus;

  useEffect(() => {
    if (!status || editorsInitializedRef.current) return;
    const timer = window.setTimeout(() => {
      editorsInitializedRef.current = true;
      applyStatusToEditors(status);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [status, applyStatusToEditors]);

  // 日志：1 秒轮询（与 llama 日志同范式），可暂停。
  useEffect(() => {
    if (!isDesktopRuntime() || !logsOpen) return;
    let disposed = false;
    const refresh = async () => {
      try {
        const next = await fast27bGetLogs();
        if (!disposed) setFast27bLogs(next);
      } catch {
        // 静默重试
      }
    };
    void refresh();
    const timer = window.setInterval(() => {
      if (logsLive) void refresh();
    }, 1000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [logsLive, logsOpen]);

  // fast27b 生命周期事件：即时反馈并刷新状态。
  useEffect(() => {
    const unlistenReady = listenDesktopEvent<{ url?: string }>(
      "fast27b:ready",
      (payload) => {
        setRuntimeMessage(`NiNfer 已就绪：${payload.url ?? ""}`);
        setProgressMessage(null);
        setStarting(false);
        void refreshStatusOnly();
      },
    );
    const unlistenStopped = listenDesktopEvent<{ message?: string }>(
      "fast27b:stopped",
      (payload) => {
        setRuntimeMessage(payload.message ?? "NiNfer 已停止。");
        setProgressMessage(null);
        setStarting(false);
        void refreshStatusOnly();
      },
    );
    const unlistenProgress = listenDesktopEvent<{ message?: string }>(
      "fast27b:progress",
      (payload) => {
        setProgressMessage(payload.message ?? null);
      },
    );
    const unlistenError = listenDesktopEvent<{ message?: string }>(
      "fast27b:error",
      (payload) => {
        setRuntimeMessage(payload.message ?? "NiNfer 运行出错。");
        setProgressMessage(null);
        setStarting(false);
        void refreshStatusOnly();
      },
    );
    return () => {
      void unlistenReady.then((dispose) => dispose());
      void unlistenStopped.then((dispose) => dispose());
      void unlistenProgress.then((dispose) => dispose());
      void unlistenError.then((dispose) => dispose());
    };
  }, [refreshStatusOnly]);

  useEffect(() => {
    const el = logViewportRef.current;
    if (el && logsLive) el.scrollTop = el.scrollHeight;
  }, [fast27bLogs, logsLive, logsOpen]);

  const handleSelectModel = async (model: Fast27bModelVariant) => {
    if (busyRef.current || model === selectedModel || settingsDirty) return;
    const previousModel = selectedModel;
    busyRef.current = true;
    setSwitchingModel(true);
    setSelectedModel(model);
    setActionMessage(null);
    if (running) setProgressMessage(`正在切换到 ${model === "bonsai" ? "Bonsai" : "Saluki"} 27B，重新加载引擎…`);
    try {
      await fast27bSelectModel(model);
      setActionMessage(`已切换到 ${model === "bonsai" ? "Bonsai" : "Saluki"} 27B${running ? "，正在加载引擎，API 就绪后即可使用。" : "，点击启动即可运行。"}`);
    } catch (error) {
      setSelectedModel(previousModel);
      setActionMessage(`模型切换失败：${String(error)}`);
    } finally {
      try {
        const next = await fast27bGetStatus();
        if (next) {
          applyStatusToEditors(next);
          setStarting(next.running && !next.api_ready && !next.requires_restart);
        }
      } catch {
        // 状态暂时不可读时由共享轮询继续检测，操作按钮仍需解除忙碌。
      } finally {
        setProgressMessage(null);
        setSwitchingModel(false);
        busyRef.current = false;
        await refreshStatusOnly();
      }
    }
  };

  const handleStart = async () => {
    if (busyRef.current) return;
    if (!engineEnabled) {
      setActionMessage("引擎已停用：请先开启引擎开关。");
      return;
    }
    busyRef.current = true;
    setStarting(true);
    setRuntimeMessage(null);
    setProgressMessage(
      `正在加载 ${selectedModel === "saluki" ? "Saluki" : "Bonsai"} 27B…`,
    );
    try {
      await fast27bStart();
      // 就绪由 fast27b:ready 事件确认，状态徽标会随之更新。
      setRuntimeMessage(
        "NiNfer 正在启动，就绪后状态徽标会变为「运行中 · API 就绪」...",
      );
    } catch (error) {
      setRuntimeMessage(`启动失败：${String(error)}`);
      setProgressMessage(null);
      setStarting(false);
    } finally {
      busyRef.current = false;
      await refreshStatusOnly();
    }
  };

  const handleStop = () => {
    setPendingConfirm({
      title: "停止 NiNfer 引擎",
      description: "正在进行的对话会被中断。",
      confirmLabel: "停止引擎",
      tone: "warning",
      action: async () => {
        setStopping(true);
        try {
          await fast27bStop();
          setRuntimeMessage("NiNfer 已停止。");
        } catch (error) {
          setRuntimeMessage(`停止失败：${String(error)}`);
        } finally {
          setStopping(false);
          await refreshStatusOnly();
        }
      },
    });
  };

  /**
   * 重启引擎：引擎失效（worker 崩溃 / 连续 503）时唯一能恢复的操作。
   * 后端同一套 argv 重新拉起，并回收同引擎路径的遗留实例（否则端口被占住起不来）。
   */
  const handleRestart = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setRestarting(true);
    setRuntimeMessage(null);
    setProgressMessage("正在停止旧实例并重新加载模型…");
    try {
      await fast27bRestart();
      setProgressMessage(null);
      setRuntimeMessage(
        "NiNfer 已重启完成：请新开对话，不要重发刚才那个超池的长历史。",
      );
    } catch (error) {
      setProgressMessage(null);
      setRuntimeMessage(`重启失败：${String(error)}`);
    } finally {
      setRestarting(false);
      busyRef.current = false;
      await refreshStatusOnly();
    }
  };

  const handleSaveConfig = async () => {
    if (busyRef.current) return;
    const portNumber = Number(port);
    const ctxNumber = Number(contextWindow);
    const draftNumber = Number(draftTokens);
    const maxTokensNumber =
      defaultMaxTokens.trim() === "" ? 0 : Number(defaultMaxTokens);
    const thinkingBudgetNumber = Number(thinkingBudget);
    const bridgePortNumber = Number(bridgePort);
    if (
      !Number.isInteger(portNumber) ||
      portNumber <= 0 ||
      portNumber > 65535
    ) {
      setActionMessage("保存失败：端口必须是 1-65535 的整数。");
      return;
    }
    if (!Number.isInteger(ctxNumber) || ctxNumber <= 0) {
      setActionMessage("保存失败：上下文窗口必须是正整数。");
      return;
    }
    if (!Number.isInteger(draftNumber) || draftNumber < 1 || draftNumber > 15) {
      setActionMessage("保存失败：推测解码草稿长度必须在 1-15 之间。");
      return;
    }
    // 0 = 不传 --default-max-tokens（交回引擎自身默认）；非 0 必须是正整数，
    // 且不能超过上下文窗口（否则引擎侧无法满足，请求会被截断且数值无意义）。
    if (!Number.isInteger(maxTokensNumber) || maxTokensNumber < 0) {
      setActionMessage(
        "保存失败：默认输出上限必须是 0 或正整数（0 = 由引擎自定）。",
      );
      return;
    }
    if (maxTokensNumber > 0 && maxTokensNumber > ctxNumber) {
      setActionMessage(
        `保存失败：默认输出上限不能超过上下文窗口（${ctxNumber}）。`,
      );
      return;
    }
    if (!Number.isInteger(thinkingBudgetNumber) || thinkingBudgetNumber < 0) {
      setActionMessage("保存失败：思考预算必须是 0 或正整数，0 表示不限制。");
      return;
    }
    if (maxTokensNumber > 0 && thinkingBudgetNumber >= maxTokensNumber) {
      setActionMessage("保存失败：思考预算必须小于默认输出上限，为正文预留空间。");
      return;
    }
    if (
      !Number.isInteger(bridgePortNumber) ||
      bridgePortNumber <= 0 ||
      bridgePortNumber > 65535
    ) {
      setActionMessage("保存失败：网页桥端口必须是 1-65535 的整数。");
      return;
    }
    if (!apiKey.trim()) {
      setActionMessage("保存失败：API Key 不能为空。");
      return;
    }
    if (!enginePath.trim() || !modelPath.trim()) {
      setActionMessage("保存失败：引擎路径和模型路径不能为空。");
      return;
    }
    busyRef.current = true;
    setSaving(true);
    setActionMessage(null);
    try {
      await fast27bSaveConfig({
        enabled: engineEnabled,
        engine_path: enginePath.trim(),
        model_path: modelPath.trim(),
        selected_model: selectedModel,
        saluki_model_path: modelPaths.saluki.trim(),
        bonsai_model_path: modelPaths.bonsai.trim(),
        port: portNumber,
        lan,
        api_key: apiKey.trim(),
        context_window: ctxNumber,
        draft_tokens: draftNumber,
        default_max_tokens: maxTokensNumber,
        default_thinking_budget: thinkingBudgetNumber,
        bridge_port: bridgePortNumber,
      });
      setActionMessage("配置已保存，下次启动生效。");
      setSettingsDirty(false);
      await refreshStatusOnly();
    } catch (error) {
      setActionMessage(`保存失败：${String(error)}`);
    } finally {
      setSaving(false);
      busyRef.current = false;
    }
  };

  const markDirty = () => setSettingsDirty(true);

  /** 启用/停用 fast27b 引擎：只翻转开关（专用命令，不触碰其他配置项）。 */
  const applyEnabled = async (next: boolean) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setActionMessage(null);
    try {
      await fast27bSetEnabled(next);
      setActionMessage(
        next
          ? "NiNfer 引擎已启用。"
          : "NiNfer 引擎已停用；可随时在此重新启用。",
      );
      await refreshStatusOnly();
    } catch (error) {
      setActionMessage(`切换引擎开关失败：${String(error)}`);
    } finally {
      busyRef.current = false;
    }
  };

  const handleToggleEnabled = (next: boolean) => {
    if (!next && running) {
      setPendingConfirm({
        title: "停用 NiNfer 引擎",
        description:
          "引擎当前正在运行；停用后启动按钮会锁定（已运行的引擎不受影响，可手动停止）。",
        confirmLabel: "停用",
        tone: "warning",
        action: () => applyEnabled(false),
      });
      return;
    }
    void applyEnabled(next);
  };

  const handleCopy = async (value: string, key: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      window.setTimeout(() => setCopied(null), 1600);
    } catch {
      setCopied(null);
    }
  };

  const handleCopyLogs = async () => {
    await navigator.clipboard.writeText(fast27bLogs.join("\n"));
    setLogCopied(true);
    window.setTimeout(() => setLogCopied(false), 1500);
  };

  const handleExportLogs = () => {
    const blob = new Blob([fast27bLogs.join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `fast27b-${new Date().toISOString().slice(0, 10)}.log`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleClearLogs = () => {
    setPendingConfirm({
      title: "清空 NiNfer 日志",
      description: "面板里的日志会立即清空；engine.log 落盘文件不受影响。",
      confirmLabel: "清空",
      tone: "warning",
      action: async () => {
        await fast27bClearLogs();
        setFast27bLogs([]);
      },
    });
  };

  const runningBadge = (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs ${
        degraded
          ? "border-[var(--state-danger)] bg-[var(--state-danger-bg)] text-[var(--state-danger)]"
          : running
            ? apiReady
              ? "border-[var(--state-success-border)] bg-[var(--state-success-bg)] text-[var(--state-success)]"
              : "border-[var(--state-warning-border)] bg-[var(--state-warning-bg)] text-[var(--state-warning)]"
            : "border-[var(--border)] bg-[var(--surface-muted)] text-secondary-custom"
      }`}
    >
      <span className="relative flex h-2 w-2">
        {running && apiReady && !degraded && (
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--state-success)] opacity-60" />
        )}
        <span
          className={`relative inline-flex h-2 w-2 rounded-full ${
            degraded
              ? "bg-[var(--state-danger)]"
              : running
                ? apiReady
                  ? "bg-[var(--state-success)]"
                  : "bg-[var(--state-warning)]"
                : "bg-[var(--text-tertiary)]"
          }`}
        />
      </span>
      {degraded
        ? needsRestart ? "已失效 · 需重启引擎" : "运行受限 · 题面超池"
        : running
          ? apiReady
            ? "运行中 · API 就绪"
            : "启动中..."
          : "已停止"}
    </span>
  );

  /** 失效 / 超池告警条：把引擎日志里的故障翻成中文，并给出唯一有效的处置。 */
  const engineAlert = degraded ? (
    <div
      className={`mb-3 rounded-lg border p-3 text-xs ${
        needsRestart
          ? "border-[var(--state-danger)] bg-[var(--state-danger-bg)] text-[var(--state-danger)]"
          : "border-[var(--state-warning-border)] bg-[var(--state-warning-bg)] text-[var(--state-warning)]"
      }`}
    >
      <div className="flex items-start gap-2">
        <Info className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="font-medium">
            {needsRestart
              ? "引擎已失效：进程还在、接口也可能还是 200，但不会再返回任何对话结果。"
              : "当前对话题面超过设备 KV 池。"}
          </p>
          {status?.degraded_reason && (
            <p className="mt-1 leading-relaxed">{status.degraded_reason}</p>
          )}
          {status?.fault_at && (
            <p className="mt-1 opacity-80">
              引擎日志时间 {status.fault_at}
              {status.fault_kind ? ` · 故障码 ${status.fault_kind}` : ""}
            </p>
          )}
          {!needsRestart && (
            <p className="mt-1 leading-relaxed">
              请新开对话（不要重发这条长历史）。池大小由引擎启动环境的
              NINFER_KV_WINDOW 决定并受显存封顶——若需要更大池子，调大该值后重启引擎，
              仅关闭占显存的程序并不能扩大池子。
            </p>
          )}
          {(status?.completions_after_fault ?? 0) > 0 && (
            <p className="mt-1 leading-relaxed">
              注意：失效之后仍有 {status?.completions_after_fault}{" "}
              次请求被记录为完成，读数存疑，
              请用一条真实的小请求复核是否已恢复。
            </p>
          )}
          {status?.raw_fault_line && (
            <p
              className="mono-font mt-1 break-all opacity-80"
              title="引擎日志原文（证据）"
            >
              {status.raw_fault_line}
            </p>
          )}
        </div>
      </div>
    </div>
  ) : null;

  const renderedLogs = useMemo(() => fast27bLogs.slice(-600), [fast27bLogs]);

  const editorField =
    "w-full rounded-md border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-xs text-primary-custom outline-none transition-colors focus:border-[var(--accent)] disabled:opacity-50";
  const secondaryButton =
    "inline-flex items-center justify-center gap-1.5 rounded-md border border-[var(--border)] px-3 py-2 text-xs text-secondary-custom transition-colors hover:bg-[var(--surface-muted)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40";
  const primaryButton =
    "inline-flex items-center justify-center gap-1.5 rounded-md bg-[var(--accent)] px-3 py-2 text-xs font-medium text-[var(--text-on-accent)] transition-colors hover:bg-[var(--accent-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40";
  const busy =
    starting || stopping || restarting || switchingModel || saving;
  const desktop = isDesktopRuntime();
  const selectedPreset = status?.model_presets.find(
    (preset) => preset.id === selectedModel,
  );
  const resourcesReady = Boolean(
    status?.engine_exists && selectedPreset?.exists,
  );
  const apiBaseUrl = `http://127.0.0.1:${status?.port ?? port}/v1`;
  const apiModelId = status?.model_id
    ?? (selectedModel === "saluki" ? "saluki" : "bonsai");
  // 只留三个真正会影响体感的手动项；桥端口/默认输出上限/思考预算沿用保存值，
  // 需要改的场景太少，摆出来只会让人以为必须调。
  const fields = [
    { label: "服务端口", value: port, update: setPort, min: 1, max: 65535 },
    {
      label: "上下文长度（ctx）",
      value: contextWindow,
      update: setContextWindow,
      min: 1,
    },
    {
      label: "草稿长度（1–15）",
      value: draftTokens,
      update: setDraftTokens,
      min: 1,
      max: 15,
    },
  ];

  const tabs = [
    { id: "overview", label: "概览", icon: Info },
    { id: "performance", label: "性能", icon: Activity },
  ] as const;

  const variants: Array<{ id: Fast27bModelVariant; label: string }> = [
    { id: "bonsai", label: "Bonsai" },
    { id: "saluki", label: "Saluki" },
  ];
  /** 变体胶囊点不动时的具体原因（按命中顺序给出第一条），null 表示可点。 */
  const capsuleDisabledReason = (exists: boolean) => {
    if (!desktop) return "NiNfer 引擎只在桌面版可用：请用 agent-llm.exe 操作。";
    if (busy) return "引擎操作进行中，等当前操作结束再切换。";
    if (settingsDirty) return "高级配置有未保存的改动：先点「保存」或还原，再切换变体。";
    if (!status) return "正在读取引擎状态，稍候再试。";
    if (!exists) return "模型文件缺失：展开「高级配置」检查该变体的模型路径。";
    return null;
  };
  const modelTitle = selectedModel === "saluki" ? "Saluki 27B" : "Bonsai 27B";
  const modelSpec = selectedModel === "saluki" ? "MTP" : "DFlash2";
  const presetExists = (variant: Fast27bModelVariant) =>
    status
      ? status.model_presets.find((preset) => preset.id === variant)?.exists !== false
      : true;
  const panel = "rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--surface)] p-5";

  return (
    <div className="h-full min-h-0 overflow-y-auto px-4 py-5 sm:px-6">
      <div className="mx-auto max-w-5xl space-y-4 pb-6">
        {/* 页头：变体切换收成标题右侧的小胶囊，不再单独占一整行 */}
        <div className="workspace-page-header flex min-w-0 items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="eyebrow mb-2 flex items-center gap-2">
              <Cpu className="h-3.5 w-3.5" />
              工作台 / NiNfer
            </div>
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="page-title">NiNfer</h1>
              <div
                role="group"
                aria-label="切换 NiNfer 模型变体"
                className="inline-flex items-center gap-0.5 rounded-full border border-[var(--border)] bg-[var(--surface-muted)] p-0.5"
              >
                {variants.map(({ id, label }) => {
                  const active = selectedModel === id;
                  const exists = presetExists(id);
                  const disabledReason = capsuleDisabledReason(exists);
                  return (
                    <button
                      key={id}
                      type="button"
                      aria-pressed={active}
                      disabled={Boolean(disabledReason)}
                      onClick={() => void handleSelectModel(id)}
                      title={
                        disabledReason
                          ?? `切换到 ${label} 27B（${id === "saluki" ? "MTP" : "DFlash2"}）`
                      }
                      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[length:var(--font-eyebrow)] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                        active
                          ? "bg-[var(--surface-raised)] text-[var(--accent)] shadow-[var(--shadow-card)]"
                          : "text-secondary-custom hover:text-primary-custom"
                      }`}
                    >
                      {switchingModel && active && <RefreshCw className="h-2.5 w-2.5 animate-spin" />}
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>
            <p className="mt-0.5 text-xs leading-5 text-secondary-custom">
              Bonsai · DFlash2 / Saluki · MTP 双变体，启动、监测与接入集中管理。
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="NiNfer 视图">
          {tabs.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              role="tab"
              id={`ninfer-tab-${id}`}
              aria-selected={activeTab === id}
              onClick={() => setActiveTab(id)}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs transition-colors ${
                activeTab === id
                  ? "bg-[var(--surface-selected)] text-primary-custom"
                  : "text-secondary-custom hover:bg-[var(--surface-hover)]"
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </button>
          ))}
        </div>

        {activeTab === "overview" && (
          <div className="space-y-4">
            <section aria-label="运行状态" className={panel}>
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                {runningBadge}
                <fieldset
                  disabled={busy || !desktop || !status}
                  className="flex items-center gap-2 text-xs text-secondary-custom disabled:opacity-50"
                >
                  <span>{engineEnabled ? "已启用" : "已停用"}</span>
                  <ToggleSwitch
                    checked={engineEnabled}
                    onChange={(next) => void handleToggleEnabled(next)}
                    label="启用 NiNfer 引擎"
                  />
                </fieldset>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[length:var(--font-subtitle)] font-semibold text-primary-custom">
                    {modelTitle}
                  </div>
                  <div className="mt-0.5 text-xs text-[var(--text-tertiary)]">
                    {modelSpec} · 草稿 {draftTokens} token · 上下文{" "}
                    {(status?.context_window_effective ?? status?.context_window ?? 262144).toLocaleString()}
                    {status?.pid ? ` · PID ${status.pid}` : ""}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {settingsDirty && (
                    <button onClick={() => void handleSaveConfig()} disabled={busy || !desktop} className={secondaryButton}>
                      <Save className="h-3.5 w-3.5" />
                      {saving ? "正在保存…" : "保存配置"}
                    </button>
                  )}
                  {!running ? (
                    <button
                      onClick={() => void handleStart()}
                      disabled={busy || settingsDirty || !engineEnabled || !resourcesReady || !desktop}
                      className={primaryButton}
                      title={
                        settingsDirty
                          ? "请先保存模型和配置"
                          : !resourcesReady
                            ? "请展开高级配置，检查引擎与模型路径"
                            : "启动所选模型"
                      }
                    >
                      {starting ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                      {starting ? "正在启动…" : "启动"}
                    </button>
                  ) : (
                    <>
                      <button onClick={() => void handleStop()} disabled={busy} className={secondaryButton}>
                        {stopping ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Square className="h-3.5 w-3.5" />}
                        {stopping ? "正在停止…" : "停止"}
                      </button>
                      {needsRestart && (
                        <button onClick={() => void handleRestart()} disabled={busy || settingsDirty || !desktop} className={`${secondaryButton} text-[var(--state-danger)]`}>
                          <RefreshCw className={`h-3.5 w-3.5 ${restarting ? "animate-spin" : ""}`} />
                          重启恢复
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>

              {loading ? (
                <div className="mt-4 rounded-md border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2.5 text-xs">
                  <WorkingBadge
                    label="正在加载模型"
                    startedAt={loadStartedAt}
                    className="font-medium text-primary-custom"
                  />
                  <div className="mt-1.5 leading-5 text-[var(--text-tertiary)]">
                    {progressMessage ?? "首次加载 27B 权重需要一两分钟，就绪后状态会变成「运行中 · API 就绪」。"}
                  </div>
                </div>
              ) : (
                progressMessage && (
                  <div className="mt-4 rounded-md border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-xs text-secondary-custom">
                    {progressMessage}
                  </div>
                )
              )}

              {engineAlert && <div className="mt-3">{engineAlert}</div>}

              {status && !resourcesReady && (
                <p role="alert" className="mt-3 text-xs text-[var(--state-warning)]">
                  {!status.engine_exists ? "引擎文件缺失。" : "所选模型文件缺失。"}
                  <button onClick={() => setConfigOpen(true)} className="ml-1 underline underline-offset-2">
                    检查高级配置
                  </button>
                </p>
              )}
            </section>

            <section aria-label="接入信息" className={panel}>
              <div className="mb-3 text-xs font-medium text-secondary-custom">接入信息</div>
              <dl className="grid gap-2 sm:grid-cols-2">
                {[
                  { key: "base_url", label: "Base URL", value: apiBaseUrl },
                  { key: "model", label: "模型 ID", value: apiModelId },
                  { key: "port", label: "端口", value: status?.port ? String(status.port) : port },
                  { key: "api_key", label: "API Key", value: status?.api_key ?? "—" },
                ].map((item) => (
                  <div
                    key={item.key}
                    className="flex min-w-0 items-center justify-between gap-2 rounded-md border border-[var(--border)] bg-[var(--surface-muted)] px-2.5 py-1.5"
                  >
                    <div className="min-w-0">
                      <dt className="text-[length:var(--font-eyebrow)] text-[var(--text-tertiary)]">{item.label}</dt>
                      <dd className="truncate text-xs text-primary-custom mono-font" title={item.value}>
                        {item.value}
                      </dd>
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleCopy(item.value, item.key)}
                      disabled={!item.value || item.value === "—"}
                      className="flex-shrink-0 rounded p-1 text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-hover)] disabled:opacity-30"
                      title="复制"
                    >
                      {copied === item.key ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                    </button>
                  </div>
                ))}
              </dl>
              <p className="mt-3 text-[length:var(--font-eyebrow)] leading-5 text-[var(--text-tertiary)]">
                NiNfer 是 OpenAI 兼容后端，可直接在对话页切到它；草稿长度、上下文等启动参数见下方「高级配置」，保存后下次启动生效。{status?.lan ? " 已开放局域网：其他设备把 127.0.0.1 换成本机局域网 IP。" : " 当前仅本机可访问。"}
              </p>
            </section>

            <Fast27bPerformance metrics={metrics} desktop={desktop} selectedModel={selectedModel} compact />

            {(actionMessage || (!loading && runtimeMessage)) && (
              <div
                role="status"
                aria-live="polite"
                className="rounded-md border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-2 text-xs text-secondary-custom"
              >
                {actionMessage ?? runtimeMessage}
              </div>
            )}

            <section className="overflow-hidden rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--surface)]">
              <button
                type="button"
                onClick={() => setConfigOpen((open) => !open)}
                aria-expanded={configOpen}
                aria-controls="ninfer-config"
                className="flex w-full items-center gap-2 px-4 py-3 text-left text-xs text-secondary-custom transition-colors hover:bg-[var(--surface-muted)]"
              >
                <ChevronDown className={`h-3.5 w-3.5 transition-transform ${configOpen ? "rotate-180" : ""}`} />
                <span className="font-medium text-primary-custom">高级配置</span>
                <span className="ml-auto text-[length:var(--font-eyebrow)]">
                  {settingsDirty ? "有未保存修改" : "路径、端口与 API key"}
                </span>
              </button>
              {configOpen && (
                <div id="ninfer-config" className="space-y-3 border-t border-[var(--border)] p-4">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="block text-xs">
                      <span className="mb-1 block text-secondary-custom">引擎路径（ninfer-serve.exe）</span>
                      <input
                        value={enginePath}
                        onChange={(event) => {
                          setEnginePath(event.target.value);
                          markDirty();
                        }}
                        spellCheck={false}
                        disabled={busy}
                        className={`${editorField} mono-font`}
                      />
                    </label>
                    {(["bonsai", "saluki"] as const).map((model) => (
                      <label key={model} className="block text-xs">
                        <span className="mb-1 block text-secondary-custom">
                          {model === "bonsai" ? "Bonsai" : "Saluki"} 模型文件（.ninfer）
                        </span>
                        <input
                          value={modelPaths[model]}
                          onChange={(event) => {
                            setModelPaths((previous) => ({ ...previous, [model]: event.target.value }));
                            markDirty();
                          }}
                          spellCheck={false}
                          disabled={running || busy}
                          className={`${editorField} mono-font`}
                        />
                      </label>
                    ))}
                  </div>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                    {fields.map((field) => (
                      <label key={field.label} className="block text-xs">
                        <span className="mb-1 block text-secondary-custom">{field.label}</span>
                        <input
                          type="number"
                          min={field.min}
                          max={field.max}
                          step={1}
                          value={field.value}
                          onChange={(event) => {
                            field.update(event.target.value);
                            markDirty();
                          }}
                          disabled={busy}
                          className={editorField}
                        />
                      </label>
                    ))}
                  </div>
                  <p className="text-[length:var(--font-eyebrow)] text-secondary-custom">
                    默认输出上限与思考预算沿用上次保存的值，不在这里暴露；保存后于下次启动生效。
                  </p>
                  <label className="block text-xs">
                    <span className="mb-1 block text-secondary-custom">API key（本地明文鉴权）</span>
                    <input
                      value={apiKey}
                      onChange={(event) => {
                        setApiKey(event.target.value);
                        markDirty();
                      }}
                      spellCheck={false}
                      disabled={busy}
                      className={`${editorField} mono-font`}
                    />
                  </label>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <fieldset disabled={busy} className="flex items-center gap-3 text-xs text-secondary-custom">
                      <ToggleSwitch
                        checked={lan}
                        onChange={(next) => {
                          setLan(next);
                          markDirty();
                        }}
                        label="对局域网开放 API"
                      />
                      <span>对局域网开放 API</span>
                    </fieldset>
                    <button
                      onClick={() => void handleSaveConfig()}
                      disabled={busy || !settingsDirty || !desktop}
                      className={primaryButton}
                    >
                      <Save className="h-3.5 w-3.5" />
                      {saving ? "正在保存…" : "保存配置"}
                    </button>
                  </div>
                </div>
              )}
            </section>

            <section className="overflow-hidden rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--surface)]">
              <button
                type="button"
                onClick={() => setLogsOpen((open) => !open)}
                aria-expanded={logsOpen}
                aria-controls="ninfer-logs"
                className="flex w-full items-center gap-2 px-4 py-3 text-left text-xs text-secondary-custom transition-colors hover:bg-[var(--surface-muted)]"
              >
                <ChevronDown className={`h-3.5 w-3.5 transition-transform ${logsOpen ? "rotate-180" : ""}`} />
                <span className="font-medium text-primary-custom">运行日志</span>
                <span className="ml-auto text-[length:var(--font-eyebrow)]">{fast27bLogs.length} 行</span>
              </button>
              {logsOpen && (
                <div id="ninfer-logs" className="border-t border-[var(--border)] p-3">
                  <div className="mb-2 flex flex-wrap justify-end gap-2">
                    <button onClick={() => setLogsLive((live) => !live)} className={secondaryButton}>
                      {logsLive ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
                      {logsLive ? "暂停刷新" : "恢复刷新"}
                    </button>
                    <button onClick={() => void handleCopyLogs()} disabled={!fast27bLogs.length} className={secondaryButton}>
                      {logCopied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                      {logCopied ? "已复制" : "复制"}
                    </button>
                    <button onClick={handleExportLogs} disabled={!fast27bLogs.length} className={secondaryButton}>
                      <Download className="h-3 w-3" />
                      导出
                    </button>
                    <button onClick={() => void handleClearLogs()} disabled={!fast27bLogs.length} className={secondaryButton}>
                      <Trash2 className="h-3 w-3" />
                      清空
                    </button>
                  </div>
                  <div
                    ref={logViewportRef}
                    className="mono-font h-48 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--app-bg)] px-3 py-2 text-[length:var(--font-eyebrow)] leading-[1.7]"
                  >
                    {!renderedLogs.length ? (
                      <div className="flex h-full items-center justify-center gap-2 text-secondary-custom">
                        <Terminal className="h-4 w-4 opacity-50" />
                        启动后显示引擎日志
                      </div>
                    ) : (
                      renderedLogs.map((line, index) => (
                        <div
                          key={`${fast27bLogs.length - renderedLogs.length + index}`}
                          className={`whitespace-pre-wrap break-all ${TONE_CLASS[classifyLogLine(line)]}`}
                        >
                          {line || " "}
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )}
            </section>
          </div>
        )}

        {activeTab === "performance" && (
          <div id="ninfer-panel-performance" role="tabpanel" aria-labelledby="ninfer-tab-performance">
            <Fast27bPerformance metrics={metrics} desktop={desktop} selectedModel={selectedModel} />
          </div>
        )}

        <ConfirmDialog
          open={pendingConfirm !== null}
          title={pendingConfirm?.title ?? ""}
          description={pendingConfirm?.description}
          confirmLabel={pendingConfirm?.confirmLabel}
          tone={pendingConfirm?.tone}
          onConfirm={async () => {
            await pendingConfirm?.action();
            setPendingConfirm(null);
          }}
          onCancel={() => setPendingConfirm(null)}
        />
      </div>
    </div>
  );
}
