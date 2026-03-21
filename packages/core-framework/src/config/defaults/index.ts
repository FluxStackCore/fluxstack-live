/**
 * ⚡ FluxStack Default Configuration
 *
 * Laravel-style: the framework ships with sensible defaults.
 * The developer only overrides what they need via configProvider.merge().
 *
 * All values here use the defineConfig system, which reads from
 * environment variables first, then falls back to these defaults.
 */

import { defineConfig, defineNestedConfig, config } from '../../utils/config-schema'
import { env, helpers } from '../../utils/env'
import { FLUXSTACK_VERSION } from '../../utils/version'
import type { FluxStackConfig } from '../types'

// ============================================================================
// Individual config sections (using defineConfig for env var support)
// ============================================================================

const appConfig = defineConfig({
  name: config.string('APP_NAME', 'fluxstack-app', true),
  version: config.string('APP_VERSION', '1.0.0', true),
  description: config.string('APP_DESCRIPTION', 'A FluxStack application', false),
  env: config.enum('NODE_ENV', ['development', 'production', 'test'] as const, 'development', false),
  mode: config.enum('FLUXSTACK_MODE', ['full-stack', 'backend-only', 'frontend-only'] as const, 'full-stack', false),
  trustProxy: config.boolean('APP_TRUST_PROXY', false),
  sessionSecret: config.string('APP_SESSION_SECRET', ''),
})

