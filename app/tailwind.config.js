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

      // 圆角：把 Tailwind 的 rounded-* 全部接到 index.css 的 --radius-* 令牌上，
      // 消除「令牌 4/8/10/14/16」与「Tailwind 默认 4/6/8/12」两套刻度并存的问题。
      // rounded(4)/md(4)/lg(8)/xl(14=panel)/2xl(16=bubble)，语义别名另开 field/panel/bubble。
      borderRadius: {
        none: '0',
        sm: 'var(--radius-sm)',
        DEFAULT: 'var(--radius-sm)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
        xl: 'var(--radius-panel)',
        '2xl': 'var(--radius-bubble)',
        full: 'var(--radius-pill)',
        field: 'var(--radius-field)',
        panel: 'var(--radius-panel)',
        bubble: 'var(--radius-bubble)',
      },

      // 阴影：同理接到 --shadow-* 三级令牌，避免 Tailwind 默认阴影（偏移更硬的实色）
      // 与 Fluent 的柔和双层阴影混用。语义映射：
      // sm/md = 卡片刻度；lg/xl = 浮层（下拉、气泡菜单、侧滑面板）；2xl = 对话框。
      boxShadow: {
        sm: 'var(--shadow-card)',
        DEFAULT: 'var(--shadow-card)',
        md: 'var(--shadow-card)',
        lg: 'var(--shadow-flyout)',
        xl: 'var(--shadow-flyout)',
        '2xl': 'var(--shadow-dialog)',
        card: 'var(--shadow-card)',
        flyout: 'var(--shadow-flyout)',
        dialog: 'var(--shadow-dialog)',
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
}
