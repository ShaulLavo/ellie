import { createDurableStreamServer } from "./server"

export { createDurableStreamServer } from "./server"

const port = parseInt(Bun.env.PORT ?? `4437`)
const { app } = createDurableStreamServer({ port })

app.listen(port)

console.log(`Durable Streams server running at http://localhost:${port}`)
