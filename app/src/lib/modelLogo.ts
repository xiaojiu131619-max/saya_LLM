import type { IconType } from '@lobehub/icons';

// 品牌图标按变体组件的深路径引入，而不是从包根引入：
// 根导出的组合式图标（如 `import { Qwen }`）在模块加载时会挂载
// Avatar / Combine 变体，它们内部依赖 antd 与 @lobehub/ui，
// 会把整套组件库带进桌面端的安装包；深路径只包含纯 SVG 组件。
import Ai2Color from '@lobehub/icons/es/Ai2/components/Color';
import BaichuanColor from '@lobehub/icons/es/Baichuan/components/Color';
import CohereColor from '@lobehub/icons/es/Cohere/components/Color';
import DeepSeekColor from '@lobehub/icons/es/DeepSeek/components/Color';
import DoubaoColor from '@lobehub/icons/es/Doubao/components/Color';
import GemmaColor from '@lobehub/icons/es/Gemma/components/Color';
import GeminiColor from '@lobehub/icons/es/Gemini/components/Color';
import GrokMono from '@lobehub/icons/es/Grok/components/Mono';
import HuggingFaceColor from '@lobehub/icons/es/HuggingFace/components/Color';
import HunyuanColor from '@lobehub/icons/es/Hunyuan/components/Color';
import IBMMono from '@lobehub/icons/es/IBM/components/Mono';
import InternLMColor from '@lobehub/icons/es/InternLM/components/Color';
import KimiColor from '@lobehub/icons/es/Kimi/components/Color';
import LGColor from '@lobehub/icons/es/LG/components/Color';
import LongCatColor from '@lobehub/icons/es/LongCat/components/Color';
import MetaColor from '@lobehub/icons/es/Meta/components/Color';
import MicrosoftColor from '@lobehub/icons/es/Microsoft/components/Color';
import MinimaxColor from '@lobehub/icons/es/Minimax/components/Color';
import MistralColor from '@lobehub/icons/es/Mistral/components/Color';
import NvidiaColor from '@lobehub/icons/es/Nvidia/components/Color';
import OpenAIMono from '@lobehub/icons/es/OpenAI/components/Mono';
import QwenColor from '@lobehub/icons/es/Qwen/components/Color';
import SenseNovaColor from '@lobehub/icons/es/SenseNova/components/Color';
import SparkColor from '@lobehub/icons/es/Spark/components/Color';
import StabilityColor from '@lobehub/icons/es/Stability/components/Color';
import StepfunMono from '@lobehub/icons/es/Stepfun/components/Mono';
import TIIColor from '@lobehub/icons/es/TII/components/Color';
import WenxinColor from '@lobehub/icons/es/Wenxin/components/Color';
import XAIMono from '@lobehub/icons/es/XAI/components/Mono';
import XiaomiMiMoMono from '@lobehub/icons/es/XiaomiMiMo/components/Mono';
import YiColor from '@lobehub/icons/es/Yi/components/Color';
import ZhipuColor from '@lobehub/icons/es/Zhipu/components/Color';

interface BrandRule {
  /** 对「家族 + 架构 + 名称」拼接文本（已转小写）做匹配 */
  pattern: RegExp;
  icon: IconType;
  /** mono = 单色图标，使用 currentColor，需要调用方传 tone 着色 */
  mono?: boolean;
}

// 命中顺序即优先级：更独特的品牌关键词放在前面，避免被宽泛关键词抢先命中。
const BRAND_RULES: BrandRule[] = [
  { pattern: /deepseek/, icon: DeepSeekColor },
  { pattern: /qwen|qwq|qvq/, icon: QwenColor },
  { pattern: /glm|zhipu|chatglm|cogview|cogvideo/, icon: ZhipuColor },
  { pattern: /kimi|moonshot/, icon: KimiColor },
  { pattern: /gemma/, icon: GemmaColor },
  { pattern: /llama/, icon: MetaColor },
  { pattern: /mistral|mixtral|ministral|codestral|pixtral|magistral|devstral/, icon: MistralColor },
  { pattern: /\bphi\b|\bphi[-_.]?\d/, icon: MicrosoftColor },
  { pattern: /\byi\b|\byi[-_.]?\d/, icon: YiColor },
  { pattern: /minimax|abab/, icon: MinimaxColor },
  { pattern: /baichuan/, icon: BaichuanColor },
  { pattern: /internlm/, icon: InternLMColor },
  { pattern: /hunyuan/, icon: HunyuanColor },
  { pattern: /doubao/, icon: DoubaoColor },
  { pattern: /gpt[-_.]?(oss|[1-9])|\bgpt\b|openai|\bo[1-9]\b/, icon: OpenAIMono, mono: true },
  { pattern: /command|cohere/, icon: CohereColor },
  { pattern: /falcon/, icon: TIIColor },
  { pattern: /stablelm|stable[-_. ]?code/, icon: StabilityColor },
  { pattern: /grok/, icon: GrokMono, mono: true },
  { pattern: /xai/, icon: XAIMono, mono: true },
  { pattern: /nemotron|nemo/, icon: NvidiaColor },
  { pattern: /exaone/, icon: LGColor },
  { pattern: /granite/, icon: IBMMono, mono: true },
  { pattern: /mimo|xiaomi/, icon: XiaomiMiMoMono, mono: true },
  { pattern: /longcat/, icon: LongCatColor },
  { pattern: /stepfun|\bstep[-_.]?\d/, icon: StepfunMono, mono: true },
  { pattern: /spark/, icon: SparkColor },
  { pattern: /ernie|wenxin/, icon: WenxinColor },
  { pattern: /sensenova|sensechat/, icon: SenseNovaColor },
  { pattern: /olmo|allenai|\bai2\b/, icon: Ai2Color },
  { pattern: /smollm|huggingface/, icon: HuggingFaceColor },
  { pattern: /gemini|imagen/, icon: GeminiColor },
];

