import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Download,
  Image,
  KeyRound,
  Loader2,
  LockKeyhole,
  Sparkles,
  Trash2,
  UploadCloud,
  WandSparkles,
  X,
} from 'lucide-react';
import {
  deleteImageApiKey,
  generateImage,
  getImageApiKeyStatus,
  isDesktopRuntime,
  saveImageApiKey,
  type GeneratedImage,
  type ImageInputPayload,
} from '@/lib/desktop';

type ProviderId = 'siliconflow' | 'newapi-openai' | 'newapi-gemini-native' | 'newapi-gemini-openai' | 'comfyui-local' | 'comfyui-lan';
type ImageMode = 'generate' | 'edit';

interface ProviderDefinition {
  id: ProviderId;
  name: string;
  shortName: string;
  tone: string;
  defaultBaseUrl: string;
  defaultModel: string;
  supportsEdit: boolean;
  supportsReference: boolean;
  kind: 'siliconflow' | 'openai' | 'gemini' | 'comfyui';
}

interface ImageSettings {
  baseUrl: string;
  model: string;
  mode: ImageMode;
  size: string;
  aspectRatio: string;
  n: number;
  quality: string;
  style: string;
  responseFormat: string;
  seed: string;
  steps: number;
  guidanceScale: number;
  negativePrompt: string;
  workflowJson: string;
}

interface ReferenceImage extends ImageInputPayload {
  id: string;
  sizeBytes: number;
  previewUrl: string;
}

interface GeneratedRecord {
  id: string;
  providerId: ProviderId;
  providerName: string;
  model: string;
  prompt: string;
  createdAt: number;
  images: GeneratedImage[];
  text?: string | null;
  usage?: unknown;
}

const PROVIDERS: ProviderDefinition[] = [
  {
    id: 'siliconflow',
    name: '硅基流动',
    shortName: 'SiliconFlow',
    tone: '#D7663E',
    defaultBaseUrl: 'https://api.siliconflow.cn/v1',
    defaultModel: 'Kwai-Kolors/Kolors',
    supportsEdit: true,
    supportsReference: true,
    kind: 'siliconflow',
  },
  {
    id: 'newapi-openai',
    name: 'New API · OpenAI 图像',
    shortName: 'OpenAI',
    tone: '#5D6BBA',
    defaultBaseUrl: 'https://your-newapi-domain/v1',
    defaultModel: 'gpt-image-1',
    supportsEdit: true,
    supportsReference: true,
    kind: 'openai',
  },
  {
    id: 'newapi-gemini-native',
    name: 'New API · Gemini 原生',
    shortName: 'Gemini Native',
    tone: '#2F8C6F',
    defaultBaseUrl: 'https://your-newapi-domain/gemini/v1beta',
    defaultModel: 'gemini-2.5-flash-image-preview',
    supportsEdit: true,
    supportsReference: true,
    kind: 'gemini',
  },
  {
    id: 'newapi-gemini-openai',
    name: 'New API · Gemini OpenAI',
    shortName: 'Gemini Chat',
    tone: '#8B6F35',
    defaultBaseUrl: 'https://your-newapi-domain/v1',
    defaultModel: 'gemini-2.5-flash-image-preview',
    supportsEdit: true,
    supportsReference: true,
    kind: 'gemini',
  },
  {
    id: 'comfyui-local',
    name: 'ComfyUI 本机',
    shortName: 'Comfy 本机',
    tone: '#6F6AB8',
    defaultBaseUrl: 'http://127.0.0.1:8188',
    defaultModel: 'sd_xl_base_1.0.safetensors',
    supportsEdit: false,
    supportsReference: false,
    kind: 'comfyui',
  },
  {
    id: 'comfyui-lan',
    name: 'ComfyUI 局域网',
    shortName: 'Comfy 局域网',
    tone: '#2C7D89',
    defaultBaseUrl: 'http://192.168.1.10:8188',
    defaultModel: 'sd_xl_base_1.0.safetensors',
    supportsEdit: false,
    supportsReference: false,
    kind: 'comfyui',
  },
];

