import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Check,
  ChevronDown,
  Code2,
  Copy,
  Cpu,
  Download,
  ExternalLink,
  Globe,
  Info,
  Pause,
  Play,
  RefreshCw,
  Save,
  Square,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import PageHeader from "@/components/PageHeader";
import ToggleSwitch from "@/components/ToggleSwitch";
import ConfirmDialog from "@/components/ConfirmDialog";
import Fast27bPerformance from "@/features/fast27b/Fast27bPerformance";
import Fast27bConnection from "@/features/fast27b/Fast27bConnection";
import Fast27bModelSwitch from "@/features/fast27b/Fast27bModelSwitch";
import { useFast27bMetrics } from "@/hooks/useFast27bMetrics";
import { refreshEngineStatus, useEngineStatuses } from "@/hooks/useEngineStatuses";
import "@/features/fast27b/fast27b.css";
import { useApp } from "@/context/AppContext";
import {
  isDesktopRuntime,
  listenDesktopEvent,
  openExternalUrl,
} from "@/lib/desktop";
import {
  dshGetStatus,
  dshStart,
  fast27bBindDsh,
  fast27bClearLogs,
  fast27bGetLogs,
  fast27bGetStatus,
  fast27bSelectModel,
  fast27bRestart,
  fast27bSaveConfig,
  fast27bSetEnabled,
  fast27bStart,
  fast27bStop,
  fast27bUnbindDsh,
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

/** 轮询等待 dsh Web 就绪；超时返回 null（由调用方决定如何提示）。 */
async function waitForDshReady(
  timeoutMs = 40000,
): Promise<{ running: boolean; webUrl: string | null } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const status = await dshGetStatus();
      if (status?.runtime.running && status.runtime.web_url) {
        return { running: true, webUrl: status.runtime.web_url };
      }
    } catch {
      // 轮询失败继续等
    }
    await new Promise((resolve) => window.setTimeout(resolve, 1000));
  }
  return null;
}

