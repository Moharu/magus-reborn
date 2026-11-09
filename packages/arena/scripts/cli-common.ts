// What the arena CLIs share (tournament.ts, strategy.ts): flag parsing, the time budget, the report options, JSON in and
// out, the dummy baseline and the worker processes. `args` is read when this module loads, after arena.ts has taken
// `--mode` out of the command line.
import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { ENGINE_VERSION } from '@magus/engine'
import { parseBaseline } from '../src'
import { fromInvocation } from './paths'

export const args = process.argv.slice(2)

/** The value of `--name`, or undefined. */
export const flag = (name: string) => {
    const i = args.indexOf(`--${name}`)
    if (i === -1) return undefined
    const value = args[i + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`--${name} needs a value`)
    return value
}

/** Every value of a flag that may be repeated, in order. */
export const flagValues = (name: string) => {
    const values: string[] = []
    args.forEach((arg, i) => {
        if (arg !== `--${name}`) return
        const value = args[i + 1]
        if (value === undefined || value.startsWith('--')) throw new Error(`--${name} needs a value`)
        values.push(value)
    })
    return values
}

export const intFlag = (name: string, fallback: number) => {
    const raw = flag(name)
    if (raw === undefined) return fallback
    if (!/^\d+$/.test(raw)) throw new Error(`--${name} must be a non-negative integer, got ${raw}`)
    return Number(raw)
}

export const fraction = (name: string, raw: string | undefined) => {
    if (raw === undefined) return undefined
    const match = /^(\d+)\/(\d+)$/.exec(raw)
    if (!match) throw new Error(`--${name} must look like i/n, got ${raw}`)
    return { index: Number(match[1]), count: Number(match[2]) }
}

/** Seconds from `--time-budget`, a positive number; counted from the start of this process. */
export const timeBudget = () => {
    const raw = flag('time-budget')
    if (raw === undefined) return undefined
    const seconds = Number(raw)
    if (!/^\d+(\.\d+)?$/.test(raw) || !(seconds > 0))
        throw new Error(`--time-budget must be a positive number of seconds, got ${raw}`)
    return seconds
}
export const elapsedSeconds = () => performance.now() / 1000
/** `stop` for the play functions: true once the budget is used up. Undefined without a budget. */
export const stopper = () => {
    const budget = timeBudget()
    return budget === undefined ? undefined : () => elapsedSeconds() >= budget
}

export const reportOptions = () => {
    const date = flag('date') ?? new Date().toISOString().slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`--date must look like YYYY-MM-DD, got ${date}`)
    const commit = flag('commit')
    if (commit !== undefined && !/^[0-9a-f]{7,40}$/i.test(commit))
        throw new Error(`--commit must be a hex commit id, got ${commit}`)
    return { date, ...(commit === undefined ? {} : { commit }) }
}

export const readJson = (file: string) => {
    try {
        return JSON.parse(readFileSync(fromInvocation(file), 'utf8')) as unknown
    } catch (error) {
        throw new Error(`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`, {
            cause: error,
        })
    }
}

export const writeOut = (value: unknown) => {
    const out = flag('out')
    if (out === undefined) return
    const text = JSON.stringify(value, null, 2) + '\n'
    if (out === '-') process.stdout.write(text)
    else writeFileSync(fromInvocation(out), text)
}

/** The table goes to stdout, unless `--out -` puts the JSON there: then it goes to stderr, so stdout stays parseable. */
export const printTable = (table: string) => (flag('out') === '-' ? console.error(table) : console.log(table))

export const loadBaseline = () => {
    const version = flag('baseline') ?? ENGINE_VERSION
    if (!/^[\w.-]+$/.test(version))
        throw new Error(`--baseline must be a version like ${ENGINE_VERSION}, got ${version}`)
    const file = fileURLToPath(new URL(`../baselines/${version}.json`, import.meta.url))
    let raw: unknown
    try {
        raw = JSON.parse(readFileSync(file, 'utf8'))
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
            throw new Error(
                `no dummy-DPS baseline for version ${version}: expected packages/arena/baselines/${version}.json (npm run arena:baseline)`,
                { cause: error },
            )
        throw error
    }
    return parseBaseline(raw, version)
}

/** Every worker still running: when one fails, the others are killed rather than left burning CPU. */
const children = new Set<ChildProcess>()
export const killWorkers = () => {
    for (const child of children) child.kill()
    children.clear()
}

/**
 * Runs worker `index` of `count`: this same script again (`script` is its `import.meta.url`) with the command line plus
 * `--worker i/n`, whose JSON stdout is the result. The worker gets what is left of the time budget when it starts.
 */
export const runWorker = <T>(script: string, index: number, count: number) =>
    new Promise<T>((resolve, reject) => {
        const budget = timeBudget()
        const rest = budget === undefined ? [] : ['--time-budget', String(Math.max(budget - elapsedSeconds(), 0.001))]
        const forwarded = args.filter((arg, i, all) => arg !== '--time-budget' && all[i - 1] !== '--time-budget')
        const child = spawn(
            process.execPath,
            [...process.execArgv, fileURLToPath(script), ...forwarded, ...rest, '--worker', `${index}/${count}`],
            { stdio: ['ignore', 'pipe', 'inherit'] },
        )
        children.add(child)
        let out = ''
        child.stdout.setEncoding('utf8').on('data', chunk => (out += chunk))
        child.on('error', error => {
            killWorkers()
            reject(error)
        })
        child.on('close', code => {
            children.delete(child)
            if (code === 0) resolve(JSON.parse(out) as T)
            else {
                killWorkers()
                reject(new Error(`worker ${index} exited with ${code}`))
            }
        })
    })
