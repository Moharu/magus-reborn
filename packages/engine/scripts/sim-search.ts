// Usage:
//   npm run sim:search -- --size N [--top K] [--jobs J] [--pool fireball,ignite,...] [--duration 60]
//                         [--reaction 0.4] [--cap C] [--no-dedupe]
// Runs every loadout of 1..N pool spells times every policy (see enumeratePolicies) through the real
// engine and prints the top K by dpsUnderPressure as JSON. The output does not depend on --jobs.
// Progress and timing go to stderr.
import { spawn } from 'node:child_process'
import { availableParallelism } from 'node:os'
import { fileURLToPath } from 'node:url'
import {
    DAMAGE_POOL,
    DEFAULT_REACTION_SECONDS,
    rankResults,
    search,
    type SearchOptions,
    type SearchResult,
    type SpellId,
} from '../src'

const toId = (s: string) => {
    const upper = s.trim().toUpperCase().replace(/-/g, '_')
    return (upper.startsWith('SPELL_') ? upper : `SPELL_${upper}`) as SpellId
}

const args = process.argv.slice(2)
const flag = (name: string) => {
    const i = args.indexOf(`--${name}`)
    return i === -1 ? undefined : args[i + 1]
}
const intFlag = (name: string, fallback?: number) => {
    const raw = flag(name)
    if (raw === undefined) {
        if (fallback === undefined) throw new Error(`--${name} is required`)
        return fallback
    }
    const n = Number(raw)
    if (!(Number.isInteger(n) && n >= 1)) throw new Error(`--${name} must be a positive integer`)
    return n
}
const numFlag = (name: string) => (flag(name) === undefined ? undefined : Number(flag(name)))

/** Runs one shard as a child process of this same script (same tsx loader) and parses its JSON. */
const runShard = (index: number, count: number) =>
    new Promise<{ evaluated: number; results: SearchResult[] }>((resolve, reject) => {
        const script = fileURLToPath(import.meta.url)
        const child = spawn(process.execPath, [...process.execArgv, script, ...args, '--shard', `${index}/${count}`], {
            stdio: ['ignore', 'pipe', 'inherit'],
        })
        let out = ''
        child.stdout.setEncoding('utf8').on('data', chunk => (out += chunk))
        child.on('error', reject)
        child.on('close', code =>
            code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`shard ${index}/${count} exited with ${code}`)),
        )
    })

const main = async () => {
    const duration = numFlag('duration')
    const reaction = numFlag('reaction')
    const cap = flag('cap') === undefined ? undefined : intFlag('cap')
    const options: SearchOptions = {
        size: intFlag('size'),
        top: intFlag('top', 10),
        pool: flag('pool') ? flag('pool')!.split(',').filter(Boolean).map(toId) : DAMAGE_POOL,
        ...(duration !== undefined ? { durationSeconds: duration } : {}),
        ...(reaction !== undefined ? { pressure: { reactionSeconds: reaction } } : {}),
        ...(cap !== undefined ? { cap } : {}),
        dedupe: !args.includes('--no-dedupe'),
    }

    const shard = flag('shard')
    if (shard !== undefined) {
        // child mode: every result of this shard, merged and truncated by the parent
        const [index, count] = shard.split('/').map(Number)
        process.stdout.write(JSON.stringify(search({ ...options, top: Infinity, shard: { index, count } })))
        return
    }

    const jobs = intFlag('jobs', Math.min(availableParallelism(), 16))
    const started = performance.now()
    let evaluated: number
    let results: SearchResult[]
    if (jobs === 1) {
        ;({ evaluated, results } = search(options))
    } else {
        const shards = await Promise.all(Array.from({ length: jobs }, (_, i) => runShard(i, jobs)))
        evaluated = shards.reduce((n, s) => n + s.evaluated, 0)
        results = rankResults(
            shards.flatMap(s => s.results),
            options.top!,
            options.dedupe,
        )
    }
    const seconds = ((performance.now() - started) / 1000).toFixed(1)
    console.error(`evaluated ${evaluated} (loadout, policy) pairs in ${seconds}s with ${jobs} job(s)`)
    const { top, pool, durationSeconds = 60, dedupe } = options
    const reactionSeconds = options.pressure?.reactionSeconds ?? DEFAULT_REACTION_SECONDS
    const header = { size: options.size, top, pool, durationSeconds, reactionSeconds, cap: cap ?? null, dedupe }
    console.log(JSON.stringify({ options: header, evaluated, results }, null, 2))
}

main().catch(error => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
})
