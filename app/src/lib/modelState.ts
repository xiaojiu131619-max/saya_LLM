import type { ModelInfo } from '@/types';

type RuntimeModel = Pick<ModelInfo, 'id' | 'status' | 'modelTask'>;

/** 向量 / 重排模型使用独立进程，不受主 llama-server 的单实例状态约束。 */
export function isIndependentModel(model: Pick<ModelInfo, 'modelTask'>) {
  return model.modelTask === 'embedding' || model.modelTask === 'rerank';
}

/**
 * 将主对话服务的本地状态收敛到单实例：目标模型为 loaded，其它已 loaded
 * 的主模型回到 standby。返回新数组但只在状态实际变化的模型上创建新对象。
 */
export function activateMainModel<T extends RuntimeModel>(models: T[], modelId: string): T[] {
  const target = models.find((model) => model.id === modelId && !isIndependentModel(model));
  if (!target) return models;

  return models.map((model) => {
    if (isIndependentModel(model)) return model;
    if (model.id === modelId) {
      return model.status === 'loaded' ? model : { ...model, status: 'loaded' };
    }
    return model.status === 'loaded' ? { ...model, status: 'standby' } : model;
  });
}

/** 主服务停止后，清除所有主模型的 loaded 标记；独立向量服务状态保持不变。 */
export function clearMainLoadedModels<T extends RuntimeModel>(models: T[]): T[] {
  return models.map((model) => (
    !isIndependentModel(model) && model.status === 'loaded'
      ? { ...model, status: 'standby' }
      : model
  ));
}
