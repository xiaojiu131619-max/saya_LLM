import { Cpu, RefreshCw } from 'lucide-react';
import type { Fast27bModelVariant } from '@/lib/desktop';

const MODEL_LABELS: Record<Fast27bModelVariant, string> = {
  heretic: 'Heretic',
  saluki: 'Saluki',
};
const MODEL_SPECS: Record<Fast27bModelVariant, string> = {
  heretic: 'DFlash2',
  saluki: 'MTP',
};

export default function Fast27bModelSwitch({ selected, onChange, disabled = false, switching = false, available }: {
  selected: Fast27bModelVariant;
  onChange: (model: Fast27bModelVariant) => void;
  disabled?: boolean;
  switching?: boolean;
  available?: Partial<Record<Fast27bModelVariant, boolean>>;
}) {
  return <div className="fast27b-model-switch" role="group" aria-label="切换 NiNfer 模型">
    {(['heretic', 'saluki'] as const).map((model) => <button
      key={model} type="button" aria-pressed={selected === model}
      disabled={disabled || available?.[model] === false}
      onClick={() => onChange(model)}
      title={available?.[model] === false ? '模型文件缺失，请检查高级配置' : `切换到 ${MODEL_LABELS[model]} 27B`}
    >
      {switching && selected === model ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Cpu className="h-4 w-4" />}
      <span>{MODEL_LABELS[model]} 27B</span>
      <span className="fast27b-model-spec">{MODEL_SPECS[model]}</span>
    </button>)}
  </div>;
}
