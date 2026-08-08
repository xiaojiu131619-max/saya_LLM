#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_ROOT = process.env.AGENT_LLM_EVAL_ROOT ?? '';
const DEFAULT_BASE_URL = 'http://127.0.0.1:8080';
const ROUND_FILES = [
  { round: 1, file: '01_第1次测试_认知判断组.md', max: 54, label: '第1次测试：认知判断组' },
  { round: 2, file: '02_第2次测试_工程规划组.md', max: 30, label: '第2次测试：工程规划组' },
  { round: 3, file: '03_第3次测试_推导批判组.md', max: 42, label: '第3次测试：推导批判组' },
  { round: 4, file: '04_第4次测试_表达感知组.md', max: 18, label: '第4次测试：表达感知组（含M12附加）' },
  { round: 5, file: '05_第5次测试_长文本组.md', max: 18, label: '第5次测试：长文本组' },
];

const BATCH_FILE_PATTERNS = [
  [/批次\s*A/i, 1],
  [/批次\s*B/i, 2],
  [/批次\s*C/i, 3],
  [/批次\s*D/i, 4],
  [/批次\s*E/i, 5],
  [/01_第1次|第1次|round[_ -]?1/i, 1],
  [/02_第2次|第2次|round[_ -]?2/i, 2],
  [/03_第3次|第3次|round[_ -]?3/i, 3],
  [/04_第4次|第4次|round[_ -]?4/i, 4],
  [/05_第5次|第5次|round[_ -]?5/i, 5],
];

function parseArgs(argv) {
  const args = {
    root: DEFAULT_ROOT,
    answers: null,
    model: null,
    baseUrl: DEFAULT_BASE_URL,
    out: null,
    onlyModel: null,
    round: null,
    dryRun: false,
    concurrency: 1,
    timeoutMs: 10 * 60 * 1000,
    maxTokens: 4096,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root') args.root = argv[++i];
    else if (arg === '--answers') args.answers = argv[++i];
    else if (arg === '--model') args.model = argv[++i];
    else if (arg === '--base-url') args.baseUrl = argv[++i].replace(/\/$/, '');
    else if (arg === '--out') args.out = argv[++i];
    else if (arg === '--only-model') args.onlyModel = argv[++i];
    else if (arg === '--round') args.round = Number(argv[++i]);
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--concurrency') args.concurrency = Math.max(1, Number(argv[++i]));
    else if (arg === '--timeout-ms') args.timeoutMs = Number(argv[++i]);
    else if (arg === '--max-tokens') args.maxTokens = Number(argv[++i]);
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }
  args.answers ??= path.join(args.root, '答案');
  args.out ??= path.join(args.root, '评分输出');
  if (!args.root.trim()) {
    throw new Error('缺少测试集根目录：请用 --root 指定，或设置环境变量 AGENT_LLM_EVAL_ROOT');
  }
  return args;
}

function printHelp() {
  console.log(`LLM 能力测评 v4.2 自动评分器

用法：
  npm run eval:v4.2 -- --dry-run
  npm run eval:v4.2 -- --base-url http://127.0.0.1:8080 --model local-model
  npm run eval:v4.2 -- --only-model "Qwen3.5 9B Uncensored" --round 1

参数：
  --root <路径>          测试集根目录，默认取环境变量 AGENT_LLM_EVAL_ROOT
  --answers <路径>       答案目录，默认 <root>\\答案
  --out <路径>           输出目录，默认 <root>\\评分输出
  --base-url <URL>       OpenAI 兼容接口地址，默认 http://127.0.0.1:8080
  --model <名称>         judge 模型名；不填则自动读取 /v1/models 的第一个模型
  --only-model <名称>    只评分某个答案子目录
  --round <1-5>          只评分某个批次
  --dry-run              只扫描结构，不调用模型
  --concurrency <数量>   并发评分数量，默认 1
  --timeout-ms <毫秒>    单次 judge 超时，默认 600000
  --max-tokens <数量>    judge 最大输出 token，默认 4096`);
}

async function readText(filePath) {
  return fs.readFile(filePath, 'utf8');
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function listFilesRecursive(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await listFilesRecursive(fullPath));
    else files.push(fullPath);
  }
  return files;
}

function detectRound(filePath) {
  const name = path.basename(filePath);
  for (const [pattern, round] of BATCH_FILE_PATTERNS) {
    if (pattern.test(name)) return round;
  }
  return null;
}

function isAnswerFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const name = path.basename(filePath).toLowerCase();
  if (!['.txt', '.md'].includes(ext)) return false;
  if (name.includes('批改答案')) return false;
  return detectRound(filePath) !== null;
}

