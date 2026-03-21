import { swagger } from '@elysiajs/swagger'
import type { FluxStack, PluginContext } from '../../../plugins/types'
import { getConfig } from '../../../config'

type Plugin = FluxStack.Plugin

/** Parse servers from config string format: "url1|desc1,url2|desc2" */
function parseServers(str: string): Array<{ url: string; description: string }> {
  if (!str?.trim()) return []

  return str.split(',')
    .map(s => {
      const [url, desc] = s.split('|').map(p => p.trim())
      return { url: url || '', description: desc || 'Server' }
    })
    .filter(s => s.url)
}

export const swaggerPlugin: Plugin = {
  name: 'swagger',
  version: '1.0.0',
  description: 'Swagger documentation plugin for FluxStack',
  author: 'FluxStack Team',
  priority: 500,
  category: 'documentation',
  tags: ['swagger', 'documentation', 'api'],
  dependencies: [],

  setup: async (context: PluginContext) => {
    const allConfig = getConfig()
    const appConfig = allConfig.app
    const serverConfig = allConfig.server
    const pluginsConfig = allConfig.plugins

    if (!pluginsConfig.swaggerEnabled) {
      context.logger.debug('Swagger plugin disabled')
      return
    }

    // Build servers list
    const servers = parseServers(pluginsConfig.swaggerServers ?? '')
    if (servers.length === 0) {
      servers.push({
        url: `http://${serverConfig.host}:${serverConfig.port}`,
        description: 'Development server'
      })
    }

    // Swagger configuration
    const config = {
      path: pluginsConfig.swaggerPath ?? '/swagger',
      documentation: {
        info: {
          title: pluginsConfig.swaggerTitle ?? appConfig.name ?? 'FluxStack API',
          version: pluginsConfig.swaggerVersion ?? appConfig.version ?? '1.0.0',
          description: pluginsConfig.swaggerDescription ?? 'API documentation'
        },
        servers
      },
      exclude: pluginsConfig.swaggerExcludePaths ?? [],
      swaggerOptions: {
        persistAuthorization: pluginsConfig.swaggerPersistAuthorization as boolean | undefined,
        displayRequestDuration: pluginsConfig.swaggerDisplayRequestDuration as boolean | undefined,
        filter: pluginsConfig.swaggerEnableFilter as boolean | undefined,
        showExtensions: pluginsConfig.swaggerShowExtensions as boolean | undefined,
        tryItOutEnabled: pluginsConfig.swaggerTryItOutEnabled as boolean | undefined
      }
    }

    // Add Basic Auth if enabled
    if (pluginsConfig.swaggerAuthEnabled && pluginsConfig.swaggerAuthPassword) {
      ;(context.app as Record<string, Function>).onBeforeHandle({ as: 'global' }, ({ request, set, path }: { request: Request; set: { status?: number; headers: Record<string, string> }; path: string }) => {
        if (!path.startsWith(pluginsConfig.swaggerPath ?? '/swagger')) return

        const authHeader = request.headers.get('authorization')
        if (!authHeader?.startsWith('Basic ')) {
          set.status = 401
          set.headers['WWW-Authenticate'] = 'Basic realm="Swagger"'
          return { error: 'Authentication required' }
        }

        const [username, password] = Buffer.from(authHeader.substring(6), 'base64')
          .toString('utf-8')
          .split(':')

        if (username !== pluginsConfig.swaggerAuthUsername ||
            password !== pluginsConfig.swaggerAuthPassword) {
          set.status = 401
          set.headers['WWW-Authenticate'] = 'Basic realm="Swagger"'
          return { error: 'Invalid credentials' }
        }
      })

      context.logger.debug(`Swagger auth enabled (user: ${pluginsConfig.swaggerAuthUsername})`)
    }

    ;(context.app as Record<string, Function>).use(swagger(config))
    context.logger.debug(`Swagger enabled at ${pluginsConfig.swaggerPath}`)
  },

  onServerStart: async (context: PluginContext) => {
    const cfg = getConfig()
    if (!cfg.plugins.swaggerEnabled) return

    const url = `http://${cfg.server.host}:${cfg.server.port}${cfg.plugins.swaggerPath}`
    context.logger.debug(`Swagger available at: ${url}`)
  }
}

export default swaggerPlugin
