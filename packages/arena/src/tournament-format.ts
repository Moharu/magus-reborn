import type { TournamentResult } from './tournament'

/** `SPELL_TEMPORAL_SHIELD` as `Temporal Shield`. */
export const spellName = (id: string) =>
    id
        .replace(/^SPELL_/, '')
        .split('_')
        .map(word => word[0] + word.slice(1).toLowerCase())
        .join(' ')

/** Shown instead of a win rate for an entrant that played no games (a partial run stopped before its pairs). */
export const NO_GAMES = 'no games'

export const percent = (x: number) => `${(x * 100).toFixed(1)}%`

/**
 * The compact ranked table, then a legend for the loadouts (`L<rank>`: baseline rank, spells, dummy DPS). Columns: rank,
 * loadout, profile, wins, games, win rate and its 95% interval. Draws are shown for information; they don't score.
 */
export const formatTable = (result: TournamentResult) => {
    const rows = result.ranking.map(r => [
        String(r.rank),
        `L${String(r.loadoutRank).padStart(2, '0')}`,
        r.profile,
        String(r.wins),
        String(r.draws),
        String(r.games),
        r.games === 0 ? NO_GAMES : percent(r.winRate),
        r.games === 0 ? NO_GAMES : `${percent(r.ci95.low)}-${percent(r.ci95.high)}`,
    ])
    const header = ['#', 'loadout', 'profile', 'wins', 'draws', 'games', 'win rate', '95% CI']
    const widths = header.map((h, i) => Math.max(h.length, ...rows.map(row => row[i].length)))
    const line = (cells: string[]) =>
        cells
            .map((cell, i) => (i === 2 || i === 1 ? cell.padEnd(widths[i]) : cell.padStart(widths[i])))
            .join('  ')
            .trimEnd()
    const { config } = result
    const legend = config.entrants
        .filter((e, i) => config.entrants.findIndex(o => o.loadoutRank === e.loadoutRank) === i)
        .map(e => {
            const baseline = config.loadouts.find(l => l.rank === e.loadoutRank)
            const spells = e.loadout.map(spellName)
            return (
                `L${String(e.loadoutRank).padStart(2, '0')}  ${spells.slice(0, 4).join(', ')} | ${spells[4]} | ${spells.slice(5).join(', ')}` +
                (baseline
                    ? `  (dps ${baseline.dps.toFixed(1)}, under pressure ${baseline.dpsUnderPressure.toFixed(1)})`
                    : '')
            )
        })
    return [
        `${result.games} matches, ${config.entrants.length} entrants, ${config.games} games per pair, seed ${config.seed}, baseline ${config.baselineVersion}. Only wins score.`,
        ...(result.partial
            ? [
                  `PARTIAL: ${result.partial.missingShards ? `the run played ${result.partial.pairsPlayed} of ${result.partial.pairsTotal} pairs (missing shards ${result.partial.missingShards.join(', ')})` : `the time budget ended the run after ${result.partial.pairsPlayed} of ${result.partial.pairsTotal} pairs`}; these rates cover the played pairs only.`,
              ]
            : []),
        line(header),
        ...rows.map(line),
        '',
        ...legend,
    ].join('\n')
}