const STORAGE_KEY = 'agent-llm-image-settings-v1';
const MAX_REFERENCE_BYTES = 8 * 1024 * 1024;
const DEFAULT_SIZE_OPTIONS = ['1024x1024', '1024x1536', '1536x1024', '512x512', 'auto'];
const SILICONFLOW_KOLORS_SIZE_OPTIONS = ['1024x1024', '960x1280', '768x1024', '720x1440', '720x1280'];
const SILICONFLOW_QWEN_IMAGE_SIZE_OPTIONS = [
  '1328x1328',
  '1664x928',
  '928x1664',
  '1472x1140',
  '1140x1472',
  '1584x1056',
  '1056x1584',
];

function defaultSettings(provider: ProviderDefinition): ImageSettings {
  return {
    baseUrl: provider.defaultBaseUrl,
    model: provider.defaultModel,
    mode: 'generate',
    size: '1024x1024',
    aspectRatio: '1:1',
    n: 1,
    quality: 'auto',
    style: 'auto',
    responseFormat: provider.kind === 'openai' ? 'b64_json' : 'url',
    seed: '',
    steps: 20,
    guidanceScale: 7.5,
    negativePrompt: '',
    workflowJson: '',
  };
}

function defaultSettingsByProvider(): Record<ProviderId, ImageSettings> {
  return Object.fromEntries(PROVIDERS.map((provider) => [provider.id, defaultSettings(provider)])) as Record<ProviderId, ImageSettings>;
}

function loadSavedSettings() {
  if (typeof window === 'undefined') {
    return { providerId: 'siliconflow' as ProviderId, settings: defaultSettingsByProvider() };
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { providerId: 'siliconflow' as ProviderId, settings: defaultSettingsByProvider() };
    const parsed = JSON.parse(raw) as { providerId?: ProviderId; settings?: Partial<Record<ProviderId, Partial<ImageSettings>>> };
    const defaults = defaultSettingsByProvider();
    for (const provider of PROVIDERS) {
      defaults[provider.id] = { ...defaults[provider.id], ...(parsed.settings?.[provider.id] ?? {}) };
    }
    return {
      providerId: PROVIDERS.some((provider) => provider.id === parsed.providerId) ? parsed.providerId as ProviderId : 'siliconflow',
      settings: defaults,
    };
  } catch {
    return { providerId: 'siliconflow' as ProviderId, settings: defaultSettingsByProvider() };
  }
}

function formatFileSize(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function imageSource(image: GeneratedImage) {
  if (image.url) return image.url;
  if (image.b64Json) return `data:${image.mimeType || 'image/png'};base64,${image.b64Json}`;
  return '';
}

function parseSeed(value: string) {
  const seed = Number(value);
  return Number.isFinite(seed) ? Math.round(seed) : null;
}

function normalizedModelName(model: string) {
  return model.trim().toLowerCase();
}

function isKolorsModel(model: string) {
  return normalizedModelName(model).includes('kolors');
}

function isQwenImageModel(model: string) {
  const normalized = normalizedModelName(model);
  return normalized.includes('qwen') && normalized.includes('image');
}

function isQwenImageEditModel(model: string) {
  return isQwenImageModel(model) && normalizedModelName(model).includes('edit');
}

function sizeOptionsFor(provider: ProviderDefinition, model: string) {
  if (provider.id !== 'siliconflow') return DEFAULT_SIZE_OPTIONS;
  if (isQwenImageModel(model)) return SILICONFLOW_QWEN_IMAGE_SIZE_OPTIONS;
  return SILICONFLOW_KOLORS_SIZE_OPTIONS;
}

function optionsWithCurrent(options: string[], current: string) {
  if (!current || options.includes(current)) return options;
  return [current, ...options];
}

function readReferenceFile(file: File): Promise<ReferenceImage> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) {
      reject(new Error(`${file.name} 不是图片文件`));
      return;
    }
    if (file.size > MAX_REFERENCE_BYTES) {
      reject(new Error(`${file.name} 超过 ${formatFileSize(MAX_REFERENCE_BYTES)} 限制`));
      return;
    }

    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`${file.name} 读取失败`));
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      const [, dataBase64 = ''] = dataUrl.split(',');
      resolve({
        id: `${file.name}-${file.lastModified}-${file.size}`,
        name: file.name,
        mimeType: file.type || 'image/png',
        dataBase64,
        sizeBytes: file.size,
        previewUrl: dataUrl,
      });
    };
    reader.readAsDataURL(file);
  });
}

