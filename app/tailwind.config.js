/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ["class"],
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      // Tailwind v3 默认 spacing 刻度有 3.5 但没有 4.5，因此代码里的
      // h-4.5 / w-4.5 不生成任何 CSS，lucide 图标回落到默认 24×24px，
      // 反而比它旁边的 15px 区块标题更大。补齐该刻度（18px）。
      spacing: { 4.5: '1.125rem' },
    },
  },
  plugins: [require("tailwindcss-animate")],
}
