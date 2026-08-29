#!/usr/bin/env node
/* eslint-disable no-console */
// Apply Fluent design tokens: replace hex literals in tsx/ts files with var(--token).
// Idempotent. UTF-8 no BOM.
//
// Round 1 (historical): the original script wrapped replacement in `[...]`, producing
//   `border-[#DCD8CF]` -> `border-[[var(--border)]]` (double brackets). Subsequent
//   runs added a half-fix that produced `border-[var(--border)]]` (one extra `]`).
// Round 2 (this run): reverse map every `[var(--xxx)]` (and `[var(--xxx)]-trailing]`)
//   back to the original hex, then re-apply with the *bare* replacement `var(--xxx)`
//   so the existing Tailwind arbitrary-value brackets wrap the result.

const fs = require('fs');
const path = require('path');

const ROOT = process.argv[2] || 'D:/Projects/Agent_LLM/app/src';

const MAP = [
  ['#E2E8F2','text-primary'],['#8E99AD','text-secondary'],['#7D766B','text-secondary'],
  ['#2F2C26','text-primary'],['#403C32','text-primary'],['#8C8576','text-secondary'],
  ['#B8C2D4','text-secondary'],['#A8B2C4','text-secondary'],['#6B7688','text-tertiary'],
  ['#8D867A','text-tertiary'],['#777780','text-tertiary'],['#4E4941','text-primary'],
  ['#625B50','text-secondary'],['#6F685A','text-secondary'],['#A49B8C','text-tertiary'],
  ['#716A5E','text-secondary'],['#8B8B94','text-secondary'],['#A39C8C','text-tertiary'],
  ['#A09A90','text-tertiary'],['#202123','text-primary'],['#817A6D','text-tertiary'],
  ['#7B7468','text-tertiary'],['#5D5D65','text-secondary'],['#5F5F67','text-primary'],
  ['#5E6B7E','text-secondary'],['#AEBBD0','text-secondary'],['#39362E','text-primary'],
  ['#8B8275','text-tertiary'],['#6F675C','text-secondary'],['#9A9082','text-tertiary'],
  ['#969083','text-tertiary'],['#5C6474','text-secondary'],['#5C554B','text-secondary'],
  ['#8A8374','text-tertiary'],['#8A8174','text-tertiary'],['#8D8D8D','text-tertiary'],
  ['#A69E8D','text-tertiary'],['#756E61','text-secondary'],['#2F2C25','text-primary'],
  ['#4D463D','text-primary'],['#6F6F6F','text-tertiary'],['#99999F','text-tertiary'],
  ['#737373','text-tertiary'],['#A5A5A5','text-tertiary'],['#9B9B9B','text-tertiary'],
  ['#888890','text-secondary'],['#92929A','text-tertiary'],['#3A4557','text-tertiary'],
  ['#4A5568','text-secondary'],['#62626A','text-tertiary'],['#B8B1A3','text-tertiary'],
  ['#9C9486','text-tertiary'],['#81796D','text-tertiary'],['#A19A8B','text-tertiary'],
  ['#BBB3A2','text-tertiary'],['#847D6B','text-tertiary'],['#B4B4B4','text-tertiary'],
  ['#7A7264','text-tertiary'],['#B8B0A0','text-tertiary'],['#34343A','text-secondary'],
  ['#3C3C43','text-secondary'],['#66666E','text-tertiary'],['#6F6F78','text-tertiary'],
  ['#71717A','text-tertiary'],
  ['#FBFAF6','app-bg'],['#FAF9F5','surface'],['#F1EEE7','surface-muted'],
  ['#F8F6F1','surface-muted'],['#1C2836','surface-raised'],['#141720','app-bg'],
  ['#1A1E28','surface-raised'],['#222733','surface-raised'],['#0D0F14','app-bg'],
  ['#F1E7DE','surface-muted'],['#EEEAE2','surface-muted'],['#1A2E28','state-success-bg'],
  ['#1E2A3A','state-danger-bg'],['#F6E4DE','state-danger-bg'],['#12151C','app-bg'],
  ['#F8EDE7','state-danger-bg'],['#EDE8DE','surface-muted'],['#EEF8F2','state-success-bg'],
  ['#F0DDD6','state-danger-border'],['#E9E5DA','surface-muted'],['#E6E1D8','surface-muted'],
  ['#F4F4F4','surface-muted'],['#202020','app-bg'],['#242424','surface-raised'],
  ['#FAFAF9','surface'],['#ECECEC','border'],['#10131A','app-bg'],
  ['#11141B','app-bg'],['#F1D4CA','state-danger-border'],['#F2DED4','state-danger-border'],
  ['#F2F8EF','state-success-bg'],['#171B24','app-bg'],['#1B1B1B','app-bg'],
  ['#101010','app-bg'],['#0B0E14','app-bg'],['#0E1219','app-bg'],
  ['#0D0D0D','app-bg'],['#1A2130','surface-raised'],['#232C3E','surface-hover'],
  ['#1C2130','surface-raised'],['#2A2A2A','surface-raised'],['#3A3A3A','surface-raised'],
  ['#303030','app-bg'],['#2A3040','surface'],['#303848','surface-hover'],
  ['#292929','app-bg'],['#29292F','app-bg'],['#211E19','app-bg'],
  ['#2E2A24','app-bg'],['#171717','app-bg'],['#2A241E','surface-muted'],
  ['#2A2113','state-warning-bg'],['#262044','accent-subtle'],['#2E1F4A','accent-subtle'],
  ['#173024','state-success-bg'],['#1C3050','accent'],['#2A4A72','accent'],
  ['#3A6494','accent'],['#4CC2FF','accent'],['#5088BC','accent'],
  ['#2D5632','state-success-border'],['#2D5638','state-success-border'],
  ['#3A5570','state-danger-border'],['#CFE1C8','state-success-border'],
  ['#CFEADA','state-success-border'],['#BFE0C8','state-success-border'],
  ['#F1EFE8','surface-muted'],['#F3EBDD','surface-muted'],['#F4F1EA','surface-muted'],
  ['#F4F0E8','surface-muted'],['#F3EFE7','surface-muted'],['#F6F3ED','surface-hover'],
  ['#F7F4EC','surface-muted'],['#ECEAE4','surface-muted'],['#FAF8F2','surface'],
  ['#FAF3EC','surface'],['#F7F7F8','surface-muted'],['#ECECF1','border'],
  ['#F1E8E1','surface-muted'],['#F4F4F2','surface-muted'],['#F0F0F2','border'],
  ['#F0F0EE','border'],['#EEEEEC','border'],['#DEDEE2','border'],
  ['#DDE4F0','border'],['#E4E4E7','border'],['#E7E7E9','border'],
  ['#E3E3E3','border'],['#D8D8D8','border'],['#747474','text-tertiary'],
  ['#EEE9DE','surface-muted'],['#EBE6DB','border'],
  ['#DCD8CF','border'],['#E3DFD6','border'],['#E2DED5','border'],
  ['#E4E0D8','border'],['#E1DCD0','border'],['#D8D2C5','border'],
  ['#E5E1D8','border'],['#DED9CC','border'],['#DDD8CC','border'],
  ['#E4E0D6','border'],['#E7E2D8','border'],['#E3DED2','border'],
  ['#E5DFD3','border'],['#E2DCD1','border'],['#DCD7CC','border'],
  ['#E2DFD6','border'],['#EAE6DD','border'],['#E6E2D8','border'],
  ['#E8E2D7','border'],['#E4DFD5','border'],['#E7E2D6','border'],
  ['#E0D8CA','border'],['#E8E3D8','border'],['#DED8CC','border'],
  ['#C8C1B4','border'],['#C7DDF4','border'],['#BFD7E8','border'],
  ['#DCC9F0','border'],
  ['#D7663E','accent'],['#D06646','accent'],['#6EA8DC','accent'],
  ['#0078D4','accent'],['#3B82F6','accent'],['#0096FF','accent'],
  ['#2F6FB0','accent'],['#A78BFA','accent'],['#673DB8','accent'],
  ['#6C5DD3','accent'],['#6A4CA3','accent'],['#7A48B5','accent'],
  ['#A8B8F0','accent'],['#B88CFF','accent'],['#2E6E9E','accent'],
  ['#373C46','accent'],['#5A6CFF','accent'],['#6478A0','accent'],
  ['#BE593A','accent-hover'],['#C45732','accent-hover'],['#C65135','accent-hover'],
  ['#DA744D','accent-hover'],['#C4502E','accent-hover'],['#E27750','accent-hover'],
  ['#BE5C3E','accent-hover'],['#8BBDE8','accent-hover'],
  ['#B76540','state-warning'],['#A86A1B','state-warning'],['#6F5A35','state-warning'],
  ['#FF9A00','state-warning'],['#9A6700','state-warning'],['#B26B00','state-warning'],
  ['#7AB8E8','state-warning'],['#D2923B','state-warning'],['#F5C56B','state-warning'],
  ['#D9A324','state-warning'],['#B77800','state-warning'],['#6D4E1D','state-warning'],
  ['#7A4D16','state-warning'],
  ['#FFF7D7','state-warning-bg'],['#FFECA8','state-warning-bg'],
  ['#FFF8DF','state-warning-bg'],['#FFF7E8','state-warning-bg'],['#FFF6E6','state-warning-bg'],
  ['#EACB71','state-warning-border'],['#E8D7A2','state-warning-border'],
  ['#E8CFA6','state-warning-border'],['#E8D3A6','state-warning-border'],
  ['#C44E36','state-danger'],['#B4563B','state-danger'],['#F87171','state-danger'],
  ['#C42B1C','state-danger'],['#FF6347','state-danger'],['#FF5F57','state-danger'],
  ['#5A96D0','state-danger'],['#B42318','state-danger'],['#F0A0A0','state-danger'],
  ['#FF8A70','state-danger'],['#9B664C','state-danger'],
  ['#FFF1EC','state-danger-bg'],['#FFF2EA','state-danger-bg'],['#FDF0EB','state-danger-bg'],
  ['#F4C9B5','state-danger-border'],['#F2B8A4','state-danger-border'],
  ['#E9C7BC','state-danger-border'],['#E8C9BD','state-danger-border'],
  ['#DCC6B9','state-danger-border'],['#E9D0C7','state-danger-border'],
  ['#E7C9BE','state-danger-border'],['#DDBFAE','state-danger-border'],
  ['#C98F70','state-danger-border'],['#C98A70','state-danger-border'],
  ['#E89B79','state-danger-border'],
  ['#2C8B58','state-success'],['#4E7751','state-success'],['#7EC8A0','state-success'],
  ['#34D399','status-loaded'],['#6EA56D','state-success'],['#2A8061','state-success'],
  ['#7EE0A3','state-success'],['#28C840','state-success'],
  ['#E9F3E4','state-success-bg'],['#E7F1E4','state-success-bg'],
  ['#FBBF24','status-loading'],['#FEBC2E','state-warning'],['#BDB8AD','status-standby'],
  ['#EEF6FF','accent-subtle'],['#E7F1F8','accent-subtle'],['#F4ECFA','accent-subtle'],
  ['#F2EEFB','accent-subtle'],['#FCEFE6','state-warning-bg'],
  ['#EEE2FF','accent-subtle'],['#F4ECFF','accent-subtle'],['#D7C7F5','accent-subtle'],
  ['#D9D3FF','accent-subtle'],['#F2F0FF','accent-subtle'],
  ['#FFFFFF','text-on-accent'],
];