export interface ModelBrandLogo {
  icon: IconType;
  mono: boolean;
}

/** 根据模型家族 / 架构 / 名称识别品牌 logo，未命中时返回 null */
export function getModelBrandLogo(...hints: Array<string | undefined>): ModelBrandLogo | null {
  const text = hints.filter(Boolean).join(' ').toLowerCase();
  if (!text) return null;
  for (const rule of BRAND_RULES) {
    if (rule.pattern.test(text)) {
      return { icon: rule.icon, mono: !!rule.mono };
    }
  }
  return null;
}

export interface ModelLogoLibraryEntry {
  /** 自定义头像的引用键，存为 `lobehub:<key>`（见 ModelFamilyLogo） */
  key: string;
  label: string;
  icon: IconType;
  mono: boolean;
}

// 头像库：全部可选品牌。与 BRAND_RULES 同源，但允许用户手动指定。
export const MODEL_LOGO_LIBRARY: ModelLogoLibraryEntry[] = [
  { key: 'deepseek', label: 'DeepSeek', icon: DeepSeekColor, mono: false },
  { key: 'qwen', label: '通义 Qwen', icon: QwenColor, mono: false },
  { key: 'zhipu', label: '智谱 GLM', icon: ZhipuColor, mono: false },
  { key: 'kimi', label: 'Kimi', icon: KimiColor, mono: false },
  { key: 'gemma', label: 'Gemma', icon: GemmaColor, mono: false },
  { key: 'llama', label: 'Llama', icon: MetaColor, mono: false },
  { key: 'mistral', label: 'Mistral', icon: MistralColor, mono: false },
  { key: 'phi', label: 'Phi', icon: MicrosoftColor, mono: false },
  { key: 'yi', label: 'Yi', icon: YiColor, mono: false },
  { key: 'minimax', label: 'MiniMax', icon: MinimaxColor, mono: false },
  { key: 'baichuan', label: '百川', icon: BaichuanColor, mono: false },
  { key: 'internlm', label: '书生 InternLM', icon: InternLMColor, mono: false },
  { key: 'hunyuan', label: '混元', icon: HunyuanColor, mono: false },
  { key: 'doubao', label: '豆包', icon: DoubaoColor, mono: false },
  { key: 'openai', label: 'OpenAI', icon: OpenAIMono, mono: true },
  { key: 'cohere', label: 'Cohere', icon: CohereColor, mono: false },
  { key: 'tii', label: 'Falcon', icon: TIIColor, mono: false },
  { key: 'stability', label: 'Stability', icon: StabilityColor, mono: false },
  { key: 'grok', label: 'Grok', icon: GrokMono, mono: true },
  { key: 'xai', label: 'xAI', icon: XAIMono, mono: true },
  { key: 'nvidia', label: 'NVIDIA', icon: NvidiaColor, mono: false },
  { key: 'lg', label: 'ExaOne', icon: LGColor, mono: false },
  { key: 'ibm', label: 'Granite', icon: IBMMono, mono: true },
  { key: 'mimo', label: '小米 MiMo', icon: XiaomiMiMoMono, mono: true },
  { key: 'longcat', label: 'LongCat', icon: LongCatColor, mono: false },
  { key: 'stepfun', label: 'StepFun', icon: StepfunMono, mono: true },
  { key: 'spark', label: '讯飞星火', icon: SparkColor, mono: false },
  { key: 'wenxin', label: '文心', icon: WenxinColor, mono: false },
  { key: 'sensenova', label: 'SenseNova', icon: SenseNovaColor, mono: false },
  { key: 'ai2', label: 'Ai2', icon: Ai2Color, mono: false },
  { key: 'huggingface', label: 'HuggingFace', icon: HuggingFaceColor, mono: false },
  { key: 'gemini', label: 'Gemini', icon: GeminiColor, mono: false },
];

export const LOBEHUB_CUSTOM_PREFIX = 'lobehub:';

/** 从头像库引用键取图标；无匹配返回 null */
export function getLibraryLogo(key: string): ModelLogoLibraryEntry | null {
  return MODEL_LOGO_LIBRARY.find((entry) => entry.key === key) ?? null;
}
