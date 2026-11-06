/**
 * 量化线场（Quantized Line Field）
 *
 * 把品牌标志的明暗采样成网格，再用四档竖线重绘：细线铺满背景，粗线构成标志。
 * 只在「单卡动效」档下叠加流动噪声与指针弹簧位移；其余情况只画静态首帧。
 *
 * 参数与视觉规则见 docs/guides/UI_DESIGN_GUIDE.md 第 7 节（D-36 ~ D-44 / D-57）。
 */

/**
 * 横向列数。参考站是 60 列 × 30 段：每段纵向取相邻两行采样，
 * 因此 60×60 的亮度表画在正方形卡片上不会变形。
 * 卡片约 215px 时列宽约 3.6px。
 */
export const LINE_FIELD_COLUMNS = 60;
/** 纵向段数。每段覆盖 2 行采样（60 行 / 30 段），段间留 0.7px 窄缝。 */
export const LINE_FIELD_ROWS = 30;

/** 四档量化阈值：低于 0.12 仍画最细一档，形成铺满背景的发丝线。 */
const TIER_THRESHOLDS = [0.12, 0.42, 0.89] as const;
/** 四档线宽（参考值，按格子大小缩放，最小 0.5px 避免整线消失）。 */
const TIER_WIDTHS = [0.38, 1.12, 2.28, 3.8] as const;
/** 四档透明度。 */
const TIER_ALPHAS = [0.15, 0.64, 0.93, 1] as const;
/** 参考站用的格子基准尺寸，用于把线宽换算到任意列宽。 */
const REFERENCE_CELL = 5.25;

const SAMPLE_SIZE = 300;
/** 标志在采样画布内的占比：留出四周留白，避免粗线贴到卡片边缘。 */
const LOGO_SCALE = 0.82;
/** 线场里标志本身占卡片短边的比例。2:3 卡片上再放大 10%，同时给底部文字留出空间。 */
const LOGO_FIELD_SCALE = 0.572;
/** 采样网格边长：60×60，与参考站一致；绘制时压成 60 列 × 30 段。 */
const SAMPLE_GRID = 60;
/** 每段纵向覆盖的采样行数。 */
const SAMPLE_ROWS_PER_SEGMENT = SAMPLE_GRID / LINE_FIELD_ROWS;
/** 每列横向覆盖的采样列数。 */
const SAMPLE_COLS_PER_COLUMN = SAMPLE_GRID / LINE_FIELD_COLUMNS;

// ---------------- 噪声（固定 seed，可复现） ----------------

const NOISE_SIZE = 128;
let noiseTable: Float32Array | null = null;

function getNoiseTable(): Float32Array {
  if (noiseTable) return noiseTable;
  const table = new Float32Array(NOISE_SIZE * NOISE_SIZE);
  let state = 7319;
  for (let i = 0; i < table.length; i += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    table[i] = ((state >>> 0) / 4294967295) * 2 - 1;
  }
  noiseTable = table;
  return table;
}

function smooth(t: number) {
  return t * t * (3 - 2 * t);
}

function valueNoise(x: number, y: number): number {
  const table = getNoiseTable();
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = smooth(x - x0);
  const fy = smooth(y - y0);
  const wrap = (v: number) => ((v % NOISE_SIZE) + NOISE_SIZE) % NOISE_SIZE;
  const xa = wrap(x0);
  const xb = wrap(x0 + 1);
  const ya = wrap(y0);
  const yb = wrap(y0 + 1);
  const top = table[ya * NOISE_SIZE + xa] * (1 - fx) + table[ya * NOISE_SIZE + xb] * fx;
  const bottom = table[yb * NOISE_SIZE + xa] * (1 - fx) + table[yb * NOISE_SIZE + xb] * fx;
  return top * (1 - fy) + bottom * fy;
}

// ---------------- 采样 ----------------

const gridCache = new Map<string, Float32Array>();
const pendingSamples = new Map<string, Promise<Float32Array | null>>();
const MAX_CACHE = 64;

