// Usage:
//   npm run arena:tournament -- [--top N] [--profiles a,b,...] [--games G] [--seed S] [--max-ticks T]
//                               [--baseline VERSION] [--jobs J] [--shard i/n] [--out FILE]
//   npm run arena:tournament -- merge SHARD.json... [--out FILE]
// Plays a round-robin between entrants (the top N baseline loadouts x the profiles) and prints the ranked table:
// win rate only, games per pair even so sides swap equally. --out writes the JSON (the result, or with --shard that
// shard's pairs, which `merge` combines). --jobs (default: the cores, at most 4) runs that many worker processes and
// never changes the output. Progress goes to stderr.
import { spawn } from 'node:child_process'
import { availableParallelism } from 'node:os'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ENGINE_VERSION } from '@magus/engine'
import {
    ARCHETYPE_NAMES,
    ARCHETYPES,
    DEFAULT_GAMES,
    DEFAULT_SEED,
    DEFAULT_TOP,
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
} from '../src'

const MAX_JOBS = 4

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
    process.stdout.write(JSON.stringify(playPairs(plan(), mine)))
}

const runWorker = (index: number, count: number) =>
    new Promise<PairResult[]>((resolve, reject) => {
        const script = fileURLToPath(import.meta.url)
        const child = spawn(process.execPath, [...process.execArgv, script, ...args, '--worker', `${index}/${count}`], {
            stdio: ['ignore', 'pipe', 'inherit'],
        })
        let out = ''
        child.stdout.setEncoding('utf8').on('data', chunk => (out += chunk))
        child.on('error', reject)
        child.on('close', code =>
            code === 0
                ? resolve(JSON.parse(out) as PairResult[])
                : reject(new Error(`worker ${index} exited with ${code}`)),
        )
    })

const main = async () => {
    if (args[0] === 'merge') {
        const files = args.slice(1).filter((arg, i, all) => !arg.startsWith('--') && all[i - 1] !== '--out')
        if (files.length === 0) throw new Error('merge needs shard files')
        const result = mergeShards(files.map(file => readJson(file) as ShardResult))
        writeOut(result)
        console.log(formatTable(result))
        return
    }

    const workerSpec = fraction('worker', flag('worker'))
    if (workerSpec) return worker(workerSpec)

    const jobs = intFlag('jobs', Math.min(availableParallelism(), MAX_JOBS))
    if (!(jobs >= 1 && jobs <= MAX_JOBS)) throw new Error(`--jobs must be between 1 and ${MAX_JOBS}, got ${jobs}`)
    const shard = fraction('shard', flag('shard'))
    const tournament = plan()
    const { config } = tournament
    if (config.top.used < config.top.requested)
        console.error(
            `--top ${config.top.requested}: the ${config.baselineVersion} baseline has ${config.top.used} loadouts, using all`,
        )
    const total = pairList(config.entrants.length).length
    const mine = shardPairs(total, shard?.index ?? 0, shard?.count ?? 1)
    console.error(
        `${config.entrants.length} entrants, ${total} pairs x ${config.games} games; this run plays ${mine.length} pairs with ${jobs} job(s)`,
    )

    let pairs: PairResult[]
    if (jobs === 1) pairs = playPairs(tournament, mine)
    else pairs = (await Promise.all(Array.from({ length: jobs }, (_, i) => runWorker(i, jobs)))).flat()
    pairs.sort((x, y) => x.pair - y.pair)

    if (shard) {
        if (flag('out') === undefined) throw new Error('--shard needs --out FILE for its result')
        writeOut({ format: SHARD_FORMAT, config, shard, pairs } satisfies ShardResult)
        console.error(`shard ${shard.index}/${shard.count}: ${pairs.length} pairs`)
        return
    }
    const result = summarize(config, pairs)
    writeOut(result)
    console.log(formatTable(result))
}

main().catch(error => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
})
