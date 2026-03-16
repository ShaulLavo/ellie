import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactCompiler from 'eslint-plugin-react-compiler'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
	globalIgnores(['dist', 'src/components/animate-ui']),
	{
		files: ['**/*.{ts,tsx}'],
		extends: [
			js.configs.recommended,
			tseslint.configs.recommended,
			reactHooks.configs.flat['recommended-latest'],
			reactRefresh.configs.vite
		],
		plugins: {
			'react-compiler': reactCompiler
		},
		languageOptions: {
			ecmaVersion: 2020,
			globals: globals.browser
		},
		rules: {
			'react-compiler/react-compiler': 'error',
			'react-hooks/exhaustive-deps': 'off',
			'@typescript-eslint/no-unused-vars': [
				'error',
				{ argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
			]
		}
	},
	{
		files: [
			'src/components/ui/**/*.tsx',
			'src/components/ai-elements/**/*.tsx',
			'src/hooks/**/*.{ts,tsx}'
		],
		rules: {
			'react-refresh/only-export-components': 'off'
		}
	}
])
