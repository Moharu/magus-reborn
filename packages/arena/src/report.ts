import { ELEMENT_SPELL_COUNT, ELEMENTS, FIXED_SPELL, type SpellElement, type SpellId } from '@magus/engine'
import { baselineFile } from './baseline'
import type { BracketResult } from './bracket'
import { wilsonInterval } from './stats'
import { elementOf, loadoutLabel, pairList, type RankedEntrant, type TournamentResult } from './tournament'
import { NO_GAMES, percent, spellName } from './tournament-format'

/**
 * The arena report (#105): the Markdown a run publishes (workflow step summary, artifact, the release balance report).
 * A pure function of the result and the two options, so the tables are the same for a given seed and inputs; the
 * date is the one thing that changes between runs, and it is in the header only.
 *
 * Fixed sections, in this order: Header, Dummy baseline, Arena win rates, Elements (#150), General pairs, Matchup
 * matrix, Bracket, Caveats.
 */
export const REPORT_SECTIONS = [
    'Header',
    'Dummy baseline',
    'Arena win rates',
    'Elements',
    'General pairs',
    'Matchup matrix',
    'Bracket',
    'Caveats',
] as const

/** The general spells in the order a pair is named (Haste first), and the order the six pairs are listed in. */
const GENERAL_ORDER: readonly SpellId[] = ['SPELL_HASTE', 'SPELL_BLUR', 'SPELL_MAGIC_EATER', 'SPELL_TEMPORAL_SHIELD']

/** An entrant's general pair, named in `GENERAL_ORDER`: `Haste + Blur`. */
const generalPair = (loadout: readonly SpellId[]) =>
    loadout
        .slice(ELEMENT_SPELL_COUNT)
        .filter(id => id !== FIXED_SPELL)
        .sort((x, y) => GENERAL_ORDER.indexOf(x) - GENERAL_ORDER.indexOf(y))
        .map(spellName)
        .join(' + ')

/** Wins, draws and games pooled over `entrants`. */
const pool = (entrants: readonly RankedEntrant[]) => ({
    entrants: entrants.length,
    wins: entrants.reduce((sum, r) => sum + r.wins, 0),
    draws: entrants.reduce((sum, r) => sum + r.draws, 0),
    games: entrants.reduce((sum, r) => sum + r.games, 0),
})

/**
 * An element's pooled entrant totals as games counted once (#163). `pooled` sums over the element's entrants, so a
 * game between two of them is in it twice (a win and a loss, or two draws); `cross` is the element's games against the
 * other element, which are in it once. Each same-element game becomes one game: half a win when decided, a draw when
 * drawn. A Fire-only run has no cross games and every game is a same-element one.
 */
const onceEach = (pooled: ReturnType<typeof pool>, cross = { wins: 0, draws: 0, games: 0 }) => {
    const sameGames = (pooled.games - cross.games) / 2
    const sameDraws = (pooled.draws - cross.draws) / 2
    return {
        entrants: pooled.entrants,
        wins: pooled.wins - (sameGames - sameDraws) / 2,
        draws: cross.draws + sameDraws,
        games: cross.games + sameGames,
    }
}

export const rateWithInterval = (wins: number, games: number) => {
    if (games === 0) return NO_GAMES
    const { low, high } = wilsonInterval(wins, games)
    return `${percent(wins / games)} (${percent(low)}-${percent(high)})`
}

const bracketSection = (bracket: BracketResult | undefined, skipped: string | undefined) => {
    const head = ['## Bracket', '']
    if (!bracket)
        return [
            ...head,
            `Not run${skipped ? `: ${skipped}` : ''}. The top-8 double-elimination bracket runs after a whole round-robin by default (\`npm run arena\`, or \`merge\` of the shards).`,
        ].join('\n')
    const seed = (n: number) => `${n} ${bracket.seeds[n - 1].id}`
    return [
        ...head,
        `The round-robin's top ${bracket.seeds.length}, seeded by rank (1v8, 4v5, 2v7, 3v6), in a double-elimination bracket. Every set is a best-of-${bracket.bestOf}; sides alternate game by game, the better seed moving first in the set's first game. A draw counts for nobody and is replayed, up to ${bracket.drawCap} draws a set; one more ends the set, to the entrant with more wins or, level, the better seed ("by seed"). The grand final has a bracket reset: if the lower-bracket winner takes the first set, a second set decides.`,
        '',
        '### Seeds',
        '',
        table(
            ['Seed', 'Entrant', 'Round-robin rank', 'Win rate'],
            bracket.seeds.map(s => [String(s.seed), s.id, String(s.rank), percent(s.winRate)]),
            [1],
        ),
        '',
        '### Sets',
        '',
        table(
            ['Set', 'Round', 'Better seed', 'Other seed', 'Score', 'Draws', 'Winner'],
            bracket.sets.map(s => [
                s.id,
                s.round,
                seed(s.a),
                seed(s.b),
                `${s.winsA}-${s.winsB}`,
                String(s.draws),
                seed(s.winner) + (s.decidedBy === 'seed' ? ' (by seed)' : ''),
            ]),
            [0, 1, 2, 3, 6],
        ),
        '',
        '### Placements',
        '',
        table(
            ['Place', 'Entrants'],
            bracket.placements.map(p => [p.place, p.seeds.map(seed).join(', ')]),
            [0, 1],
        ),
    ].join('\n')
}

