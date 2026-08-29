import type { CSSProperties, ReactNode } from 'react';
import { getLibraryLogo, getModelBrandLogo, LOBEHUB_CUSTOM_PREFIX } from '@/lib/modelLogo';

interface ModelFamilyLogoProps {
  family?: string;
  architecture?: string;
  name?: string;
  size?: number;
  /** 用户自定义头像（data URL）优先于品牌图标 */
  customSrc?: string;
  /** 单色品牌图标（OpenAI、Grok、IBM 等）的着色，建议传模型主题色 */
  tone?: string;
  /** 未命中品牌图标时渲染的占位内容（保持原有几何字符方案） */
  fallback?: ReactNode;
  className?: string;
}

/** 模型品牌 logo：命中 @lobehub/icons 品牌时渲染彩色图标，否则渲染 fallback */
export default function ModelFamilyLogo({
  family,
  architecture,
  name,
  size = 18,
  customSrc,
  tone,
  fallback = null,
  className,
}: ModelFamilyLogoProps) {
  if (customSrc) {
    // 头像库引用（`lobehub:<key>`）：渲染库内品牌图标，不经过 img。
    if (customSrc.startsWith(LOBEHUB_CUSTOM_PREFIX)) {
      const entry = getLibraryLogo(customSrc.slice(LOBEHUB_CUSTOM_PREFIX.length));
      if (entry) {
        const style: CSSProperties | undefined = entry.mono && tone ? { color: tone } : undefined;
        const Icon = entry.icon;
        return <Icon size={size} className={className} style={style} />;
      }
    }
    return (
      <img
        src={customSrc}
        alt=""
        width={size}
        height={size}
        className={`rounded-full object-cover ${className ?? ''}`}
        style={{ width: size, height: size }}
      />
    );
  }
  const brand = getModelBrandLogo(family, architecture, name);
  if (!brand) return <>{fallback}</>;
  const style: CSSProperties | undefined = brand.mono && tone ? { color: tone } : undefined;
  const Icon = brand.icon;
  return <Icon size={size} className={className} style={style} />;
}
