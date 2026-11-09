// Usage:
//   npm run arena -- --mode strategy [--fire-set a,b,c,d]... [--set a,b,c,d]... [--profiles a,b,...] [--seeds K] [--games G] [--seed S]
//                    [--max-ticks T] [--baseline VERSION] [--jobs J] [--time-budget SECONDS] [--shard i/n] [--out FILE]
//                    [--report FILE] [--date YYYY-MM-DD] [--commit SHA]
//   npm run arena -- --mode strategy merge SHARD.json... [--allow-missing] [--out FILE] [--report FILE]
//                    [--date YYYY-MM-DD] [--commit SHA]
// (`npm run arena:strategy` is the same command.) The strategy tournament (#137): every game is a mirror, both players
// get the same loadout, so only the profile varies. A setup is a Fire set with one of the 6 pairs of the four
// non-Counterspell general spells (Counterspell always in). --fire-set (four Fire spells, ids or short names such as
// fireball,living-bomb,ignite,meteor) replaces the default, the best Fire set of the dummy baseline, and may be repeated
// to run several Fire sets. A set may also be four Frost spells (#150, e.g. frostbolt,glacier,frost-bomb,ice-spear);
// --set is the element-neutral name of --fire-set, and both may be given (the --fire-set ones first). On every setup each profile plays every profile, itself included: K derived seeds (default
// 30) x G games each (even, default 36), sides alternating. --out, --jobs, --time-budget, --shard, --report and
// `merge` work as in the tournament; progress goes to stderr.
import { writeFileSync } from 'node:fs'
import {
    ARCHETYPE_NAMES,
    ARCHETYPES,
    clampJobs,
    DEFAULT_SEED,
    DEFAULT_STRATEGY_GAMES,
    DEFAULT_STRATEGY_SEEDS,
    formatStrategyReport,
    formatStrategyTable,
    jobCount,
    mergeStrategyShards,
    parseFireSet,
    planStrategy,
    playJobs,
    shardPairs,
    STRATEGY_SHARD_FORMAT,
    summarizeStrategy,
    type ArchetypeName,
    type StrategyJobResult,
    type StrategyResult,
    type StrategyShardResult,
} from '../src'
import {
    args,
    flag,
    flagValues,
    fraction,
    intFlag,
    killWorkers,
    loadBaseline,
    loadFrostBaseline,
    printTable,
    readJson,
    reportOptions,
    runWorker,
    stopper,
    writeOut,
} from './cli-common'
import { fromInvocation } from './paths'

/** Writes `--out` (JSON), prints the table and writes `--report` (Markdown) for a whole result. */
const publish = (result: StrategyResult) => {
    const report = flag('report')
    const options = report === undefined ? undefined : reportOptions()
    writeOut(result)
    printTable(formatStrategyTable(result))
    if (report !== undefined && options) writeFileSync(fromInvocation(report), formatStrategyReport(result, options))
}

const plan = () => {
    const names = (flag('profiles') ?? ARCHETYPE_NAMES.join(',')).split(',').filter(Boolean)
    for (const name of names)
        if (!(ARCHETYPE_NAMES as string[]).includes(name))
            throw new Error(`--profiles: unknown profile ${name} (one of ${ARCHETYPE_NAMES.join(', ')})`)
    const fireSets = [...flagValues('fire-set'), ...flagValues('set')].map(parseFireSet)
    const frostBaseline = loadFrostBaseline()
    return planStrategy({
        baseline: loadBaseline(),
        ...(frostBaseline ? { frostBaseline } : {}),
        ...(fireSets.length === 0 ? {} : { fireSets }),
        profiles: names.map(name => ARCHETYPES[name as ArchetypeName].profile),
        seeds: intFlag('seeds', DEFAULT_STRATEGY_SEEDS),
        games: intFlag('games', DEFAULT_STRATEGY_GAMES),
        seed: intFlag('seed', DEFAULT_SEED),
        ...(flag('max-ticks') === undefined ? {} : { maxTicks: intFlag('max-ticks', 0) }),
    })
}

/** Child mode: this worker's share of the (shard's) jobs, as JSON on stdout. */
const worker = (spec: { index: number; count: number }) => {
    const shard = fraction('shard', flag('shard')) ?? { index: 0, count: 1 }
    const tournament = plan()
    const mine = shardPairs(jobCount(tournament.config), shard.index, shard.count).filter(
        (_, i) => i % spec.count === spec.index,
    )
    process.stdout.write(JSON.stringify(playJobs(tournament, mine, undefined, stopper())))
}

const main = async () => {
    if (args[0] === 'merge') {
        // every flag but --allow-missing takes a value, so the files are the arguments that are neither a flag nor its value
        const files = args
            .slice(1)
            .filter(
                (arg, i, all) =>
                    !arg.startsWith('--') && (all[i - 1] === '--allow-missing' || !all[i - 1]?.startsWith('--')),
            )
        if (files.length === 0) throw new Error('merge needs shard files')
        publish(
            mergeStrategyShards(
                files.map(file => readJson(file) as StrategyShardResult),
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
    const shard = fraction('shard', flag('shard'))
    if (shard && flag('report') !== undefined)
        throw new Error('--report needs a whole run: merge the shards, then report')
    const tournament = plan()
    const { config } = tournament
    const total = jobCount(config)
    const mine = shardPairs(total, shard?.index ?? 0, shard?.count ?? 1)
    console.error(
        `${config.setups.length} mirror setups x ${config.profiles.length} profiles, ${config.seeds * config.games} games per cell; ${total} jobs, this run plays ${mine.length} with ${jobs} job(s)`,
    )

    let played: StrategyJobResult[]
    if (jobs === 1) played = playJobs(tournament, mine, undefined, stop)
    else
        played = (
            await Promise.all(
                Array.from({ length: jobs }, (_, i) => runWorker<StrategyJobResult[]>(import.meta.url, i, jobs)),
            )
        ).flat()
    played.sort((x, y) => x.job - y.job)
    const partial = played.length < mine.length
    if (partial) console.error(`warning: the time budget ended the run after ${played.length} of ${mine.length} jobs`)

    if (shard) {
        if (flag('out') === undefined) throw new Error('--shard needs --out FILE for its result')
        writeOut({
            format: STRATEGY_SHARD_FORMAT,
            config,
            shard,
            ...(partial ? { partial: true as const } : {}),
            jobs: played,
        } satisfies StrategyShardResult)
        console.error(`shard ${shard.index}/${shard.count}: ${played.length} jobs${partial ? ' (partial)' : ''}`)
        return
    }
    publish(summarizeStrategy(config, played, partial))
}

main().catch(error => {
    killWorkers()
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
})