const reverse = Object.fromEntries(MAP.map(([hex, token]) => [token.toUpperCase(), hex.toUpperCase()]));

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (/\.(tsx|ts)$/.test(e.name)) out.push(p);
  }
  return out;
}

const files = walk(ROOT);
let totalHits = 0;
let fileHits = 0;

for (const file of files) {
  let content = fs.readFileSync(file, 'utf8');
  let hits = 0;
  // Pass A: reverse any `[var(--token)]` (or `[var(--token)]]` with trailing `]`)
  //   back to the *bracketed* hex literal `[#XXX]` so Pass B can re-apply.
  content = content.replace(/\[var\((--[A-Za-z0-9_-]+)\)\](?:\])?/g, (m, name) => {
    const hex = reverse[name.replace('--','').toUpperCase()];
    if (hex) { hits++; return `[${hex}]`; }
    return m;
  });
  // Pass B: replace bare hex literal with `var(--token)`. Existing `[]` wraps remain.
  for (const [hex, token] of MAP) {
    const pattern = new RegExp(hex.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    const before = content;
    content = content.replace(pattern, `var(--${token})`);
    if (content !== before) hits++;
  }
  if (hits > 0) {
    fs.writeFileSync(file, content, 'utf8');
    fileHits++;
    totalHits += hits;
    console.log(`patched: ${file.slice(ROOT.length + 1)} (${hits} hits)`);
  }
}
console.log(`\nfiles touched: ${fileHits}`);
console.log(`total replacements: ${totalHits}`);
