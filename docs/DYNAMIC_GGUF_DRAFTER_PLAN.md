# Dynamic GGUF 与推理侧车（MTP/DSpark/DFlash）接入方案

> 状态：**Phase 1-3 已实施（2026-08-17），Phase 4 待做**
> 制定日期：2026-08-17
> 背景：调研 unsloth（`unslothai/unsloth`）推理架构后，提炼其对 Agent LLM 有实际价值的接入点。
> 核心结论：**Agent LLM 的 MTP 主链路已经打通，本次补齐了 DSpark/DFlash 侧车识别、子目录布局发现、精度偏好排序与 UD- 动态量化标识。**

## 实施进度

| Phase | 内容 | 状态 |
|-------|------|------|
| 0 | G1 修复：`dspark*`/`dflash*` 不再混入模型列表 | ✅ 已提交（含单测） |
| 1 | 侧车发现（根目录+子目录+精度偏好+防跨模型）、ModelInfo 字段、UD- 标识、缓存签名 | ✅ 已实施（3 个新单测） |
| 2 | ServerConfig 字段、命令行接线、dspark/dflash 启动前校验 | ✅ 已实施 |
| 3 | 前端「推测解码」下拉（off/MTP/DSpark/DFlash）+ 草稿深度 + 徽标/详情 | ✅ 已实施 |
| 4 | README 模型准备指引、侧车自动下载（Post-1.0） | ⏳ 待做 |

---

## 一、背景

unsloth 的 GGUF 推理底层就是 llama-server（llama.cpp），与 Agent LLM 同一引擎。
它对推理体验的增益不在引擎，而在**模型文件的组织方式**：

1. **Dynamic GGUF（UD- 系列）**：按层重要性分配位宽的预量化文件（校准数据 >150 万 token），
   命名带 `UD-` 标记（如 `UD-Q4_K_XL`、`UD-IQ4_XS`），llama.cpp 直接兼容。
2. **推理侧车（drafter）**：与主模型配对的小型草稿模型，配合 llama-server 的
   speculative decoding（`--spec-type` + `-md`）实现 1.4–2.2× 推理加速：
   - **MTP**：多 token 预测头，`mtp-<模型名>.gguf`（Qwen 系列内嵌于主文件，Gemma 4 为独立文件）
   - **DSpark / DFlash**：独立侧车，`dspark-<模型名>.gguf` / `dflash-<模型名>.gguf`
3. Agent LLM 的 `gguf_parser.rs` 已识别 MTP 架构，白名单以**部署内核二进制**中实际存在的
   `<ARCH> MTP` 断言标记为准（勿以 third_party 源码检出为依据，两者版本可能不一致）：
   `qwen35`/`qwen35moe`/`qwen3next`/`cohere2moe`/`step35`/`glm4`/`glm-dsa`/`deepseek32`/`deepseek4`/
   `mimo2`/`nemotron_h_moe`/`hy-v3`，另保留 `gemma4`/`gemma4-assistant` 官方独立草稿配对，
   本方案聚焦把侧车体系补完整。

> ⚠️ 许可证约束：unsloth 的 `studio/` 推理代码为 **AGPL-3.0-only**。本方案仅借鉴其
> **文件命名约定与发现规则**（事实接口，不受版权保护），**不复制任何实现代码**。

---

## 二、现状盘点（已具备，避免重复开发）

| 能力 | 现状 | 位置 |
|------|------|------|
| MTP 架构识别 | ✅ 支持架构白名单 + 内嵌 MTP / 独立 draft 分类 | `gguf_parser.rs` `classify_mtp()` |
| MTP 元数据入库 | ✅ `mtp_support` / `has_embedded_mtp` / `mtp_draft_path` 等字段 | `model_info.rs:42-91` |
| 扫描排除伴生文件 | ✅ 排除 `mmproj*`、`mtp*` 前缀；兄弟文件变化纳入缓存 key | `model_scanner.rs:96-101` `companion_signature()` |
| 加载参数接线 | ✅ `-md <草稿路径>` + `--spec-type`（有草稿时默认 `draft-mtp`）+ `--spec-draft-device` | `process_manager.rs:1633-1653` |
| 前端开关 | ✅ MTP 开关 → `mtp_draft_path` / `spec_type` | `desktop.ts:932-933` |
| 量化标签解析 | ✅ `RE_QUANT` 能从 `UD-Q4_K_XL` 中提取 `Q4_K_XL` | `model_scanner.rs:17-18` |

