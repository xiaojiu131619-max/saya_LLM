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
