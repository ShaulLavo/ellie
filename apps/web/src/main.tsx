import '@fontsource-variable/bricolage-grotesque'
import '@fontsource-variable/geist/wght.css'
import '@fontsource-variable/jetbrains-mono'
import './output.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from '@tanstack/react-router'
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client'
import { ConfirmDialogProvider } from '@omit/react-confirm-dialog'
import { ThemeProvider } from './hooks/use-theme.tsx'
import { queryClient } from './lib/query-client'
import { idbPersister } from './lib/persister'
import { router } from './router'

createRoot(document.getElementById('root')!).render(
	<StrictMode>
		<ThemeProvider>
			<PersistQueryClientProvider
				client={queryClient}
				persistOptions={{
					persister: idbPersister,
					maxAge: 1000 * 60 * 60 * 24
				}}
			>
				<ConfirmDialogProvider>
					<RouterProvider router={router} />
				</ConfirmDialogProvider>
			</PersistQueryClientProvider>
		</ThemeProvider>
	</StrictMode>
)