---

## 三、unsloth 的侧车发现规则（源码提炼，作为需求输入）

来自 `unsloth studio/backend/utils/models/model_config.py`（`detect_mtp_file` / `detect_dspark_file`）：

### 3.1 文件命名约定

| 侧车类型 | 根目录命名 | 子目录命名 | 精度偏好 |
|----------|-----------|-----------|---------|
| MTP | `mtp-<模型名>.gguf` | `MTP/mtp-<模型名>.gguf` 或 `<模型名>-MTP-*.gguf` | **Q4_0 最优**（最小优先） |
| DSpark | `dspark-<模型名>.gguf` | `dspark/dspark-<模型名>.gguf` | **Q8_0 最优**（模型卡推荐） |
| DFlash | `dflash-<模型名>.gguf` | 同上模式 | Q8_0 优先 |
| mmproj（已有） | `mmproj*.gguf` | — | — |

### 3.2 配对规则（防跨模型误挂）

- `<模型名>` 必须是主模型文件名的**前缀**（跨家族与具体版本双层匹配，更长前缀优先）：
  多模型同目录时 `mtp-model.gguf` 不会挂到 `model_v2-*.gguf` 上。
- 分片侧车（`-00001-of-00002.gguf`）折叠到分片 1，按总大小参与排序。
- 精度排序仅在候选间比较：MTP = 最小体积优先 → Q4_0 → Q8_0 → BF16/F16；
  DSpark = 家族特异性 → Q8_0 → 体积 → 文件名稳定序。

### 3.3 llama-server 传递方式

- 侧车路径：`-md <path>`（即 `--model-draft`）
- 模式：`--spec-type mtp|dspark|dflash|ngram|mtp+ngram|off`（可逗号链式）；
  旧拼写 `draft-mtp`/`draft-dspark` 仍被接受
- 深度：`--spec-draft-n-max`（1..16，可选）
- **能力探测**：启动前探测 llama-server 是否支持对应 spec 类型
  （unsloth 检测 `--spec-type draft-dspark` 可用性，不支持则跳过侧车并警告，不阻断加载）

---

## 四、差距分析（本方案要解决的）

| 编号 | 差距 | 影响 | 优先级 |
|------|------|------|--------|
| G1 | `dspark-*.gguf` / `dflash-*.gguf` 未被识别为伴生文件，会以"损坏的独立模型"出现在模型列表 | 用户困惑、误加载失败 | **P0** |
| G2 | 无侧车发现逻辑：MTP 仅靠文件名前缀排除，未主动发现并绑定到主模型 | Gemma 4 等外置 MTP 无法自动配对 | **P0** |
| G3 | 不扫描 `MTP/`、`dspark/` 子目录布局 | 官方 HF 仓库布局下侧车丢失 | P1 |
| G4 | 无精度偏好与家族前缀匹配 | 多模型目录可能挂错侧车 | P1 |
| G5 | `spec_type` 前端硬编码 `'draft-mtp'`（旧拼写），无 dspark/dflash/ngram 选项 | 无法使用 DSpark 加速 | P1 |
| G6 | 无 llama-server spec 能力探测，旧版内核带 `--spec-type draft-dspark` 会启动失败 | 兼容性风险 | P1 |
| G7 | `UD-` 动态量化标识未解析展示，用户无法区分动态/静态量化 | 信息展示缺失 | P2 |
| G8 | 无 `--spec-draft-n-max`（草稿深度）显式参数 | 高级调参缺失 | P2 |

---

## 五、实施方案