function hashString(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

/**
 * 把标志图形画进离屏画布，算出 60×60 的亮度表（Rec.709）。
 *
 * 两种来源分开处理：
 * - 透明 SVG：统一重绘成白色路径，用 alpha 覆盖率当墨迹；
 * - 图片：有透明通道时同样用覆盖率；不透明图片用亮度取反找深色墨迹。
 */
function gridFromImage(image: CanvasImageSource, mode: 'coverage' | 'ink'): Float32Array | null {
  const canvas = document.createElement('canvas');
  canvas.width = SAMPLE_SIZE;
  canvas.height = SAMPLE_SIZE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.clearRect(0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
  const logoSize = SAMPLE_SIZE * LOGO_SCALE;
  const logoOffset = (SAMPLE_SIZE - logoSize) / 2;
  const logoEnd = logoOffset + logoSize;
  ctx.drawImage(image, logoOffset, logoOffset, logoSize, logoSize);
  const { data } = ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE);

  const cell = SAMPLE_SIZE / SAMPLE_GRID;
  const coverageGrid = new Float32Array(SAMPLE_GRID * SAMPLE_GRID);
  const luminanceGrid = new Float32Array(SAMPLE_GRID * SAMPLE_GRID);
  let transparentPixels = 0;
  let sampledPixels = 0;

  for (let row = 0; row < SAMPLE_GRID; row += 1) {
    for (let col = 0; col < SAMPLE_GRID; col += 1) {
      let alphaSum = 0;
      let luminanceSum = 0;
      const startY = Math.floor(row * cell);
      const endY = Math.floor((row + 1) * cell);
      const startX = Math.floor(col * cell);
      const endX = Math.floor((col + 1) * cell);
      for (let y = startY; y < endY; y += 1) {
        for (let x = startX; x < endX; x += 1) {
          const offset = (y * SAMPLE_SIZE + x) * 4;
          const alpha = data[offset + 3] / 255;
          // 透明判定只看标志实际绘制的矩形，不把 0.82 缩放留出的外边距算进去。
          if (x >= logoOffset && x < logoEnd && y >= logoOffset && y < logoEnd) {
            sampledPixels += 1;
            if (alpha < 0.5) transparentPixels += 1;
          }
          if (alpha === 0) continue;
          const luminance = (0.2126 * data[offset] + 0.7152 * data[offset + 1] + 0.0722 * data[offset + 2]) / 255;
          alphaSum += alpha;
          luminanceSum += luminance * alpha;
        }
      }
      const cellPixels = Math.max(1, (endX - startX) * (endY - startY));
      const index = row * SAMPLE_GRID + col;
      coverageGrid[index] = alphaSum / cellPixels;
      luminanceGrid[index] = alphaSum > 0 ? luminanceSum / alphaSum : 1;
    }
  }

  const hasTransparency = transparentPixels > sampledPixels * 0.02;
  const grid = new Float32Array(SAMPLE_GRID * SAMPLE_GRID);
  const useCoverage = mode === 'coverage' || hasTransparency;
  for (let i = 0; i < grid.length; i += 1) {
    grid[i] = useCoverage
      ? coverageGrid[i]
      : 1 - luminanceGrid[i];
  }

  return grid;
}

/**
 * 采样前把 SVG 统一重绘成白色路径。
 *
 * 参考站的做法是「黑色画布 + 白色 Path2D」，采样只关心形状；
 * 因此不要在采样阶段用主题色，否则浅色品牌标志的覆盖率没问题、但亮度会偏弱。
 * 线色只在最终 Canvas 描边时使用。
 */
function serializeSvg(source: SVGSVGElement): string {
  const clone = source.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', String(SAMPLE_SIZE));
  clone.setAttribute('height', String(SAMPLE_SIZE));
  const nodes: Element[] = [clone, ...Array.from(clone.querySelectorAll('*'))];
  for (const node of nodes) {
    for (const attr of ['fill', 'stroke']) {
      const value = node.getAttribute(attr);
      if (value && value !== 'none') node.setAttribute(attr, '#FFFFFF');
    }
    // 描边图标不要被默认黑色填充；纯路径图形则改成白色。
    if (node.hasAttribute('stroke') && !node.hasAttribute('fill')) {
      node.setAttribute('fill', 'none');
    } else if (node !== clone && !node.hasAttribute('fill') && !node.hasAttribute('stroke')) {
      node.setAttribute('fill', '#FFFFFF');
    }
    for (const attr of ['color', 'stop-color']) {
      if (node.getAttribute(attr) === 'currentColor') {
        node.setAttribute(attr, '#FFFFFF');
      }
    }
  }
  return new XMLSerializer().serializeToString(clone);
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('标志图形加载失败'));
    image.src = src;
  });
}

