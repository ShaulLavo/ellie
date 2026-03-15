export interface ClientEnv {
	readonly API_BASE_URL: string
}

export const env: ClientEnv = {
	API_BASE_URL: window.location.origin
}
