// Usage:
//   npm run sim:search -- [--top K] [--jobs J] [--fire fireball,ignite,...] [--general haste,blur,...]
//                         [--duration 60] [--reaction 0.4] [--cap C] [--no-dedupe]
// Runs every 0.2 loadout (4 Fire spells, Counterspell, 2 general spells; --fire and --general narrow the
// pools) times every policy (see searchCandidates) through the real engine and prints the top K by
// dpsUnderPressure as JSON. The output does not depend on --jobs (default: the cores, at most 4).
// Progress and timing go to stderr.
import { spawn } from 'node:child_process'
import { availableParallelism } from 'node:os'
import { fileURLToPath } from 'node:url'
import {
    DEFAULT_ELEMENT,
    DEFAULT_REACTION_SECONDS,
    enumerateShapeLoadouts,
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
    if (i === -1) return undefined
    const value = args[i + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`--${name} needs a value`)
    return value
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
const listFlag = (name: string) => flag(name)?.split(',').filter(Boolean).map(toId)

/** Default worker count: one per core, but never more than this, so a default run stays a light load. */
const MAX_DEFAULT_JOBS = 4

/** Runs one shard as a child process of this same script (same tsx loader) and parses its JSON. */
const runShard = (index: number, count: number) =>
    new Promise<{ evaluated: number; pairs: number; results: SearchResult[] }>((resolve, reject) => {
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
    for (const removed of ['size', 'pool'])
        if (args.includes(`--${removed}`))
            throw new Error(
                `--${removed} was removed: the search covers the 0.2 loadouts; narrow them with --fire/--general`,
            )
    const elementSpells = listFlag('fire')
    const generalSpells = listFlag('general')
    const options: SearchOptions = {
        top: intFlag('top', 10),
        ...(elementSpells ? { elementSpells } : {}),
        ...(generalSpells ? { generalSpells } : {}),
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

    const loadouts = enumerateShapeLoadouts(options).length // validates --fire/--general before forking
    const jobs = intFlag('jobs', Math.min(availableParallelism(), MAX_DEFAULT_JOBS))
    const started = performance.now()
    let evaluated: number
    let pairs: number
    let results: SearchResult[]
    if (jobs === 1) {
        ;({ evaluated, pairs, results } = search(options))
    } else {
        const shards = await Promise.all(Array.from({ length: jobs }, (_, i) => runShard(i, jobs)))
        evaluated = shards.reduce((n, s) => n + s.evaluated, 0)
        pairs = shards.reduce((n, s) => n + s.pairs, 0)
        results = rankResults(
            shards.flatMap(s => s.results),
            options.top!,
            options.dedupe,
        )
    }
    const seconds = ((performance.now() - started) / 1000).toFixed(1)
    console.error(
        `simulated ${evaluated} policies covering ${pairs} (loadout, policy) pairs over ${loadouts} loadouts in ${seconds}s with ${jobs} job(s)`,
    )
    const { top, durationSeconds = 60, dedupe } = options
    const reactionSeconds = options.pressure?.reactionSeconds ?? DEFAULT_REACTION_SECONDS
    const header = {
        element: DEFAULT_ELEMENT,
        fire: elementSpells ?? null,
        general: generalSpells ?? null,
        loadouts,
        top,
        durationSeconds,
        reactionSeconds,
        cap: cap ?? null,
        dedupe,
    }
    console.log(JSON.stringify({ options: header, evaluated, pairs, results }, null, 2))
}

main().catch(error => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
})
