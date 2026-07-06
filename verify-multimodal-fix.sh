#!/bin/bash

# 多模态功能快速验证脚本
# 运行此脚本检查修复是否成功应用

echo "=========================================="
echo "  多模态聊天功能验证清单"
echo "=========================================="
echo ""

# 1. 检查文件是否已修改
echo "📝 [1/4] 检查 ChatBubble.tsx 修改..."
if grep -q "MultimodalAttachments" "D:/Projects/Agent_LLM/app/src/components/ChatBubble.tsx"; then
    echo "   ✅ MultimodalAttachments 组件已添加"
else
    echo "   ❌ 未找到 MultimodalAttachments 组件"
    exit 1
fi

if grep -q "message.multimodalContent" "D:/Projects/Agent_LLM/app/src/components/ChatBubble.tsx"; then
    echo "   ✅ 多模态内容渲染已启用"
else
    echo "   ❌ 未找到多模态内容渲染"
    exit 1
fi

echo ""

# 2. 检查视觉模型
echo "🔍 [2/4] 检查视觉模型配置..."
VISION_COUNT=$(node -e "
const fs = require('fs');
const path = require('path');
const cacheDir = path.join(process.env.APPDATA || '', 'AgentLLM', 'cache');
if (!fs.existsSync(cacheDir)) { console.log(0); process.exit(0); }
const files = fs.readdirSync(cacheDir).filter(f => f.endsWith('.json'));
let count = 0;
for (const file of files) {
  try {
    const content = JSON.parse(fs.readFileSync(path.join(cacheDir, file), 'utf-8'));
    if (content.info && content.info.mmproj_path) count++;
  } catch (err) {}
}
console.log(count);
" 2>/dev/null)

if [ "$VISION_COUNT" -gt 0 ]; then
    echo "   ✅ 找到 $VISION_COUNT 个视觉模型"
else
    echo "   ⚠️  未找到视觉模型（可能需要扫描模型目录）"
fi

echo ""

# 3. 检查 TypeScript 编译
echo "🔧 [3/4] TypeScript 类型检查..."
cd "D:/Projects/Agent_LLM/app"
if npx tsc --noEmit 2>&1 | grep -q "error TS"; then
    echo "   ❌ 发现类型错误"
    exit 1
else
    echo "   ✅ 无类型错误"
fi

echo ""

# 4. 显示支持的文件类型
echo "📎 [4/4] 支持的文件类型..."
echo "   📷 图片: PNG, JPG, GIF, WEBP, BMP, TIFF"
echo "   🎵 音频: WAV, MP3, M4A, AAC, OGG, FLAC, OPUS"
echo "   🎬 视频: MP4, MOV, MKV, WEBM, AVI"
echo "   📄 文本: TXT, MD, JSON, YAML, 代码文件等"

echo ""
echo "=========================================="
echo "  ✅ 多模态功能修复验证通过！"
echo "=========================================="
echo ""
echo "🚀 下一步操作："
echo "   1. 重启或重新构建应用"
echo "   2. 加载任意视觉模型"
echo "   3. 点击 ➕ 上传图片测试"
echo ""
echo "📖 详细说明请查看: MULTIMODAL_FIXED.md"
echo ""
