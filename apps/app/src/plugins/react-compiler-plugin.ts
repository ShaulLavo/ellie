import type { BunPlugin } from 'bun'

const reactCompilerPlugin: BunPlugin = {
	name: 'react-compiler',
	setup(build) {
		build.onLoad({ filter: /\.[jt]sx$/ }, async args => {
			const { transformSync } = await import('@babel/core')
			const code = await Bun.file(args.path).text()

			const result = transformSync(code, {
				filename: args.path,
				plugins: [
					'babel-plugin-react-compiler',
					['@babel/plugin-transform-typescript', { isTSX: true }],
					['@babel/plugin-transform-react-jsx', { runtime: 'automatic' }]
				]
			})

			return {
				contents: result?.code ?? code,
				loader: 'js'
			}
		})
	}
}

export default reactCompilerPlugin