### Phase 1（P0）：侧车识别与发现（纯 Rust 后端）

**1.1 扩展伴生文件排除**（`model_scanner.rs`）

```rust
fn is_companion_gguf_stem(lower_stem: &str) -> bool {
    lower_stem.starts_with("mmproj")
        || lower_stem.contains("mmproj")
        || lower_stem.starts_with("mtp")
        || lower_stem.starts_with("dspark")   // 新增
        || lower_stem.starts_with("dflash")   // 新增
}
```

**1.2 新增侧车发现模块** `services/drafter_discovery.rs`

```
discover_drafters(model_path) -> DrafterBundle
  ├─ 同目录扫描：mtp-* / dspark-* / dflash-*.gguf
  ├─ 子目录扫描：MTP/ dspark/ dflash/（同名规则，另接受 <模型名>-MTP-*.gguf）
  ├─ 家族前缀匹配：<模型名> 前缀越长越优先；不匹配则丢弃
  ├─ 精度排序：MTP → 最小体积/Q4_0 优先；DSpark/DFlash → Q8_0 优先
  └─ 分片折叠：-00001-of-00005 → 取分片 1，按总大小排序
返回 DrafterBundle {
    mtp: Option<PathBuf>,
    dspark: Option<PathBuf>,
    dflash: Option<PathBuf>,
}
```

**1.3 数据模型扩展**（`model_info.rs`）

```rust
pub struct ModelInfo {
    // ...现有字段
    pub mtp_draft_path: Option<String>,      // 已有
    pub dspark_draft_path: Option<String>,   // 新增
    pub dflash_draft_path: Option<String>,   // 新增
    pub is_dynamic_quant: bool,              // 新增（G7）：文件名含 UD- 量化标记
}
```

**1.4 缓存 key 纳入侧车目录**

`companion_signature()` 目前只哈希同目录兄弟 `.gguf`；扩展为同时哈希
`MTP/`、`dspark/`、`dflash/` 子目录内容，保证侧车增删后缓存失效。

### Phase 2（P1）：加载接线与能力探测

**2.1 ServerConfig 扩展**（`server_config.rs`，全部 `#[serde(default)]` 向后兼容）

```rust
pub dspark_draft_path: Option<String>,   // 新增
pub dflash_draft_path: Option<String>,   // 新增
pub spec_draft_n_max: Option<u32>,       // 新增（G8，1..16，None=不传）
```

**2.2 命令行生成**（`process_manager.rs`，在现有 `-md` 逻辑处扩展）

- 三个侧车互斥使用（同一时刻只有一个 `-md`），优先级：MTP > DSpark > DFlash。
- `--spec-type` 取值跟随所选侧车类型：`mtp` / `dspark` / `dflash`；
  新拼写与旧 `draft-mtp` 等价，保持前端传什么后端用什么，**后端不改写用户选择**。
- `--spec-draft-n-max` 仅在用户显式设置时传递。

**2.3 能力探测**（G6）

复用现有 `append_server_tools` 的能力探测机制（`process_manager.rs:290` 附近已有
兼容白名单回退）。新增：启动前解析 llama-server `--help` 中是否含
`--spec-type` 各取值；不支持时：

- 日志警告（中文）：「当前 llama-server 内核不支持 {类型} 推测解码，已跳过侧车」
- **跳过侧车参数继续启动**（不失败、不改其它参数），与 unsloth 行为一致

### Phase 3（P1）：前端 UI

**3.1 加载页参数区**（沿用现有 MTP 开关位置）

- MTP 开关（已有）→ 保持不变
- 新增「推测解码（speculative）」下拉：`关闭 | MTP | DSpark | DFlash | ngram`
  - 仅列出扫描发现的可用侧车（无 DSpark 侧车则不显示该选项）
  - 显式选择才传参；默认「关闭」，**不静默开启**（遵循 AGENTS.md 参数基线原则）
- 高级折叠区新增「草稿深度（--spec-draft-n-max）」数字输入（1–16，留空=默认）

