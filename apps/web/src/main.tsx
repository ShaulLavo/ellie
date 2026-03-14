import '@fontsource-variable/bricolage-grotesque'
import '@fontsource-variable/geist/wght.css'
import '@fontsource-variable/jetbrains-mono'
import './styles.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from '@tanstack/react-router'
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client'
import { ConfirmDialogProvider } from '@omit/react-confirm-dialog'
import { ThemeProvider } from './hooks/use-theme.tsx'
import { queryClient } from './lib/query-client'
import { localStoragePersister } from './lib/persister'
import { router } from './router'

createRoot(document.getElementById('root')!).render(
	<StrictMode>
		<ThemeProvider>
			<PersistQueryClientProvider
				client={queryClient}
				persistOptions={{
					persister: localStoragePersister,
					maxAge: Number.POSITIVE_INFINITY,
					dehydrateOptions: {
						shouldDehydrateQuery: query => {
							const key = query.queryKey[0]
							if (
								typeof key === 'string' &&
								key.startsWith('/db')
							)
								return false
							return query.state.status === 'success'
						}
					}
				}}
			>
				<ConfirmDialogProvider>
					<RouterProvider router={router} />
				</ConfirmDialogProvider>
			</PersistQueryClientProvider>
		</ThemeProvider>
	</StrictMode>
)