async function discoverAnswerSets(answersDir, onlyModel) {
  const modelDirs = [];
  const entries = await fs.readdir(answersDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === '模板') continue;
    const modelRoot = path.join(answersDir, entry.name);
    const files = [];
    for (const file of (await listFilesRecursive(modelRoot)).filter(isAnswerFile)) {
      const stat = await fs.stat(file);
      if (stat.size > 0) files.push(file);
    }
    if (files.length === 0) continue;
    if (onlyModel && !entry.name.includes(onlyModel)) continue;
    const rounds = new Map();
    for (const file of files) {
      const round = detectRound(file);
      if (round && !rounds.has(round)) rounds.set(round, file);
    }
    modelDirs.push({ name: entry.name, root: modelRoot, rounds });
  }
  return modelDirs;
}

async function loadRoundQuestions(root) {
  const rounds = new Map();
  for (const info of ROUND_FILES) {
    const filePath = path.join(root, info.file);
    if (await pathExists(filePath)) {
      rounds.set(info.round, { ...info, path: filePath, content: await readText(filePath) });
    }
  }
  return rounds;
}

async function resolveJudgeModel(baseUrl, explicitModel) {
  if (explicitModel) return explicitModel;
  const response = await fetch(`${baseUrl}/v1/models`);
  if (!response.ok) throw new Error(`读取 /v1/models 失败：HTTP ${response.status}`);
  const data = await response.json();
  const model = data?.data?.[0]?.id;
  if (!model) throw new Error('/v1/models 没有返回模型 id，请用 --model 指定');
  return model;
}

function buildJudgePrompt({ scorer, question, answer, modelName, roundInfo }) {
  return `你是严格的 LLM 能力测评 v4.2 裁判。请只根据给定评分器、题目和被测模型答案评分，不要替被测模型补全答案。

评分要求：
1. 严格按 0-3 分锚点逐题评分。
2. 第1次的 M1/M2/M10 需要检查 confidence 并应用校准/过度自信规则。
3. M3 代码题如果无法实际运行，必须标注“未运行，按静态审查估分”。
4. M8 必须严格文本绑定，引用外部知识该题 0 分。
5. 输出必须是合法 JSON，不要 Markdown，不要代码块。

JSON 格式：
{
  "model_name": "${jsonEscape(modelName)}",
  "round": ${roundInfo.round},
  "round_label": "${jsonEscape(roundInfo.label)}",
  "core_score": 0,
  "core_max": ${roundInfo.round === 4 ? 12 : roundInfo.max},
  "extra_score": 0,
  "extra_max": ${roundInfo.round === 4 ? 6 : 0},
  "items": [
    {"id":"M1-1","score":0,"max":3,"confidence":null,"comment":"简短扣分原因"}
  ],
  "summary": "总体评价",
  "strengths": ["亮点"],
  "weaknesses": ["短板"]
}

【评分器】
${scorer}

【题目】
${question}

【被测模型答案】
${answer}`;
}

function jsonEscape(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

async function callJudge({ baseUrl, model, prompt, timeoutMs, maxTokens }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: '你是严格、保守、可复现的中文评分裁判。只输出合法 JSON。' },
          { role: 'user', content: prompt },
        ],
        temperature: 0,
        max_tokens: maxTokens,
      }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`judge HTTP ${response.status}: ${text.slice(0, 500)}`);
    const data = JSON.parse(text);
    return data?.choices?.[0]?.message?.content ?? '';
  } finally {
    clearTimeout(timeout);
  }
}

function parseJudgeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('judge 未返回 JSON');
    return JSON.parse(match[0]);
  }
}

function gradeFromScore(score) {
  if (score >= 140) return 'S';
  if (score >= 110) return 'A';
  if (score >= 85) return 'B';
  if (score >= 55) return 'C';
  return 'D';
}

