export interface HttpRouteDispatchOptions {
  connectedClients: number;
  manifestPath: string;
}

type RouteHandler = (
  req: Request,
  path: string,
  options: HttpRouteDispatchOptions,
) => Response | Promise<Response>;

interface RouteDefinition {
  method: string;
  path: string;
  handler: RouteHandler;
}

const routes: RouteDefinition[] = [
  {
    method: "GET",
    path: "/api/status",
    handler: (_req, _path, options) =>
      Response.json({
        connectedClients: options.connectedClients,
      }),
  },
  {
    method: "GET",
    path: "/manifest.json",
    handler: (_req, _path, options) =>
      new Response(Bun.file(options.manifestPath), {
        headers: { "Content-Type": "application/manifest+json" },
      }),
  },
];

export async function dispatchHttpRoute(
  req: Request,
  path: string,
  options: HttpRouteDispatchOptions,
): Promise<Response | null> {
  const route = routes.find((candidate) => {
    return candidate.path === path && candidate.method === req.method;
  });
  if (!route) return null;
  return route.handler(req, path, options);
}
