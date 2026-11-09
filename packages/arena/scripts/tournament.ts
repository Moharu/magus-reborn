// Usage:
//   npm run arena -- [--top N] [--general-pairs K] [--profiles a,b,...] [--games G] [--seed S] [--max-ticks T]
//                    [--baseline VERSION] [--jobs J] [--time-budget SECONDS] [--shard i/n] [--out FILE]
//                    [--report FILE] [--date YYYY-MM-DD] [--commit SHA]
//   npm run arena -- merge SHARD.json... [--out FILE] [--report FILE] [--date YYYY-MM-DD] [--commit SHA]
// (`npm run arena:tournament` is the same command.) Plays a round-robin between entrants (the top N distinct Fire sets, each with its best K general pairs, x the profiles) and prints the ranked table:
// win rate only, games per pair even so sides swap equally. --out writes the JSON (the result, or with --shard that
// shard's pairs, which `merge` combines). --jobs (default 4, values above 4 are clamped to 4 with a warning) runs that
// many worker processes and never changes the output. --time-budget stops the run when that many seconds have passed
// (each pair is finished first); the result is then partial and its table and report say so. --report writes the
// Markdown report (#105). Progress goes to stderr.
import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { ENGINE_VERSION } from '@magus/engine'
import {
    ARCHETYPE_NAMES,
    ARCHETYPES,
    clampJobs,
    DEFAULT_GAMES,
    DEFAULT_SEED,
    DEFAULT_GENERAL_PAIRS,
    DEFAULT_TOP,
    formatReport,
    formatTable,
    mergeShards,
    pairList,
    parseBaseline,
    planTournament,
    playPairs,
    shardPairs,
    SHARD_FORMAT,
    summarize,
    type ArchetypeName,
    type PairResult,
    type ShardResult,
    type TournamentResult,
} from '../src'

const args = process.argv.slice(2)
const flag = (name: string) => {
    const i = args.indexOf(`--${name}`)
    if (i === -1) return undefined
    const value = args[i + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`--${name} needs a value`)
    return value
}
const intFlag = (name: string, fallback: number) => {
    const raw = flag(name)
    if (raw === undefined) return fallback
    if (!/^\d+$/.test(raw)) throw new Error(`--${name} must be a non-negative integer, got ${raw}`)
    return Number(raw)
}
const fraction = (name: string, raw: string | undefined) => {
    if (raw === undefined) return undefined
    const match = /^(\d+)\/(\d+)$/.exec(raw)
    if (!match) throw new Error(`--${name} must look like i/n, got ${raw}`)
    return { index: Number(match[1]), count: Number(match[2]) }
}

/** Seconds from `--time-budget`, a positive number; counted from the start of this process. */
const timeBudget = () => {
    const raw = flag('time-budget')
    if (raw === undefined) return undefined
    const seconds = Number(raw)
    if (!/^\d+(\.\d+)?$/.test(raw) || !(seconds > 0))
        throw new Error(`--time-budget must be a positive number of seconds, got ${raw}`)
    return seconds
}
const elapsedSeconds = () => performance.now() / 1000
/** `stop` for `playPairs`: true once the budget is used up. Undefined without a budget. */
const stopper = () => {
    const budget = timeBudget()
    return budget === undefined ? undefined : () => elapsedSeconds() >= budget
}

const reportOptions = () => {
    const date = flag('date') ?? new Date().toISOString().slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`--date must look like YYYY-MM-DD, got ${date}`)
    const commit = flag('commit')
    if (commit !== undefined && !/^[0-9a-f]{7,40}$/i.test(commit))
        throw new Error(`--commit must be a hex commit id, got ${commit}`)
    return { date, ...(commit === undefined ? {} : { commit }) }
}

/** Writes `--out` (JSON), prints the table and writes `--report` (Markdown) for a whole tournament result. */
const publish = (result: TournamentResult) => {
    const report = flag('report')
    const options = report === undefined ? undefined : reportOptions()
    writeOut(result)
    printTable(formatTable(result))
    if (report !== undefined && options) writeFileSync(report, formatReport(result, options))
}

const readJson = (file: string) => {
    try {
        return JSON.parse(readFileSync(file, 'utf8')) as unknown
    } catch (error) {
        throw new Error(`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`, {
            cause: error,
        })
    }
}

const writeOut = (value: unknown) => {
    const out = flag('out')
    if (out === undefined) return
    const text = JSON.stringify(value, null, 2) + '\n'
    if (out === '-') process.stdout.write(text)
    else writeFileSync(out, text)
}

/** The table goes to stdout, unless `--out -` puts the JSON there: then it goes to stderr, so stdout stays parseable. */
const printTable = (table: string) => (flag('out') === '-' ? console.error(table) : console.log(table))

