import type { AgentArtifact } from '@/types';

/**
 * 产物门的判定层。
 *
 * 目标只有一个：拦住「模型说完成了，但交付物的类型/内容对不上」的情况，
 * 例如任务要 PDF、模型却写了一个 Markdown 文件然后改名成 `.pdf`。
 *
 * 两条刻意收窄的规则，避免把普通问答误判成失败：
 * - 任务类型白名单：只有下表里的类型会触发产物门，其它任务一律放行；
 * - 创建意图判定：必须出现「生成 / 导出成 / 保存为」等明确动作，或者直接点名
 *   文件名（如 `report.pdf`）。「PDF 是什么格式」「为什么导出的 PDF 打不开」
 *   这类提问不拦。
 *
 * 校验顺序：存在 → 扩展名 → 非空 → 文件头（魔数）。魔数由宿主
 * `pi_resolve_artifacts` 嗅探后随产物元数据一起返回，前端不重复读文件。
 */

export type ArtifactIssue =
  | 'missing'
  | 'wrong_type'
  | 'empty_file'
  | 'magic_mismatch';

export interface ArtifactExpectation {
  id: string;
  label: string;
  extensions: string[];
}

export interface ArtifactGateVerdict {
  /** 是否命中白名单并执行了校验；false 时 ok 恒为 true。 */
  gated: boolean;
  ok: boolean;
  issue: ArtifactIssue | null;
  /** 给用户看的说明；ok 时为空串。 */
  detail: string;
  expectation: ArtifactExpectation | null;
  /** 扩展名匹配上的产物标题。 */
  matched: string[];
}

/** 只依赖产物元数据，方便在测试里直接构造。 */
export type ArtifactGateItem = Pick<
  AgentArtifact,
  'kind' | 'title' | 'path' | 'size' | 'magic' | 'magicOk'
>;

interface TaskArtifactRule extends ArtifactExpectation {
  pattern: RegExp;
}

/**
 * 任务类型白名单。顺序即优先级：
 * - 先看交付容器（PPT / 表格 / PDF），「包含思维导图的 PPT」要按 PPT 校验；
 * - 再看思维导图，它的扩展名允许 png / svg / html，因此「导出 PNG 导图」也能过；
 * - 最后才是图片与普通文档，避免「报告」抢在「PPT」前面要求 Markdown。
 */
export const TASK_ARTIFACT_RULES: TaskArtifactRule[] = [
  {
    id: 'slides',
    label: '演示文稿',
    extensions: ['pptx', 'ppt', 'pdf'],
    pattern: /(ppt|pptx|幻灯片|演示文稿|slides?)/i,
  },
  {
    id: 'spreadsheet',
    label: '表格',
    extensions: ['xlsx', 'xls', 'csv'],
    pattern: /(excel|xlsx|xls|csv|电子表格|统计表|表格)/i,
  },
  {
    id: 'pdf',
    label: 'PDF',
    extensions: ['pdf'],
    pattern: /(^|[^a-z])pdf([^a-z]|$)/i,
  },
  {
    id: 'mindmap',
    label: '思维导图',
    extensions: ['mmd', 'mermaid', 'mindmap', 'html', 'svg', 'png', 'json'],
    pattern: /(思维导图|脑图|mind\s?map|\.mmd\b|mermaid)/i,
  },
  {
    id: 'image',
    label: '图片',
    extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg'],
    pattern: /(生图|图片|海报|插画|配图|封面|头像|照片|渲染|image|png|jpe?g|webp|svg)/i,
  },
  {
    id: 'document',
    label: '文档',
    extensions: ['md', 'markdown', 'docx', 'pdf', 'txt', 'html'],
    pattern: /(报告|文档|简历|合同|方案|说明书|markdown|docx?|word)/i,
  },
];

/** 明确的产出动作；「导出 PDF 报错」这类排障句不会命中。 */
const EXPLICIT_CREATE =
  /(生成|制作|创建|新建|写一份|写个|写一个|做一份|做个|做一个|做成|做\s*(?:个|一个|一份)?\s*(?=pptx?|pdf|xlsx?|csv|幻灯片|演示文稿|表格|excel|思维导图|脑图|图片|海报|文档|报告|word|docx?)|绘制|画一张|画个|画一个|保存为|保存成|导出为|导出成|导出到|输出为|输出成|输出到|整理成|转成|转换成|转换成为|给我一份|make|create|generate|render|draw|save\s+as|export\s+as|convert\s+to)/i;