function createGeneratedRecord(params: {
  providerId: ProviderId;
  providerName: string;
  model: string;
  prompt: string;
  images: GeneratedImage[];
  text?: string | null;
  usage?: unknown;
}): GeneratedRecord {
  const createdAt = Date.now();
  return {
    id: `image-${createdAt}`,
    providerId: params.providerId,
    providerName: params.providerName,
    model: params.model,
    prompt: params.prompt,
    createdAt,
    images: params.images,
    text: params.text,
    usage: params.usage,
  };
}

export default function ImagePage() {
  const saved = useMemo(() => loadSavedSettings(), []);
  const [providerId, setProviderId] = useState<ProviderId>(saved.providerId);
  const [settingsByProvider, setSettingsByProvider] = useState<Record<ProviderId, ImageSettings>>(saved.settings);
  const [prompt, setPrompt] = useState('');
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [hasSavedKey, setHasSavedKey] = useState(false);
  const [keyMessage, setKeyMessage] = useState<string | null>(null);
  const [references, setReferences] = useState<ReferenceImage[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [records, setRecords] = useState<GeneratedRecord[]>([]);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const provider = PROVIDERS.find((item) => item.id === providerId) ?? PROVIDERS[0];
  const settings = settingsByProvider[providerId];
  const desktopReady = isDesktopRuntime();
  const effectiveMode: ImageMode = provider.supportsEdit ? settings.mode : 'generate';
  const apiKeyRequired = provider.kind !== 'comfyui';
  const siliconflowKolors = provider.id === 'siliconflow' && isKolorsModel(settings.model);
  const siliconflowQwenImage = provider.id === 'siliconflow' && isQwenImageModel(settings.model);
  const siliconflowQwenEdit = provider.id === 'siliconflow' && isQwenImageEditModel(settings.model);
  const canUseReferences = provider.supportsReference && (
    provider.id === 'siliconflow'
      ? siliconflowKolors || siliconflowQwenEdit
      : provider.kind !== 'openai' || effectiveMode === 'edit'
  );
  const showSizeField = (provider.id !== 'siliconflow' || !siliconflowQwenEdit) && provider.kind !== 'comfyui';
  const showCountField = provider.kind !== 'comfyui' && (provider.id !== 'siliconflow' || siliconflowKolors);
  const sizeOptions = optionsWithCurrent(sizeOptionsFor(provider, settings.model), settings.size);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ providerId, settings: settingsByProvider }));
  }, [providerId, settingsByProvider]);

  useEffect(() => {
    if (!apiKeyRequired) {
      return;
    }
    let cancelled = false;
    void getImageApiKeyStatus(providerId).then((status) => {
      if (!cancelled) setHasSavedKey(status.hasKey);
    });
    return () => {
      cancelled = true;
    };
  }, [apiKeyRequired, providerId]);

  const updateSettings = (patch: Partial<ImageSettings>) => {
    setSettingsByProvider((current) => ({
      ...current,
      [providerId]: { ...current[providerId], ...patch },
    }));
  };

  const handleProviderChange = (nextProviderId: ProviderId) => {
    setProviderId(nextProviderId);
    setApiKeyInput('');
    setKeyMessage(null);
  };

  const handleSaveKey = async () => {
    if (!apiKeyRequired) {
      setKeyMessage('ComfyUI 使用 Base URL 连接，无需 API Key。');
      return true;
    }
    if (!desktopReady) {
      setKeyMessage('请在桌面版中保存 API Key。');
      return false;
    }
    try {
      await saveImageApiKey(providerId, apiKeyInput);
      setHasSavedKey(true);
      setApiKeyInput('');
      setKeyMessage('密钥已加密保存到系统凭据库。');
      return true;
    } catch (error) {
      setKeyMessage(`保存失败：${String(error)}`);
      return false;
    }
  };

  const handleDeleteKey = async () => {
    if (!apiKeyRequired) {
      setApiKeyInput('');
      setKeyMessage('ComfyUI 没有保存的 API Key。');
      return;
    }
    if (!desktopReady) {
      setKeyMessage('请在桌面版中管理 API Key。');
      return;
    }
    await deleteImageApiKey(providerId);
    setHasSavedKey(false);
    setApiKeyInput('');
    setKeyMessage('已删除保存的密钥。');
  };

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setMessage(null);
    try {
      const next = await Promise.all(Array.from(files).map(readReferenceFile));
      setReferences((current) => [...current, ...next].slice(0, 8));
    } catch (error) {
      setMessage(String(error instanceof Error ? error.message : error));
    }
  };

  const handleGenerate = async () => {
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) {
      setMessage('请输入提示词。');
      return;
    }
    if (apiKeyRequired) {
      let keyReady = hasSavedKey;
      if (!keyReady && apiKeyInput.trim()) {
        keyReady = await handleSaveKey();
      }
      if (!keyReady) {
        setMessage('请先保存当前供应商的 API Key。');
        return;
      }
    }

    setIsGenerating(true);
    setMessage('正在请求图像模型...');
    try {
      const response = await generateImage({
        providerId,
        baseUrl: settings.baseUrl,
        model: settings.model,
        prompt: trimmedPrompt,
        negativePrompt: settings.negativePrompt,
        mode: effectiveMode,
        size: settings.size,
        aspectRatio: settings.aspectRatio,
        n: settings.n,
        quality: settings.quality,
        style: settings.style,
        responseFormat: settings.responseFormat,
        seed: parseSeed(settings.seed),
        steps: settings.steps,
        guidanceScale: settings.guidanceScale,
        workflowJson: settings.workflowJson,
        images: canUseReferences ? references.map(({ name, mimeType, dataBase64 }) => ({ name, mimeType, dataBase64 })) : [],
      });

      const record = createGeneratedRecord({
        providerId,
        providerName: provider.name,
        model: response.model,
        prompt: trimmedPrompt,
        images: response.images,
        text: response.text,
        usage: response.usage,
      });
      setRecords((current) => [record, ...current].slice(0, 24));
      setMessage(response.images.length > 0 ? `生成完成，共 ${response.images.length} 张。` : '请求完成，但响应中没有解析到图片。');
    } catch (error) {
      setMessage(`生成失败：${String(error instanceof Error ? error.message : error)}`);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleCopy = async (id: string, image: GeneratedImage) => {
    const src = imageSource(image);
    if (!src) return;
    await navigator.clipboard.writeText(src);
    setCopiedId(id);
    window.setTimeout(() => setCopiedId(null), 1600);
  };

  const handleDownload = (record: GeneratedRecord, image: GeneratedImage, index: number) => {
    const src = imageSource(image);
    if (!src) return;
    const link = document.createElement('a');
    link.href = src;
    link.download = `${record.providerId}-${record.createdAt}-${index + 1}.png`;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.click();
  };

  return (
    <div className="flex h-full flex-1 flex-col overflow-hidden bg-[#FBFAF6] text-[#2F2C26] dark:bg-[#171512] dark:text-[#F3EBDD]">
      <div className="flex-shrink-0 border-b border-[#E7E2D8] bg-[#FBFAF6] px-5 py-4 dark:border-white/[0.08] dark:bg-[#171512]">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-[#D7663E]">
              <WandSparkles className="h-4 w-4" />
              Image Studio
            </div>
            <h1 className="truncate text-2xl font-bold text-[#2F2C26]">生图工作台</h1>
          </div>
          <div className="flex flex-wrap gap-2">
            {PROVIDERS.map((item) => {
              const selected = providerId === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => handleProviderChange(item.id)}
                  className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${
                    selected ? 'border-transparent text-white' : 'border-[#DCD8CF] bg-[#FAF9F5] text-[#625B50] hover:bg-[#F1EEE7]'
                  }`}
                  style={selected ? { background: item.tone } : undefined}
                >
                  {item.shortName}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        <div className="grid min-h-full grid-cols-1 gap-4 xl:grid-cols-[420px_minmax(0,1fr)]">
          <section className="space-y-4">
            <Panel>
              <div className="mb-4 flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-[#2F2C26]">{provider.name}</div>
                  <div className="mt-1 text-xs text-[#8C8576]">
                    {apiKeyRequired ? (hasSavedKey ? 'API Key 已保存' : '未保存 API Key') : '通过 ComfyUI HTTP API 连接'}
                  </div>
                </div>
                <div className={`flex h-9 w-9 items-center justify-center rounded-md ${hasSavedKey || !apiKeyRequired ? 'bg-[#EEF8F2] text-[#2C8B58]' : 'bg-[#F8EDE7] text-[#D7663E]'}`}>
                  {hasSavedKey || !apiKeyRequired ? <CheckCircle2 className="h-4 w-4" /> : <LockKeyhole className="h-4 w-4" />}
                </div>
              </div>

              <Field label="Base URL">
                <input
                  value={settings.baseUrl}
                  onChange={(event) => updateSettings({ baseUrl: event.target.value })}
                  className="form-input mono-font"
                />
              </Field>

              {apiKeyRequired ? (
                <Field label="API Key">
                  <div className="flex gap-2">
                    <div className="relative min-w-0 flex-1">
                      <KeyRound className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#9B9485]" />
                      <input
                        type="password"
                        value={apiKeyInput}
                        onChange={(event) => setApiKeyInput(event.target.value)}
                        placeholder={hasSavedKey ? '已加密保存，输入新 key 可覆盖' : '输入后保存到系统凭据库'}
                        className="form-input pl-9"
                      />
                    </div>
                    <button onClick={() => void handleSaveKey()} className="action-button bg-[#D7663E] text-white hover:bg-[#C65D37]">
                      保存
                    </button>
                    <button onClick={() => void handleDeleteKey()} className="icon-button" title="删除密钥">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </Field>
              ) : (
                <div className="rounded-md border border-[#DCD8CF] bg-[#F8F6F1] px-3 py-2 text-xs text-[#625B50]">
                  ComfyUI 无需 API Key；本机默认 127.0.0.1:8188，局域网地址可在 Base URL 中改成目标机器 IP。
                </div>
              )}

              {keyMessage && <StatusLine message={keyMessage} tone={keyMessage.includes('失败') ? 'error' : 'ok'} />}
            </Panel>

            <Panel>
              <div className="mb-4 flex items-center justify-between gap-3">
                <div className="text-sm font-semibold text-[#2F2C26]">生成参数</div>
                <Sparkles className="h-4 w-4 text-[#D7663E]" />
              </div>

              <Field label="模型">
                <input
                  value={settings.model}
                  onChange={(event) => updateSettings({ model: event.target.value })}
                  className="form-input mono-font"
                />
              </Field>

              {provider.kind === 'comfyui' && (
                <Field label="Workflow JSON">
                  <textarea
                    value={settings.workflowJson}
                    onChange={(event) => updateSettings({ workflowJson: event.target.value })}
                    rows={5}
                    placeholder="可留空使用默认工作流；自定义 JSON 支持 {{prompt}} / {{negativePrompt}} / {{model}} 占位符"
                    className="form-input mono-font resize-y leading-5"
                  />
                </Field>
              )}

              {provider.supportsEdit && (
                <div className="mb-3 grid grid-cols-2 gap-2 rounded-md border border-[#DCD8CF] bg-[#F8F6F1] p-1">
                  {(['generate', 'edit'] as ImageMode[]).map((mode) => (
                    <button
                      key={mode}
                      onClick={() => updateSettings({ mode })}
                      className={`rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                        effectiveMode === mode ? 'bg-[#E7E1D5] text-[#D7663E]' : 'text-[#625B50] hover:bg-[#EEEAE2]'
                      }`}
                    >
                      {mode === 'generate' ? '文生图' : '图像编辑'}
                    </button>
                  ))}
                </div>
              )}

              <Field label="提示词">
                <textarea
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  rows={6}
                  placeholder="描述画面主体、风格、光线、构图和细节"
                  className="form-input resize-none leading-6"
                />
              </Field>

              {provider.kind === 'siliconflow' && (
                <Field label="反向提示词">
                  <input
                    value={settings.negativePrompt}
                    onChange={(event) => updateSettings({ negativePrompt: event.target.value })}
                    placeholder="不希望出现的内容"
                    className="form-input"
                  />
                </Field>
              )}

              <div className="grid grid-cols-2 gap-3">
                {showSizeField && (
                  <Field label={provider.kind === 'gemini' ? '图像尺寸' : '尺寸'}>
                    <select value={settings.size} onChange={(event) => updateSettings({ size: event.target.value })} className="form-input">
                      {sizeOptions.map((size) => (
                        <option key={size} value={size}>{size}</option>
                      ))}
                    </select>
                  </Field>
                )}
                {showCountField && (
                  <Field label="数量">
                    <input
                      type="number"
                      min={1}
                      max={provider.kind === 'siliconflow' ? 4 : 10}
                      value={settings.n}
                      onChange={(event) => updateSettings({ n: Math.max(1, Math.min(provider.kind === 'siliconflow' ? 4 : 10, Number(event.target.value) || 1)) })}
                      className="form-input text-right mono-font"
                    />
                  </Field>
                )}
                {provider.kind === 'gemini' && (
                  <Field label="比例">
                    <select value={settings.aspectRatio} onChange={(event) => updateSettings({ aspectRatio: event.target.value })} className="form-input">
                      <option value="1:1">1:1</option>
                      <option value="16:9">16:9</option>
                      <option value="9:16">9:16</option>
                      <option value="4:3">4:3</option>
                      <option value="3:4">3:4</option>
                    </select>
                  </Field>
                )}
                {provider.kind === 'openai' && (
                  <>
                    <Field label="质量">
                      <select value={settings.quality} onChange={(event) => updateSettings({ quality: event.target.value })} className="form-input">
                        <option value="auto">auto</option>
                        <option value="low">low</option>
                        <option value="medium">medium</option>
                        <option value="high">high</option>
                        <option value="standard">standard</option>
                        <option value="hd">hd</option>
                      </select>
                    </Field>
                    <Field label="返回">
                      <select value={settings.responseFormat} onChange={(event) => updateSettings({ responseFormat: event.target.value })} className="form-input">
                        <option value="b64_json">b64_json</option>
                        <option value="url">url</option>
                      </select>
                    </Field>
                  </>
                )}
                {provider.kind === 'siliconflow' && (
                  <>
                    <Field label="步数">
                      <input
                        type="number"
                        min={1}
                        max={100}
                        value={settings.steps}
                        onChange={(event) => updateSettings({ steps: Number(event.target.value) || 20 })}
                        className="form-input text-right mono-font"
                      />
                    </Field>
                    {(siliconflowKolors || siliconflowQwenImage) && (
                      <Field label={siliconflowQwenImage ? 'CFG' : 'Guidance'}>
                        <input
                          type="number"
                          min={0}
                          step={0.5}
                          value={settings.guidanceScale}
                          onChange={(event) => updateSettings({ guidanceScale: Number(event.target.value) || 0 })}
                          className="form-input text-right mono-font"
                        />
                      </Field>
                    )}
                  </>
                )}
                {provider.kind === 'comfyui' && (
                  <>
                    <Field label="尺寸">
                      <input
                        value={settings.size}
                        onChange={(event) => updateSettings({ size: event.target.value })}
                        placeholder="1024x1024"
                        className="form-input text-right mono-font"
                      />
                    </Field>
                    <Field label="步数">
                      <input
                        type="number"
                        min={1}
                        max={150}
                        value={settings.steps}
                        onChange={(event) => updateSettings({ steps: Number(event.target.value) || 20 })}
                        className="form-input text-right mono-font"
                      />
                    </Field>
                    <Field label="CFG">
                      <input
                        type="number"
                        min={0}
                        step={0.5}
                        value={settings.guidanceScale}
                        onChange={(event) => updateSettings({ guidanceScale: Number(event.target.value) || 0 })}
                        className="form-input text-right mono-font"
                      />
                    </Field>
                  </>
                )}
                <Field label="Seed">
                  <input
                    value={settings.seed}
                    onChange={(event) => updateSettings({ seed: event.target.value })}
                    placeholder="随机"
                    className="form-input text-right mono-font"
                  />
                </Field>
              </div>
            </Panel>

            <Panel>
              <div className="mb-3 flex items-center justify-between">
                <div className="text-sm font-semibold text-[#2F2C26]">参考图</div>
                {references.length > 0 && (
                  <button onClick={() => setReferences([])} className="text-xs text-[#C44E36] hover:underline">
                    清空
                  </button>
                )}
              </div>
              <label className={`flex min-h-[92px] cursor-pointer flex-col items-center justify-center rounded-md border border-dashed px-4 py-5 text-center transition-colors ${
                canUseReferences ? 'border-[#D8D2C5] bg-[#FBFAF6] hover:bg-[#F5F1E9]' : 'border-[#E3DED3] bg-[#F8F6F1] opacity-55'
              }`}>
                <UploadCloud className="mb-2 h-5 w-5 text-[#9B9485]" />
                <span className="text-sm font-medium text-[#403C32]">{canUseReferences ? '上传 PNG/JPG/WebP' : '当前模式不使用参考图'}</span>
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  disabled={!canUseReferences}
                  className="hidden"
                  onChange={(event) => {
                    void handleFiles(event.target.files);
                    event.target.value = '';
                  }}
                />
              </label>
              {references.length > 0 && (
                <div className="mt-3 grid grid-cols-4 gap-2">
                  {references.map((item) => (
                    <div key={item.id} className="group relative aspect-square overflow-hidden rounded-md border border-[#DDD8CC] bg-[#F8F6F1]">
                      <img src={item.previewUrl} alt={item.name} className="h-full w-full object-cover" />
                      <button
                        onClick={() => setReferences((current) => current.filter((image) => image.id !== item.id))}
                        className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full bg-black/55 text-white opacity-0 transition-opacity group-hover:opacity-100"
                        title="移除"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </Panel>

            <button
              onClick={() => void handleGenerate()}
              disabled={isGenerating}
              className="flex h-11 w-full items-center justify-center gap-2 rounded-md bg-[#D7663E] px-4 text-sm font-semibold text-white transition-colors hover:bg-[#C65D37] disabled:opacity-60"
            >
              {isGenerating ? <Loader2 className="h-4 w-4 animate-spin" /> : <WandSparkles className="h-4 w-4" />}
              {isGenerating ? '生成中' : '开始生图'}
            </button>
          </section>

          <section className="min-w-0 rounded-md border border-[#E2DFD6] bg-[#FAF9F5] dark:border-white/[0.08] dark:bg-[#15130F]">
            <div className="flex items-center justify-between gap-3 border-b border-[#E2DFD6] px-4 py-3 dark:border-white/[0.08]">
              <div>
                <div className="text-sm font-semibold text-[#2F2C26]">输出结果</div>
                <div className="mt-0.5 text-xs text-[#8C8576]">{records.length > 0 ? `${records.length} 条记录` : '等待生成'}</div>
              </div>
              {message && <StatusLine message={message} tone={message.includes('失败') || message.includes('没有') ? 'error' : 'ok'} compact />}
            </div>

            <div className="min-h-[520px] p-4">
              {records.length === 0 ? (
                <div className="flex min-h-[480px] items-center justify-center rounded-md border border-dashed border-[#DDD8CC] bg-[#FBFAF6]">
                  <div className="text-center">
                    <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-[#EDE7DD] text-[#D7663E]">
                      <Image className="h-6 w-6" />
                    </div>
                    <div className="text-sm font-semibold text-[#403C32]">还没有生成结果</div>
                    <div className="mt-1 text-xs text-[#8C8576]">保存密钥后输入提示词即可开始</div>
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  {records.map((record) => (
                    <div key={record.id} className="rounded-md border border-[#E2DFD6] bg-[#FBFAF6] p-3">
                      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2 text-xs text-[#8C8576]">
                            <span className="rounded-full bg-[#EFEAE0] px-2 py-0.5 font-semibold text-[#625B50]">{record.providerName}</span>
                            <span className="mono-font">{record.model}</span>
                            <span>{new Date(record.createdAt).toLocaleTimeString('zh-CN', { hour12: false })}</span>
                          </div>
                          <div className="mt-2 line-clamp-2 text-sm leading-6 text-[#403C32]">{record.prompt}</div>
                        </div>
                      </div>

                      {record.text && (
                        <div className="mb-3 rounded-md border border-[#E2DFD6] bg-[#F8F6F1] px-3 py-2 text-xs leading-5 text-[#625B50]">
                          {record.text}
                        </div>
                      )}

                      {record.images.length > 0 ? (
                        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-3">
                          {record.images.map((imageItem, imageIndex) => {
                            const src = imageSource(imageItem);
                            const imageId = `${record.id}-${imageIndex}`;
                            return (
                              <div key={imageId} className="group overflow-hidden rounded-md border border-[#DDD8CC] bg-[#F8F6F1]">
                                {src ? (
                                  <img src={src} alt={`generated-${imageIndex + 1}`} className="aspect-square w-full object-cover" />
                                ) : (
                                  <div className="flex aspect-square items-center justify-center text-xs text-[#8C8576]">无法预览</div>
                                )}
                                <div className="flex items-center justify-between gap-2 px-2 py-2">
                                  <span className="mono-font truncate text-[11px] text-[#8C8576]">{imageItem.mimeType || (imageItem.url ? 'url' : 'base64')}</span>
                                  <div className="flex gap-1">
                                    <button onClick={() => void handleCopy(imageId, imageItem)} className="icon-button h-8 w-8" title="复制地址">
                                      {copiedId === imageId ? <CheckCircle2 className="h-4 w-4 text-[#2C8B58]" /> : <Copy className="h-4 w-4" />}
                                    </button>
                                    <button onClick={() => handleDownload(record, imageItem, imageIndex)} className="icon-button h-8 w-8" title="下载/打开">
                                      <Download className="h-4 w-4" />
                                    </button>
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <div className="rounded-md border border-[#E8C9BD] bg-[#F8EDE7] px-3 py-2 text-sm text-[#C44E36]">
                          响应中没有可展示图片，可检查模型是否支持图像输出。
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-[#E2DFD6] bg-[#FAF9F5] p-4 shadow-[0_1px_2px_rgba(64,60,50,0.04)] dark:border-white/[0.08] dark:bg-[#15130F] dark:shadow-[0_12px_32px_rgba(0,0,0,0.22)]">
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="mb-3 block">
      <span className="mb-1.5 block text-xs font-semibold text-[#756E61] dark:text-[#BDB4A7]">{label}</span>
      {children}
    </label>
  );
}

function StatusLine({ message, tone, compact = false }: { message: string; tone: 'ok' | 'error'; compact?: boolean }) {
  const Icon = tone === 'ok' ? CheckCircle2 : AlertTriangle;
  return (
    <div className={`flex min-w-0 items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs ${
      tone === 'ok' ? 'border-[#CFEADA] bg-[#EEF8F2] text-[#2C8B58]' : 'border-[#E8C9BD] bg-[#F8EDE7] text-[#C44E36]'
    } ${compact ? 'max-w-[320px]' : 'mt-3'}`}>
      <Icon className="h-3.5 w-3.5 flex-shrink-0" />
      <span className="truncate">{message}</span>
    </div>
  );
}