const loadBaseline = () => {
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

const plan = () => {
    const names = (flag('profiles') ?? ARCHETYPE_NAMES.join(',')).split(',').filter(Boolean)
    for (const name of names)
        if (!(ARCHETYPE_NAMES as string[]).includes(name))
            throw new Error(`--profiles: unknown profile ${name} (one of ${ARCHETYPE_NAMES.join(', ')})`)
    return planTournament({
        baseline: loadBaseline(),
        top: intFlag('top', DEFAULT_TOP),
        generalPairs: intFlag('general-pairs', DEFAULT_GENERAL_PAIRS),
        profiles: names.map(name => ARCHETYPES[name as ArchetypeName].profile),
        games: intFlag('games', DEFAULT_GAMES),
        seed: intFlag('seed', DEFAULT_SEED),
        ...(flag('max-ticks') === undefined ? {} : { maxTicks: intFlag('max-ticks', 0) }),
    })
}

/** Child mode: this worker's share of the (shard's) pairs, as JSON on stdout. */
const worker = (spec: { index: number; count: number }) => {
    const shard = fraction('shard', flag('shard')) ?? { index: 0, count: 1 }
    const total = pairList(plan().config.entrants.length).length
    const mine = shardPairs(total, shard.index, shard.count).filter((_, i) => i % spec.count === spec.index)
    process.stdout.write(JSON.stringify(playPairs(plan(), mine, undefined, stopper())))
}

/** Every worker still running: when one fails, the others are killed rather than left burning CPU. */
const children = new Set<ChildProcess>()
const killWorkers = () => {
    for (const child of children) child.kill()
    children.clear()
}

const runWorker = (index: number, count: number) =>
    new Promise<PairResult[]>((resolve, reject) => {
        const script = fileURLToPath(import.meta.url)
        // the worker gets what is left of the time budget when it starts
        const budget = timeBudget()
        const rest = budget === undefined ? [] : ['--time-budget', String(Math.max(budget - elapsedSeconds(), 0.001))]
        const forwarded = args.filter((arg, i, all) => arg !== '--time-budget' && all[i - 1] !== '--time-budget')
        const child = spawn(
            process.execPath,
            [...process.execArgv, script, ...forwarded, ...rest, '--worker', `${index}/${count}`],
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
            if (code === 0) resolve(JSON.parse(out) as PairResult[])
            else {
                killWorkers()
                reject(new Error(`worker ${index} exited with ${code}`))
            }
        })
    })

const main = async () => {
    if (args[0] === 'merge') {
        // every flag takes a value, so the files are the arguments that are neither a flag nor its value
        const files = args.slice(1).filter((arg, i, all) => !arg.startsWith('--') && !all[i - 1]?.startsWith('--'))
        if (files.length === 0) throw new Error('merge needs shard files')
        publish(mergeShards(files.map(file => readJson(file) as ShardResult)))
        return
    }

    const workerSpec = fraction('worker', flag('worker'))
    if (workerSpec) return worker(workerSpec)

    const { jobs, warning } = clampJobs(flag('jobs') === undefined ? undefined : intFlag('jobs', 0))
    if (warning) console.error(`warning: ${warning}`)
    const stop = stopper()
    if (flag('report') !== undefined) reportOptions() // a bad --date or --commit fails before the run, not after
    const shard = fraction('shard', flag('shard'))
    if (shard && flag('report') !== undefined)
        throw new Error('--report needs a whole run: merge the shards, then report')
    const tournament = plan()
    const { config } = tournament
    if (config.top.used < config.top.requested)
        console.error(
            `--top ${config.top.requested}: the ${config.baselineVersion} baseline has ${config.top.used} Fire sets, using all`,
        )
    const total = pairList(config.entrants.length).length
    const mine = shardPairs(total, shard?.index ?? 0, shard?.count ?? 1)
    console.error(
        `${config.entrants.length} entrants, ${total} pairs x ${config.games} games; this run plays ${mine.length} pairs with ${jobs} job(s)`,
    )

    let pairs: PairResult[]
    if (jobs === 1) pairs = playPairs(tournament, mine, undefined, stop)
    else pairs = (await Promise.all(Array.from({ length: jobs }, (_, i) => runWorker(i, jobs)))).flat()
    pairs.sort((x, y) => x.pair - y.pair)
    const partial = pairs.length < mine.length
    if (partial) console.error(`warning: the time budget ended the run after ${pairs.length} of ${mine.length} pairs`)

    if (shard) {
        if (flag('out') === undefined) throw new Error('--shard needs --out FILE for its result')
        writeOut({
            format: SHARD_FORMAT,
            config,
            shard,
            ...(partial ? { partial: true as const } : {}),
            pairs,
        } satisfies ShardResult)
        console.error(`shard ${shard.index}/${shard.count}: ${pairs.length} pairs${partial ? ' (partial)' : ''}`)
        return
    }
    publish(summarize(config, pairs, partial))
}

main().catch(error => {
    killWorkers()
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
})
