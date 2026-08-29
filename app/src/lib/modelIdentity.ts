import type { ModelInfo } from '@/types';

const QUANT_SUFFIX = /[-_.]?(?:UD-)?(?:IQ|Q)\d[\w.]*$/i;
const TRAILING_FORMAT = /[-_.](?:GGUF|gguf)$/i;

function fileStem(path?: string) {
  if (!path) return '';
  const normalized = path.replace(/\\/g, '/');
  const file = normalized.split('/').filter(Boolean).pop() ?? '';
  return file.replace(/\.gguf$/i, '');
}

/** 把任意用户输入收成 llama.cpp --alias 可用的短名 */
export function sanitizeApiName(value: string) {
  const cleaned = value
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9._+-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
  return cleaned || 'local-model';
}

/** 从文件名/家族提取关键词，去掉量化后缀，得到默认可调用名 */
export function suggestedApiName(model: Pick<ModelInfo, 'name' | 'family' | 'params' | 'filePath'>) {
  let stem = (model.name || fileStem(model.filePath) || model.family || 'local-model')
    .replace(/\.gguf$/i, '');
  stem = stem.replace(TRAILING_FORMAT, '').replace(QUANT_SUFFIX, '');
  if (stem.length > 48) {
    const family = (model.family || 'model').toLowerCase().replace(/\s+/g, '-');
    const params = (model.params || '').replace(/\s+/g, '').toLowerCase();
    stem = params && params !== '本地' ? `${family}-${params}` : family;
  }
  return sanitizeApiName(stem);
}

export function resolveApiName(model?: Pick<ModelInfo, 'name' | 'family' | 'params' | 'filePath' | 'apiName'> | null) {
  if (!model) return 'local-model';
  const custom = model.apiName?.trim();
  return sanitizeApiName(custom || suggestedApiName(model));
}

export function pickImageAsDataUrl(maxBytes = 512 * 1024): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp,image/gif,image/svg+xml';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      if (file.size > maxBytes) {
        reject(new Error(`图片请小于 ${(maxBytes / 1024).toFixed(0)} KB`));
        return;
      }
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || '') || null);
      reader.onerror = () => reject(new Error('读取图片失败'));
      reader.readAsDataURL(file);
    };
    input.click();
  });
}