**3.2 模型卡片/详情**

- 新增徽标：「动态量化（UD）」— 当 `is_dynamic_quant` 为真
- 新增徽标：「MTP / DSpark / DFlash 已检测」— 显示发现的侧车文件名（tooltip 完整路径）

**3.3 类型同步**（`types/index.ts` + `desktop.ts`）

```typescript
interface ModelInfo {
  dsparkDraftPath?: string;
  dflashDraftPath?: string;
  isDynamicQuant?: boolean;
}
```

### Phase 4（P2）：收尾

- CHANGELOG 条目 + README「模型准备」一节：指引从 unsloth/HF 下载
  `UD-` 系列 GGUF 与侧车文件的推荐目录布局
- 侧车下载（如模型下载页支持 HF 仓库拉取时自动带侧车）→ 列入 Post-1.0

---

## 六、参数显式性约定（遵循 AGENTS.md）

1. **所有侧车/推测解码参数默认关闭**。默认启动行为与本方案落地前完全一致
   （`spec_type=None`、无 `-md`）。
2. 用户显式开启后，选择持久化到该模型的参数预设（与 ngl/ctx 同机制）。
3. 能力探测导致的"跳过侧车"必须在日志与 UI 明示，不得静默降级。
4. 不修改任何现有默认值：`ngl`/`ctx`/batch/parallel/KV 等一概不动。

---

## 七、测试与验收

| 用例 | 预期 |
|------|------|
| 目录含 `dspark-model.gguf` 无主模型 | 不出现在模型列表（G1） |
| 主模型 + 同名 `mtp-`/`dspark-` 侧车 | 扫描后 ModelInfo 正确绑定侧车路径 |
| 主模型 + `MTP/`、`dspark/` 子目录布局 | 侧车被发现并绑定 |
| 多模型同目录，侧车名仅前缀匹配其一 | 不跨模型误挂（G4） |
| 同类型多个精度侧车（Q4_0/Q8_0/BF16） | MTP 选最小/Q4_0，DSpark 选 Q8_0 |
| 旧版 llama-server（无 `--spec-type dspark`） | 警告 + 跳过侧车，正常启动（G6） |
| 显式开启 MTP 加载 | 进程命令行含 `-md` 与 `--spec-type`，日志可复制验证 |
| 默认加载（不动开关） | 命令行与现状逐字节一致（回归基线） |
| `UD-Q4_K_XL` 文件 | 量化标签 `Q4_K_XL` + 动态量化徽标（G7） |
| 侧车文件增删后重扫 | 缓存失效，重新发现（伴生签名变化） |

Rust 单测落在 `drafter_discovery.rs`（纯函数，参考 `gguf_parser.rs` 现有测试风格）；
前端用 Vitest 覆盖开关 → 参数映射。

---

## 八、风险与边界

| 风险 | 缓解 |
|------|------|
| llama.cpp `--spec-type` 取值随版本漂移 | 能力探测 + 兼容白名单回退；旧拼写 `draft-mtp` 保留兼容 |
| 侧车与主模型不匹配导致加载失败 | 家族前缀匹配 + 启动失败时的中文错误指引（提示检查侧车配对） |
| 用户误以为侧车会默认加速 | UI 文案明确「需手动开启」；徽标仅表示"检测到" |
| AGPL 污染 | 只实现命名/目录约定（事实接口），不参考其代码结构逐行翻译；评审时复查 |
| DSpark 侧车体积（Q8_0 较大） | 模型详情展示侧车文件大小，供用户判断 |

---

## 九、工作量估算

| Phase | 内容 | 规模 |
|-------|------|------|
| 1 | 扫描/发现/数据模型（Rust） | ~300 行 + 测试 |
| 2 | 命令行生成 + 能力探测（Rust） | ~150 行 |
| 3 | 前端 UI + 类型 | ~250 行 |
| 4 | 文档与收尾 | 文档 |

建议按 Phase 1 → 2 → 3 顺序独立提交，可分别回归。
