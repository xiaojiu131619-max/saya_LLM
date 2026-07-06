import type {
  ComfyPrompt,
  ComfyPromptNodeInput,
  ComfyResourceOptions,
  ImageGenerationParams,
  ImageInputParam,
  ImageLoraParam,
  ImageWorkflowRecord,
  NodeInputBinding,
  WorkflowBinding,
} from '@/features/image/state/imageTypes';

function clonePrompt(prompt: ComfyPrompt): ComfyPrompt {
  return JSON.parse(JSON.stringify(prompt)) as ComfyPrompt;
}

function bindingValue(prompt: ComfyPrompt, binding?: NodeInputBinding) {
  if (!binding) return undefined;
  return prompt[binding.nodeId]?.inputs[binding.input];
}

function stringValue(value: ComfyPromptNodeInput | undefined, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function numberValue(value: ComfyPromptNodeInput | undefined, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function writeBinding(prompt: ComfyPrompt, binding: NodeInputBinding | undefined, value: string | number | boolean) {
  if (!binding) return;
  const node = prompt[binding.nodeId];
  if (!node || !(binding.input in node.inputs)) return;
  node.inputs[binding.input] = value;
}

function workflowLoras(workflow: ImageWorkflowRecord): ImageLoraParam[] {
  return workflow.binding.loras.map((binding, index) => {
    const node = workflow.prompt[binding.nodeId];
    const name = stringValue(node?.inputs[binding.loraNameInput], '');
    const strengthModel = numberValue(
      binding.strengthModelInput ? node?.inputs[binding.strengthModelInput] : undefined,
      1
    );
    const strengthClip = numberValue(
      binding.strengthClipInput ? node?.inputs[binding.strengthClipInput] : undefined,
      strengthModel
    );

    return {
      id: `${binding.nodeId}-${index}`,
      nodeId: binding.nodeId,
      name,
      strengthModel,
      strengthClip,
      enabled: Boolean(name) && (strengthModel > 0 || strengthClip > 0),
    };
  });
}

function workflowImageInputs(workflow: ImageWorkflowRecord): ImageInputParam[] {
  return workflow.binding.imageInputs.map((binding) => ({
    nodeId: binding.nodeId,
    imageName: stringValue(workflow.prompt[binding.nodeId]?.inputs[binding.input], ''),
  }));
}

export function createParamsFromWorkflow(
  workflow: ImageWorkflowRecord,
  resources: ComfyResourceOptions
): ImageGenerationParams {
  const binding = workflow.binding;
  const checkpoint = stringValue(bindingValue(workflow.prompt, binding.checkpoint), resources.checkpoints[0] ?? '');
  const samplerName = stringValue(bindingValue(workflow.prompt, binding.samplerName), resources.samplers[0] ?? '');
  const scheduler = stringValue(bindingValue(workflow.prompt, binding.scheduler), resources.schedulers[0] ?? '');
  const seed = numberValue(bindingValue(workflow.prompt, binding.seed), Math.floor(Math.random() * 1_000_000_000));

  return {
    positivePrompt: stringValue(bindingValue(workflow.prompt, binding.positivePrompt), ''),
    negativePrompt: stringValue(bindingValue(workflow.prompt, binding.negativePrompt), ''),
    checkpoint,
    loras: workflowLoras(workflow),
    width: numberValue(bindingValue(workflow.prompt, binding.width), 1024),
    height: numberValue(bindingValue(workflow.prompt, binding.height), 1024),
    seed,
    randomSeed: !binding.seed,
    steps: numberValue(bindingValue(workflow.prompt, binding.steps), 20),
    cfg: numberValue(bindingValue(workflow.prompt, binding.cfg), 7),
    samplerName,
    scheduler,
    batchSize: numberValue(bindingValue(workflow.prompt, binding.batchSize), 1),
    batchCount: 1,
    imageInputs: workflowImageInputs(workflow),
  };
}

export function buildPromptFromParams(
  workflow: ImageWorkflowRecord,
  params: ImageGenerationParams,
  seedOverride?: number
): ComfyPrompt {
  const prompt = clonePrompt(workflow.prompt);
  const binding = workflow.binding;

  writeBinding(prompt, binding.positivePrompt, params.positivePrompt);
  writeBinding(prompt, binding.negativePrompt, params.negativePrompt);
  writeBinding(prompt, binding.checkpoint, params.checkpoint);
  writeBinding(prompt, binding.width, Math.max(64, Math.round(params.width)));
  writeBinding(prompt, binding.height, Math.max(64, Math.round(params.height)));
  writeBinding(prompt, binding.batchSize, Math.max(1, Math.round(params.batchSize)));
  writeBinding(prompt, binding.seed, seedOverride ?? Math.round(params.seed));
  writeBinding(prompt, binding.steps, Math.max(1, Math.round(params.steps)));
  writeBinding(prompt, binding.cfg, Number(params.cfg));
  writeBinding(prompt, binding.samplerName, params.samplerName);
  writeBinding(prompt, binding.scheduler, params.scheduler);

  for (const lora of params.loras) {
    const loraBinding = binding.loras.find((item) => item.nodeId === lora.nodeId);
    const node = prompt[lora.nodeId];
    if (!loraBinding || !node) continue;
    node.inputs[loraBinding.loraNameInput] = lora.name;
    if (loraBinding.strengthModelInput) {
      node.inputs[loraBinding.strengthModelInput] = lora.enabled ? Number(lora.strengthModel) : 0;
    }
    if (loraBinding.strengthClipInput) {
      node.inputs[loraBinding.strengthClipInput] = lora.enabled ? Number(lora.strengthClip) : 0;
    }
  }

  for (const imageInput of params.imageInputs) {
    const imageBinding = binding.imageInputs.find((item) => item.nodeId === imageInput.nodeId);
    writeBinding(prompt, imageBinding, imageInput.imageName);
  }

  return prompt;
}

export function updateParamsForRatio(params: ImageGenerationParams, ratio: string): ImageGenerationParams {
  const [rawWidth, rawHeight] = ratio.split(':').map((part) => Number(part));
  if (!rawWidth || !rawHeight) return params;
  const area = Math.max(512 * 512, params.width * params.height);
  const width = Math.round(Math.sqrt(area * (rawWidth / rawHeight)) / 64) * 64;
  const height = Math.round(width * (rawHeight / rawWidth) / 64) * 64;
  return {
    ...params,
    width: Math.max(64, width),
    height: Math.max(64, height),
  };
}

export function enabledRequiredBindings(binding: WorkflowBinding) {
  return [
    binding.positivePrompt,
    binding.negativePrompt,
    binding.width,
    binding.height,
    binding.seed,
    binding.steps,
    binding.cfg,
  ].filter(Boolean).length;
}
