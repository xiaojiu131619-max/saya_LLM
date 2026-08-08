import type { ModelInfo, VideoSupportLevel } from '@/types';

export function modelVideoSupport(model?: Pick<ModelInfo, 'supportsVideo' | 'supportsVision' | 'videoSupport'> | null): VideoSupportLevel {
  if (!model) return 'none';
  if (model.videoSupport) return model.videoSupport;
  if (model.supportsVideo) return 'verified';
  return model.supportsVision ? 'frames' : 'none';
}

export function videoSupportTitle(level: VideoSupportLevel) {
  switch (level) {
    case 'verified':
      return '视频：已验证模型能力';
    case 'candidate':
      return '视频候选：模型结构支持，仍需 ffmpeg/ffprobe 与运行时验证';
    case 'frames':
      return '视频：仅支持抽帧兼容，不能保证动作和时间关系';
    default:
      return '视频：未检测到';
  }
}
