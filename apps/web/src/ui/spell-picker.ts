import { HOTKEYS, SPELL_IDS, SPELLS, type School, type SpellId } from '@magus/engine'
import { h } from '../dom'
import { iconUrl } from '../game/icons'
import { getAdvancedDescriptions, setAdvancedDescriptions } from '../identity'

type Selection = { kind: 'slot'; index: number } | { kind: 'spell'; id: SpellId } | null

const SCHOOL_LABEL: Record<School, string> = { FIRE: 'Fire', GENERAL: 'General' }

const stats = (id: SpellId) => {
    const def = SPELLS[id]
    return [
        def.castSeconds ? `Cast ${def.castSeconds}s` : 'Instant',
        def.cooldownSeconds ? `Cooldown ${def.cooldownSeconds}s` : null,
    ]
        .filter(Boolean)
        .join(' · ')
}

export interface SpellPicker {
    el: HTMLElement
    setLoadout(loadout: SpellId[]): void
    setLocked(locked: boolean): void
}

/**
 * Six loadout slots plus the grimoire. Pick a slot then a spell (or the other way round)
 * to place it; picking a spell that is already equipped swaps the two slots.
 */
export const spellPicker = (initial: SpellId[], onChange: (loadout: SpellId[]) => void): SpellPicker => {
    let loadout = [...initial]
    let selection: Selection = null
    let detail: SpellId = loadout[0]
    let locked = false
    let advanced = getAdvancedDescriptions()
    const el = h('div', { class: 'picker' })

    const place = (index: number, id: SpellId) => {
        const next = [...loadout]
        const existing = next.indexOf(id)
        if (existing !== -1) next[existing] = next[index]
        next[index] = id
        selection = null
        if (next.join() !== loadout.join()) {
            loadout = next
            onChange([...loadout])
        }
    }

    const clickSlot = (index: number) => {
        if (locked) return
        detail = loadout[index]
        if (selection?.kind === 'spell') place(index, selection.id)
        else if (selection?.kind === 'slot' && selection.index !== index) place(index, loadout[selection.index])
        else selection = selection?.kind === 'slot' ? null : { kind: 'slot', index }
        render()
    }

    const clickSpell = (id: SpellId) => {
        detail = id
        if (!locked) {
            if (selection?.kind === 'slot') place(selection.index, id)
            else selection = selection?.kind === 'spell' && selection.id === id ? null : { kind: 'spell', id }
        }
        render()
    }

    const render = () => {
        const slotSelected = (i: number) => selection?.kind === 'slot' && selection.index === i
        const spellSelected = (id: SpellId) => selection?.kind === 'spell' && selection.id === id
        const schools = [...new Set(SPELL_IDS.map(id => SPELLS[id].school))]
        const def = SPELLS[detail]

        el.classList.toggle('locked', locked)
        el.replaceChildren(
            h(
                'div',
                { class: 'loadout', role: 'list', 'aria-label': 'Your spells' },
                loadout.map((id, i) =>
                    h(
                        'button',
                        {
                            class: `slot${slotSelected(i) ? ' selected' : ''}`,
                            role: 'listitem',
                            disabled: locked,
                            'aria-pressed': String(slotSelected(i)),
                            onclick: () => clickSlot(i),
                        },
                        h('img', { src: iconUrl(id), alt: '' }),
                        h('span', { class: 'key' }, HOTKEYS[i]),
                        h('span', { class: 'name' }, SPELLS[id].label),
                    ),
                ),
            ),
            h(
                'div',
                { class: 'grimoire' },
                schools.map(school =>
                    h(
                        'section',
                        null,
                        h('h3', null, SCHOOL_LABEL[school]),
                        h(
                            'div',
                            { class: 'spells' },
                            SPELL_IDS.filter(id => SPELLS[id].school === school).map(id => {
                                const equipped = loadout.indexOf(id)
                                return h(
                                    'button',
                                    {
                                        class: `spell${spellSelected(id) ? ' selected' : ''}${equipped !== -1 ? ' equipped' : ''}`,
                                        onclick: () => clickSpell(id),
                                    },
                                    h('img', { src: iconUrl(id), alt: '' }),
                                    equipped !== -1 ? h('span', { class: 'key' }, HOTKEYS[equipped]) : null,
                                    h('span', { class: 'name' }, SPELLS[id].label),
                                    h('span', { class: 'meta' }, stats(id)),
                                )
                            }),
                        ),
                    ),
                ),
            ),
            h(
                'div',
                { class: 'details' },
                h('img', { src: iconUrl(detail), alt: '' }),
                h(
                    'div',
                    null,
                    h('strong', null, def.label),
                    h('p', null, advanced ? def.advancedDescription : def.description),
                    h('span', { class: 'meta' }, stats(detail)),
                ),
                h(
                    'label',
                    { class: 'toggle' },
                    h('input', {
                        type: 'checkbox',
                        checked: advanced,
                        onchange: (e: Event) => {
                            advanced = (e.target as HTMLInputElement).checked
                            setAdvancedDescriptions(advanced)
                            render()
                        },
                    }),
                    'Exact numbers',
                ),
            ),
            h(
                'p',
                { class: 'hint' },
                locked
                    ? 'Spells locked in.'
                    : selection
                      ? selection.kind === 'slot'
                          ? 'Now pick a spell (or another slot to swap).'
                          : `Now pick a slot for ${SPELLS[selection.id].label}.`
                      : 'Pick a slot, then a spell to put in it.',
            ),
        )
    }

    render()
    return {
        el,
        setLoadout(next) {
            if (next.join() === loadout.join()) return
            loadout = [...next]
            render()
        },
        setLocked(value) {
            if (value === locked) return
            locked = value
            selection = null
            render()
        },
    }
}