/** 直接点名文件名，例如「结果写到 report.pdf」。 */
const FILE_TARGET =
  /(^|[\s(（"'`])([a-z0-9_-]+\.(pptx?|xlsx?|csv|pdf|png|jpe?g|gif|webp|bmp|svg|md|markdown|docx?|txt|html?|mmd|mermaid))\b/i;

/** 「导出成 Excel」「做成 PPT」这类明确的目标写法，优先于关键词出现顺序。 */
const TARGET_TOKEN =
  /(?:导出为|导出成|导出到|输出为|输出成|输出到|保存为|保存成|转成|转换成|整理成|做成)\s*(?:一份|一个|个|张|份)?\s*(pptx?|pdf|xlsx?|csv|docx?|markdown|md|思维导图|脑图|mermaid|mmd|图片|海报|png|jpe?g|webp|svg|excel|word|幻灯片|演示文稿|表格|文档|报告)/i;

const EXTENSION_RULE: Record<string, string> = {
  ppt: 'slides', pptx: 'slides',
  xls: 'spreadsheet', xlsx: 'spreadsheet', csv: 'spreadsheet',
  pdf: 'pdf',
  mmd: 'mindmap', mermaid: 'mindmap', mindmap: 'mindmap',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image',
  webp: 'image', bmp: 'image', svg: 'image',
  md: 'document', markdown: 'document', doc: 'document', docx: 'document',
  txt: 'document', html: 'document', htm: 'document',
};

const TOKEN_RULE: Record<string, string> = {
  ppt: 'slides', pptx: 'slides', 幻灯片: 'slides', 演示文稿: 'slides',
  excel: 'spreadsheet', xlsx: 'spreadsheet', xls: 'spreadsheet',
  csv: 'spreadsheet', 表格: 'spreadsheet',
  pdf: 'pdf',
  思维导图: 'mindmap', 脑图: 'mindmap', mermaid: 'mindmap', mmd: 'mindmap',
  图片: 'image', 海报: 'image', png: 'image', jpg: 'image', jpeg: 'image',
  webp: 'image', svg: 'image',
  word: 'document', docx: 'document', md: 'document', markdown: 'document',
  文档: 'document', 报告: 'document',
};

function fileExtension(name: string): string {
  const parts = name.toLowerCase().split('.');
  return parts.length > 1 ? parts.pop() ?? '' : '';
}

function ruleById(id: string): ArtifactExpectation | null {
  const rule = TASK_ARTIFACT_RULES.find((item) => item.id === id);
  return rule ? { id: rule.id, label: rule.label, extensions: rule.extensions } : null;
}

function explicitExpectation(prompt: string): ArtifactExpectation | null {
  const file = prompt.match(FILE_TARGET);
  if (file) {
    const id = EXTENSION_RULE[file[3]?.toLowerCase() ?? ''];
    const expectation = id ? ruleById(id) : null;
    if (expectation) return expectation;
  }

  const target = prompt.match(TARGET_TOKEN);
  if (target) {
    const id = TOKEN_RULE[target[1]?.toLowerCase() ?? ''];
    const expectation = id ? ruleById(id) : null;
    if (expectation) return expectation;
  }
  return null;
}

function wantsDeliverable(text: string): boolean {
  return EXPLICIT_CREATE.test(text) || FILE_TARGET.test(text);
}

/** 从任务文本推断产物类型；推不出来或只是提问时返回 null。 */
export function artifactExpectation(text: string): ArtifactExpectation | null {
  const prompt = (text ?? '').trim();
  if (!prompt || !wantsDeliverable(prompt)) return null;

  // 明确点名的交付物优先于关键词顺序，避免「把 PDF 里的表格导出成 Excel」
  // 先命中 PDF，反而要求一份 PDF。
  const explicit = explicitExpectation(prompt);
  if (explicit) return explicit;

  for (const rule of TASK_ARTIFACT_RULES) {
    if (rule.pattern.test(prompt)) {
      return { id: rule.id, label: rule.label, extensions: rule.extensions };
    }
  }
  return null;
}

function artifactName(artifact: ArtifactGateItem): string {
  return artifact.path || artifact.title || '';
}

function displayName(artifact: ArtifactGateItem): string {
  return artifact.title || artifact.path || '未命名产物';
}

function listNames(artifacts: ArtifactGateItem[]): string {
  return artifacts.map(displayName).join('、');
}

/**
 * 判定本轮产物是否满足任务要求。
 *
 * 只对白名单内的任务类型生效；`magicOk` 缺省视为通过，兼容旧消息。
 */
export function judgeArtifactDelivery(
  prompt: string,
  artifacts: ArtifactGateItem[],
): ArtifactGateVerdict {
  const expectation = artifactExpectation(prompt);
  if (!expectation) {
    return {
      gated: false,
      ok: true,
      issue: null,
      detail: '',
      expectation: null,
      matched: [],
    };
  }

  const files = (artifacts ?? []).filter((artifact) => artifact.kind !== 'link');
  const matched = files.filter((artifact) => {
    if (!artifact.path) return false;
    return expectation.extensions.includes(fileExtension(artifactName(artifact)));
  });
  const matchedNames = matched.map(displayName);

  if (files.length === 0) {
    return {
      gated: true,
      ok: false,
      issue: 'missing',
      detail: `任务要求${expectation.label}，但没有检测到写文件产物。`,
      expectation,
      matched: [],
    };
  }

  if (matched.length === 0) {
    return {
      gated: true,
      ok: false,
      issue: 'wrong_type',
      detail: `任务要求${expectation.label}（${expectation.extensions.join('/')}），实际产物为 ${listNames(files)}。`,
      expectation,
      matched: [],
    };
  }

  const nonEmpty = matched.filter(
    (artifact) => typeof artifact.size !== 'number' || artifact.size > 0,
  );
  if (nonEmpty.length === 0) {
    return {
      gated: true,
      ok: false,
      issue: 'empty_file',
      detail: `任务要求${expectation.label}，但产物为空文件：${matchedNames.join('、')}。`,
      expectation,
      matched: matchedNames,
    };
  }

  const magicWrong = nonEmpty.filter((artifact) => artifact.magicOk === false);
  if (magicWrong.length > 0) {
    const detail = magicWrong
      .map((artifact) => `${displayName(artifact)}（检测到 ${artifact.magic ?? '无法识别'}）`)
      .join('、');
    return {
      gated: true,
      ok: false,
      issue: 'magic_mismatch',
      detail: `任务要求${expectation.label}，但文件头与扩展名不符：${detail}。`,
      expectation,
      matched: matchedNames,
    };
  }

  return {
    gated: true,
    ok: true,
    issue: null,
    detail: '',
    expectation,
    matched: matchedNames,
  };
}
