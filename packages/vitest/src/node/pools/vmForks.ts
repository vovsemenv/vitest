import * as nodeos from 'node:os'
import v8 from 'node:v8'
import EventEmitter from 'node:events'
import { createBirpc } from 'birpc'
import { resolve } from 'pathe'
import type { TinypoolChannel, Options as TinypoolOptions } from 'tinypool'
import Tinypool from 'tinypool'
import { rootDir } from '../../paths'
import type { ContextRPC, ContextTestEnvironment, ResolvedConfig, RunnerRPC, RuntimeRPC, Vitest } from '../../types'
import type { PoolProcessOptions, ProcessPool, RunWithFiles } from '../pool'
import { groupFilesByEnv } from '../../utils/test-helpers'
import { AggregateError } from '../../utils/base'
import type { WorkspaceProject } from '../workspace'
import { getWorkerMemoryLimit, stringToBytes } from '../../utils/memory-limit'
import { createMethodsRPC } from './rpc'

const suppressWarningsPath = resolve(rootDir, './suppress-warnings.cjs')

function createChildProcessChannel(project: WorkspaceProject) {
  const emitter = new EventEmitter()
  const cleanup = () => emitter.removeAllListeners()

  const events = { message: 'message', response: 'response' }
  const channel: TinypoolChannel = {
    onMessage: callback => emitter.on(events.message, callback),
    postMessage: message => emitter.emit(events.response, message),
  }

  const rpc = createBirpc<RunnerRPC, RuntimeRPC>(
    createMethodsRPC(project),
    {
      eventNames: ['onCancel'],
      serialize: v8.serialize,
      deserialize: v => v8.deserialize(Buffer.from(v)),
      post(v) {
        emitter.emit(events.message, v)
      },
      on(fn) {
        emitter.on(events.response, fn)
      },
      onTimeoutError(functionName) {
        throw new Error(`[vitest-pool]: Timeout calling "${functionName}"`)
      },
    },
  )

  project.ctx.onCancel(reason => rpc.onCancel(reason))

  return { channel, cleanup }
}

function stringifyRegex(input: RegExp | string): string {
  if (typeof input === 'string')
    return input
  return `$$vitest:${input.toString()}`
}

export function createVmForksPool(ctx: Vitest, { execArgv, env }: PoolProcessOptions): ProcessPool {
  const numCpus
    = typeof nodeos.availableParallelism === 'function'
      ? nodeos.availableParallelism()
      : nodeos.cpus().length

  const threadsCount = ctx.config.watch
    ? Math.max(Math.floor(numCpus / 2), 1)
    : Math.max(numCpus - 1, 1)

  const poolOptions = ctx.config.poolOptions?.vmForks ?? {}

  const maxThreads = poolOptions.maxForks ?? ctx.config.maxWorkers ?? threadsCount
  const minThreads = poolOptions.maxForks ?? ctx.config.minWorkers ?? threadsCount

  const worker = resolve(ctx.distPath, 'workers/vmForks.js')

  const options: TinypoolOptions = {
    runtime: 'child_process',
    filename: resolve(ctx.distPath, 'worker.js'),

    maxThreads,
    minThreads,

    env,
    execArgv: [
      '--experimental-import-meta-resolve',
      '--experimental-vm-modules',
      '--require',
      suppressWarningsPath,
      ...poolOptions.execArgv ?? [],
      ...execArgv,
    ],

    terminateTimeout: ctx.config.teardownTimeout,
    concurrentTasksPerWorker: 1,
    maxMemoryLimitBeforeRecycle: getMemoryLimit(ctx.config) || undefined,
  }

  if (poolOptions.singleFork || !ctx.config.fileParallelism) {
    options.maxThreads = 1
    options.minThreads = 1
  }

  const pool = new Tinypool(options)

  const runWithFiles = (name: string): RunWithFiles => {
    let id = 0

    async function runFiles(project: WorkspaceProject, config: ResolvedConfig, files: string[], environment: ContextTestEnvironment, invalidates: string[] = []) {
      ctx.state.clearFiles(project, files)
      const { channel, cleanup } = createChildProcessChannel(project)
      const workerId = ++id
      const data: ContextRPC = {
        pool: 'forks',
        worker,
        config,
        files,
        invalidates,
        environment,
        workerId,
        projectName: project.getName(),
        providedContext: project.getProvidedContext(),
      }
      try {
        await pool.run(data, { name, channel })
      }
      catch (error) {
        // Worker got stuck and won't terminate - this may cause process to hang
        if (error instanceof Error && /Failed to terminate worker/.test(error.message))
          ctx.state.addProcessTimeoutCause(`Failed to terminate worker while running ${files.join(', ')}.`)

        // Intentionally cancelled
        else if (ctx.isCancelling && error instanceof Error && /The task has been cancelled/.test(error.message))
          ctx.state.cancelFiles(files, ctx.config.root, project.config.name)

        else
          throw error
      }
      finally {
        cleanup()
      }
    }

    return async (specs, invalidates) => {
      // Cancel pending tasks from pool when possible
      ctx.onCancel(() => pool.cancelPendingTasks())

      const configs = new Map<WorkspaceProject, ResolvedConfig>()
      const getConfig = (project: WorkspaceProject): ResolvedConfig => {
        if (configs.has(project))
          return configs.get(project)!

        const _config = project.getSerializableConfig()

        const config = {
          ..._config,
          // v8 serialize does not support regex
          testNamePattern: _config.testNamePattern
            ? stringifyRegex(_config.testNamePattern)
            : undefined,
        } as ResolvedConfig
        configs.set(project, config)
        return config
      }

      const filesByEnv = await groupFilesByEnv(specs)
      const promises = Object.values(filesByEnv).flat()
      const results = await Promise.allSettled(promises
        .map(({ file, environment, project }) => runFiles(project, getConfig(project), [file], environment, invalidates)))

      const errors = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map(r => r.reason)
      if (errors.length > 0)
        throw new AggregateError(errors, 'Errors occurred while running tests. For more information, see serialized error.')
    }
  }

  return {
    name: 'vmForks',
    runTests: runWithFiles('run'),
    close: () => pool.destroy(),
  }
}

function getMemoryLimit(config: ResolvedConfig) {
  const memory = nodeos.totalmem()
  const limit = getWorkerMemoryLimit(config)

  if (typeof memory === 'number') {
    return stringToBytes(
      limit,
      config.watch ? memory / 2 : memory,
    )
  }

  // If totalmem is not supported we cannot resolve percentage based values like 0.5, "50%"
  if ((typeof limit === 'number' && limit > 1) || (typeof limit === 'string' && limit.at(-1) !== '%'))
    return stringToBytes(limit)

  // just ignore "memoryLimit" value because we cannot detect memory limit
  return null
}