export interface ReportOptions {
    /** The report date, `YYYY-MM-DD` (UTC). Given by the caller: the report itself reads no clock. */
    readonly date: string
    /** The commit the run was built from, shown when given. */
    readonly commit?: string
    /** Why the bracket was not run, shown in its section when the result has none. */
    readonly bracketSkipped?: string
}

export const table = (header: string[], rows: string[][], left: number[] = [0]) => {
    const line = (cells: string[]) => `| ${cells.join(' | ')} |`
    const rule = header.map((_, i) => (left.includes(i) ? ':---' : '---:'))
    return [line(header), line(rule), ...rows.map(line)].join('\n')
}

export const rate = (wins: number, games: number) => (games === 0 ? 0 : wins / games)

/** `FIRE` as `Fire`. */
const elementName = (element: SpellElement) => element[0] + element.slice(1).toLowerCase()

/**
 * The Elements section (#150): how each element fares against the other, over the games between a Fire entrant and a
 * Frost one (the played pairs only), overall and per profile, with 95% Wilson intervals; then each element's win rate
 * over all its games. A Fire-only run says so.
 */
const elementsSection = (result: TournamentResult) => {
    const { config, ranking, partial } = result
    const head = ['## Elements', '']
    const present = ELEMENTS.filter(element => config.entrants.some(e => elementOf(e) === element))
    if (present.length < 2)
        return [
            ...head,
            `${present.map(elementName).join(', ') || 'No'} entrants only: no cross-element games. Frost sets play alongside the Fire ones when the version has a Frost table (\`baselines/${baselineFile(config.baselineVersion, 'FROST')}\`) and \`--frost-top\` is not 0.`,
        ].join('\n')
    const profiles = config.profiles.map(p => p.name)
    const played = partial ? new Set(partial.played) : undefined
    // per element (and per element and profile): wins, draws and games against the other element
    const cross = new Map<string, { wins: number; draws: number; games: number }>()
    const add = (key: string, wins: number, draws: number) => {
        const value = cross.get(key) ?? { wins: 0, draws: 0, games: 0 }
        value.wins += wins
        value.draws += draws
        value.games += config.games
        cross.set(key, value)
    }
    pairList(config.entrants.length).forEach(([i, j], pair) => {
        if (played && !played.has(pair)) return
        const a = config.entrants[i]
        const b = config.entrants[j]
        if (elementOf(a) === elementOf(b)) return
        const winsA = result.matrix[a.id][b.id]
        const winsB = result.matrix[b.id][a.id]
        const draws = config.games - winsA - winsB
        add(elementOf(a), winsA, draws)
        add(elementOf(b), winsB, draws)
        add(`${elementOf(a)}\n${a.profile}`, winsA, draws)
        add(`${elementOf(b)}\n${b.profile}`, winsB, draws)
    })
    const ci = (wins: number, games: number) => {
        if (games === 0) return NO_GAMES
        const { low, high } = wilsonInterval(wins, games)
        return `${percent(low)}-${percent(high)}`
    }
    const versus = (element: SpellElement) =>
        present
            .filter(other => other !== element)
            .map(elementName)
            .join(', ')
    return [
        ...head,
        `Fire against Frost: every game between a Fire entrant and a Frost one (both sides of the same games, so the two win rates and the draws add up to 100%), with the 95% Wilson interval. Each element's sets are its own table's top sets (\`baselines/${baselineFile(config.baselineVersion)}\`, \`baselines/${baselineFile(config.baselineVersion, 'FROST')}\`), so this compares the field's best of each, played by these profiles.`,
        '',
        '### Fire vs Frost',
        '',
        table(
            ['Element', 'Against', 'Entrants', 'Wins', 'Draws', 'Games', 'Win rate', '95% CI'],
            present.map(element => {
                const value = cross.get(element) ?? { wins: 0, draws: 0, games: 0 }
                return [
                    elementName(element),
                    versus(element),
                    String(ranking.filter(r => elementOf(r) === element).length),
                    String(value.wins),
                    String(value.draws),
                    String(value.games),
                    value.games === 0 ? NO_GAMES : percent(rate(value.wins, value.games)),
                    ci(value.wins, value.games),
                ]
            }),
            [0, 1],
        ),
        '',
        '### Per profile',
        '',
        "Win rate (95% CI) of each profile's entrants of one element against every entrant of the other element.",
        '',
        table(
            ['Profile', ...present.map(element => `${elementName(element)} vs ${versus(element)}`)],
            profiles.map(profile => [
                profile,
                ...present.map(element => {
                    const value = cross.get(`${element}\n${profile}`)
                    return value ? rateWithInterval(value.wins, value.games) : '-'
                }),
            ]),
        ),
        '',
        '### All games',
        '',
        "Each element's win rate over all its entrants' games, those between two entrants of the same element included. Every game counts once: a game between two entrants of the same element is one game of that element, worth half a win when it was decided (one entrant won, the other lost) and a draw when it was drawn.",
        '',
        table(
            ['Element', 'Entrants', 'Wins', 'Draws', 'Games', 'Win rate', '95% CI'],
            present.map(element => {
                const p = onceEach(pool(ranking.filter(r => elementOf(r) === element)), cross.get(element))
                return [
                    elementName(element),
                    String(p.entrants),
                    String(p.wins),
                    String(p.draws),
                    String(p.games),
                    p.games === 0 ? NO_GAMES : percent(rate(p.wins, p.games)),
                    ci(p.wins, p.games),
                ]
            }),
        ),
    ].join('\n')
}

