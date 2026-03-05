/** Typed HTTP errors that carry their own status code. */

export class HttpError extends Error {
	readonly status: number
	constructor(status: number, message: string) {
		super(message)
		this.status = status
	}
}

export class BadRequestError extends HttpError {
	constructor(message: string) {
		super(400, message)
	}
}

export class NotFoundError extends HttpError {
	constructor(message: string) {
		super(404, message)
	}
}
