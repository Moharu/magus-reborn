// Usage:
//   npm run arena -- [--top N] [--general-pairs K] [--profiles a,b,...] [--games G] [--seed S] [--max-ticks T]
//                    [--baseline VERSION] [--jobs J] [--time-budget SECONDS] [--shard i/n] [--out FILE]
//                    [--report FILE] [--date YYYY-MM-DD] [--commit SHA] [--bracket-best-of N] [--no-bracket]
//   npm run arena -- merge SHARD.json... [--allow-missing] [--out FILE] [--report FILE] [--date YYYY-MM-DD] [--commit SHA]
//                    [--bracket-best-of N] [--no-bracket]
// (`npm run arena:tournament` is the same command.) Plays a round-robin between entrants (the top N distinct Fire sets, each with its best K general pairs, default all 6, x the profiles) and prints the ranked table:
// win rate only, games per pair even so sides swap equally. --out writes the JSON (the result, or with --shard that
// shard's pairs, which `merge` combines). --jobs (default 4, values above 4 are clamped to 4 with a warning) runs that
// many worker processes and never changes the output. --time-budget stops the run when that many seconds have passed
// (each pair is finished first); the result is then partial and its table and report say so. --report writes the
// Markdown report (#105). A whole run (not a --shard) and `merge` then play the top-8 double-elimination bracket (#136)
// with best-of-N sets (--bracket-best-of, default 5), recorded in the JSON and the report; --no-bracket skips it.
// Progress goes to stderr.
import { writeFileSync } from 'node:fs'
import { fromInvocation } from './paths'
import {
    ARCHETYPE_NAMES,
    ARCHETYPES,
    clampJobs,
    DEFAULT_BEST_OF,
    DEFAULT_GAMES,
    DEFAULT_SEED,
    DEFAULT_GENERAL_PAIRS,
    DEFAULT_TOP,
    formatBracket,
    formatReport,
    formatTable,
    mergeShards,
    pairList,
    planTournament,
    playPairs,
    shardPairs,
    SHARD_FORMAT,
    summarize,
    withBracket,
    type ArchetypeName,
    type PairResult,
    type ShardResult,
    type TournamentResult,
} from '../src'
import {
    args,
    flag,
    fraction,
    intFlag,
    killWorkers,
    loadBaseline,
    printTable,
    readJson,
    reportOptions,
    runWorker,
    stopper,
    writeOut,
} from './cli-common'

/** The flags that take no value. */
const SWITCHES = ['--allow-missing', '--no-bracket']

/** `--bracket-best-of`: odd and at least 1. */
const bracketBestOf = () => {
    const bestOf = intFlag('bracket-best-of', DEFAULT_BEST_OF)
    if (!(bestOf >= 1 && bestOf % 2 === 1))
        throw new Error(`--bracket-best-of must be an odd positive integer, got ${bestOf}`)
    return bestOf
}

/**
 * Plays the bracket (unless --no-bracket), writes `--out` (JSON), prints the table and writes `--report` (Markdown)
 * for a whole tournament result.
 */
const publish = (whole: TournamentResult) => {
    const report = flag('report')
    const options = report === undefined ? undefined : reportOptions()
    let result = whole
    let skipped: string | undefined = '--no-bracket was given'
    if (!args.includes('--no-bracket')) {
        console.error('playing the top-8 double-elimination bracket')
        ;({ result, skipped } = withBracket(whole, { bestOf: bracketBestOf() }))
        if (skipped) console.error(`warning: no bracket: ${skipped}`)
    }
    writeOut(result)
    printTable(formatTable(result) + (result.bracket ? `\n\n${formatBracket(result.bracket)}` : ''))
    if (report !== undefined && options)
        writeFileSync(
            fromInvocation(report),
            formatReport(result, { ...options, ...(skipped === undefined ? {} : { bracketSkipped: skipped }) }),
        )
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

const main = async () => {
    if (args[0] === 'merge') {
        // every flag but the switches takes a value, so the files are the arguments that are neither a flag nor its value
        const files = args
            .slice(1)
            .filter(
                (arg, i, all) =>
                    !arg.startsWith('--') && (SWITCHES.includes(all[i - 1]) || !all[i - 1]?.startsWith('--')),
            )
        if (files.length === 0) throw new Error('merge needs shard files')
        publish(
            mergeShards(
                files.map(file => readJson(file) as ShardResult),
                { allowMissing: args.includes('--allow-missing') },
            ),
        )
        return
    }

    const workerSpec = fraction('worker', flag('worker'))
    if (workerSpec) return worker(workerSpec)

    const { jobs, warning } = clampJobs(flag('jobs') === undefined ? undefined : intFlag('jobs', 0))
    if (warning) console.error(`warning: ${warning}`)
    const stop = stopper()
    if (flag('report') !== undefined) reportOptions() // a bad --date or --commit fails before the run, not after
    if (!args.includes('--no-bracket')) bracketBestOf() // the same for a bad --bracket-best-of
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
    else
        pairs = (
            await Promise.all(Array.from({ length: jobs }, (_, i) => runWorker<PairResult[]>(import.meta.url, i, jobs)))
        ).flat()
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
