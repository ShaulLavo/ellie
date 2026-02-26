import './output.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client'
import { ReactQueryDevtools } from '@tanstack/react-query-devtools'
import { ConfirmDialogProvider } from '@omit/react-confirm-dialog'
import { ThemeProvider } from './hooks/use-theme.tsx'
import { queryClient } from './lib/query-client'
import { idbPersister } from './lib/persister'
import App from './App.tsx'

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
					<App />
				</ConfirmDialogProvider>
				<ReactQueryDevtools initialIsOpen={false} />
			</PersistQueryClientProvider>
		</ThemeProvider>
	</StrictMode>
)
