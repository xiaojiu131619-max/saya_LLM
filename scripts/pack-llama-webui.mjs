// 从 llama.cpp 的 llama-server 二进制里导出官方 webui 资产，打成应用内嵌的 `llama-webui.bin`。
//
// 官方 webui 是编译进 llama-server 的（当成一堆 gzip 流放在 PE 的只读段里），llama.cpp 发布包
// 不带单独的静态目录，所以这里按「gzip 流出现顺序 == 资产路径字典序」把两者配对——
// 该规律在 b10709 / b10883 / b11860 三个内核上都验证过（见 docs/guides/NINFER_DLC_GUIDE.md）。
//
// 用法：
//   node scripts/pack-llama-webui.mjs [llama-server-impl.dll 路径]
// 默认路径按顺序探测：应用内核目录（target/release/resources/kernels/*/）、beellama 的 bin。
// 产出：
//   app/src-tauri/resources/llama-webui.bin   （69 个 gzip 流顺序拼接）
//   标准输出打印可直接贴进 services/webui_assets.rs 的 WebuiAsset 行

import { existsSync, readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync, crc32 } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');

// 资产清单：路径 + 解压后字节数（b11860 实测值，用于校验配对是否错位）。
const MANIFEST = [
  ['_app/immutable/assets/bundle.oAmIsIaD.css', 543230],
  ['_app/immutable/bundle.Cvb_ispa.js', 8859829],
  ['_app/version.json', 27],
  ['apple-splash-landscape-1136x640.png', 1246],
  ['apple-splash-landscape-1334x750.png', 1571],
  ['apple-splash-landscape-2266x1488.png', 4403],
  ['apple-splash-landscape-2360x1640.png', 5005],
  ['apple-splash-landscape-2388x1668.png', 5166],
  ['apple-splash-landscape-2532x1170.png', 3783],
  ['apple-splash-landscape-2556x1179.png', 3818],
  ['apple-splash-landscape-2622x1206.png', 3977],
  ['apple-splash-landscape-2732x2048.png', 7037],
  ['apple-splash-landscape-2778x1284.png', 4469],
  ['apple-splash-landscape-2796x1290.png', 4511],
  ['apple-splash-landscape-2868x1320.png', 4689],
  ['apple-splash-landscape-dark-1136x640.png', 1262],
  ['apple-splash-landscape-dark-1334x750.png', 1579],
  ['apple-splash-landscape-dark-2266x1488.png', 4437],
  ['apple-splash-landscape-dark-2360x1640.png', 4995],
  ['apple-splash-landscape-dark-2388x1668.png', 5142],
  ['apple-splash-landscape-dark-2532x1170.png', 3766],
  ['apple-splash-landscape-dark-2556x1179.png', 3816],
  ['apple-splash-landscape-dark-2622x1206.png', 3971],
  ['apple-splash-landscape-dark-2732x2048.png', 7055],
  ['apple-splash-landscape-dark-2778x1284.png', 4456],
  ['apple-splash-landscape-dark-2796x1290.png', 4515],
  ['apple-splash-landscape-dark-2868x1320.png', 4685],
  ['apple-splash-portrait-1170x2532.png', 3664],
  ['apple-splash-portrait-1179x2556.png', 3719],
  ['apple-splash-portrait-1206x2622.png', 3882],
  ['apple-splash-portrait-1284x2778.png', 4292],
  ['apple-splash-portrait-1290x2796.png', 4493],
  ['apple-splash-portrait-1320x2868.png', 4563],
  ['apple-splash-portrait-1488x2266.png', 4284],
  ['apple-splash-portrait-1640x2360.png', 4887],
  ['apple-splash-portrait-1668x2388.png', 5016],
  ['apple-splash-portrait-2048x2732.png', 6948],
  ['apple-splash-portrait-640x1136.png', 1207],
  ['apple-splash-portrait-750x1334.png', 1524],
  ['apple-splash-portrait-dark-1170x2532.png', 3663],
  ['apple-splash-portrait-dark-1179x2556.png', 3741],
  ['apple-splash-portrait-dark-1206x2622.png', 3883],
  ['apple-splash-portrait-dark-1284x2778.png', 4292],
  ['apple-splash-portrait-dark-1290x2796.png', 4482],
  ['apple-splash-portrait-dark-1320x2868.png', 4565],
  ['apple-splash-portrait-dark-1488x2266.png', 4307],
  ['apple-splash-portrait-dark-1640x2360.png', 4883],
  ['apple-splash-portrait-dark-1668x2388.png', 5019],
  ['apple-splash-portrait-dark-2048x2732.png', 6937],
  ['apple-splash-portrait-dark-640x1136.png', 1214],
  ['apple-splash-portrait-dark-750x1334.png', 1536],
  ['apple-touch-icon-180x180.png', 806],
  ['favicon-dark.ico', 493],
  ['favicon-dark.svg', 807],
  ['favicon.ico', 486],
  ['favicon.svg', 807],
  ['index.html', 12639],
  ['manifest.webmanifest', 524],
  ['maskable-icon-512x512.png', 1894],
  ['pwa-192x192.png', 3733],
  ['pwa-512x512.png', 12773],
  ['pwa-64x64.png', 1253],
  ['recommended-mcp/context7.png', 1489],
  ['recommended-mcp/exa.ico', 15154],
  ['recommended-mcp/github-dark.png', 584],
  ['recommended-mcp/github-light.png', 958],
  ['recommended-mcp/huggingface.ico', 205556],
  ['sw.js', 6829],
  ['workbox-b3c04f83.js', 21669],
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function locateBinary() {
  const explicit = process.argv[2];
  if (explicit) return explicit;
  const candidates = [];
  const kernels = join(repo, 'app/src-tauri/target/release/resources/kernels');
  if (existsSync(kernels)) {
    for (const entry of readdirSync(kernels)) {
      candidates.push(join(kernels, entry, 'llama-server-impl.dll'));
    }
  }
  candidates.push(join(repo, 'app/src-tauri/target/release/llama-server-impl.dll'));
  for (const dir of ['D:/LLM/beellama/bin', 'D:/LLM/infer/engine']) {
    candidates.push(join(dir, 'llama-server-impl.dll'));
  }
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

/** 扫出二进制里所有 gzip 流的起点。 */
function findGzipOffsets(buffer) {
  const offsets = [];
  for (let i = 0; i + 3 < buffer.length; i += 1) {
    if (buffer[i] === 0x1f && buffer[i + 1] === 0x8b && buffer[i + 2] === 0x08) offsets.push(i);
  }
  return offsets;
}

/** 用 zlib 原始流解压（gzip 头 10 字节固定、无额外字段），得出解压后长度。 */
function rawSize(buffer, offset) {
  const body = buffer.subarray(offset + 10);
  // finishFlush: 2 (Z_SYNC_FLUSH) —— 允许 deflate 流后面跟着 gzip 尾部的 CRC/ISIZE。
  const out = inflateRawSync(body, { finishFlush: 2 });
  return out.length;
}

const binaryPath = locateBinary();
if (!existsSync(binaryPath)) {
  console.error(`找不到 llama-server 二进制：${binaryPath}`);
  process.exit(1);
}
const buffer = readFileSync(binaryPath);
const offsets = findGzipOffsets(buffer);
const blobs = [];
for (const offset of offsets) {
  try {
    const size = rawSize(buffer, offset);
    if (size > 20) blobs.push({ offset, size });
  } catch {
    // 不是真正的 gzip 流（随机命中的字节组合），跳过
  }
}
console.log(`源二进制：${binaryPath}（${(statSync(binaryPath).size / 1e6).toFixed(1)} MB）`);
console.log(`gzip 流：${blobs.length}，清单项：${MANIFEST.length}`);

const count = Math.min(blobs.length, MANIFEST.length);
const mismatches = [];
for (let i = 0; i < count; i += 1) {
  if (blobs[i].size !== MANIFEST[i][1]) mismatches.push({ index: i, path: MANIFEST[i][0], expected: MANIFEST[i][1], actual: blobs[i].size });
}
if (mismatches.length > 0) {
  console.warn('⚠ 配对校验不一致（webui 版本可能与清单不同，请核对后再提交）：');
  for (const row of mismatches.slice(0, 20)) {
    console.warn(`   #${row.index} ${row.path} 期望 ${row.expected} 实际 ${row.actual}`);
  }
}

const parts = [];
const rows = [];
let cursor = 0;
for (let i = 0; i < count; i += 1) {
  const limit = (i + 1 < count ? blobs[i + 1].offset : buffer.length) - blobs[i].offset;
  const gzLen = gzStreamLength(buffer, blobs[i].offset, limit);
  parts.push(buffer.subarray(blobs[i].offset, blobs[i].offset + gzLen));
  const path = MANIFEST[i][0];
  const mime = MIME[path.slice(path.lastIndexOf('.'))] ?? 'application/octet-stream';
  rows.push(`    WebuiAsset { path: "${path}", offset: ${cursor}, gz_len: ${gzLen}, mime: "${mime}" },`);
  cursor += gzLen;
}

/** gzip 流长度：用 gzip 尾部的 CRC32 + ISIZE 精确定位流尾（deflate 自身不报长度）。 */
function gzStreamLength(buffer, offset, limit) {
  const raw = inflateRawSync(buffer.subarray(offset + 10, offset + limit), { finishFlush: 2 });
  const crc = crc32(raw) >>> 0;
  const isize = raw.length >>> 0;
  // 从头部往后找第一个「CRC32 与 ISIZE 都对得上」的位置，即 deflate 流结束处。
  for (let p = offset + 10; p <= offset + limit - 8; p += 1) {
    if (buffer.readUInt32LE(p) === crc && buffer.readUInt32LE(p + 4) === isize) {
      return p + 8 - offset;
    }
  }
  throw new Error(`定位 gzip 流尾失败（offset=${offset}）`);
}

const out = join(repo, 'app/src-tauri/resources/llama-webui.bin');
writeFileSync(out, Buffer.concat(parts));
console.log(`已写入 ${out}（${cursor} 字节，${parts.length} 个资产）`);
console.log('把下面几行替换进 services/webui_assets.rs 的 ASSETS：');
console.log(rows.join('\n'));