export default function Fast27bPage() {
  const { dispatch } = useApp();
  const busyRef = useRef(false);
  const editorsInitializedRef = useRef(false);
  const logViewportRef = useRef<HTMLDivElement>(null);
  const engineStatuses = useEngineStatuses();
  const status = engineStatuses.fast27b;
  const metrics = useFast27bMetrics();
  const [activeTab, setActiveTab] = useState<"overview" | "performance" | "api">("overview");
  const [progressMessage, setProgressMessage] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [runtimeMessage, setRuntimeMessage] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [switchingModel, setSwitchingModel] = useState(false);
  const [binding, setBinding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [fast27bLogs, setFast27bLogs] = useState<string[]>([]);
  const [logsLive, setLogsLive] = useState(true);
  const [logCopied, setLogCopied] = useState(false);

  // 可编辑配置（从 status 初始化；「保存配置」落盘）。
  const [enginePath, setEnginePath] = useState("");
  const [selectedModel, setSelectedModel] =
    useState<Fast27bModelVariant>("heretic");
  const [modelPaths, setModelPaths] = useState<
    Record<Fast27bModelVariant, string>
  >({ heretic: "", swift: "" });
  const modelPath = modelPaths[selectedModel];
  const [port, setPort] = useState("8094");
  const [lan, setLan] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [contextWindow, setContextWindow] = useState("262144");
  const [draftTokens, setDraftTokens] = useState("4");
  const [defaultMaxTokens, setDefaultMaxTokens] = useState("32768");
  const [thinkingBudget, setThinkingBudget] = useState("8192");
  const [bridgePort, setBridgePort] = useState("8095");
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const [openingDsh, setOpeningDsh] = useState(false);

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
  const devicePoolTokens = status?.device_pool_tokens ?? null;
  const boundModel = status?.dsh_bound_model ?? null;
  const engineEnabled = status?.enabled ?? true;

  const applyStatusToEditors = useCallback((next: Fast27bStatus) => {
    setEnginePath(next.engine_path);
    setSelectedModel(next.selected_model);
    setModelPaths({
      heretic:
        next.model_presets.find((preset) => preset.id === "heretic")
          ?.model_path ?? "",
      swift:
        next.model_presets.find((preset) => preset.id === "swift")
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

  // 日志：1 秒轮询（与 dsh/llama 日志同范式），可暂停。
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
        setRuntimeMessage(`fast27b 已就绪：${payload.url ?? ""}`);
        setProgressMessage(null);
        setStarting(false);
        void refreshStatusOnly();
      },
    );
    const unlistenStopped = listenDesktopEvent<{ message?: string }>(
      "fast27b:stopped",
      (payload) => {
        setRuntimeMessage(payload.message ?? "fast27b 已停止。");
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
        setRuntimeMessage(payload.message ?? "fast27b 运行出错。");
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

  /** 确保 dsh 在跑（不在跑则拉起并等待就绪）；返回就绪后的 Web 地址或 null。 */
  const ensureDshRunning = async (): Promise<string | null> => {
    const before = await dshGetStatus();
    if (before?.runtime.running && before.runtime.web_url) {
      return before.runtime.web_url;
    }
    if (before && !before.package.installed) {
      throw new Error("dsh 尚未安装：请先到 Agent 页完成安装");
    }
    await dshStart();
    const ready = await waitForDshReady();
    if (!ready) {
      throw new Error(
        "dsh 在 40 秒内未就绪：请到 Agent（智能体）页查看 dsh 运行日志",
      );
    }
    return ready.webUrl;
  };

  const handleSelectModel = async (model: Fast27bModelVariant) => {
    if (busyRef.current || model === selectedModel || settingsDirty) return;
    const previousModel = selectedModel;
    busyRef.current = true;
    setSwitchingModel(true);
    setSelectedModel(model);
    setActionMessage(null);
    if (running) setProgressMessage(`正在切换到 ${model === "heretic" ? "Heretic" : "Swift"} 27B，重新加载引擎…`);
    try {
      await fast27bSelectModel(model);
      setActionMessage(`已切换到 ${model === "heretic" ? "Heretic" : "Swift"} 27B${running ? "，正在加载引擎，API 就绪后即可使用。" : "，点击启动即可运行。"}`);
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
      `正在加载 ${selectedModel === "swift" ? "Swift" : "Heretic"} 27B…`,
    );
    try {
      await fast27bStart();
      // 就绪由 fast27b:ready 事件确认，状态徽标会随之更新。
      setRuntimeMessage(
        "fast27b 正在启动，就绪后状态徽标会变为「运行中 · API 就绪」...",
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
      title: "停止 fast-27b 引擎",
      description: "正在进行的对话会被中断。",
      confirmLabel: "停止引擎",
      tone: "warning",
      action: async () => {
        setStopping(true);
        try {
          await fast27bStop();
          setRuntimeMessage("fast27b 已停止。");
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
        "fast27b 已重启完成：请新开对话，不要重发刚才那个超池的长历史。",
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

  const handleBind = async () => {
    if (busyRef.current) return;
    if (!engineEnabled) {
      setActionMessage("引擎已停用：请先开启引擎开关。");
      return;
    }
    busyRef.current = true;
    setBinding(true);
    setActionMessage(null);
    setProgressMessage("正在把 fast27b 接入 dsh...");
    try {
      const result = await fast27bBindDsh();
      if (result) {
        setActionMessage(
          `已接入模型 ${result.model_id}（${result.provider}），已设为 dsh 默认模型。`,
        );
      }
      await refreshStatusOnly();
    } catch (error) {
      setActionMessage(`接入失败：${String(error)}`);
    } finally {
      setBinding(false);
      setProgressMessage(null);
      busyRef.current = false;
    }
  };

  const handleUnbind = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBinding(true);
    setActionMessage(null);
    setProgressMessage("正在解除接入...");
    try {
      await fast27bUnbindDsh();
      setActionMessage(
        "已解除接入：dsh 配置已回滚（备份保留在 settings.yaml.bak）。",
      );
      await refreshStatusOnly();
    } catch (error) {
      setActionMessage(`解除失败：${String(error)}`);
    } finally {
      setBinding(false);
      setProgressMessage(null);
      busyRef.current = false;
    }
  };

  const handleOpenDshWeb = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setActionMessage(null);
    setOpeningDsh(true);
    setProgressMessage("正在确认 dsh Web 状态…");
    try {
      const webUrl = await ensureDshRunning();
      if (!webUrl) {
        throw new Error("dsh Web 地址未知");
      }
      setProgressMessage(null);
      await openExternalUrl(webUrl);
    } catch (error) {
      setProgressMessage(null);
      setActionMessage(`打开 dsh Web 失败：${String(error)}`);
    } finally {
      setOpeningDsh(false);
      busyRef.current = false;
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
    if (!Number.isInteger(draftNumber) || draftNumber < 0 || draftNumber > 5) {
      setActionMessage("保存失败：推测解码草稿长度必须在 0-5 之间。");
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
        swift_model_path: modelPaths.swift.trim(),
        heretic_model_path: modelPaths.heretic.trim(),
        port: portNumber,
        lan,
        api_key: apiKey.trim(),
        context_window: ctxNumber,
        draft_tokens: draftNumber,
        default_max_tokens: maxTokensNumber,
        default_thinking_budget: thinkingBudgetNumber,
        bridge_port: bridgePortNumber,
        auto_open_dsh_web: status?.auto_open_dsh_web ?? true,
      });
      setActionMessage(
        "配置已保存，下次启动生效；DSH 接入如有变化请重新接入。",
      );
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

  const applyBatPreset = () => {
    setSelectedModel("heretic");
    setContextWindow("262144");
    setDraftTokens("4");
    setDefaultMaxTokens("32768");
    setThinkingBudget("8192");
    markDirty();
    setActionMessage("已套用 start-heretic-best.bat 的推理参数，保存后于下次启动生效。");
  };

  /** 启用/停用 fast27b 引擎：只翻转开关（专用命令，不触碰其他配置项）。 */
  const applyEnabled = async (next: boolean) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setActionMessage(null);
    try {
      await fast27bSetEnabled(next);
      setActionMessage(
        next
          ? "fast-27b 引擎已启用。"
          : "fast-27b 引擎已停用；可随时在此重新启用。",
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
        title: "停用 fast-27b 引擎",
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
      title: "清空 fast27b 日志",
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
              请新开对话（不要重发这条长历史）；若需要更大池子，先关掉占显存的程序再重启引擎。
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
    "inline-flex items-center justify-center gap-1.5 rounded-md bg-[var(--accent)] px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-[var(--accent-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40";
  const busy =
    starting || stopping || restarting || switchingModel || binding || saving || openingDsh;
  const desktop = isDesktopRuntime();
  const selectedPreset = status?.model_presets.find(
    (preset) => preset.id === selectedModel,
  );
  const resourcesReady = Boolean(
    status?.engine_exists && selectedPreset?.exists,
  );
  const fields = [
    { label: "服务端口", value: port, update: setPort, min: 1, max: 65535 },
    {
      label: "WebUI 桥端口",
      value: bridgePort,
      update: setBridgePort,
      min: 1,
      max: 65535,
    },
    {
      label: "上下文长度（ctx）",
      value: contextWindow,
      update: setContextWindow,
      min: 1,
    },
    {
      label: "草稿长度（0–5）",
      value: draftTokens,
      update: setDraftTokens,
      min: 0,
      max: 5,
    },
    {
      label: "默认输出上限",
      value: defaultMaxTokens,
      update: setDefaultMaxTokens,
      min: 0,
    },
    {
      label: "思考预算（token）",
      value: thinkingBudget,
      update: setThinkingBudget,
      min: 0,
    },
  ];

  const openWebui = () => {
    dispatch({ type: "SET_WEBUI_ENGINE", payload: "fast27b" });
    dispatch({ type: "SET_AGENT_TAB", payload: "webui" });
    dispatch({ type: "SET_VIEW", payload: "agent" });
  };

  const openChat = () => {
    dispatch({ type: "SET_CHAT_ENGINE", payload: "fast27b" });
    dispatch({ type: "SET_VIEW", payload: "chat" });
  };

  const tabs = [
    { id: "overview", label: "概览", icon: Info },
    { id: "performance", label: "性能", icon: Activity },
    { id: "api", label: "API", icon: Code2 },
  ] as const;

  return (
    <div className="fast27b-workspace h-full min-h-0 overflow-y-auto px-4 py-5 sm:px-6">
      <div className="mx-auto max-w-5xl space-y-4 pb-6">
        <PageHeader
          icon={Cpu}
          title="fast-27b"
          description="Heretic · DFlash2 / Swift · MTP，启动、监测与接入集中管理。"
          className="mb-4"
        />

        <Fast27bModelSwitch
          selected={selectedModel}
          onChange={(model) => void handleSelectModel(model)}
          disabled={busy || settingsDirty || !status || !desktop}
          switching={switchingModel}
          available={status ? Object.fromEntries(status.model_presets.map((preset) => [preset.id, preset.exists])) : undefined}
        />
        <div className="fast27b-tabs" role="tablist" aria-label="fast-27b 工作台视图">
          {tabs.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              id={`fast27b-tab-${id}`}
              type="button"
              role="tab"
              aria-selected={activeTab === id}
              aria-controls={`fast27b-panel-${id}`}
              tabIndex={activeTab === id ? 0 : -1}
              onClick={() => setActiveTab(id)}
              onKeyDown={(event) => {
                const direction = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
                if (!direction && event.key !== "Home" && event.key !== "End") return;
                event.preventDefault();
                const index = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (tabs.findIndex((tab) => tab.id === id) + direction + tabs.length) % tabs.length;
                setActiveTab(tabs[index].id);
                document.getElementById(`fast27b-tab-${tabs[index].id}`)?.focus();
              }}
            >
              <Icon className="h-4 w-4" />{label}
            </button>
          ))}
        </div>

        {activeTab === "overview" && <div id="fast27b-panel-overview" role="tabpanel" aria-labelledby="fast27b-tab-overview" className="space-y-4">
        <section
          aria-label="模型与运行状态"
          className="fast27b-launch-panel rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--surface)] p-5"
        >
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            {runningBadge}
            <fieldset
              disabled={busy || !desktop || !status}
              className="flex items-center gap-2 text-xs text-secondary-custom disabled:opacity-50"
            >
              <span>{engineEnabled ? "引擎已启用" : "引擎已停用"}</span>
              <ToggleSwitch
                checked={engineEnabled}
                onChange={(next) => void handleToggleEnabled(next)}
                label="启用 fast-27b 引擎"
              />
            </fieldset>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-[length:var(--font-subtitle)] font-semibold text-primary-custom">{selectedModel === "heretic" ? "Heretic" : "Swift"} 27B</div>
            <div className="flex flex-wrap gap-2">
              {settingsDirty && (
                <button
                  onClick={() => void handleSaveConfig()}
                  disabled={busy || !desktop}
                  className={secondaryButton}
                >
                  <Save className="h-3.5 w-3.5" />
                  {saving ? "正在保存…" : "保存配置"}
                </button>
              )}
              {!running ? (
                <button
                  onClick={() => void handleStart()}
                  disabled={
                    busy ||
                    settingsDirty ||
                    !engineEnabled ||
                    !resourcesReady ||
                    !desktop
                  }
                  className={primaryButton}
                  title={
                    settingsDirty
                      ? "请先保存模型和配置"
                      : !resourcesReady
                        ? "请展开高级配置，检查引擎与模型路径"
                        : "启动所选模型"
                  }
                >
                  {starting ? (
                    <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Play className="h-3.5 w-3.5" />
                  )}
                  {starting ? "正在启动…" : "启动引擎"}
                </button>
              ) : (
                <button
                  onClick={() => void handleStop()}
                  disabled={busy}
                  className={secondaryButton}
                >
                  {stopping ? (
                    <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Square className="h-3.5 w-3.5" />
                  )}
                  {stopping ? "正在停止…" : "停止引擎"}
                </button>
              )}
              {needsRestart && (
                <button
                  onClick={() => void handleRestart()}
                  disabled={busy || settingsDirty || !desktop}
                  className={`${secondaryButton} text-[var(--state-danger)]`}
                >
                  <RefreshCw
                    className={`h-3.5 w-3.5 ${restarting ? "animate-spin" : ""}`}
                  />
                  重启恢复
                </button>
              )}
            </div>
          </div>
          <p
            id="fast27b-model-hint"
            className="mt-2 text-[length:var(--font-eyebrow)] text-secondary-custom"
          >
            {running
              ? "点击顶部切换按钮可重载到另一个模型，当前进行中的请求会中断。"
              : settingsDirty
                ? "有未保存修改，保存后即可启动。"
                : "Heretic 使用 DFlash2，Swift 使用 MTP；默认草稿 4 token，视觉常驻，推理参数参照 start-heretic-best.bat。"}
          </p>
          <div className="fast27b-profile-tags" aria-label="当前推理配置">
            <span>{selectedModel === "heretic" ? "DFlash2" : "MTP"} · 草稿 {draftTokens} token</span>
            <span>k8v4 · 主机 KV 16 GiB</span>
            <span>视觉常驻 · 单并发</span>
            <span>思考 high · 预算 {Number(thinkingBudget).toLocaleString()}</span>
          </div>
          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 border-t border-[var(--border)] pt-3 text-[length:var(--font-eyebrow)] text-secondary-custom">
            <span className="mono-font">
              API · {status?.lan ? "0.0.0.0" : "127.0.0.1"}:
              {status?.port ?? port}
            </span>
            <span>
              上下文 · {(status?.context_window ?? 262144).toLocaleString()}
            </span>
            {devicePoolTokens !== null && (
              <span>
                设备 KV 池 · {devicePoolTokens.toLocaleString()} token
              </span>
            )}
          </div>
          {status && !resourcesReady && (
            <p
              role="alert"
              className="mt-3 text-xs text-[var(--state-warning)]"
            >
              {!status.engine_exists ? "引擎文件缺失。" : "所选模型文件缺失。"}
              <button
                onClick={() => setConfigOpen(true)}
                className="ml-1 underline underline-offset-2"
              >
                检查高级配置
              </button>
            </p>
          )}
          {engineAlert && <div className="mt-3">{engineAlert}</div>}
        </section>

        <section
          aria-label="接入与对话"
          className="grid divide-y divide-[var(--border)] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] md:grid-cols-2 md:divide-x md:divide-y-0"
        >
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <h2 className="text-xs font-semibold text-primary-custom">DSH</h2>
              <p
                className="mt-1 truncate text-[length:var(--font-eyebrow)] text-secondary-custom"
                title={boundModel ?? "接入后设为默认模型"}
              >
                {boundModel ? `已接入 · ${boundModel}` : "智能体默认模型"}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() =>
                  void (boundModel ? handleUnbind() : handleBind())
                }
                disabled={
                  busy ||
                  !desktop ||
                  (!boundModel && (!apiReady || !engineEnabled))
                }
                className={secondaryButton}
                title="接入会替换 DSH 当前默认模型，与模型页共用同一提供方槽位"
              >
                {binding ? (
                  <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                ) : boundModel ? (
                  <X className="h-3.5 w-3.5" />
                ) : (
                  <Check className="h-3.5 w-3.5" />
                )}
                {boundModel ? "解除" : "接入 DSH"}
              </button>
              <button
                onClick={() => void handleOpenDshWeb()}
                disabled={busy || !desktop}
                className={secondaryButton}
                title="打开 DSH 网页；未运行时会先自动启动"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                打开
              </button>
            </div>
          </div>
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div>
              <h2 className="text-xs font-semibold text-primary-custom">
                WebUI
              </h2>
              <p className="mt-1 text-[length:var(--font-eyebrow)] text-secondary-custom">
                直接与当前模型对话
              </p>
            </div>
            <button
              onClick={openWebui}
              disabled={busy || !apiReady || !desktop}
              className={secondaryButton}
              title={
                apiReady ? "打开应用内 WebUI" : "请先启动引擎并等待 API 就绪"
              }
            >
              <Globe className="h-3.5 w-3.5" />
              打开 WebUI
            </button>
          </div>
        </section>

        <Fast27bPerformance metrics={metrics} desktop={desktop} selectedModel={selectedModel} compact />
        </div>}

        {activeTab === "performance" && <div id="fast27b-panel-performance" role="tabpanel" aria-labelledby="fast27b-tab-performance">
          <Fast27bPerformance metrics={metrics} desktop={desktop} selectedModel={selectedModel} />
        </div>}
        {activeTab === "api" && <div id="fast27b-panel-api" role="tabpanel" aria-labelledby="fast27b-tab-api">
          <Fast27bConnection status={status} desktop={desktop} onOpenChat={openChat} />
        </div>}

        {(progressMessage || runtimeMessage || actionMessage) && (
          <div
            role="status"
            aria-live="polite"
            className="space-y-1 rounded-lg bg-[var(--surface-muted)] px-3 py-2 text-xs text-secondary-custom"
          >
            {progressMessage && (
              <p className="flex items-center gap-2">
                <RefreshCw className="h-3.5 w-3.5 shrink-0 animate-spin text-[var(--accent)]" />
                {progressMessage}
              </p>
            )}
            {!progressMessage && runtimeMessage && (
              <p className="flex items-start gap-2">
                <Info className="h-3.5 w-3.5 shrink-0" />
                {runtimeMessage}
              </p>
            )}
            {actionMessage && <p>{actionMessage}</p>}
          </div>
        )}

        <section className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
          <button
            type="button"
            onClick={() => setConfigOpen((open) => !open)}
            aria-expanded={configOpen}
            aria-controls="fast27b-config"
            className="flex w-full items-center gap-2 px-4 py-3 text-left text-xs text-secondary-custom transition-colors hover:bg-[var(--surface-muted)]"
          >
            <ChevronDown
              className={`h-3.5 w-3.5 transition-transform ${configOpen ? "rotate-180" : ""}`}
            />
            <span className="font-medium text-primary-custom">高级配置</span>
            <span className="ml-auto text-[length:var(--font-eyebrow)]">
              {settingsDirty ? "有未保存修改" : "路径、参数与 API key"}
            </span>
          </button>
          {configOpen && (
            <div
              id="fast27b-config"
              className="space-y-3 border-t border-[var(--border)] p-4"
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block text-xs">
                  <span className="mb-1 block text-secondary-custom">
                    引擎路径（ninfer-serve-86.exe）
                  </span>
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
                {(["heretic", "swift"] as const).map((model) => (
                  <label key={model} className="block text-xs">
                    <span className="mb-1 block text-secondary-custom">
                      {model === "heretic" ? "Heretic" : "Swift"} 模型文件（.ninfer）
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
                    <span className="mb-1 block text-secondary-custom">
                      {field.label}
                    </span>
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
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-[length:var(--font-eyebrow)] text-secondary-custom">默认输出上限为 0 时由引擎自定；思考预算为 0 时不限制。保存后于下次启动生效。</p>
                  <button type="button" onClick={applyBatPreset} disabled={busy || running || !desktop} className={secondaryButton}>应用 bat 参数</button>
                </div>
                <details className="rounded-[var(--radius-lg)] bg-[var(--surface-muted)] p-3 text-[length:var(--font-eyebrow)] text-secondary-custom">
                  <summary className="cursor-pointer font-medium text-primary-custom">查看固定参数与 KV 环境变量</summary>
                  <p className="mono-font mt-2 break-words leading-relaxed">--kv-capacity auto · --kv-headroom-mib 128 · --kv-dtype k8v4 · --host-kv-mib 16384 · --prefill-chunk 1024 · --lm-head-draft · --ngram-draft-tokens 0 · --vision --vision-residency resident · --default-reasoning-effort high · --max-concurrency 1 · --presence-penalty 0 · --max-shared-prefixes 0 · --gdn-state-fp16</p>
                  <p className="mono-font mt-2 break-words leading-relaxed">NINFER_KV_WINDOW=16384 · NINFER_KV_RETRIEVE=8192 · NINFER_KV_RING=1 · NINFER_HOST_PAGEABLE=1 · NINFER_KV_REUSE_HOSTBACKED=1</p>
                  <p className="mt-2">已有非空 NINFER_* 环境值优先；API 监听与鉴权使用本页保存的配置。</p>
                </details>
              <label className="block text-xs">
                <span className="mb-1 block text-secondary-custom">
                  API key（本地明文鉴权）
                </span>
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
                <fieldset
                  disabled={busy}
                  className="flex items-center gap-3 text-xs text-secondary-custom"
                >
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

        <section className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
          <button
            type="button"
            onClick={() => setLogsOpen((open) => !open)}
            aria-expanded={logsOpen}
            aria-controls="fast27b-logs"
            className="flex w-full items-center gap-2 px-4 py-3 text-left text-xs text-secondary-custom transition-colors hover:bg-[var(--surface-muted)]"
          >
            <ChevronDown
              className={`h-3.5 w-3.5 transition-transform ${logsOpen ? "rotate-180" : ""}`}
            />
            <span className="font-medium text-primary-custom">运行日志</span>
            <span className="ml-auto text-[length:var(--font-eyebrow)]">{fast27bLogs.length} 行</span>
          </button>
          {logsOpen && (
            <div
              id="fast27b-logs"
              className="border-t border-[var(--border)] p-3"
            >
              <div className="mb-2 flex flex-wrap justify-end gap-2">
                <button
                  onClick={() => setLogsLive((live) => !live)}
                  className={secondaryButton}
                >
                  {logsLive ? (
                    <Pause className="h-3 w-3" />
                  ) : (
                    <Play className="h-3 w-3" />
                  )}
                  {logsLive ? "暂停刷新" : "恢复刷新"}
                </button>
                <button
                  onClick={() => void handleCopyLogs()}
                  disabled={!fast27bLogs.length}
                  className={secondaryButton}
                >
                  {logCopied ? (
                    <Check className="h-3 w-3" />
                  ) : (
                    <Copy className="h-3 w-3" />
                  )}
                  {logCopied ? "已复制" : "复制"}
                </button>
                <button
                  onClick={handleExportLogs}
                  disabled={!fast27bLogs.length}
                  className={secondaryButton}
                >
                  <Download className="h-3 w-3" />
                  导出
                </button>
                <button
                  onClick={() => void handleClearLogs()}
                  disabled={!fast27bLogs.length}
                  className={secondaryButton}
                >
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