/**
 * 从卡片里的标志元素采样亮度表。
 * - SVG：统一转成白色路径，按形状覆盖率采样；
 * - `<img>`：直接使用其 src（自定义头像），不透明图片按深色墨迹采样。
 * 结果按图形内容缓存，尺寸变化与重复渲染都不会重新采样。
 */
export async function sampleLineField(target: Element): Promise<Float32Array | null> {
  const svg = target.querySelector('svg');
  let key: string;
  let src: string;
  let mode: 'coverage' | 'ink' = 'ink';
  if (svg) {
    mode = 'coverage';
    const serialized = serializeSvg(svg as SVGSVGElement);
    key = `svg:${hashString(serialized)}`;
    src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(serialized)}`;
  } else {
    const img = target.querySelector('img');
    if (!img || !img.src) return null;
    key = `img:${hashString(img.src)}`;
    src = img.src;
  }

  const cached = gridCache.get(key);
  if (cached) return cached;
  // 同一品牌的多张卡片会同时挂载：合并进行中的采样，避免重复解码与读像素。
  const pending = pendingSamples.get(key);
  if (pending) return pending;

  const task = loadImage(src)
    .then((image) => {
      const grid = gridFromImage(image, mode);
      if (!grid) return null;
      if (gridCache.size >= MAX_CACHE) {
        const oldest = gridCache.keys().next().value;
        if (oldest !== undefined) gridCache.delete(oldest);
      }
      gridCache.set(key, grid);
      return grid;
    })
    .catch(() => null)
    .finally(() => {
      pendingSamples.delete(key);
    });

  pendingSamples.set(key, task);
  return task;
}

// ---------------- 绘制 ----------------

export interface LineFieldPointer {
  /** 相对画布左上角的 CSS 像素坐标。 */
  x: number;
  y: number;
  /** 0~1 的脉冲强度，指针移动时置 1，随后指数衰减。 */
  pulse: number;
}

export interface LineFieldFrame {
  cssWidth: number;
  cssHeight: number;
  color: string;
  /** 动画时间（秒）；静态首帧传 0。 */
  time: number;
  pointer: LineFieldPointer | null;
}

function tierOf(brightness: number): number {
  if (brightness >= TIER_THRESHOLDS[2]) return 3;
  if (brightness >= TIER_THRESHOLDS[1]) return 2;
  if (brightness >= TIER_THRESHOLDS[0]) return 1;
  return 0;
}

/** 把亮度表画成一帧。静态与动画共用同一套几何，避免首帧与动效跳变。 */
export function drawLineField(
  canvas: HTMLCanvasElement,
  grid: Float32Array,
  frame: LineFieldFrame,
): void {
  const { cssWidth, cssHeight, color, time, pointer } = frame;
  if (cssWidth <= 0 || cssHeight <= 0) return;

  const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 3));
  const backingWidth = Math.round(cssWidth * dpr);
  const backingHeight = Math.round(cssHeight * dpr);
  if (canvas.width !== backingWidth || canvas.height !== backingHeight) {
    canvas.width = backingWidth;
    canvas.height = backingHeight;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);

  const backgroundCellW = cssWidth / LINE_FIELD_COLUMNS;
  const backgroundSegmentH = cssHeight / LINE_FIELD_ROWS;
  const backgroundWidthScale = Math.max(backgroundCellW / REFERENCE_CELL, 0.5 / TIER_WIDTHS[0]);

  // 背景：整卡铺细竖线，保留参考站的「细线铺满、粗线成标志」层级。
  ctx.strokeStyle = color;
  ctx.lineCap = 'butt';
  ctx.globalAlpha = TIER_ALPHAS[0];
  ctx.lineWidth = Math.max(TIER_WIDTHS[0] * backgroundWidthScale, 0.5);
  ctx.beginPath();
  for (let col = 0; col < LINE_FIELD_COLUMNS; col += 1) {
    const x = (col + 0.5) * backgroundCellW;
    for (let row = 0; row < LINE_FIELD_ROWS; row += 1) {
      const y = row * backgroundSegmentH;
      ctx.moveTo(x, y);
      ctx.lineTo(x, y + Math.max(backgroundSegmentH - 0.7, 1));
    }
  }
  ctx.stroke();

  // 标志：在卡片中上部留出一个正方形，只把亮度表映射到这个区域。
  const logoSize = Math.min(cssWidth, cssHeight) * LOGO_FIELD_SCALE;
  const logoLeft = (cssWidth - logoSize) / 2;
  // 2:3 卡片里标志居中；底部文字用渐变浮层压在线场上。
  const logoTop = (cssHeight - logoSize) / 2;
  const logoCellW = logoSize / LINE_FIELD_COLUMNS;
  const logoSegmentH = logoSize / LINE_FIELD_ROWS;
  const logoWidthScale = Math.max(logoCellW / REFERENCE_CELL, 0.5 / TIER_WIDTHS[0]);
  const radius = Math.max(logoSize / 4, logoSegmentH * 2);

  // 按档分组，每组只设置一次样式。
  const buckets: Array<Array<{ x: number; y: number; h: number; w: number }>> = [[], [], [], []];
  for (let col = 0; col < LINE_FIELD_COLUMNS; col += 1) {
    const sampleCol = Math.min(
      SAMPLE_GRID - 1,
      Math.max(0, Math.floor(col * SAMPLE_COLS_PER_COLUMN)),
    );
    for (let row = 0; row < LINE_FIELD_ROWS; row += 1) {
      let brightness = 0;
      for (let offset = 0; offset < SAMPLE_ROWS_PER_SEGMENT; offset += 1) {
        const sampleRow = row * SAMPLE_ROWS_PER_SEGMENT + offset;
        brightness += grid[sampleRow * SAMPLE_GRID + sampleCol];
      }
      brightness /= SAMPLE_ROWS_PER_SEGMENT;
      if (time > 0) {
        const noise = valueNoise(col * 0.15 + 7, row * 0.16 - time * 0.17);
        brightness = brightness * 0.94 + noise * 0.12 * (0.25 + brightness * 0.75);
      }
      const tier = tierOf(brightness);
      // 标志区域内的空白格交给背景细线，不重复叠加最细档。
      if (tier === 0) continue;

      let x = logoLeft + (col + 0.5) * logoCellW;
      let y = logoTop + row * logoSegmentH;
      if (pointer && pointer.pulse > 0.001) {
        const cx = logoLeft + (col + 0.5) * logoCellW - pointer.x;
        const cy = logoTop + (row + 0.5) * logoSegmentH - pointer.y;
        const distance = Math.hypot(cx, cy);
        if (distance < radius) {
          const influence = (1 - distance / radius) ** 2 * pointer.pulse * 25;
          const safe = distance || 1;
          x += (cx / safe) * influence;
          y += ((cy / safe) * influence) * 0.58;
        }
      }
      buckets[tier].push({ x, y, h: Math.max(logoSegmentH - 0.7, 1), w: TIER_WIDTHS[tier] * logoWidthScale });
    }
  }

  ctx.strokeStyle = color;
  ctx.lineCap = 'butt';
  for (let tier = 0; tier < buckets.length; tier += 1) {
    const segments = buckets[tier];
    if (segments.length === 0) continue;
    ctx.globalAlpha = TIER_ALPHAS[tier];
    ctx.lineWidth = Math.max(TIER_WIDTHS[tier] * logoWidthScale, 0.5);
    ctx.beginPath();
    for (const segment of segments) {
      ctx.moveTo(segment.x, segment.y);
      ctx.lineTo(segment.x, segment.y + segment.h);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

/** 是否应当关闭动效（系统偏好或应用设置「减少动画」）。 */
export function prefersReducedMotion(): boolean {
  if (document.documentElement.classList.contains('reduce-motion')) return true;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
