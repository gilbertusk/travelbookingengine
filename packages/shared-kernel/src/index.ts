/**
 * @tbe/shared-kernel
 *
 * Fondasi bersama untuk seluruh service backend. Package ini sengaja tidak
 * bergantung pada Kafka, RabbitMQ, Redis, maupun Prisma — begitu salah satunya
 * masuk, setiap service ikut menariknya meski tidak memakainya.
 */

export {
  andThen,
  err,
  isErr,
  isOk,
  map,
  mapErr,
  ok,
  partition,
  unwrapOr,
  type Err,
  type Ok,
  type Result,
} from './result/result.js'

export {
  AppError,
  ConfigError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  RateLimitedError,
  TimeoutError,
  UnauthorizedError,
  UpstreamError,
  ValidationError,
  isAppError,
  type AppErrorParams,
  type ErrorDetails,
} from './errors/app-error.js'

export {
  GENERIC_SERVER_MESSAGE,
  toErrorResponse,
  type ErrorResponse,
  type ErrorResponseBody,
} from './errors/error-response.js'

export {
  CORRELATION_HEADER,
  getCorrelationId,
  getOrCreateCorrelationId,
  newCorrelationId,
  runWithCorrelation,
  type CorrelationContext,
} from './correlation/correlation.js'

export { REDACTED, buildLoggerOptions, createLogger, type LoggerOptions } from './logger/logger.js'
export type { Logger } from 'pino'

export { baseEnvSchema, createConfig, type BaseEnv } from './config/config.js'

export { success, type PaginationMeta, type SuccessResponse } from './http/envelope.js'
export {
  correlationIdOf,
  correlationMiddleware,
  isAcceptableCorrelationId,
} from './http/correlation-middleware.js'
export { createErrorHandler, notFoundHandler } from './http/error-handler.js'
export { validate, type ValidatingMiddleware, type ValidationSource } from './http/validate.js'
export { createHttpServer, finalizeHttpServer, type HttpServerOptions } from './http/server.js'

export {
  createHealthRouter,
  runChecks,
  type DependencyStatus,
  type HealthCheck,
} from './health/health.js'

export {
  createApp,
  type AppOptions,
  type ManagedApp,
  type ManagedResource,
} from './lifecycle/lifecycle.js'

export { currentTraceIds, type TraceIds } from './observability/trace-context.js'
export {
  initTracing,
  tracingResource,
  type TracingHandle,
  type TracingOptions,
} from './observability/tracing.js'
export { annotateSpan, withSpan } from './observability/span.js'
export {
  currentTraceparent,
  isValidTraceparent,
  withTraceparent,
} from './observability/propagation.js'
export {
  CIRCUIT_STATE_VALUES,
  createMetrics,
  metricsHandler,
  observeDuration,
  type DomainMetrics,
  type Metrics,
  type MetricsOptions,
} from './observability/metrics.js'
