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

      // 字号只缩放文字，不缩放 rem 间距：根字号固定 16px，font-size 统一乘
      // --ui-font-scale。行高同步缩放，避免 150% 时文字挤在一起。
      fontSize: {
        xs: ['calc(0.75rem * var(--ui-font-scale, 1))', { lineHeight: '1.3333' }],
        sm: ['calc(0.875rem * var(--ui-font-scale, 1))', { lineHeight: '1.4286' }],
        base: ['calc(1rem * var(--ui-font-scale, 1))', { lineHeight: '1.5' }],
        lg: ['calc(1.125rem * var(--ui-font-scale, 1))', { lineHeight: '1.5556' }],
        xl: ['calc(1.25rem * var(--ui-font-scale, 1))', { lineHeight: '1.4' }],
        '2xl': ['calc(1.5rem * var(--ui-font-scale, 1))', { lineHeight: '1.3333' }],
        '3xl': ['calc(1.875rem * var(--ui-font-scale, 1))', { lineHeight: '1.2' }],
        '4xl': ['calc(2.25rem * var(--ui-font-scale, 1))', { lineHeight: '1.1111' }],
        '5xl': ['calc(3rem * var(--ui-font-scale, 1))', { lineHeight: '1' }],
        '6xl': ['calc(3.75rem * var(--ui-font-scale, 1))', { lineHeight: '1' }],
        '7xl': ['calc(4.5rem * var(--ui-font-scale, 1))', { lineHeight: '1' }],
      },

      lineHeight: {
        3: 'calc(0.75rem * var(--ui-font-scale, 1))',
        4: 'calc(1rem * var(--ui-font-scale, 1))',
        5: 'calc(1.25rem * var(--ui-font-scale, 1))',
        6: 'calc(1.5rem * var(--ui-font-scale, 1))',
        7: 'calc(1.75rem * var(--ui-font-scale, 1))',
        8: 'calc(2rem * var(--ui-font-scale, 1))',
        9: 'calc(2.25rem * var(--ui-font-scale, 1))',
        10: 'calc(2.5rem * var(--ui-font-scale, 1))',
      },

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
