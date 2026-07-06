export type ComfyPromptNodeInput = string | number | boolean | null | [string, number] | string[] | number[];

export interface ComfyPromptNode {
  class_type: string;
  inputs: Record<string, ComfyPromptNodeInput>;
  _meta?: {
    title?: string;
  };
}

export type ComfyPrompt = Record<string, ComfyPromptNode>;

export interface NodeInputBinding {
  nodeId: string;
  input: string;
}

export interface LoraBinding {
  nodeId: string;
  loraNameInput: string;
  strengthModelInput?: string;
  strengthClipInput?: string;
}

export interface WorkflowBinding {
  positivePrompt?: NodeInputBinding;
  negativePrompt?: NodeInputBinding;
  width?: NodeInputBinding;
  height?: NodeInputBinding;
  batchSize?: NodeInputBinding;
  checkpoint?: NodeInputBinding;
  seed?: NodeInputBinding;
  steps?: NodeInputBinding;
  cfg?: NodeInputBinding;
  samplerName?: NodeInputBinding;
  scheduler?: NodeInputBinding;
  imageInputs: NodeInputBinding[];
  loras: LoraBinding[];
}

export interface WorkflowAnalysis {
  format: 'apiPrompt' | 'uiWorkflow' | 'unknown';
  prompt: ComfyPrompt | null;
  binding: WorkflowBinding;
  nodeCount: number;
  warnings: string[];
}

export interface ImageLoraParam {
  id: string;
  nodeId: string;
  name: string;
  strengthModel: number;
  strengthClip: number;
  enabled: boolean;
}

export interface ImageInputParam {
  nodeId: string;
  imageName: string;
}

export interface ImageGenerationParams {
  positivePrompt: string;
  negativePrompt: string;
  checkpoint: string;
  loras: ImageLoraParam[];
  width: number;
  height: number;
  seed: number;
  randomSeed: boolean;
  steps: number;
  cfg: number;
  samplerName: string;
  scheduler: string;
  batchSize: number;
  batchCount: number;
  imageInputs: ImageInputParam[];
}

export interface ImageWorkflowRecord {
  id: string;
  name: string;
  rawJson: unknown;
  prompt: ComfyPrompt;
  binding: WorkflowBinding;
  nodeCount: number;
  warnings: string[];
  createdAt: number;
  updatedAt: number;
}

export interface ComfyImageRef {
  filename: string;
  subfolder?: string;
  type?: string;
}

export interface ImageOutputRecord {
  id: string;
  jobId: string;
  promptId: string;
  image: ComfyImageRef;
  url: string;
  params: ImageGenerationParams;
  workflowName: string;
  workflowSnapshot: ComfyPrompt;
  createdAt: number;
}

export interface ImageGenerationJob {
  id: string;
  promptId?: string;
  status: 'queued' | 'running' | 'done' | 'error' | 'cancelled';
  params: ImageGenerationParams;
  workflowName: string;
  outputs: ImageOutputRecord[];
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ComfyResourceOptions {
  checkpoints: string[];
  loras: string[];
  samplers: string[];
  schedulers: string[];
}

export interface ComfyPromptResponse {
  prompt_id: string;
  number?: number;
  node_errors?: Record<string, unknown>;
}
