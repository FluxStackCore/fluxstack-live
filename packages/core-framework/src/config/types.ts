/**
 * ⚡ FluxStack Config Types
 *
 * Type definitions for the complete FluxStack configuration.
 * These types are inferred from the default config values.
 */

export interface AppConfig {
  name: string
  version: string
  description: string
  env: 'development' | 'production' | 'test'
  mode: 'full-stack' | 'backend-only' | 'frontend-only'
  trustProxy: boolean
  sessionSecret: string
}

export interface ServerConfig {
  port: number
  host: string
  apiPrefix: string
  backendPort: number
  enableRequestLogging: boolean
  showBanner: boolean
  cors: CorsConfig
}

export interface CorsConfig {
  origins: string[]
  methods: string[]
  headers: string[]
  credentials: boolean
  maxAge: number
}

export interface ClientConfig {
  port: number
  host: string
  build: ClientBuildConfig
}

export interface ClientBuildConfig {
  outDir: string
  sourceMaps: boolean
  minify: boolean
  target: string
  assetsDir: string
  cssCodeSplit: boolean
  chunkSizeWarningLimit: number
  emptyOutDir: boolean
}

export interface BuildConfig {
  target: 'bun' | 'node' | 'docker'
  outDir: string
  sourceMaps: boolean
  clean: boolean
  mode: 'development' | 'production'
  external: string[]
  optimize: boolean
  optimization: OptimizationConfig
}

export interface OptimizationConfig {
  minify: boolean
  treeshake: boolean
  compress: boolean
  splitChunks: boolean
  bundleAnalyzer: boolean
  removeUnusedCSS: boolean
  optimizeImages: boolean
}

export interface LoggerConfig {
  level: 'debug' | 'info' | 'warn' | 'error'
  format: 'pretty' | 'json'
  dateFormat: string
  objectDepth: number
  logToFile: boolean
  maxSize: string
  maxFiles: string
  transports: string[]
  enableColors: boolean
  enableStackTrace: boolean
}

export interface PluginsConfig {
  enabled: string[]
  disabled: string[]
  autoDiscover: boolean
  pluginsDir: string
  discoverNpmPlugins: boolean
  discoverProjectPlugins: boolean
  allowedPlugins: string[]
  config: Record<string, unknown>
  loggerEnabled: boolean
  swaggerEnabled: boolean
  swaggerTitle: string
  swaggerVersion: string
  swaggerDescription: string
  swaggerPath: string
  swaggerExcludePaths: string[]
  swaggerServers: string
  swaggerPersistAuthorization: boolean
  swaggerDisplayRequestDuration: boolean
  swaggerEnableFilter: boolean
  swaggerShowExtensions: boolean
  swaggerTryItOutEnabled: boolean
  swaggerAuthEnabled: boolean
  swaggerAuthUsername: string
  swaggerAuthPassword: string
  staticFilesEnabled: boolean
  staticPublicDir: string
  staticUploadsDir: string
  staticCacheMaxAge: number
  staticEnableUploads: boolean
  staticEnablePublic: boolean
  viteEnabled: boolean
  viteExcludePaths: string[]
}

export interface MonitoringConfig {
  enabled: boolean
  exporters: string[]
  enableHealthChecks: boolean
  healthCheckInterval: number
  enableAlerts: boolean
  alertWebhook: string | undefined
  metrics: MetricsConfig
  profiling: ProfilingConfig
}

export interface MetricsConfig {
  enabled: boolean
  collectInterval: number
  httpMetrics: boolean
  systemMetrics: boolean
  customMetrics: boolean
  exportToConsole: boolean
  exportToFile: boolean
  exportToHttp: boolean
  exportHttpUrl: string | undefined
  retentionPeriod: number
  maxDataPoints: number
}

export interface ProfilingConfig {
  enabled: boolean
  sampleRate: number
  memoryProfiling: boolean
  cpuProfiling: boolean
  heapSnapshot: boolean
  outputDir: string
  maxProfiles: number
}

export interface RuntimeConfig {
  enableSwagger: boolean
  enableMetrics: boolean
  enableMonitoring: boolean
  enableDebugMode: boolean
  debugLive: boolean
  rateLimitEnabled: boolean
  rateLimitMax: number
  rateLimitWindow: number
  requestTimeout: number
  maxUploadSize: number
  maintenanceMode: boolean
  maintenanceMessage: string
}

export interface DatabaseConfig {
  url: string
  provider: 'postgres' | 'mysql' | 'sqlite' | 'mssql' | 'mongodb'
  connectionTimeout: number
  ssl: boolean
}

export interface ServicesConfig {
  email: {
    host: string
    port: number
    username: string
    password: string
    fromAddress: string
    secure: boolean
  }
  jwt: {
    secret: string
    expiresIn: string
    audience: string
    issuer: string
  }
  storage: {
    driver: 'local' | 's3'
    localDir: string
    s3Bucket: string
    s3Region: string
    s3Endpoint: string
  }
  redis: {
    enabled: boolean
    url: string
  }
}

export interface AuthConfig {
  defaults: {
    guard: 'session' | 'token'
    provider: 'memory' | 'database'
  }
  passwords: {
    hashAlgorithm: 'bcrypt' | 'argon2id'
    bcryptRounds: number
  }
  rateLimit: {
    maxAttempts: number
    decaySeconds: number
  }
  token: {
    ttl: number
  }
}

export interface SessionConfig {
  driver: 'memory'
  lifetime: number
  cookieName: string
  httpOnly: boolean
  secure: boolean
  sameSite: 'strict' | 'lax' | 'none'
  path: string
  domain: string
}

export interface SystemConfig {
  user: string
  username: string
  home: string
  userProfile: string
  pwd: string
  path: string
  shell: string
  term: string
  lang: string
  tmpDir: string
  ci: boolean
}

/**
 * Complete FluxStack Configuration
 */
export interface FluxStackConfig {
  app: AppConfig
  server: ServerConfig
  client: ClientConfig
  build: BuildConfig
  logging: LoggerConfig
  plugins: PluginsConfig
  monitoring: MonitoringConfig
  runtime: RuntimeConfig
  system: SystemConfig
  database: DatabaseConfig
  services: ServicesConfig
  auth: AuthConfig
  session: SessionConfig
  cors: CorsConfig
  clientBuild: ClientBuildConfig
  optimization: OptimizationConfig
  environments: Record<string, Record<string, unknown>>
}
