import { Battle, DamageMeter, DEFAULT_SPELLS, GAME_TICK_INTERVAL } from '@magus/engine'
import { h } from '../dom'
import type { BattleView } from '../game/battle-view'
import { iconUrl } from '../game/icons'
import { getLoadout, getName, setLoadout } from '../identity'
import { spellPicker } from '../ui/spell-picker'
import { BATTLE_SETUP_ERROR, battleErrorPanel, loadBattleChunk, newVersionPanel } from './battle-chunk'

/** Big enough that nothing in the game can kill it; shown as ∞. */
const DUMMY_HP = 1e9
/** Catch up at most this many ticks per frame after the tab was in the background. */
const MAX_CATCH_UP = 10

export const trainingScreen = (root: HTMLElement) => {
    let loadout = getLoadout()
    let battle: Battle
    let logSeen = 0
    const meter = new DamageMeter('player2')
    let view: BattleView | null = null
    let disposed = false
    let raf = 0
    let last = performance.now()
    let acc = 0
    let meterTimer = 0

    const stage = h('div', { class: 'stage' })
    const totals = h('div', { class: 'meter-totals' })
    const rows = h('ol', { class: 'meter-rows' })
    const modal = h('dialog', { class: 'modal' })

    const restart = () => {
        battle = new Battle(
            { name: getName() || 'You', spells: loadout },
            { name: 'Training Dummy', spells: DEFAULT_SPELLS, hp: DUMMY_HP },
        )
        logSeen = 0
        meter.reset()
        renderMeter()
        view?.update(battle.state, [], [])
    }

    const renderMeter = () => {
        meter.setTick(battle.state.gameTick)
        const summary = meter.summary()
        totals.replaceChildren(
            h('div', null, h('span', null, 'Damage'), h('strong', null, summary.total.toFixed(1))),
            h('div', null, h('span', null, 'DPS'), h('strong', null, summary.dps.toFixed(2))),
            h('div', null, h('span', null, 'Time'), h('strong', null, `${summary.seconds.toFixed(1)}s`)),
        )
        rows.replaceChildren(
            ...(summary.rows.length
                ? summary.rows.map(row =>
                      h(
                          'li',
                          { style: `--share:${(row.share * 100).toFixed(1)}%` },
                          h('img', { src: iconUrl(row.source), alt: '' }),
                          h('span', { class: 'label' }, row.label),
                          h('span', { class: 'value' }, `${row.total.toFixed(1)}`),
                          h('span', { class: 'pct' }, `${(row.share * 100).toFixed(0)}%`),
                      ),
                  )
                : [h('li', { class: 'empty' }, 'Hit the dummy to start the meter.')]),
        )
    }

    const loop = (now: number) => {
        raf = requestAnimationFrame(loop)
        acc += now - last
        last = now
        let ticks = 0
        while (acc >= GAME_TICK_INTERVAL && ticks < MAX_CATCH_UP) {
            battle.tick()
            acc -= GAME_TICK_INTERVAL
            ticks++
            flush()
        }
        if (ticks === MAX_CATCH_UP) acc = 0
        meterTimer += ticks
        if (meterTimer >= 5) {
            meterTimer = 0
            renderMeter()
        }
    }

    /** Push state and new log entries to the view and the meter. */
    const flush = () => {
        const log = battle.state.log
        const newLog = log.slice(logSeen)
        logSeen = log.length
        const events = battle.drainEvents()
        meter.record(events)
        view?.update(battle.state, newLog, events)
    }

    const openPicker = () => {
        const picker = spellPicker(loadout, next => {
            loadout = next
            setLoadout(next)
        })
        modal.replaceChildren(
            h('h2', null, 'Choose your spells'),
            picker.el,
            h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: () => modal.close() }, 'Done')),
        )
        const before = loadout.join()
        modal.onclose = () => {
            if (loadout.join() !== before) restart()
        }
        modal.showModal()
    }

    restart()
    root.append(
        h(
            'div',
            { class: 'training' },
            h(
                'header',
                { class: 'bar' },
                h('a', { class: 'btn small', href: '/', 'data-link': true }, '← Back'),
                h('h2', null, 'Training room'),
                h('span', { class: 'muted' }, 'The dummy never fights back.'),
            ),
            h(
                'div',
                { class: 'training-body' },
                stage,
                h(
                    'aside',
                    { class: 'panel meter' },
                    h('h3', null, 'Damage meter'),
                    totals,
                    rows,
                    h(
                        'div',
                        { class: 'actions' },
                        h(
                            'button',
                            {
                                class: 'btn',
                                onclick: () => {
                                    meter.reset()
                                    renderMeter()
                                },
                            },
                            'Reset meter',
                        ),
                        h('button', { class: 'btn', onclick: restart }, 'Restart'),
                        h('button', { class: 'btn primary', onclick: openPicker }, 'Change spells'),
                    ),
                ),
            ),
            modal,
        ),
    )

    loadBattleChunk(() => import('../game/battle-view'), {
        onLoaded: ({ BattleView }) =>
            BattleView.create(stage, {
                me: 'player1',
                onPress: i => {
                    const accepted = battle.startCast('player1', i)
                    flush()
                    return accepted
                },
                onRelease: i => {
                    battle.stopCast('player1', i)
                    flush()
                },
            }),
        onCreated: v => {
            if (disposed) return v.destroy()
            view = v
            view.update(battle.state, [], [])
            last = performance.now()
            raf = requestAnimationFrame(loop)
        },
        isCurrent: () => !disposed,
        onFailed: () => stage.replaceChildren(newVersionPanel()),
        onCreateFailed: message => stage.replaceChildren(battleErrorPanel(message)),
        onSetupFailed: () => {
            cancelAnimationFrame(raf)
            view?.destroy()
            view = null
            stage.replaceChildren(battleErrorPanel(BATTLE_SETUP_ERROR))
        },
    })

    return () => {
        disposed = true
        cancelAnimationFrame(raf)
        view?.destroy()
    }
}
