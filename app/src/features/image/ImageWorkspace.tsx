import {
  CheckCircle2,
  Copy,
  FileJson,
  Image as ImageIcon,
  Loader2,
  Plus,
  RefreshCw,
  Send,
  Sparkles,
  Square,
  Upload,
  Wand2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { useApp } from '@/context/AppContext';
import {
  buildComfyImageUrl,
  extractComfyResourceOptions,
  extractImagesFromHistory,
  getComfyHistory,
  getComfyObjectInfo,
  getComfySystemStats,
  interruptComfy,
  submitComfyPrompt,
  uploadComfyImage,
} from '@/features/image/services/comfyApi';
import type {
  ComfyResourceOptions,
  ImageGenerationJob,
  ImageGenerationParams,
  ImageOutputRecord,
  ImageWorkflowRecord,
} from '@/features/image/state/imageTypes';
import { analyzeWorkflowJson, bindingLabel } from '@/features/image/workflow/workflowParser';
import {
  buildPromptFromParams,
  createParamsFromWorkflow,
  enabledRequiredBindings,
  updateParamsForRatio,
} from '@/features/image/workflow/workflowMutator';

const STORAGE_KEY = 'agent-llm-comfy-image-workspace-v1';
const CLIENT_ID = `agent-llm-${Math.random().toString(36).slice(2)}`;
const RATIO_PRESETS = ['1:1', '3:4', '4:3', '16:9', '9:16'];
const EMPTY_RESOURCES: ComfyResourceOptions = {
  checkpoints: [],
  loras: [],
  samplers: [],
  schedulers: [],
};

interface StoredImageWorkspace {
  baseUrl?: string;
  workflows?: ImageWorkflowRecord[];
  activeWorkflowId?: string;
  gallery?: ImageOutputRecord[];
}

interface PromptSuggestion {
  positive: string;
  negative: string;
}

function loadStoredWorkspace(): StoredImageWorkspace {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed as StoredImageWorkspace : {};
  } catch {
    return {};
  }
}

function persistWorkspace(state: StoredImageWorkspace) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function newId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function randomSeed() {
  return Math.floor(Math.random() * 1_000_000_000);
}

