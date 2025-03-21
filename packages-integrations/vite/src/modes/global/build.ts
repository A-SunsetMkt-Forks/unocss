import type { GenerateResult, UnocssPluginContext } from '@unocss/core'
import type { NormalizedOutputOptions, PluginContext, RenderedChunk } from 'rollup'
import type { Plugin, ResolvedConfig } from 'vite'
import type { VitePluginConfig } from '../../types'
import { isAbsolute, resolve } from 'node:path'
import { setupContentExtractor } from '#integration/content'
import { getHash } from '#integration/hash'
import {
  getHashPlaceholder,
  getLayerPlaceholder,
  HASH_PLACEHOLDER_RE,
  LAYER_MARK_ALL,
  LAYER_PLACEHOLDER_RE,
  RESOLVED_ID_RE,
  resolveId,
  resolveLayer,
} from '#integration/layers'
import { applyTransformers } from '#integration/transformers'
import { getPath, replaceAsync } from '#integration/utils'
import { LAYER_IMPORTS, LAYER_PREFLIGHTS } from '@unocss/core'
import { MESSAGE_UNOCSS_ENTRY_NOT_FOUND } from './shared'

// https://github.com/vitejs/vite/blob/main/packages/plugin-legacy/src/index.ts#L742-L744
function isLegacyChunk(chunk: RenderedChunk, options: NormalizedOutputOptions) {
  return options.format === 'system' && chunk.fileName.includes('-legacy')
}

