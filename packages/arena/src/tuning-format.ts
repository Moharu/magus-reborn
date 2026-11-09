import { percent, spellName } from './tournament-format'
import type { Score, TuningResult } from './tuning'

const loadoutLabel = (rank: number) => `L${String(rank).padStart(2, '0')}`
const record = (score: Score) => `${score.wins}/${score.games} wins`

/** A change in win rate in percentage points, signed: `+3.1 pp`. */
const points = (from: Score, to: Score) => {
    const delta = Math.round((to.winRate - from.winRate) * 1000) / 10
    return `${delta > 0 ? '+' : ''}${delta.toFixed(1)} pp`
}

/**
 * The run as readable text: one row per generation (population best, median and worst win rate, the best profile and
 * its win rate on each loadout), then the best profile's selection and holdout win rates, the parameters it changed,
 * (with `compareToStart`, the improvement over the untuned starting profile on both seed sets),
 * whether the budget cut the run short, and the loadout legend.
 */
export const formatTuning = (result: TuningResult) => {
    const { config, best } = result
    const loadouts = config.loadouts.map(l => loadoutLabel(l.rank))
    const header = ['gen', 'best', 'median', 'worst', 'best profile', ...loadouts]
    const rows = result.generations.map(g => {
        const top = g.ranking[0]
        return [
            String(g.generation),
            percent(g.best),
            percent(g.median),
            percent(g.worst),
            `${top.profile.name} (${top.origin})`,
            ...top.score.perLoadout.map(l => percent(l.winRate)),
        ]
    })
    const widths = header.map((h, i) => Math.max(h.length, ...rows.map(row => row[i].length)))
    const line = (cells: string[]) =>
        cells
            .map((cell, i) => (i === 4 ? cell.padEnd(widths[i]) : cell.padStart(widths[i])))
            .join('  ')
            .trimEnd()
    const changes = best.changes.length
        ? best.changes.map(c => `  ${c.path}: ${JSON.stringify(c.from)} -> ${JSON.stringify(c.to)}`)
        : ['  none (the starting profile itself)']
    const legend = config.loadouts.map(({ rank, loadout }) => {
        const spells = loadout.map(spellName)
        return `${loadoutLabel(rank)}  ${spells.slice(0, 4).join(', ')} | ${spells[4]} | ${spells.slice(5).join(', ')}`
    })
    return [
        `Self-tuning${config.tunedProfile ? ` of ${config.tunedProfile} only` : ''}, seed ${config.seed}: population ${config.population}, ${config.generations} generation(s), elite ${config.elite}. ` +
            `Each profile plays ${config.matchesPerProfile} matches against ${config.field.join(', ')} on ${loadouts.length} loadout(s), ` +
            `${config.games} games per pair, baseline ${config.baselineVersion}. Only wins score.`,
        line(header),
        ...rows.map(line),
        '',
        `Best profile: ${best.profile.name} (from ${best.origin})`,
        `  selection seeds: ${percent(best.score.winRate)} (${record(best.score)})`,
        `  fresh seeds (holdout, not used for selection): ${percent(best.holdout.winRate)} (${record(best.holdout)})`,
        ...(result.start
            ? [
                  `Untuned starting point (${result.start.profile.name}), same seeds:`,
                  `  selection seeds: ${percent(result.start.score.winRate)} (${record(result.start.score)}), tuned ${points(result.start.score, best.score)}`,
                  `  fresh seeds (holdout): ${percent(result.start.holdout.winRate)} (${record(result.start.holdout)}), tuned ${points(result.start.holdout, best.holdout)}`,
              ]
            : []),
        'Changed parameters:',
        ...changes,
        ...(result.partial && result.stopped
            ? [
                  '',
                  `PARTIAL: the --max-matches budget of ${config.maxMatches} had no room left for the next profile in generation ${result.stopped.generation} ` +
                      `(${result.stopped.scored} of ${config.population} scored), so the run stopped there; this is the best found so far.`,
              ]
            : []),
        '',
        `${result.matches} matches in total.`,
        ...legend,
    ].join('\n')
}
