import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // resources：技能库模板、画布与引擎等随包资源（第三方/生成物），不参与 lint。
  globalIgnores(['dist', 'output', 'resources', 'src-tauri/target', 'src-tauri/target-*', 'src-tauri/gen']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
  },
  {
    files: ['src/context/AppContext.tsx'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
])