function numberFromInput(value: string, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function selectOptions(options: string[], current: string) {
  return Array.from(new Set([current, ...options].filter(Boolean)));
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function formatDate(timestamp: number) {
  return new Date(timestamp).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function shortText(value: string, fallback = '未设置') {
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  return trimmed.length > 28 ? `${trimmed.slice(0, 28)}...` : trimmed;
}

function buildSuggestion(params: ImageGenerationParams | null): PromptSuggestion {
  const base = params?.positivePrompt.trim();
  const subject = base || 'a cinematic portrait, soft studio light, elegant details';
  return {
    positive: `${subject}, high detail, balanced composition, natural color grading, sharp focus, refined texture, professional lighting`,
    negative: 'low quality, blurry, bad anatomy, extra fingers, watermark, text, jpeg artifacts, overexposed, underexposed',
  };
}

export default function ImageWorkspace() {
  const { dispatch } = useApp();
  const [stored] = useState<StoredImageWorkspace>(() => loadStoredWorkspace());
  const initialWorkflow = stored.workflows?.find((workflow) => workflow.id === stored.activeWorkflowId)
    ?? stored.workflows?.[0]
    ?? null;
  const [baseUrl, setBaseUrl] = useState(stored.baseUrl ?? 'http://127.0.0.1:8188');
  const [connected, setConnected] = useState(false);
  const [checking, setChecking] = useState(false);
  const [resources, setResources] = useState<ComfyResourceOptions>(EMPTY_RESOURCES);
  const [workflows, setWorkflows] = useState<ImageWorkflowRecord[]>(stored.workflows ?? []);
  const [activeWorkflowId, setActiveWorkflowId] = useState(initialWorkflow?.id ?? '');
  const [params, setParams] = useState<ImageGenerationParams | null>(() =>
    initialWorkflow ? createParamsFromWorkflow(initialWorkflow, EMPTY_RESOURCES) : null
  );
  const [gallery, setGallery] = useState<ImageOutputRecord[]>(stored.gallery ?? []);
  const [selectedImageId, setSelectedImageId] = useState(stored.gallery?.[0]?.id ?? '');
  const [jobs, setJobs] = useState<ImageGenerationJob[]>([]);
  const [generating, setGenerating] = useState(false);
  const [statusText, setStatusText] = useState('连接 ComfyUI 后上传工作流。');
  const [suggestion, setSuggestion] = useState<PromptSuggestion | null>(null);
  const cancelRef = useRef(false);

  const activeWorkflow = useMemo(
    () => workflows.find((workflow) => workflow.id === activeWorkflowId) ?? null,
    [activeWorkflowId, workflows]
  );
  const selectedImage = useMemo(
    () => gallery.find((item) => item.id === selectedImageId) ?? gallery[0] ?? null,
    [gallery, selectedImageId]
  );
  const activeJob = jobs[0];

  useEffect(() => {
    persistWorkspace({
      baseUrl,
      workflows,
      activeWorkflowId,
      gallery: gallery.slice(0, 80),
    });
  }, [activeWorkflowId, baseUrl, gallery, workflows]);

  const patchParams = useCallback((patch: Partial<ImageGenerationParams>) => {
    setParams((current) => current ? { ...current, ...patch } : current);
  }, []);

  const activateWorkflow = useCallback((workflow: ImageWorkflowRecord) => {
    setActiveWorkflowId(workflow.id);
    setParams(createParamsFromWorkflow(workflow, resources));
  }, [resources]);

  const connectComfy = useCallback(async () => {
    setChecking(true);
    setStatusText('正在连接 ComfyUI...');
    try {
      await getComfySystemStats(baseUrl);
      const objectInfo = await getComfyObjectInfo(baseUrl);
      const nextResources = extractComfyResourceOptions(objectInfo);
      setResources(nextResources);
      if (activeWorkflow) {
        setParams(createParamsFromWorkflow(activeWorkflow, nextResources));
      }
      setConnected(true);
      setStatusText('ComfyUI 已连接，资源列表已刷新。');
    } catch (error) {
      setConnected(false);
      setResources(EMPTY_RESOURCES);
      setStatusText(`连接失败：${String(error)}`);
    } finally {
      setChecking(false);
    }
  }, [activeWorkflow, baseUrl]);

  const handleWorkflowUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;

    try {
      const raw = JSON.parse(await file.text());
      const analysis = analyzeWorkflowJson(raw);
      if (!analysis.prompt) {
        setStatusText(analysis.warnings.join(' '));
        return;
      }
      const workflow: ImageWorkflowRecord = {
        id: newId('workflow'),
        name: file.name.replace(/\.json$/i, ''),
        rawJson: raw,
        prompt: analysis.prompt,
        binding: analysis.binding,
        nodeCount: analysis.nodeCount,
        warnings: analysis.warnings,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      setWorkflows((current) => [workflow, ...current]);
      setActiveWorkflowId(workflow.id);
      setParams(createParamsFromWorkflow(workflow, resources));
      setStatusText(`已读取工作流：${workflow.name}`);
    } catch (error) {
      setStatusText(`工作流读取失败：${String(error)}`);
    }
  };

  const updateLora = (id: string, patch: Partial<ImageGenerationParams['loras'][number]>) => {
    setParams((current) => current
      ? {
          ...current,
          loras: current.loras.map((lora) => lora.id === id ? { ...lora, ...patch } : lora),
        }
      : current);
  };

  const enableNextLoraSlot = () => {
    const disabled = params?.loras.find((lora) => !lora.enabled);
    if (!disabled) {
      setStatusText('当前工作流没有可启用的空 LoRA 节点；动态插入 LoRA 会在后续阶段实现。');
      return;
    }
    updateLora(disabled.id, {
      enabled: true,
      name: disabled.name || resources.loras[0] || '',
      strengthModel: disabled.strengthModel || 1,
      strengthClip: disabled.strengthClip || 1,
    });
  };

  const uploadImageToNode = async (nodeId: string, file: File) => {
    if (!params) return;
    try {
      setStatusText('正在上传图片到 ComfyUI...');
      const response = await uploadComfyImage(baseUrl, file);
      const imageName = response.name ?? file.name;
      patchParams({
        imageInputs: params.imageInputs.map((input) =>
          input.nodeId === nodeId ? { ...input, imageName } : input
        ),
      });
      setStatusText(`图片已上传：${imageName}`);
    } catch (error) {
      setStatusText(`图片上传失败：${String(error)}`);
    }
  };

  const waitForImages = useCallback(async (promptId: string) => {
    for (let attempt = 0; attempt < 180; attempt += 1) {
      if (cancelRef.current) throw new Error('生成已取消。');
      const history = await getComfyHistory(baseUrl, promptId);
      const images = extractImagesFromHistory(history, promptId);
      if (images.length > 0) return images;
      await delay(1000);
    }
    throw new Error('等待 ComfyUI 输出超时。');
  }, [baseUrl]);

  const generateImages = async () => {
    if (!activeWorkflow || !params) {
      setStatusText('请先上传并选择工作流。');
      return;
    }
    if (!connected) {
      setStatusText('请先连接 ComfyUI。');
      return;
    }

    cancelRef.current = false;
    setGenerating(true);
    setSuggestion(null);
    const jobId = newId('job');
    const job: ImageGenerationJob = {
      id: jobId,
      status: 'running',
      params,
      workflowName: activeWorkflow.name,
      outputs: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    setJobs((current) => [job, ...current].slice(0, 12));

    try {
      const allOutputs: ImageOutputRecord[] = [];
      const count = Math.max(1, Math.round(params.batchCount));
      for (let index = 0; index < count; index += 1) {
        const seed = params.randomSeed ? randomSeed() : params.seed;
        const batchParams = { ...params, seed };
        const prompt = buildPromptFromParams(activeWorkflow, batchParams, seed);
        setStatusText(`正在提交第 ${index + 1} / ${count} 批...`);
        const response = await submitComfyPrompt(baseUrl, prompt, CLIENT_ID);
        if (response.node_errors && Object.keys(response.node_errors).length > 0) {
          throw new Error(JSON.stringify(response.node_errors));
        }
        setJobs((current) => current.map((item) =>
          item.id === jobId ? { ...item, promptId: response.prompt_id, updatedAt: Date.now() } : item
        ));
        setStatusText(`已进入 Comfy 队列：${response.prompt_id}`);
        const images = await waitForImages(response.prompt_id);
        const outputs = images.map((image) => ({
          id: newId('image'),
          jobId,
          promptId: response.prompt_id,
          image,
          url: buildComfyImageUrl(baseUrl, image),
          params: batchParams,
          workflowName: activeWorkflow.name,
          workflowSnapshot: prompt,
          createdAt: Date.now(),
        }));
        allOutputs.push(...outputs);
        setGallery((current) => [...outputs, ...current].slice(0, 80));
        if (outputs[0]) setSelectedImageId(outputs[0].id);
      }
      setJobs((current) => current.map((item) =>
        item.id === jobId
          ? { ...item, status: 'done', outputs: allOutputs, updatedAt: Date.now() }
          : item
      ));
      setStatusText(`生成完成，共输出 ${allOutputs.length} 张图片。`);
    } catch (error) {
      const message = String(error);
      setJobs((current) => current.map((item) =>
        item.id === jobId
          ? { ...item, status: cancelRef.current ? 'cancelled' : 'error', error: message, updatedAt: Date.now() }
          : item
      ));
      setStatusText(cancelRef.current ? '生成已取消。' : `生成失败：${message}`);
    } finally {
      setGenerating(false);
    }
  };

  const stopGeneration = async () => {
    cancelRef.current = true;
    try {
      await interruptComfy(baseUrl);
      setStatusText('已向 ComfyUI 发送停止请求。');
    } catch (error) {
      setStatusText(`停止请求失败：${String(error)}`);
    }
  };

  const createSuggestion = () => {
    setSuggestion(buildSuggestion(params));
    setStatusText('已生成一组提示词建议，点击应用后才会写入。');
  };

  const copyText = async (value: string) => {
    await navigator.clipboard.writeText(value);
    setStatusText('已复制到剪贴板。');
  };

  return (
    <div className="paper-surface flex h-full min-h-0 overflow-hidden rounded-md border border-[#DCD8CF] bg-[#FBFAF6] text-[#2F2C26] shadow-sm dark:border-white/[0.08] dark:bg-[#11100E] dark:text-[#F3EBDD]">
      <aside className="hidden w-72 flex-shrink-0 flex-col border-r border-[#E3DFD6] bg-[#F2F0EA] p-3 dark:border-white/[0.08] dark:bg-[#15130F] xl:flex">
        <div className="mb-3 flex items-center justify-between gap-2">
          <div>
            <div className="text-base font-semibold">Comfy 生图</div>
            <div className="text-xs text-[#8C8576] dark:text-[#A9A095]">工作流驱动的生图工作区</div>
          </div>
          <button
            type="button"
            onClick={() => dispatch({ type: 'SET_VIEW', payload: 'home' })}
            className="rounded-md border border-[#DCD8CF] bg-[#FAF9F5] px-2.5 py-1.5 text-xs text-[#4E4941] hover:bg-[#EAE6DD] dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-[#D8D0C3]"
          >
            返回
          </button>
        </div>

        <section className="rounded-md border border-[#DCD8CF] bg-[#FAF9F5] p-3 dark:border-white/[0.08] dark:bg-white/[0.05]">
          <div className="mb-2 flex items-center justify-between gap-2 text-xs font-semibold text-[#4E4941] dark:text-[#D8D0C3]">
            <span>Comfy 地址</span>
            <span className={`inline-flex items-center gap-1 ${connected ? 'text-[#2C8B58]' : 'text-[#A49B8C]'}`}>
              {connected ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Square className="h-3 w-3" />}
              {connected ? '已连接' : '未连接'}
            </span>
          </div>
          <input
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            className="h-9 w-full rounded-md border border-[#DCD8CF] bg-[#FBFAF6] px-3 text-xs outline-none focus:border-[#D7663E] dark:border-white/[0.08] dark:bg-[#15130F]"
          />
          <button
            type="button"
            onClick={connectComfy}
            disabled={checking}
            className="mt-2 flex h-9 w-full items-center justify-center gap-2 rounded-md bg-[#D7663E] text-sm font-semibold text-white disabled:opacity-60"
          >
            {checking ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            {checking ? '连接中' : '连接 / 刷新'}
          </button>
        </section>

        <section className="mt-3 min-h-0 flex-1 overflow-hidden rounded-md border border-[#DCD8CF] bg-[#FAF9F5] p-3 dark:border-white/[0.08] dark:bg-white/[0.05]">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="text-xs font-semibold text-[#4E4941] dark:text-[#D8D0C3]">工作流</div>
            <label className="flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-[#DCD8CF] bg-[#FBFAF6] px-2 text-xs hover:bg-[#F1EEE7] dark:border-white/[0.08] dark:bg-[#15130F]">
              <Upload className="h-3.5 w-3.5" />
              上传
              <input type="file" accept=".json,application/json" className="hidden" onChange={handleWorkflowUpload} />
            </label>
          </div>
          <div className="max-h-[34vh] space-y-2 overflow-y-auto pr-1">
            {workflows.length === 0 ? (
              <div className="rounded-md border border-dashed border-[#D6CFC2] p-3 text-xs text-[#8C8576] dark:border-white/[0.10] dark:text-[#A9A095]">
                暂无工作流
              </div>
            ) : workflows.map((workflow) => {
              const active = workflow.id === activeWorkflowId;
              return (
                <button
                  key={workflow.id}
                  type="button"
                  onClick={() => activateWorkflow(workflow)}
                  className={`w-full rounded-md border p-3 text-left transition-colors ${
                    active
                      ? 'border-[#D7663E]/40 bg-[#F4E4D9] dark:bg-[#3A241C]'
                      : 'border-[#DCD8CF] bg-[#FBFAF6] hover:bg-[#F1EEE7] dark:border-white/[0.08] dark:bg-[#15130F]'
                  }`}
                >
                  <div className="flex items-center gap-2 text-sm font-semibold">
                    <FileJson className="h-4 w-4 text-[#D7663E]" />
                    <span className="truncate">{workflow.name}</span>
                  </div>
                  <div className="mt-1 text-xs text-[#8C8576] dark:text-[#A9A095]">
                    {workflow.nodeCount} 个节点 · 绑定 {enabledRequiredBindings(workflow.binding)} 项
                  </div>
                </button>
              );
            })}
          </div>
        </section>

        <section className="mt-3 rounded-md border border-[#DCD8CF] bg-[#FAF9F5] p-3 text-xs dark:border-white/[0.08] dark:bg-white/[0.05]">
          <div className="mb-2 font-semibold text-[#4E4941] dark:text-[#D8D0C3]">节点绑定</div>
          <BindingLine label="正提示词" value={bindingLabel(activeWorkflow?.binding.positivePrompt)} />
          <BindingLine label="负提示词" value={bindingLabel(activeWorkflow?.binding.negativePrompt)} />
          <BindingLine label="尺寸" value={bindingLabel(activeWorkflow?.binding.width)} />
          <BindingLine label="模型" value={bindingLabel(activeWorkflow?.binding.checkpoint)} />
          <BindingLine label="图片输入" value={`${activeWorkflow?.binding.imageInputs.length ?? 0} 个`} />
        </section>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col bg-[#FBFAF6] dark:bg-[#171512]">
        <header className="flex flex-shrink-0 items-center justify-between gap-3 border-b border-[#E3DFD6] px-4 py-3 dark:border-white/[0.08]">
          <div className="min-w-0">
            <div className="truncate text-lg font-semibold">提示词、参数与图库</div>
            <div className="truncate text-xs text-[#8C8576] dark:text-[#A9A095]">{statusText}</div>
          </div>
          <div className="flex flex-shrink-0 items-center gap-2">
            <label className="flex h-9 cursor-pointer items-center gap-2 rounded-md border border-[#DCD8CF] bg-[#FAF9F5] px-3 text-sm hover:bg-[#F1EEE7] dark:border-white/[0.08] dark:bg-white/[0.05] xl:hidden">
              <Upload className="h-4 w-4" />
              工作流
              <input type="file" accept=".json,application/json" className="hidden" onChange={handleWorkflowUpload} />
            </label>
            <button
              type="button"
              onClick={createSuggestion}
              disabled={!params}
              className="flex h-9 items-center gap-2 rounded-md border border-[#DCD8CF] bg-[#FAF9F5] px-3 text-sm hover:bg-[#F1EEE7] disabled:opacity-50 dark:border-white/[0.08] dark:bg-white/[0.05]"
            >
              <Wand2 className="h-4 w-4" />
              推荐提示词
            </button>
            {generating ? (
              <button
                type="button"
                onClick={stopGeneration}
                className="flex h-9 items-center gap-2 rounded-md bg-[#6E6256] px-4 text-sm font-semibold text-white"
              >
                <X className="h-4 w-4" />
                停止
              </button>
            ) : (
              <button
                type="button"
                onClick={generateImages}
                disabled={!params || !activeWorkflow}
                className="flex h-9 items-center gap-2 rounded-md bg-[#D7663E] px-4 text-sm font-semibold text-white disabled:opacity-50"
              >
                <Send className="h-4 w-4" />
                开始生成
              </button>
            )}
          </div>
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-1 gap-0 lg:grid-cols-[minmax(0,1fr)_330px]">
          <div className="flex min-w-0 flex-col gap-3 overflow-y-auto p-4">
            <section className="grid gap-3 xl:grid-cols-2">
              <PromptBox
                title="正提示词"
                value={params?.positivePrompt ?? ''}
                onChange={(value) => patchParams({ positivePrompt: value })}
                placeholder="输入正提示词"
              />
              <PromptBox
                title="负提示词"
                value={params?.negativePrompt ?? ''}
                onChange={(value) => patchParams({ negativePrompt: value })}
                placeholder="输入负提示词"
              />
            </section>

            {suggestion && (
              <section className="rounded-md border border-[#DCD8CF] bg-[#FFFDF8] p-3 dark:border-white/[0.08] dark:bg-white/[0.04]">
                <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
                  <Sparkles className="h-4 w-4 text-[#D7663E]" />
                  提示词建议
                </div>
                <div className="grid gap-2 text-xs text-[#5F574C] dark:text-[#D8D0C3] xl:grid-cols-2">
                  <SuggestionBlock
                    label="正提示词"
                    value={suggestion.positive}
                    onApply={() => patchParams({ positivePrompt: suggestion.positive })}
                    onCopy={() => void copyText(suggestion.positive)}
                  />
                  <SuggestionBlock
                    label="负提示词"
                    value={suggestion.negative}
                    onApply={() => patchParams({ negativePrompt: suggestion.negative })}
                    onCopy={() => void copyText(suggestion.negative)}
                  />
                </div>
              </section>
            )}

            <section className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_260px]">
              <div className="rounded-md border border-[#DCD8CF] bg-[#FFFDF8] p-3 dark:border-white/[0.08] dark:bg-white/[0.04]">
                <div className="mb-3 flex items-center justify-between gap-2">
                  <div className="text-sm font-semibold">图库</div>
                  <div className="text-xs text-[#8C8576] dark:text-[#A9A095]">{gallery.length} 张图片</div>
                </div>
                {gallery.length === 0 ? (
                  <div className="grid min-h-[280px] place-items-center rounded-md border border-dashed border-[#D6CFC2] text-sm text-[#8C8576] dark:border-white/[0.10] dark:text-[#A9A095]">
                    生成结果会显示在这里
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-3 md:grid-cols-3 2xl:grid-cols-4">
                    {gallery.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => setSelectedImageId(item.id)}
                        className={`group overflow-hidden rounded-md border bg-[#F1EEE7] text-left transition ${
                          selectedImage?.id === item.id
                            ? 'border-[#D7663E]'
                            : 'border-[#DCD8CF] hover:border-[#C7BDAF] dark:border-white/[0.08]'
                        }`}
                      >
                        <div className="aspect-square overflow-hidden bg-[#E8E2D7]">
                          <img src={item.url} alt={item.image.filename} className="h-full w-full object-cover transition group-hover:scale-[1.02]" />
                        </div>
                        <div className="px-2 py-1.5">
                          <div className="truncate text-xs font-semibold">seed {item.params.seed}</div>
                          <div className="truncate text-[11px] text-[#8C8576]">{formatDate(item.createdAt)}</div>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <ImageDetails image={selectedImage} onCopy={copyText} />
            </section>
          </div>

          <aside className="min-h-0 overflow-y-auto border-l border-[#E3DFD6] bg-[#F7F3EA] p-4 dark:border-white/[0.08] dark:bg-[#15130F]">
            <ParameterPanel
              params={params}
              resources={resources}
              activeWorkflow={activeWorkflow}
              activeJob={activeJob}
              generating={generating}
              onPatch={patchParams}
              onRatio={(ratio) => setParams((current) => current ? updateParamsForRatio(current, ratio) : current)}
              onLoraPatch={updateLora}
              onLoraAdd={enableNextLoraSlot}
              onImageUpload={uploadImageToNode}
            />
          </aside>
        </div>
      </main>
    </div>
  );
}

function BindingLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-[#E7E0D5] py-1.5 last:border-b-0 dark:border-white/[0.08]">
      <span className="text-[#8C8576] dark:text-[#A9A095]">{label}</span>
      <span className="truncate font-semibold">{value}</span>
    </div>
  );
}

function PromptBox({ title, value, placeholder, onChange }: {
  title: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  return (
    <section className="rounded-md border border-[#DCD8CF] bg-[#FFFDF8] p-3 dark:border-white/[0.08] dark:bg-white/[0.04]">
      <div className="mb-2 text-sm font-semibold">{title}</div>
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="min-h-32 w-full resize-y rounded-md border border-[#DCD8CF] bg-[#FBFAF6] px-3 py-2 text-sm leading-6 outline-none focus:border-[#D7663E] dark:border-white/[0.08] dark:bg-[#15130F]"
      />
    </section>
  );
}

function SuggestionBlock({ label, value, onApply, onCopy }: {
  label: string;
  value: string;
  onApply: () => void;
  onCopy: () => void;
}) {
  return (
    <div className="rounded-md border border-[#E3DFD6] bg-[#FBFAF6] p-2 dark:border-white/[0.08] dark:bg-[#15130F]">
      <div className="mb-1 font-semibold">{label}</div>
      <div className="min-h-14 leading-5">{value}</div>
      <div className="mt-2 flex gap-2">
        <button type="button" onClick={onApply} className="rounded-md bg-[#D7663E] px-2 py-1 text-xs font-semibold text-white">应用</button>
        <button type="button" onClick={onCopy} className="rounded-md border border-[#DCD8CF] px-2 py-1 text-xs">复制</button>
      </div>
    </div>
  );
}

function ParameterPanel({ params, resources, activeWorkflow, activeJob, generating, onPatch, onRatio, onLoraPatch, onLoraAdd, onImageUpload }: {
  params: ImageGenerationParams | null;
  resources: ComfyResourceOptions;
  activeWorkflow: ImageWorkflowRecord | null;
  activeJob?: ImageGenerationJob;
  generating: boolean;
  onPatch: (patch: Partial<ImageGenerationParams>) => void;
  onRatio: (ratio: string) => void;
  onLoraPatch: (id: string, patch: Partial<ImageGenerationParams['loras'][number]>) => void;
  onLoraAdd: () => void;
  onImageUpload: (nodeId: string, file: File) => void;
}) {
  if (!params) {
    return (
      <div className="grid h-full place-items-center rounded-md border border-dashed border-[#D6CFC2] text-center text-sm text-[#8C8576] dark:border-white/[0.10] dark:text-[#A9A095]">
        上传工作流后显示参数
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PanelSection title="模型">
        <select
          value={params.checkpoint}
          onChange={(event) => onPatch({ checkpoint: event.target.value })}
          className="h-9 w-full rounded-md border border-[#DCD8CF] bg-[#FFFDF8] px-2 text-xs dark:border-white/[0.08] dark:bg-[#11100E]"
        >
          {selectOptions(resources.checkpoints, params.checkpoint).map((item) => (
            <option key={item} value={item}>{item}</option>
          ))}
        </select>
      </PanelSection>

      <PanelSection title="比例与尺寸">
        <div className="mb-2 flex flex-wrap gap-1.5">
          {RATIO_PRESETS.map((ratio) => (
            <button
              key={ratio}
              type="button"
              onClick={() => onRatio(ratio)}
              className="rounded-full border border-[#DCD8CF] bg-[#FFFDF8] px-2.5 py-1 text-xs font-semibold hover:border-[#D7663E] dark:border-white/[0.08] dark:bg-[#11100E]"
            >
              {ratio}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <NumberField label="宽度" value={params.width} onChange={(value) => onPatch({ width: value })} />
          <NumberField label="高度" value={params.height} onChange={(value) => onPatch({ height: value })} />
        </div>
      </PanelSection>

      <PanelSection title="采样参数">
        <div className="grid grid-cols-2 gap-2">
          <NumberField label="Seed" value={params.seed} onChange={(value) => onPatch({ seed: value })} />
          <NumberField label="步数" value={params.steps} onChange={(value) => onPatch({ steps: value })} />
          <NumberField label="CFG" value={params.cfg} step="0.1" onChange={(value) => onPatch({ cfg: value })} />
          <NumberField label="每批张数" value={params.batchSize} onChange={(value) => onPatch({ batchSize: value })} />
          <NumberField label="批次数" value={params.batchCount} onChange={(value) => onPatch({ batchCount: value })} />
        </div>
        <label className="mt-2 flex items-center gap-2 text-xs text-[#6E665A] dark:text-[#CFC7BA]">
          <input
            type="checkbox"
            checked={params.randomSeed}
            onChange={(event) => onPatch({ randomSeed: event.target.checked })}
          />
          每批使用随机 seed
        </label>
        <div className="mt-2 grid gap-2">
          <select
            value={params.samplerName}
            onChange={(event) => onPatch({ samplerName: event.target.value })}
            className="h-9 rounded-md border border-[#DCD8CF] bg-[#FFFDF8] px-2 text-xs dark:border-white/[0.08] dark:bg-[#11100E]"
          >
            {selectOptions(resources.samplers, params.samplerName).map((item) => (
              <option key={item} value={item}>{item}</option>
            ))}
          </select>
          <select
            value={params.scheduler}
            onChange={(event) => onPatch({ scheduler: event.target.value })}
            className="h-9 rounded-md border border-[#DCD8CF] bg-[#FFFDF8] px-2 text-xs dark:border-white/[0.08] dark:bg-[#11100E]"
          >
            {selectOptions(resources.schedulers, params.scheduler).map((item) => (
              <option key={item} value={item}>{item}</option>
            ))}
          </select>
        </div>
      </PanelSection>

      <PanelSection
        title="LoRA"
        action={(
          <button type="button" onClick={onLoraAdd} className="rounded-md border border-[#DCD8CF] p-1 hover:bg-[#EFE8DC] dark:border-white/[0.08]">
            <Plus className="h-3.5 w-3.5" />
          </button>
        )}
      >
        {params.loras.length === 0 ? (
          <div className="text-xs text-[#8C8576] dark:text-[#A9A095]">当前工作流没有 LoRA 节点</div>
        ) : (
          <div className="space-y-2">
            {params.loras.map((lora) => (
              <div key={lora.id} className="rounded-md border border-[#E3DFD6] bg-[#FFFDF8] p-2 dark:border-white/[0.08] dark:bg-[#11100E]">
                <div className="mb-2 flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={lora.enabled}
                    onChange={(event) => onLoraPatch(lora.id, { enabled: event.target.checked })}
                  />
                  <select
                    value={lora.name}
                    onChange={(event) => onLoraPatch(lora.id, { name: event.target.value, enabled: true })}
                    className="min-w-0 flex-1 rounded-md border border-[#DCD8CF] bg-[#FBFAF6] px-2 py-1 text-xs dark:border-white/[0.08] dark:bg-[#15130F]"
                  >
                    {selectOptions(resources.loras, lora.name).map((item) => (
                      <option key={item} value={item}>{item}</option>
                    ))}
                  </select>
                  <button type="button" onClick={() => onLoraPatch(lora.id, { enabled: false, strengthModel: 0, strengthClip: 0 })}>
                    <X className="h-4 w-4 text-[#8C8576]" />
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <NumberField label="模型强度" value={lora.strengthModel} step="0.05" onChange={(value) => onLoraPatch(lora.id, { strengthModel: value })} />
                  <NumberField label="CLIP 强度" value={lora.strengthClip} step="0.05" onChange={(value) => onLoraPatch(lora.id, { strengthClip: value })} />
                </div>
              </div>
            ))}
          </div>
        )}
      </PanelSection>

      <PanelSection title="图片输入">
        {params.imageInputs.length === 0 ? (
          <div className="text-xs text-[#8C8576] dark:text-[#A9A095]">当前工作流没有 LoadImage 节点</div>
        ) : (
          <div className="space-y-2">
            {params.imageInputs.map((input) => (
              <label key={input.nodeId} className="flex cursor-pointer items-center justify-between gap-2 rounded-md border border-[#DCD8CF] bg-[#FFFDF8] px-3 py-2 text-xs dark:border-white/[0.08] dark:bg-[#11100E]">
                <span className="min-w-0 truncate">节点 {input.nodeId} · {input.imageName || '未选择图片'}</span>
                <Upload className="h-4 w-4 flex-shrink-0 text-[#D7663E]" />
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    event.currentTarget.value = '';
                    if (file) void onImageUpload(input.nodeId, file);
                  }}
                />
              </label>
            ))}
          </div>
        )}
      </PanelSection>

      <PanelSection title="任务队列">
        <div className="rounded-md border border-[#DCD8CF] bg-[#FFFDF8] p-3 text-xs dark:border-white/[0.08] dark:bg-[#11100E]">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="font-semibold">{generating ? '生成中' : activeJob?.status === 'done' ? '最近完成' : '空闲'}</span>
            {generating && <Loader2 className="h-4 w-4 animate-spin text-[#D7663E]" />}
          </div>
          <div className="text-[#8C8576] dark:text-[#A9A095]">
            {activeJob?.promptId ? `prompt_id: ${activeJob.promptId}` : activeWorkflow ? `工作流：${activeWorkflow.name}` : '暂无任务'}
          </div>
        </div>
      </PanelSection>
    </div>
  );
}

function PanelSection({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-2 text-sm font-semibold">
        <span>{title}</span>
        {action}
      </div>
      {children}
    </section>
  );
}

function NumberField({ label, value, step = '1', onChange }: {
  label: string;
  value: number;
  step?: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="block rounded-md border border-[#DCD8CF] bg-[#FFFDF8] px-2 py-1.5 text-xs dark:border-white/[0.08] dark:bg-[#11100E]">
      <span className="text-[#8C8576] dark:text-[#A9A095]">{label}</span>
      <input
        type="number"
        step={step}
        value={Number.isFinite(value) ? value : 0}
        onChange={(event) => onChange(numberFromInput(event.target.value, value))}
        className="mt-0.5 w-full bg-transparent text-sm font-semibold outline-none"
      />
    </label>
  );
}

function ImageDetails({ image, onCopy }: { image: ImageOutputRecord | null; onCopy: (value: string) => Promise<void> }) {
  if (!image) {
    return (
      <aside className="rounded-md border border-[#DCD8CF] bg-[#FFFDF8] p-3 dark:border-white/[0.08] dark:bg-white/[0.04]">
        <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
          <ImageIcon className="h-4 w-4 text-[#D7663E]" />
          图片详情
        </div>
        <div className="text-xs text-[#8C8576] dark:text-[#A9A095]">选择图片后显示生成信息</div>
      </aside>
    );
  }

  const detailText = [
    `正提示词：${image.params.positivePrompt}`,
    `负提示词：${image.params.negativePrompt}`,
    `模型：${image.params.checkpoint}`,
    `尺寸：${image.params.width}x${image.params.height}`,
    `Seed：${image.params.seed}`,
    `Steps：${image.params.steps}`,
    `CFG：${image.params.cfg}`,
    `Sampler：${image.params.samplerName}`,
    `Scheduler：${image.params.scheduler}`,
    `Workflow：${image.workflowName}`,
  ].join('\n');

  return (
    <aside className="rounded-md border border-[#DCD8CF] bg-[#FFFDF8] p-3 dark:border-white/[0.08] dark:bg-white/[0.04]">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2 text-sm font-semibold">
          <ImageIcon className="h-4 w-4 flex-shrink-0 text-[#D7663E]" />
          <span className="truncate">图片详情</span>
        </div>
        <button type="button" onClick={() => void onCopy(detailText)} className="rounded-md border border-[#DCD8CF] p-1.5 hover:bg-[#F1EEE7] dark:border-white/[0.08]">
          <Copy className="h-3.5 w-3.5" />
        </button>
      </div>
      <img src={image.url} alt={image.image.filename} className="mb-3 aspect-square w-full rounded-md object-cover" />
      <div className="space-y-1.5 text-xs">
        <DetailLine label="模型" value={shortText(image.params.checkpoint)} />
        <DetailLine label="尺寸" value={`${image.params.width} × ${image.params.height}`} />
        <DetailLine label="Seed" value={String(image.params.seed)} />
        <DetailLine label="采样" value={shortText(image.params.samplerName)} />
        <DetailLine label="步数 / CFG" value={`${image.params.steps} / ${image.params.cfg}`} />
        <DetailLine label="工作流" value={shortText(image.workflowName)} />
      </div>
    </aside>
  );
}

function DetailLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-[#E7E0D5] py-1.5 last:border-b-0 dark:border-white/[0.08]">
      <span className="text-[#8C8576] dark:text-[#A9A095]">{label}</span>
      <span className="min-w-0 truncate font-semibold">{value}</span>
    </div>
  );
}