const corsDefaults = defineConfig({
  origins: config.array('CORS_ORIGINS', ['http://localhost:3000', 'http://localhost:5173']),
  methods: config.array('CORS_METHODS', ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']),
  headers: config.array('CORS_HEADERS', ['Content-Type', 'Authorization']),
  credentials: config.boolean('CORS_CREDENTIALS', false),
  maxAge: config.number('CORS_MAX_AGE', 86400),
})

const serverDefaults = defineConfig({
  port: {
    type: 'number' as const,
    env: 'PORT',
    default: 3000,
    required: true,
    validate: (value: number) => {
      if (value < 1 || value > 65535) return 'Port must be between 1 and 65535'
      return true
    },
  },
  host: config.string('HOST', 'localhost', true),
  apiPrefix: {
    type: 'string' as const,
    env: 'API_PREFIX',
    default: '/api',
    validate: (value: string) => value.startsWith('/') || 'API prefix must start with /',
  },
  backendPort: config.number('BACKEND_PORT', 3001),
  enableRequestLogging: config.boolean('ENABLE_REQUEST_LOGGING', true),
  showBanner: config.boolean('SHOW_SERVER_BANNER', true),
})

const viteDefaults = defineConfig({
  port: config.number('VITE_PORT', 5173, true),
  host: config.string('VITE_HOST', 'localhost'),
  strictPort: config.boolean('VITE_STRICT_PORT', true),
  open: config.boolean('VITE_OPEN', false),
  enableLogging: config.boolean('ENABLE_VITE_PROXY_LOGS', false),
  allowedHosts: config.array('VITE_ALLOWED_HOSTS', ['localhost']),
})

const clientBuildDefaults = defineConfig({
  outDir: config.string('CLIENT_OUTDIR', 'dist/client'),
  sourceMaps: config.boolean('CLIENT_SOURCEMAPS', helpers.isDevelopment()),
  minify: config.boolean('CLIENT_MINIFY', helpers.isProduction()),
  target: config.string('CLIENT_TARGET', 'esnext'),
  assetsDir: config.string('CLIENT_ASSETS_DIR', 'assets'),
  cssCodeSplit: config.boolean('CLIENT_CSS_CODE_SPLIT', true),
  chunkSizeWarningLimit: config.number('CLIENT_CHUNK_SIZE_WARNING', 500),
  emptyOutDir: config.boolean('CLIENT_EMPTY_OUTDIR', true),
})

const buildDefaults = defineConfig({
  target: config.enum('BUILD_TARGET', ['bun', 'node', 'docker'] as const, 'bun', true),
  outDir: config.string('BUILD_OUT_DIR', 'dist', true),
  sourceMaps: config.boolean('BUILD_SOURCE_MAPS', helpers.isDevelopment()),
  clean: config.boolean('BUILD_CLEAN', true),
  mode: config.enum('BUILD_MODE', ['development', 'production'] as const, helpers.isProduction() ? 'production' : 'development'),
  external: config.array('BUILD_EXTERNAL', []),
  optimize: config.boolean('BUILD_OPTIMIZE', true),
})

const optimizationDefaults = defineConfig({
  minify: config.boolean('BUILD_MINIFY', helpers.isProduction()),
  treeshake: config.boolean('BUILD_TREESHAKE', true),
  compress: config.boolean('BUILD_COMPRESS', helpers.isProduction()),
  splitChunks: config.boolean('BUILD_SPLIT_CHUNKS', true),
  bundleAnalyzer: config.boolean('BUILD_BUNDLE_ANALYZER', false),
  removeUnusedCSS: config.boolean('BUILD_REMOVE_UNUSED_CSS', false),
  optimizeImages: config.boolean('BUILD_OPTIMIZE_IMAGES', false),
})

const loggerDefaults = defineConfig({
  level: config.enum('LOG_LEVEL', ['debug', 'info', 'warn', 'error'] as const, 'info'),
  format: config.enum('LOG_FORMAT', ['pretty', 'json'] as const, 'pretty'),
  dateFormat: config.string('LOG_DATE_FORMAT', 'YYYY-MM-DD HH:mm:ss'),
  objectDepth: config.number('LOG_OBJECT_DEPTH', 4),
  logToFile: config.boolean('LOG_TO_FILE', false),
  maxSize: config.string('LOG_MAX_SIZE', '20m'),
  maxFiles: config.string('LOG_MAX_FILES', '14d'),
  transports: config.array('LOG_TRANSPORTS', ['console']),
  enableColors: config.boolean('LOG_COLORS', true),
  enableStackTrace: config.boolean('LOG_STACK_TRACE', true),
})

const pluginsDefaults = defineConfig({
  enabled: config.array('FLUXSTACK_PLUGINS_ENABLED', ['logger', 'swagger', 'vite', 'cors', 'static-files']),
  disabled: config.array('FLUXSTACK_PLUGINS_DISABLED', []),
  autoDiscover: config.boolean('PLUGINS_AUTO_DISCOVER', true),
  pluginsDir: config.string('PLUGINS_DIR', 'plugins'),
  discoverNpmPlugins: config.boolean('PLUGINS_DISCOVER_NPM', false),
  discoverProjectPlugins: config.boolean('PLUGINS_DISCOVER_PROJECT', true),
  allowedPlugins: config.array('PLUGINS_ALLOWED', []),
  config: {
    type: 'object' as const,
    default: {
      swagger: {
        title: 'FluxStack API',
        version: FLUXSTACK_VERSION,
        description: 'API documentation for FluxStack application',
        path: '/swagger',
      },
      staticFiles: {
        publicDir: 'public',
        uploadsDir: 'uploads',
      },
    },
  },
  loggerEnabled: config.boolean('LOGGER_PLUGIN_ENABLED', true),
  swaggerEnabled: config.boolean('SWAGGER_ENABLED', true),
  swaggerTitle: config.string('SWAGGER_TITLE', 'FluxStack API'),
  swaggerVersion: config.string('SWAGGER_VERSION', FLUXSTACK_VERSION),
  swaggerDescription: config.string('SWAGGER_DESCRIPTION', 'API documentation for FluxStack application'),
  swaggerPath: config.string('SWAGGER_PATH', '/swagger'),
  swaggerExcludePaths: config.array('SWAGGER_EXCLUDE_PATHS', []),
  swaggerServers: config.string('SWAGGER_SERVERS', ''),
  swaggerPersistAuthorization: config.boolean('SWAGGER_PERSIST_AUTH', true),
  swaggerDisplayRequestDuration: config.boolean('SWAGGER_DISPLAY_DURATION', true),
  swaggerEnableFilter: config.boolean('SWAGGER_ENABLE_FILTER', true),
  swaggerShowExtensions: config.boolean('SWAGGER_SHOW_EXTENSIONS', true),
  swaggerTryItOutEnabled: config.boolean('SWAGGER_TRY_IT_OUT', true),
  swaggerAuthEnabled: config.boolean('SWAGGER_AUTH_ENABLED', false),
  swaggerAuthUsername: config.string('SWAGGER_AUTH_USERNAME', 'admin'),
  swaggerAuthPassword: config.string('SWAGGER_AUTH_PASSWORD', ''),
  staticFilesEnabled: config.boolean('STATIC_FILES_ENABLED', true),
  staticPublicDir: config.string('STATIC_PUBLIC_DIR', 'public'),
  staticUploadsDir: config.string('STATIC_UPLOADS_DIR', 'uploads'),
  staticCacheMaxAge: config.number('STATIC_CACHE_MAX_AGE', 31536000),
  staticEnableUploads: config.boolean('STATIC_ENABLE_UPLOADS', true),
  staticEnablePublic: config.boolean('STATIC_ENABLE_PUBLIC', true),
  viteEnabled: config.boolean('VITE_PLUGIN_ENABLED', true),
  viteExcludePaths: config.array('VITE_EXCLUDE_PATHS', ['/api', '/swagger']),
})

const monitoringDefaults = defineConfig({
  enabled: config.boolean('ENABLE_MONITORING', false),
  exporters: config.array('MONITORING_EXPORTERS', []),
  enableHealthChecks: config.boolean('ENABLE_HEALTH_CHECKS', true),
  healthCheckInterval: config.number('HEALTH_CHECK_INTERVAL', 30000),
  enableAlerts: config.boolean('ENABLE_ALERTS', false),
  alertWebhook: config.string('ALERT_WEBHOOK'),
})

const metricsDefaults = defineConfig({
  enabled: config.boolean('ENABLE_METRICS', false),
  collectInterval: {
    type: 'number' as const,
    env: 'METRICS_INTERVAL',
    default: 5000,
    validate: (value: number) => value >= 1000 || 'Metrics interval must be at least 1000ms',
  },
  httpMetrics: config.boolean('HTTP_METRICS', true),
  systemMetrics: config.boolean('SYSTEM_METRICS', true),
  customMetrics: config.boolean('CUSTOM_METRICS', false),
  exportToConsole: config.boolean('METRICS_EXPORT_CONSOLE', helpers.isDevelopment()),
  exportToFile: config.boolean('METRICS_EXPORT_FILE', false),
  exportToHttp: config.boolean('METRICS_EXPORT_HTTP', false),
  exportHttpUrl: config.string('METRICS_EXPORT_URL'),
  retentionPeriod: config.number('METRICS_RETENTION_PERIOD', 3600000),
  maxDataPoints: config.number('METRICS_MAX_DATA_POINTS', 1000),
})

const profilingDefaults = defineConfig({
  enabled: config.boolean('PROFILING_ENABLED', false),
  sampleRate: {
    type: 'number' as const,
    env: 'PROFILING_SAMPLE_RATE',
    default: helpers.isProduction() ? 0.01 : 0.1,
    validate: (value: number) => (value >= 0 && value <= 1) || 'Sample rate must be between 0 and 1',
  },
  memoryProfiling: config.boolean('MEMORY_PROFILING', false),
  cpuProfiling: config.boolean('CPU_PROFILING', false),
  heapSnapshot: config.boolean('HEAP_SNAPSHOT', false),
  outputDir: config.string('PROFILING_OUTPUT_DIR', 'profiling'),
  maxProfiles: config.number('PROFILING_MAX_PROFILES', 10),
})

const databaseDefaults = defineConfig({
  url: config.string('DATABASE_URL', ''),
  provider: config.enum('DATABASE_PROVIDER', ['postgres', 'mysql', 'sqlite', 'mssql', 'mongodb'] as const, 'postgres'),
  connectionTimeout: config.number('DATABASE_CONNECTION_TIMEOUT', 5000),
  ssl: config.boolean('DATABASE_SSL', false),
})

const servicesDefaults = defineNestedConfig({
  email: {
    host: config.string('MAIL_HOST', 'smtp.example.com'),
    port: config.number('MAIL_PORT', 587),
    username: config.string('MAIL_USERNAME', ''),
    password: config.string('MAIL_PASSWORD', ''),
    fromAddress: config.string('MAIL_FROM_ADDRESS', 'no-reply@example.com'),
    secure: config.boolean('MAIL_SECURE', false),
  } as const,
  jwt: {
    secret: config.string('JWT_SECRET', 'change-me'),
    expiresIn: config.string('JWT_EXPIRES_IN', '1h'),
    audience: config.string('JWT_AUDIENCE', 'fluxstack'),
    issuer: config.string('JWT_ISSUER', 'fluxstack'),
  } as const,
  storage: {
    driver: config.enum('STORAGE_DRIVER', ['local', 's3'] as const, 'local'),
    localDir: config.string('STORAGE_LOCAL_DIR', 'uploads'),
    s3Bucket: config.string('STORAGE_S3_BUCKET', ''),
    s3Region: config.string('STORAGE_S3_REGION', ''),
    s3Endpoint: config.string('STORAGE_S3_ENDPOINT', ''),
  } as const,
  redis: {
    enabled: config.boolean('REDIS_ENABLED', false),
    url: config.string('REDIS_URL', 'redis://localhost:6379'),
  } as const,
})

const authDefaults = defineNestedConfig({
  defaults: {
    guard: config.enum('AUTH_DEFAULT_GUARD', ['session', 'token'] as const, 'session'),
    provider: config.enum('AUTH_DEFAULT_PROVIDER', ['memory', 'database'] as const, 'memory'),
  } as const,
  passwords: {
    hashAlgorithm: config.enum('AUTH_HASH_ALGORITHM', ['bcrypt', 'argon2id'] as const, 'bcrypt'),
    bcryptRounds: config.number('AUTH_BCRYPT_ROUNDS', 10),
  } as const,
  rateLimit: {
    maxAttempts: config.number('AUTH_RATE_LIMIT_MAX_ATTEMPTS', 5),
    decaySeconds: config.number('AUTH_RATE_LIMIT_DECAY_SECONDS', 60),
  } as const,
  token: {
    ttl: config.number('AUTH_TOKEN_TTL', 86400),
  } as const,
})

const sessionDefaults = defineConfig({
  driver: config.enum('SESSION_DRIVER', ['memory'] as const, 'memory'),
  lifetime: config.number('SESSION_LIFETIME', 7200),
  cookieName: config.string('SESSION_COOKIE', 'fluxstack_session'),
  httpOnly: config.boolean('SESSION_HTTP_ONLY', true),
  secure: config.boolean('SESSION_SECURE', false),
  sameSite: config.enum('SESSION_SAME_SITE', ['strict', 'lax', 'none'] as const, 'lax'),
  path: config.string('SESSION_PATH', '/'),
  domain: config.string('SESSION_DOMAIN', ''),
})

const systemDefaults = defineConfig({
  user: config.string('USER', ''),
  username: config.string('USERNAME', ''),
  home: config.string('HOME', ''),
  userProfile: config.string('USERPROFILE', ''),
  pwd: config.string('PWD', ''),
  path: config.string('PATH', ''),
  shell: config.string('SHELL', ''),
  term: config.string('TERM', ''),
  lang: config.string('LANG', 'en_US.UTF-8'),
  tmpDir: config.string('TMPDIR', ''),
  ci: config.boolean('CI', false),
})

const runtimeDefaults = {
  enableSwagger: true,
  enableMetrics: false,
  enableMonitoring: false,
  enableDebugMode: false,
  debugLive: false,
  rateLimitEnabled: true,
  rateLimitMax: 100,
  rateLimitWindow: 60000,
  requestTimeout: 30000,
  maxUploadSize: 10485760,
  maintenanceMode: false,
  maintenanceMessage: 'System is under maintenance. Please try again later.',
}

// ============================================================================
// Compose into full FluxStackConfig
// ============================================================================

export function loadDefaultConfig(): FluxStackConfig {
  const serverWithCors = {
    ...serverDefaults,
    cors: corsDefaults,
  }

  const clientFull = {
    port: viteDefaults.port,
    host: viteDefaults.host,
    build: {
      ...clientBuildDefaults,
      sourceMaps: true,
    },
  }

  const buildFull = {
    ...buildDefaults,
    optimization: {
      ...optimizationDefaults,
      minify: true,
    },
  }

  const monitoringFull = {
    ...monitoringDefaults,
    metrics: metricsDefaults,
    profiling: profilingDefaults,
  }

  return {
    app: appConfig,
    server: serverWithCors,
    client: clientFull,
    build: buildFull,
    cors: corsDefaults,
    clientBuild: clientBuildDefaults,
    optimization: optimizationDefaults,
    logging: loggerDefaults,
    plugins: pluginsDefaults,
    monitoring: monitoringFull,
    runtime: runtimeDefaults,
    system: systemDefaults,
    database: databaseDefaults,
    services: servicesDefaults,
    auth: authDefaults,
    session: sessionDefaults,
    environments: {
      development: {
        logging: { level: 'debug', format: 'pretty' },
        build: { optimization: { ...optimizationDefaults, minify: false } },
      },
      production: {
        logging: { level: 'warn', format: 'json' },
        monitoring: { enabled: true },
      },
      test: {
        logging: { level: 'error', format: 'pretty' },
        server: { port: 0 },
        client: { port: 0 },
      },
    },
  } as unknown as FluxStackConfig
}
