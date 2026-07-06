import type {
  ComfyPrompt,
  ComfyPromptNode,
  ComfyPromptNodeInput,
  NodeInputBinding,
  WorkflowAnalysis,
  WorkflowBinding,
} from '@/features/image/state/imageTypes';

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isPromptNode(value: unknown): value is ComfyPromptNode {
  return isObject(value) && typeof value.class_type === 'string' && isObject(value.inputs);
}

function isComfyPrompt(value: unknown): value is ComfyPrompt {
  if (!isObject(value)) return false;
  const entries = Object.entries(value);
  return entries.length > 0 && entries.every(([, node]) => isPromptNode(node));
}

function linkedNodeId(value: ComfyPromptNodeInput | undefined) {
  return Array.isArray(value) && typeof value[0] === 'string' ? value[0] : undefined;
}

function findFirstNode(prompt: ComfyPrompt, predicate: (node: ComfyPromptNode, nodeId: string) => boolean) {
  return Object.entries(prompt).find(([nodeId, node]) => predicate(node, nodeId));
}

function findNodes(prompt: ComfyPrompt, classType: string) {
  return Object.entries(prompt).filter(([, node]) => node.class_type === classType);
}

function inputBinding(nodeId: string | undefined, input: string): NodeInputBinding | undefined {
  return nodeId ? { nodeId, input } : undefined;
}

function nodeHasInput(prompt: ComfyPrompt, nodeId: string | undefined, input: string) {
  return Boolean(nodeId && prompt[nodeId] && input in prompt[nodeId].inputs);
}

function apiPromptFromRaw(raw: unknown) {
  if (isComfyPrompt(raw)) return raw;
  if (isObject(raw) && isComfyPrompt(raw.prompt)) return raw.prompt;
  return null;
}

function detectFormat(raw: unknown) {
  if (apiPromptFromRaw(raw)) return 'apiPrompt' as const;
  if (isObject(raw) && Array.isArray(raw.nodes)) return 'uiWorkflow' as const;
  return 'unknown' as const;
}

export function analyzeWorkflowJson(raw: unknown): WorkflowAnalysis {
  const format = detectFormat(raw);
  const prompt = apiPromptFromRaw(raw);
  const warnings: string[] = [];
  const emptyBinding: WorkflowBinding = { imageInputs: [], loras: [] };

  if (!prompt) {
    return {
      format,
      prompt: null,
      binding: emptyBinding,
      nodeCount: 0,
      warnings: format === 'uiWorkflow'
        ? ['当前版本优先支持 Comfy API prompt 格式，UI workflow 转换会在后续阶段补齐。']
        : ['未识别到可提交的 Comfy API prompt。'],
    };
  }

  const binding: WorkflowBinding = { imageInputs: [], loras: [] };
  const samplerEntry = findFirstNode(prompt, (node) => node.class_type === 'KSampler' || node.class_type === 'KSamplerAdvanced');
  const samplerId = samplerEntry?.[0];
  const sampler = samplerEntry?.[1];

  if (samplerId && sampler) {
    const positiveId = linkedNodeId(sampler.inputs.positive);
    const negativeId = linkedNodeId(sampler.inputs.negative);
    binding.positivePrompt = nodeHasInput(prompt, positiveId, 'text') ? { nodeId: positiveId!, input: 'text' } : undefined;
    binding.negativePrompt = nodeHasInput(prompt, negativeId, 'text') ? { nodeId: negativeId!, input: 'text' } : undefined;

    const latentId = linkedNodeId(sampler.inputs.latent_image);
    if (prompt[latentId ?? '']?.class_type === 'EmptyLatentImage') {
      binding.width = inputBinding(latentId, 'width');
      binding.height = inputBinding(latentId, 'height');
      binding.batchSize = inputBinding(latentId, 'batch_size');
    }

    binding.seed = inputBinding(samplerId, 'seed');
    binding.steps = inputBinding(samplerId, 'steps');
    binding.cfg = inputBinding(samplerId, 'cfg');
    binding.samplerName = inputBinding(samplerId, 'sampler_name');
    binding.scheduler = inputBinding(samplerId, 'scheduler');
  } else {
    warnings.push('未找到 KSampler 节点，生成参数需要手动绑定。');
  }

  const clipTextNodes = findNodes(prompt, 'CLIPTextEncode');
  if (!binding.positivePrompt && clipTextNodes[0]) {
    binding.positivePrompt = { nodeId: clipTextNodes[0][0], input: 'text' };
    warnings.push('正提示词使用第一个 CLIPTextEncode 作为兜底绑定。');
  }
  if (!binding.negativePrompt && clipTextNodes[1]) {
    binding.negativePrompt = { nodeId: clipTextNodes[1][0], input: 'text' };
    warnings.push('负提示词使用第二个 CLIPTextEncode 作为兜底绑定。');
  }

  if (!binding.width || !binding.height) {
    const latentEntry = findFirstNode(prompt, (node) => node.class_type === 'EmptyLatentImage');
    if (latentEntry) {
      binding.width = { nodeId: latentEntry[0], input: 'width' };
      binding.height = { nodeId: latentEntry[0], input: 'height' };
      binding.batchSize = { nodeId: latentEntry[0], input: 'batch_size' };
      warnings.push('尺寸使用第一个 EmptyLatentImage 作为兜底绑定。');
    }
  }

  const checkpointEntry = findFirstNode(prompt, (node) => node.class_type === 'CheckpointLoaderSimple');
  if (checkpointEntry) {
    binding.checkpoint = { nodeId: checkpointEntry[0], input: 'ckpt_name' };
  } else {
    warnings.push('未找到 CheckpointLoaderSimple，首版不会自动切换拆分式模型节点。');
  }

  for (const [nodeId, node] of Object.entries(prompt)) {
    if (node.class_type === 'LoraLoader' || node.class_type === 'LoraLoaderModelOnly') {
      binding.loras.push({
        nodeId,
        loraNameInput: 'lora_name',
        strengthModelInput: 'strength_model' in node.inputs ? 'strength_model' : undefined,
        strengthClipInput: 'strength_clip' in node.inputs ? 'strength_clip' : undefined,
      });
    }
    if (node.class_type === 'LoadImage' && 'image' in node.inputs) {
      binding.imageInputs.push({ nodeId, input: 'image' });
    }
  }

  if (binding.loras.length === 0) {
    warnings.push('未找到已有 LoRA 节点；动态增加 LoRA 会在后续阶段实现。');
  }

  return {
    format,
    prompt,
    binding,
    nodeCount: Object.keys(prompt).length,
    warnings,
  };
}

export function bindingLabel(binding?: NodeInputBinding) {
  return binding ? `节点 ${binding.nodeId}.${binding.input}` : '未绑定';
}