function toCsvCell(value) {
  const text = value == null ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function buildMarkdownReport(result) {
  const totalCore = result.rounds.reduce((sum, round) => sum + Number(round.core_score ?? 0), 0);
  const totalExtra = result.rounds.reduce((sum, round) => sum + Number(round.extra_score ?? 0), 0);
  const lines = [
    `# LLM 能力测评 v4.2 自动评分报告`,
    ``,
    `- 被测模型：${result.model_name}`,
    `- Judge 模型：${result.judge_model}`,
    `- 评分时间：${result.created_at}`,
    `- 核心总分：${totalCore.toFixed(2)} / 156`,
    `- 附加分：${totalExtra.toFixed(2)} / 6`,
    `- 等级：${gradeFromScore(totalCore)}`,
    ``,
    `## 批次汇总`,
    `| 批次 | 核心得分 | 附加分 | 评价 |`,
    `|---|---:|---:|---|`,
  ];
  for (const round of result.rounds) {
    lines.push(`| ${round.round_label ?? `第${round.round}次`} | ${round.core_score ?? 0} / ${round.core_max ?? ''} | ${round.extra_score ?? 0} / ${round.extra_max ?? 0} | ${round.summary ?? ''} |`);
  }
  lines.push('', '## 逐题明细');
  for (const round of result.rounds) {
    lines.push('', `### ${round.round_label ?? `第${round.round}次`}`);
    for (const item of round.items ?? []) {
      lines.push(`- ${item.id}: ${item.score}/${item.max ?? 3}，confidence=${item.confidence ?? '无'}，${item.comment ?? ''}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

async function writeReports(outDir, results) {
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, 'results.json'), `${JSON.stringify(results, null, 2)}\n`, 'utf8');
  const csvRows = [['模型', 'Judge', '批次', '题号', '得分', '满分', 'confidence', '评语']];
  for (const result of results) {
    for (const round of result.rounds) {
      for (const item of round.items ?? []) {
        csvRows.push([result.model_name, result.judge_model, round.round_label ?? round.round, item.id, item.score, item.max ?? 3, item.confidence ?? '', item.comment ?? '']);
      }
    }
  }
  await fs.writeFile(path.join(outDir, 'items.csv'), csvRows.map((row) => row.map(toCsvCell).join(',')).join('\n'), 'utf8');
  for (const result of results) {
    const safeName = result.model_name.replace(/[\\/:*?"<>|]/g, '_');
    await fs.writeFile(path.join(outDir, `${safeName}.md`), buildMarkdownReport(result), 'utf8');
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const scorerPath = path.join(args.root, 'LLM能力测评评分器_Skills_v4.2.md');
  const fallbackScorerPath = path.join(args.root, 'LLM 能力测评评分器 v4.2.md');
  const scorer = await readText(await pathExists(scorerPath) ? scorerPath : fallbackScorerPath);
  const questions = await loadRoundQuestions(args.root);
  const answerSets = await discoverAnswerSets(args.answers, args.onlyModel);
  const jobs = [];
  for (const answerSet of answerSets) {
    for (const [round, file] of answerSet.rounds.entries()) {
      if (args.round && round !== args.round) continue;
      const roundInfo = questions.get(round);
      if (!roundInfo) continue;
      const content = await readText(file);
      if (!content.trim()) continue;
      jobs.push({ answerSet, roundInfo, file, answer: content });
    }
  }

  console.log(`测试集：${args.root}`);
  console.log(`答案目录：${args.answers}`);
  console.log(`发现模型目录：${answerSets.length}`);
  console.log(`待评分批次：${jobs.length}`);

  if (args.dryRun) {
    for (const answerSet of answerSets) {
      const rounds = [...answerSet.rounds.entries()]
        .map(([round, file]) => `第${round}次=${path.relative(answerSet.root, file)}`)
        .join('；');
      console.log(`- ${answerSet.name}: ${rounds}`);
    }
    return;
  }

  const judgeModel = await resolveJudgeModel(args.baseUrl, args.model);
  console.log(`Judge 模型：${judgeModel}`);
  const grouped = new Map();
  let completed = 0;
  for (const job of jobs) {
    const prompt = buildJudgePrompt({
      scorer,
      question: job.roundInfo.content,
      answer: job.answer,
      modelName: job.answerSet.name,
      roundInfo: job.roundInfo,
    });
    console.log(`[${completed + 1}/${jobs.length}] 评分 ${job.answerSet.name} - 第${job.roundInfo.round}次`);
    const raw = await callJudge({
      baseUrl: args.baseUrl,
      model: judgeModel,
      prompt,
      timeoutMs: args.timeoutMs,
      maxTokens: args.maxTokens,
    });
    const parsed = parseJudgeJson(raw);
    parsed.source_file = job.file;
    if (!grouped.has(job.answerSet.name)) {
      grouped.set(job.answerSet.name, {
        model_name: job.answerSet.name,
        judge_model: judgeModel,
        created_at: new Date().toISOString(),
        rounds: [],
      });
    }
    grouped.get(job.answerSet.name).rounds.push(parsed);
    completed += 1;
  }
  const results = [...grouped.values()].map((result) => ({
    ...result,
    rounds: result.rounds.sort((a, b) => Number(a.round) - Number(b.round)),
  }));
  await writeReports(args.out, results);
  console.log(`评分完成：${args.out}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