export function GlobalModeBuildPlugin(ctx: UnocssPluginContext<VitePluginConfig>): Plugin[] {
  const { ready, extract, tokens, filter, getConfig, tasks, flushTasks } = ctx
  const vfsLayers = new Set<string>()
  const layerImporterMap = new Map<string, string>()
  let viteConfig: ResolvedConfig

  // use maps to differentiate multiple build. using outDir as key
  const cssPostPlugins = new Map<string | undefined, Plugin | undefined>()
  const cssPlugins = new Map<string | undefined, Plugin | undefined>()

  async function applyCssTransform(css: string, id: string, dir: string | undefined, ctx: PluginContext) {
    const {
      postcss = true,
    } = await getConfig()
    if (!cssPlugins.get(dir) || !postcss)
      return css
    // @ts-expect-error without this context absolute assets will throw an error
    const result = await cssPlugins.get(dir).transform.call(ctx, css, id)
    if (!result)
      return css
    if (typeof result === 'string')
      css = result
    else if (result.code)
      css = result.code
    css = css.replace(/[\n\r]/g, '')
    return css
  }

  let lastTokenSize = 0
  let lastResult: GenerateResult | undefined
  async function generateAll() {
    await flushTasks()
    if (lastResult && lastTokenSize === tokens.size)
      return lastResult
    lastResult = await ctx.uno.generate(tokens, { minify: true })
    lastTokenSize = tokens.size
    return lastResult
  }

  let replaced = false

  return [
    {
      name: 'unocss:global:build:scan',
      apply: 'build',
      enforce: 'pre',
      async buildStart() {
        vfsLayers.clear()
        tasks.length = 0
        lastTokenSize = 0
        lastResult = undefined
      },
      transform(code, id) {
        if (filter(code, id))
          tasks.push(extract(code, id))
        return null
      },
      transformIndexHtml: {
        order: 'pre',
        handler(code, { filename }) {
          tasks.push(extract(code, filename))
        },
        // Compatibility with Legacy Vite
        enforce: 'pre',
        transform(code, { filename }) {
          tasks.push(extract(code, filename))
        },
      },
      resolveId(id, importer) {
        const entry = resolveId(id)
        if (entry) {
          const layer = resolveLayer(entry)
          if (layer) {
            vfsLayers.add(layer)
            if (importer)
              layerImporterMap.set(importer, entry)
          }
          return entry
        }
      },
      load(id) {
        const layer = resolveLayer(getPath(id))
        if (layer) {
          vfsLayers.add(layer)
          return getLayerPlaceholder(layer)
        }
      },
      moduleParsed({ id, importedIds }) {
        if (!layerImporterMap.has(id))
          return

        const layerKey = layerImporterMap.get(id)!
        if (!importedIds.includes(layerKey)) {
          layerImporterMap.delete(id)
          vfsLayers.delete(resolveLayer(layerKey)!)
        }
      },
      async configResolved(config) {
        const distDirs = [
          resolve(config.root, config.build.outDir),
        ]

        // for Vite lib more with rollupOptions.output, #2231
        if (config.build.rollupOptions.output) {
          const outputOptions = config.build.rollupOptions.output
          const outputDirs = Array.isArray(outputOptions)
            ? outputOptions.map(option => option.dir).filter(Boolean) as string[]
            : outputOptions.dir
              ? [outputOptions.dir]
              : []

          outputDirs.forEach((dir) => {
            distDirs.push(dir)

            if (!isAbsolute(dir))
              distDirs.push(resolve(config.root, dir))
          })
        }

        const cssPostPlugin = config.plugins.find(i => i.name === 'vite:css-post') as Plugin | undefined
        const cssPlugin = config.plugins.find(i => i.name === 'vite:css') as Plugin | undefined

        if (cssPostPlugin)
          distDirs.forEach(dir => cssPostPlugins.set(dir, cssPostPlugin))

        if (cssPlugin)
          distDirs.forEach(dir => cssPlugins.set(dir, cssPlugin))

        await ready
      },
      // we inject a hash to chunk before the dist hash calculation to make sure
      // the hash is different when unocss changes
      async renderChunk(_, chunk, options) {
        const isLegacy = isLegacyChunk(chunk, options)

        if (isLegacy && (!ctx.uno.config.legacy || ctx.uno.config.legacy.renderModernChunks))
          return null
        // skip hash generation on non-entry chunk
        if (!Object.keys(chunk.modules).some(i => RESOLVED_ID_RE.test(i)))
          return null

        const cssPost = cssPostPlugins.get(options.dir)
        if (!cssPost) {
          this.warn('[unocss] failed to find vite:css-post plugin. It might be an internal bug of UnoCSS')
          return null
        }

        let { css } = await generateAll()
        const fakeCssId = `${viteConfig.root}/${chunk.fileName}-unocss-hash.css`
        css = await applyCssTransform(css, fakeCssId, options.dir, this)

        const transformHandler = 'handler' in cssPost.transform!
          ? cssPost.transform.handler
          : cssPost.transform!
        if (isLegacy) {
          await transformHandler.call({} as any, css, '/__uno.css')
        }
        else {
          const hash = getHash(css)
          await transformHandler.call({} as any, getHashPlaceholder(hash), fakeCssId)
        }

        // fool the css plugin to generate the css in corresponding chunk
        chunk.modules[fakeCssId] = {
          code: null,
          originalLength: 0,
          removedExports: [],
          renderedExports: [],
          renderedLength: 0,
        }

        return null
      },
    },
    {
      name: 'unocss:global:content',
      enforce: 'pre',
      configResolved(config) {
        viteConfig = config
      },
      buildStart() {
        tasks.push(setupContentExtractor(ctx, viteConfig.mode !== 'test' && viteConfig.command === 'serve'))
      },
    },
    {
      name: 'unocss:global:build:generate',
      apply: 'build',
      async renderChunk(code, chunk, options) {
        if (isLegacyChunk(chunk, options))
          return null

        if (!Object.keys(chunk.modules).some(i => RESOLVED_ID_RE.test(i)))
          return null

        const cssPost = cssPostPlugins.get(options.dir)
        if (!cssPost) {
          this.warn('[unocss] failed to find vite:css-post plugin. It might be an internal bug of UnoCSS')
          return null
        }

        const result = await generateAll()
        const importsLayer = result.getLayer(LAYER_IMPORTS) ?? ''
        const fakeCssId = `${viteConfig.root}/${chunk.fileName}-unocss-hash.css`
        const preflightLayers = ctx.uno.config.preflights?.map(i => i.layer).concat(LAYER_PREFLIGHTS).filter(Boolean)

        await Promise.all(preflightLayers.map(i => result.setLayer(i!, async (layerContent) => {
          const preTransform = await applyTransformers(ctx, layerContent, fakeCssId, 'pre')
          const defaultTransform = await applyTransformers(ctx, preTransform?.code || layerContent, fakeCssId)
          const postTransform = await applyTransformers(ctx, defaultTransform?.code || preTransform?.code || layerContent, fakeCssId, 'post')
          return postTransform?.code || defaultTransform?.code || preTransform?.code || layerContent
        })))

        const cssWithLayers = await Promise.all(Array.from(vfsLayers).map(async (layer) => {
          const layerStart = `#--unocss-layer-start--${layer}--{start:${layer}}`
          const layerEnd = `#--unocss-layer-end--${layer}--{end:${layer}}`

          let layerContent
          if (layer === LAYER_MARK_ALL) {
            layerContent = result.getLayers(undefined, [...vfsLayers, LAYER_IMPORTS])
          }
          else {
            layerContent = result.getLayer(layer) || ''
          }

          return `${importsLayer}${layerStart} ${layerContent} ${layerEnd}`
        }))

        const css = await applyCssTransform(cssWithLayers.join(''), fakeCssId, options.dir, this)
        const transformHandler = 'handler' in cssPost.transform!
          ? cssPost.transform.handler
          : cssPost.transform!
        await transformHandler.call({} as unknown as any, css, fakeCssId)
      },
    },
    {
      name: 'unocss:global:build:bundle',
      apply: 'build',
      enforce: 'post',
      // rewrite the css placeholders
      async generateBundle(options, bundle) {
        const checkJs = ['umd', 'amd', 'iife'].includes(options.format)
        const files = Object.keys(bundle)
          .filter(i => i.endsWith('.css') || (checkJs && i.endsWith('.js')))

        if (!files.length)
          return

        if (!vfsLayers.size) {
          // If `vfsLayers` is empty and `replaced` is true, that means
          // `generateBundle` hook is called on previous build pipeline. e.g. ssr
          // Since we already replaced the layers and don't have any more layers
          // to replace on current build pipeline, we can skip the warning.
          if (replaced)
            return

          if ((await getConfig() as VitePluginConfig).checkImport) {
            this.warn(MESSAGE_UNOCSS_ENTRY_NOT_FOUND)
          }

          return
        }

        const getLayer = (layer: string, input: string, replace = false) => {
          const re = new RegExp(`#--unocss-layer-start--${layer}--\\{start:${layer}\\}([\\s\\S]*?)#--unocss-layer-end--${layer}--\\{end:${layer}\\}`, 'g')
          if (replace)
            return input.replace(re, '')

          const match = re.exec(input)
          if (match)
            return match[1]
          return ''
        }

        for (const file of files) {
          const chunk = bundle[file]
          if (chunk.type === 'asset' && typeof chunk.source === 'string') {
            const css = chunk.source
              .replace(HASH_PLACEHOLDER_RE, '')
            chunk.source = await replaceAsync(css, LAYER_PLACEHOLDER_RE, async (_, layer) => {
              replaced = true
              return getLayer(layer.trim(), css)
            })
            Array.from(vfsLayers).forEach((layer) => {
              chunk.source = getLayer(layer, chunk.source as string, true)
            })
          }
          else if (chunk.type === 'chunk' && typeof chunk.code === 'string') {
            const js = chunk.code
              .replace(HASH_PLACEHOLDER_RE, '')
            chunk.code = await replaceAsync(js, LAYER_PLACEHOLDER_RE, async (_, layer) => {
              replaced = true
              const css = getLayer(layer.trim(), js)
              return css
                .replace(/\n/g, '')
                .replace(/(?<!\\)(['"])/g, '\\$1')
            })
            Array.from(vfsLayers).forEach((layer) => {
              chunk.code = getLayer(layer, chunk.code, true)
            })
          }
        }

        if (!replaced) {
          let msg = '[unocss] does not found CSS placeholder in the generated chunks'
          if (viteConfig.build.lib && checkJs)
            msg += '\nIt seems you are building in library mode, it\'s recommended to set `build.cssCodeSplit` to true.\nSee https://github.com/vitejs/vite/issues/1579'
          else
            msg += '\nThis is likely an internal bug of unocss vite plugin'
          // #3748 Because some files may not contain unocss syntax, and then an error will be reported.
          this.warn(msg)
        }
      },
    },
  ]
}
