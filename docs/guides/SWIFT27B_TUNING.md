# Swift-1.5-Qwen3.8-27B 本地推理调优报告(BeeLlama + kvarn4)

> 2026-09-28 于本机(RTX 3080 Ti 12GB / 驱动 616.92 / Windows 10)实测定案,同日修订:
> 发现 64K 上下文 + q8_0/q6_0 KV 会触发 NVIDIA 驱动系统内存回退(详见第四节),
> 最终定案改为 **非 MTP 模型 + kvarn4 KV + 小批次缓冲**,64K 满速约 40 tok/s,且在桌面程序占用约 2GB 显存时仍稳。

## 一、定案配置

| 项目 | 取值 |
| --- | --- |
| 运行时 | BeeLlama v0.4.7(build 11860,CUDA 13.3),`D:\LLM\beellama\bin\llama-server.exe` |
| 模型 | `D:\LLM\beellama\models\Swift-1.5-Qwen3.8-27B-GSQ-RCO-IQ2_XS.gguf`(7.84GB,无 MTP 头版,SHA256 已校验) |
| 视觉投影器 | `D:\LLM\beellama\models\mmproj-Swift-1.5-Qwen3.8-27B-F16.gguf`(927MB,来自 [ukisai/Swift-1.5-Qwen3.8-27B-GGUF](https://huggingface.co/ukisai/Swift-1.5-Qwen3.8-27B-GGUF),GSQ 仓库本身不带) |
| KV 缓存 | `-ctk kvarn4 -ctv kvarn4 --kv-tail-tokens 1024`(kvarn4 方差归一化量化 + 精度尾巴;KLD 0.000994,仍在近无损档,64K 下体积约 1.2GB vs q8/q6 的 2GB、kvarn5 的 1.45GB) |
| 上下文 | `-c 65536`(64K,定案) |
| 视觉放置 | `--no-mmproj-offload`(放 CPU) |
| 采样 | `--temp 1.0 --top-p 0.95 --top-k 20 --min-p 0`(模型卡推荐值) |
| API 模型名 | `swift-1.5-qwen3.8-27b`(`--alias`) |
| 端口 | 8090(插件)/ 8080(脚本) |

> 为什么不用 `-mtp` 版模型:插件固定不启用 MTP(见第三节),无 MTP 头版省 361MB 显存,
> 文本能力完全相同。

一键脚本:`scripts/start-swift27b-64k.bat`(启动,防重复)、`scripts/stop-swift27b.bat`(停止)。

> **应用内 DLC(2026-09-28 起)**:本套调优已作为 BeeLlama DLC 集成进 Agent LLM 应用
> (镜像 ninfer DLC 的托管模式):Agent 页顶部按钮切换 →「BeeLlama DLC」,支持一键启动、
> 接入 dsh、配置编辑(路径/端口/上下文/视觉放置)、实时日志。插件默认参数与本报告定案一致,
> 固定 KV 预设 k8v6(`q8_0/q6_0` + 1024 尾巴),且刻意不暴露 MTP 开关(原因见第三节)。

## 二、完整启动命令

```bat
D:\LLM\beellama\bin\llama-server.exe ^
  -m "D:\LLM\beellama\models\Swift-1.5-Qwen3.8-27B-GSQ-RCO-IQ2_XS.gguf" ^
  --mmproj "D:\LLM\beellama\models\mmproj-Swift-1.5-Qwen3.8-27B-F16.gguf" ^
  --no-mmproj-offload -ngl 99 -c 65536 -b 512 -ub 256 ^
  -fa on -ctk kvarn4 -ctv kvarn4 --kv-tail-tokens 1024 ^
  --temp 1.0 --top-p 0.95 --top-k 20 --min-p 0 ^
  --jinja --alias swift-1.5-qwen3.8-27b --port 8090
```

## 三、实测数据(同机同模型 A/B)

| 配置 | 生成速度 | prefill | 结论 |
| --- | --- | --- | --- |
| BeeLlama + MTP 开 | 6.1 tok/s | 406 ms/token | ❌ MTP 路径拖慢约 5 倍 |
| 官方 llama.cpp b11226 + MTP 开 | 8.1 tok/s | 402 ms/token | ❌ 同样复现,非 fork 独有 |
| BeeLlama + MTP 关 | **42 tok/s** | 30 ms/token | ✅ 正常 |
| 官方 llama.cpp b11226 + MTP 关 | 44.9 tok/s | 32 ms/token | ✅ 与 BeeLlama 相当 |
| 对照:Qwen3.5-9B(同运行时) | 102 tok/s | 11 ms/token | 运行时本身健康 |

**上下文 × KV 二分实测**(2026-09-28 晚,视觉放 CPU,二轮取稳态):

| 上下文 | KV | 生成速度 | 结论 |
| --- | --- | --- | --- |
| 16K | q8_0/q6_0 | 41.0 tok/s | ✅ |
| 32K | q8_0/q6_0 | 40.2 tok/s | ✅ |
| 48K | q8_0/q6_0 | 41.5 tok/s | ✅ |
| 64K | q8_0/q6_0 | **4.5 tok/s** | ❌ 显存贴边触发系统内存回退 |
| 64K | kvarn5/kvarn5 | 40.8 tok/s | ✅ 但余量偏薄,桌面程序多时仍可能回退 |
| 64K | kvarn4/kvarn4 + 小缓冲 | ~40 tok/s | ✅ **定案**:再省 ~320MB,桌面 2GB 时仍稳 |

**MTP 结论**:`--spec-type draft-mtp` 在两个运行时上都使 Qwen3.8-27B 的 prefill 恶化 12 倍、生成恶化 5 倍(MTP 投机本身在工作,接受率 42~49%,但得不偿失)。与社区已知问题一致(llama.cpp issue #27623、discussion #27164)。**在该模型上等待上游修复前不要开启 MTP**。

**投机解码补充实验(2026-09-29)**:①给 MTP 加 `--spec-draft-ngl 99`(草稿上 GPU)仍只有 5.9 tok/s——慢的不是草稿位置,是该模型的 MTP 路径本身,彻底排除;②`ngram-simple` 投机零收益:常规对话 38.8 tok/s(与基线持平),连"复述三遍"的高重复任务接受率也只有 9.7%。**结论:在 Swift 27B 出现专门的 DFlash 草稿模型之前,一切投机解码都不用开**,当前 39~42 tok/s 即为本机该模型的实际水平。

**64K 慢速的根因(重要)**:q8_0/q6_0 KV 在 64K 时约 2GB,总显存需求 ~12.05GB 贴近 12.29GB 物理上限, NVIDIA 驱动会把溢出的 CUDA 分配**静默**落到系统内存(CUDA Sysmem Fallback),表现为速度掉约 10 倍、无任何报错。换 kvarn4(64K 约 1.2GB,KLD 0.000994 仍在近无损档)留出余量即恢复满速。同类症状(突然变慢 10 倍)先怀疑这个,对策:降上下文 / 关桌面程序 / 换更小的 KV 档。

## 四、上下文上限阶梯(视觉模块已加载、kvarn4 KV + 小缓冲)

| 上下文 | 显存占用(轻载桌面) | 速度 | 评价 |
| --- | --- | --- | --- |
| 64K(定案) | ~10.2GB + 桌面 | 41 tok/s | 桌面程序显存 >2GB 时有回退风险,注意第五节症状 |
| 48K | ~9.9GB + 桌面 | 41 tok/s | 稳 |
| 32K | ~9.6GB + 桌面 | 40 tok/s | 稳 |
| 16K | ~9.2GB + 桌面 | 41 tok/s | 最稳 |

再往上(80K+)在 12GB 显存上无法容纳,除非换更小的量化档或降低 KV 精度。

## 五、已知坑与注意事项

1. **mmproj 来源不能搞错**:27B 的视觉投影器在 `ukisai/Swift-1.5-Qwen3.8-27B-GGUF` 仓库;[Flash-Next 仓库的 mmproj](https://huggingface.co/ukisai/Swift-1.5-Qwen3.8-Flash-Next-GGUF) 是另一套架构(hidden 2560 / qwen4_exp),与 27B(hidden 5120 / qwen3_5)不兼容。
2. **必须 `-fa on`**:KV 量化(kvarn4 / q8_0 / q6_0 / 尾巴)只在 FlashAttention 路径下生效。
3. **显存贴边 = 静默 10 倍减速**:64K + 大体积 KV 会触发 NVIDIA 驱动系统内存回退(见第三节),症状是速度骤降且无报错;对策是降上下文 / 换小 KV 档 / 关桌面程序,或把"NVIDIA App → CUDA 系统内存回退策略"设为"首选无回退"(改为直接报 OOM,便于发现)。
4. **GSQ-RCO 仓库只有语言模型**:模型卡明示"vision projector has not been verified for this release",因此视觉文件取自通用 GGUF 仓库。
5. **huggingface.co 需镜像**:国内直连不通,下载用 `https://hf-mirror.com/<repo>/resolve/main/<文件名>`。
6. **模型卡未对长上下文背书**:其 KLD 质量评测仅覆盖 512 token;长上下文下若出现异常输出,优先降低 `-c` 验证。
7. 视觉放 CPU 后,单张小图编码约数秒(6 线程 CPU);大图会更慢,属预期行为。

## 六、与本应用(Agent LLM)集成

**应用内 DLC(推荐)**:Agent 页顶部按钮切换 →「BeeLlama DLC」,托管模式与 ninfer DLC 一致:
获取与安装完整指南见 [BEELLAMA_DLC_GUIDE.md](./BEELLAMA_DLC_GUIDE.md)。

- 一键启动:启动引擎 → 探活就绪 → 接入 dsh(未绑定时)→ 拉起 dsh → 打开界面
- 配置可编辑:引擎/模型/视觉投影器路径、端口(默认 8090)、上下文(默认 65536)、
  API Key(空 = 不鉴权)、视觉投影器放置(CPU/GPU)、局域网开放
- 固定预设:kvarn4 KV(+ 1024 尾巴)、`-ngl 99 -b 512 -ub 256 -fa on --jinja`、
  采样 temp 1.0 / top-p 0.95 / top-k 20(模型卡推荐)
- **刻意不暴露 MTP 开关**:draft-mtp 路径对 Qwen3.8 拖慢约 5 倍(见第三节)
- API 模型名固定为 `swift-1.5-qwen3.8-27b`(`--alias`),供 OpenAI 兼容调用与 dsh 绑定

脚本方式(备选):`scripts/start-swift27b-64k.bat` / `scripts/stop-swift27b.bat`。