export const formatReport = (result: TournamentResult, options: ReportOptions): string => {
    const { config, ranking, partial } = result
    const profiles = config.profiles.map(p => p.name)
    const loadoutRanks = config.loadouts.map(l => l.rank)
    const spells = (loadout: { rank: number; element?: SpellElement }) => {
        const entrant = config.entrants.find(e => e.loadoutRank === loadout.rank && elementOf(e) === elementOf(loadout))
        return entrant ? entrant.loadout.map(spellName) : []
    }
    const totalDraws = ranking.reduce((sum, r) => sum + r.draws, 0) / 2
    const decided = result.games - totalDraws

    const header = [
        '## Header',
        '',
        `- **Version:** \`${config.baselineVersion}\``,
        `- **Seed:** ${config.seed}`,
        `- **Date:** ${options.date} (UTC)`,
        ...(options.commit === undefined ? [] : [`- **Commit:** \`${options.commit}\``]),
        `- **Status:** ${
            partial
                ? `PARTIAL: ${partial.pairsPlayed} of ${partial.pairsTotal} pairs played` +
                  (partial.missingShards ? `, missing shards ${partial.missingShards.join(', ')}` : '')
                : `complete: ${(config.entrants.length * (config.entrants.length - 1)) / 2} pairs played`
        }`,
        `- **Entrants:** ${config.entrants.length} (${loadoutRanks.length} loadouts x ${profiles.length} profiles: ${profiles.join(', ')})`,
        `- **Loadouts:** top ${config.top.used} Fire sets` +
            (config.top.used < config.top.requested
                ? ` (${config.top.requested} requested, the baseline has fewer)`
                : '') +
            (config.frost
                ? ` and top ${config.frost.top.used} Frost sets` +
                  (config.frost.top.used < config.frost.top.requested
                      ? ` (${config.frost.top.requested} requested, the Frost table has fewer)`
                      : '')
                : '') +
            `, ${config.generalPairs} general pair(s) each`,
        `- **Games:** ${config.games} per pair, ${result.games} played, time cap ${config.maxTicks} ticks`,
    ].join('\n')

    const baseline = [
        '## Dummy baseline',
        '',
        config.frost
            ? `The entrants' loadouts with their damage per second on a training dummy (\`baselines/${baselineFile(config.baselineVersion)}\` for Fire and \`baselines/${baselineFile(config.baselineVersion, 'FROST')}\` for Frost, from \`npm run sim:search\`). "Under pressure" is the search's Counterspell-pressure model. L<rank> is a Fire loadout's rank in the Fire table, I<rank> a Frost loadout's in the Frost table.`
            : `The entrants' loadouts with their damage per second on a training dummy (\`baselines/${config.baselineVersion}.json\`, from \`npm run sim:search\`). "Under pressure" is the search's Counterspell-pressure model. L<rank> is the loadout's rank in that table.`,
        '',
        table(
            [
                'Loadout',
                config.frost ? 'Element set' : 'Fire set',
                'Counterspell',
                'General spells',
                'DPS',
                'DPS under pressure',
            ],
            config.loadouts.map(l => {
                const names = spells(l)
                return [
                    loadoutLabel({ loadoutRank: l.rank, element: l.element }),
                    names.slice(0, ELEMENT_SPELL_COUNT).join(', '),
                    names[ELEMENT_SPELL_COUNT] ?? '',
                    names.slice(ELEMENT_SPELL_COUNT + 1).join(', '),
                    l.dps.toFixed(1),
                    l.dpsUnderPressure.toFixed(1),
                ]
            }),
            [0, 1, 2, 3],
        ),
    ].join('\n')

    const byProfile = profiles
        .map(name => {
            const own = ranking.filter(r => r.profile === name)
            const wins = own.reduce((sum, r) => sum + r.wins, 0)
            const draws = own.reduce((sum, r) => sum + r.draws, 0)
            const games = own.reduce((sum, r) => sum + r.games, 0)
            return { name, entrants: own.length, wins, draws, games }
        })
        .sort(
            (x, y) =>
                Number(x.games === 0) - Number(y.games === 0) ||
                y.wins * x.games - x.wins * y.games ||
                (x.name < y.name ? -1 : x.name > y.name ? 1 : 0),
        )
    const winRates = [
        '## Arena win rates',
        '',
        'Only wins score: a draw (time cap or both players dead on the same tick) and a loss are both non-wins. Intervals are 95% Wilson.',
        '',
        '### By profile',
        '',
        table(
            ['Profile', 'Entrants', 'Wins', 'Draws', 'Games', 'Win rate'],
            byProfile.map(p => [
                p.name,
                String(p.entrants),
                String(p.wins),
                String(p.draws),
                String(p.games),
                p.games === 0 ? NO_GAMES : percent(rate(p.wins, p.games)),
            ]),
        ),
        '',
        '### By entrant',
        '',
        table(
            ['#', 'Loadout', 'Profile', 'Wins', 'Draws', 'Games', 'Win rate', '95% CI'],
            ranking.map(r => [
                String(r.rank),
                loadoutLabel(r),
                r.profile,
                String(r.wins),
                String(r.draws),
                String(r.games),
                r.games === 0 ? NO_GAMES : percent(r.winRate),
                r.games === 0 ? NO_GAMES : `${percent(r.ci95.low)}-${percent(r.ci95.high)}`,
            ]),
            [1, 2],
        ),
    ].join('\n')

    // win rate by general pair and with vs without Haste (#136), over all profiles and per profile
    const pairs = [...new Set(config.entrants.map(e => generalPair(e.loadout)))].sort((x, y) => {
        const key = (name: string) => name.split(' + ').map(n => GENERAL_ORDER.map(spellName).indexOf(n))
        const [kx, ky] = [key(x), key(y)]
        return kx[0] - ky[0] || kx[1] - ky[1]
    })
    const haste = spellName('SPELL_HASTE')
    const groups: { name: string; has: (r: RankedEntrant) => boolean }[] = [
        ...pairs.map(name => ({ name, has: (r: RankedEntrant) => generalPair(r.loadout) === name })),
        { name: 'With Haste', has: r => r.loadout.includes('SPELL_HASTE') },
        { name: 'Without Haste', has: r => !r.loadout.includes('SPELL_HASTE') },
    ]
    const general = [
        '## General pairs',
        '',
        `Win rate by the entrants' general pair (Counterspell is in every loadout), and with ${haste} against without it, pooled over every entrant with that pair (all ${config.frost ? 'Fire and Frost' : 'Fire'} sets), with the 95% Wilson interval. A group's games include those against entrants of the same group.`,
        '',
        '### All profiles',
        '',
        table(
            ['General pair', 'Entrants', 'Wins', 'Draws', 'Games', 'Win rate', '95% CI'],
            groups.map(({ name, has }) => {
                const p = pool(ranking.filter(has))
                const ci = wilsonInterval(p.wins, p.games)
                return [
                    name,
                    String(p.entrants),
                    String(p.wins),
                    String(p.draws),
                    String(p.games),
                    p.games === 0 ? NO_GAMES : percent(rate(p.wins, p.games)),
                    p.games === 0 ? NO_GAMES : `${percent(ci.low)}-${percent(ci.high)}`,
                ]
            }),
        ),
        '',
        '### Per profile',
        '',
        'Win rate (95% CI) of each profile with each general pair.',
        '',
        table(
            ['General pair', ...profiles],
            groups.map(({ name, has }) => [
                name,
                ...profiles.map(profile => {
                    const p = pool(ranking.filter(r => r.profile === profile && has(r)))
                    return p.entrants === 0 ? '-' : rateWithInterval(p.wins, p.games)
                }),
            ]),
        ),
    ].join('\n')

    // profile against profile, over the pairs that were played: wins of the row's entrants against the column's
    const cell = new Map<string, { wins: number; games: number }>()
    const get = (row: string, column: string) => {
        const key = `${row}\n${column}`
        let value = cell.get(key)
        if (!value) cell.set(key, (value = { wins: 0, games: 0 }))
        return value
    }
    const played = partial ? new Set(partial.played) : undefined
    pairList(config.entrants.length).forEach(([i, j], pair) => {
        if (played && !played.has(pair)) return
        const a = config.entrants[i]
        const b = config.entrants[j]
        if (a.profile === b.profile) return
        const forward = get(a.profile, b.profile)
        const backward = get(b.profile, a.profile)
        forward.wins += result.matrix[a.id][b.id]
        backward.wins += result.matrix[b.id][a.id]
        forward.games += config.games
        backward.games += config.games
    })
    const matrix = [
        '## Matchup matrix',
        '',
        'Profile against profile: the share of games the row profile won against the column profile, over every pair of their entrants (all loadouts), with wins/games. Row and column rates add to less than 100% by the draws. The diagonal is empty: two entrants of one profile differ only by loadout. The full entrant-by-entrant matrix is in the result JSON (`matrix`).',
        '',
        table(
            ['Row \\ column', ...profiles],
            profiles.map(row => [
                row,
                ...profiles.map(column => {
                    const value = row === column ? undefined : cell.get(`${row}\n${column}`)
                    return value ? `${percent(rate(value.wins, value.games))} (${value.wins}/${value.games})` : '-'
                }),
            ]),
        ),
    ].join('\n')

    const gameCounts = ranking.map(r => r.games)
    const minGames = Math.min(...gameCounts)
    const maxGames = Math.max(...gameCounts)
    const widest = Math.max(0, ...ranking.filter(r => r.games > 0).map(r => (r.ci95.high - r.ci95.low) / 2))
    const caveats = [
        '## Caveats',
        '',
        partial
            ? `- **Partial run.** ${
                  partial.missingShards
                      ? `Shards ${partial.missingShards.join(', ')} were missing (their job failed), so`
                      : 'The time budget ended the run, so'
              } only ${partial.pairsPlayed} of ${partial.pairsTotal} pairs were played. Entrants with no games show "${NO_GAMES}" and rank last. The pairs are played in a fixed order, so entrants late in it played fewer games: compare the Games column before the win rates. A run stopped by its time budget is not reproducible, because where it stops depends on the machine's speed.`
            : '- **Partial runs.** This run is complete: every pair was played.',
        `- **Draws.** ${totalDraws} of ${result.games} games (${percent(rate(totalDraws, result.games))}) were draws (time cap or both players dead on one tick). They score no win for either entrant.`,
        `- **Sample size.** Each entrant played ${minGames === maxGames ? minGames : `${minGames} to ${maxGames}`} games (${config.games} per opponent pair). The widest 95% interval is +/- ${percent(widest)}; entrants whose intervals overlap are not reliably different, and one seed is one sample of each matchup.`,
        `- **First mover.** \`player1\` acts first within a tick and won ${percent(rate(result.firstWins, decided))} of the ${decided} decided games; sides alternate, so each entrant had it in half its games.`,
        ...(result.bracket
            ? [
                  `- **Bracket.** ${result.bracket.sets.length} sets of best-of-${result.bracket.bestOf}, ${result.bracket.sets.reduce((sum, s) => sum + s.games, 0)} games: a few games per set decide a placement, so it shows how the top 8 fare head to head, not a reliable order${partial ? '; on a partial run the seeds come from partial win rates' : ''}.`,
              ]
            : []),
        '- **Meaning.** Win rates describe these profiles on these loadouts against each other, not human play, and they depend on the profiles: a stronger profile for a loadout can change its rank.',
    ].join('\n')

    return [
        `# Arena report: ${config.baselineVersion}`,
        '',
        header,
        '',
        baseline,
        '',
        winRates,
        '',
        elementsSection(result),
        '',
        general,
        '',
        matrix,
        '',
        bracketSection(result.bracket, options.bracketSkipped),
        '',
        caveats,
        '',
    ].join('\n')
}
