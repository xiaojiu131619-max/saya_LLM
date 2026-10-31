import type { ModelInfo } from '@/types';

export const modelFamilyIcons: Record<string, string> = {
  Qwen: '◆',
  Llama: '■',
  Mistral: '▲',
  Yi: '●',
  Gemma: '◇',
  DeepSeek: '⬢',
  Phi: '▣',
  Local: '◆',
  本地: '◆',
};

function fallbackGroupName(name: string) {
  return name
    .split(/[._\-\s]+/)
    .find((part) => part.length > 1)
    ?.replace(/^\w/, (char) => char.toUpperCase()) ?? '本地';
}

export function getModelThemeGroup(model: Pick<ModelInfo, 'family' | 'name' | 'architecture'>) {
  const label = model.family && model.family !== 'Local'
    ? model.family
    : model.architecture || fallbackGroupName(model.name);

  return {
    key: label.toLowerCase(),
    label,
    icon: modelFamilyIcons[label] ?? modelFamilyIcons[model.family] ?? label[0]?.toUpperCase() ?? '◆',
  };
}

/**
 * 各家族主题色的**纯色回退值**。
 *
 * 扫描出来的模型默认用 CSS 变量（`var(--accent)` 等）表达主题色，这样界面跟随
 * 系统强调色；但 `<input type="color">` 只认 `#RRGGBB`，色盘/预设色块也需要
 * 真实色值才能预览。所以这里再维护一份等价的纯色表，只在「取色器/预览」场景使用，
 * 不参与模型列表的实际渲染。
 */
const FAMILY_SOLID_FALLBACK: Record<string, string> = {
  Qwen: '#6749b8',
  Llama: '#2a8061',
  Mistral: '#ff9a00',
  Yi: '#0096ff',
  Gemma: '#ff6347',
  DeepSeek: '#373c46',
  Phi: '#6478a0',
  Local: '#5a6cff',
};

/**
 * 取模型的默认主题色纯值（用于「恢复默认」与色盘初值）。
 *
 * 模型自带的 `themeColorSolid` 可能是 CSS 变量，此时按家族回退表换成纯色；
 * 已经没有家族信息时用 Fluent 默认蓝。
 */
export function getThemeDefaultColor(model: Pick<ModelInfo, 'family' | 'themeColorSolid'>): string {
  const explicit = model.themeColorSolid?.trim() ?? '';
  const hex = explicit.match(/^#([0-9a-f]{6})/i);
  if (hex) return `#${hex[1]}`;
  return FAMILY_SOLID_FALLBACK[model.family] ?? '#0078D4';
}
