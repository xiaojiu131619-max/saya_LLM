import type { ReasoningMode } from '@/types';
import type { PiPermissionMode } from '@/lib/ipc/pi';

/** 思考挡位的界面四挡（显示与发送共用同一份档案，见 ReasoningMenu）。 */
export const REASONING_OPTIONS: Array<{ mode: ReasoningMode; label: string; description: string }> = [
  { mode: 'off', label: '关闭', description: '不请求 thinking 输出' },
  { mode: 'auto', label: '自动', description: '按模型能力自动启用' },
  { mode: 'think', label: '思考', description: '使用常规思考预算' },
  { mode: 'deep', label: '深思', description: '使用更高思考预算' },
];

export const PI_PERMISSION_OPTIONS: Array<{ value: PiPermissionMode; label: string; hint: string }> = [
  { value: 'plan', label: '只读', hint: '读/列目录放行；写、改、命令一律拒绝' },
  { value: 'auto', label: '守门', hint: '新建文件放行；覆盖/修改/命令逐条询问' },
  { value: 'full', label: '放行', hint: '工作区内文件操作放行；命令仍挡危险命令' },
];

export const PERMISSION_LABELS: Record<PiPermissionMode, string> = {
  plan: '只读',
  auto: '守门',
  full: '放行',
};
