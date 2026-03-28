import 'server-only';

import { resolveRequestClientIp } from '@/lib/clientIp';
import { logger, serializeError } from '@/lib/logger';

type RouteHandler<TContext> = (
  req: Request,
  context: TContext
) => Response | Promise<Response>;

type DefaultRouteContext = {
  params: Promise<Record<string, string>>;
};

export function withRequestLogging<TContext = DefaultRouteContext>(
  routeName: string,
  handler: RouteHandler<TContext>
) {
  return async (req: Request, context: TContext): Promise<Response> => {
    const startedAt = Date.now();
    const url = new URL(req.url);
    const requestLogger = logger.child({
      component: 'http',
      route: routeName,
      method: req.method,
      path: url.pathname,
      clientIp: resolveRequestClientIp(req),
    });

    try {
      const response = await handler(req, context);
      requestLogger.info(
        {
          status: response.status,
          durationMs: Date.now() - startedAt,
        },
        'HTTP request completed'
      );
      return response;
    } catch (error) {
      requestLogger.error(
        {
          status: 500,
          durationMs: Date.now() - startedAt,
          err: serializeError(error),
        },
        'HTTP request failed'
      );
      throw error;
    }
  };
}
