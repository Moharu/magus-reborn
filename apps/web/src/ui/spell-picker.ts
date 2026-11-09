import {
    DEFAULT_LOADOUTS,
    DEFAULT_ELEMENT,
    ELEMENTS,
    loadoutElement,
    FIXED_SLOT,
    HOTKEYS,
    LOADOUT_SLOTS,
    SPELLBOOKS,
    SPELLS,
    type SpellElement,
    type SpellId,
} from '@magus/engine'
import { h } from '../dom'
import '../game/hotkeys'
import { iconUrl } from '../game/icons'
import { BATTLE_BAR, battleButtonX as buttonX, HEIGHT, WIDTH } from '../game/layout'
import { getAdvancedDescriptions, setAdvancedDescriptions } from '../identity'
import { canTarget, click, drop, type Selection, type Target } from './loadout-logic'

const BAR = { ...BATTLE_BAR, buttonTop: BATTLE_BAR.top, panelPad: 16 }

/** Labels only; spells and descriptions come from the engine catalog. */
const ELEMENT_LABEL: Record<SpellElement, string> = { FIRE: 'Fire', FROST: 'Frost' }
/** Pointer travel in px before a press counts as a drag rather than a tap. */
const DRAG_THRESHOLD = 6

const stats = (id: SpellId) => {
    const def = SPELLS[id]
    return [
        def.castSeconds ? `Cast ${def.castSeconds}s` : 'Instant',
        def.cooldownSeconds ? `Cooldown ${def.cooldownSeconds}s` : null,
    ]
        .filter(Boolean)
        .join(' · ')
}

/** Two rows of icon cards, ending 14 stage pixels above the battle bar panel. */
export const BOOK = { top: 240, cardHeight: 100, rowGap: 8, height: 100 * 2 + 8 } as const
/** The selected-spell strip above the spellbook, in stage pixels. */
export const DETAILS = { top: 10, height: 76 } as const

/** Spellbook card boxes in stage pixels, as rendered: `columns` per row, over `firstSlot`'s bar section. */
export const cardBoxes = (count: number, firstSlot: number, columns: number) => {
    const slotsWide = LOADOUT_SLOTS.filter(k => (firstSlot === 0 ? k === 'element' : k === 'general')).length
    const width = slotsWide * BAR.button + (slotsWide - 1) * BAR.gap
    const w = (width - (columns - 1) * BAR.gap) / columns
    return Array.from({ length: count }, (_, n) => ({
        x: buttonX(firstSlot) + (n % columns) * (w + BAR.gap),
        y: BOOK.top + Math.floor(n / columns) * (BOOK.cardHeight + BOOK.rowGap),
        w,
        h: BOOK.cardHeight,
    }))
}

/** Absolute box in stage pixels, as percentages of the 960x600 stage so it scales with it. */
const box = (x: number, y: number, w: number, hgt: number) =>
    `left:${(x / WIDTH) * 100}%;top:${(y / HEIGHT) * 100}%;width:${(w / WIDTH) * 100}%;height:${(hgt / HEIGHT) * 100}%`

export interface SpellPicker {
    el: HTMLElement
    setOverlayDetails(value: boolean): void
    setLoadout(loadout: SpellId[]): void
    /** Makes the picker read-only. `reason` replaces the hint line. */
    setLocked(locked: boolean, reason?: string): void
}

export interface SpellPickerOptions {
    element?: SpellElement
    /** Between rounds the element is fixed; before the match it is chosen here. */
    elementLocked?: boolean
    /** Setup headers share the arena; descriptions open on demand without shifting its bar. */
    overlayDetails?: boolean
}

const targetData = (target: Target) => (target.kind === 'slot' ? `slot:${target.index}` : `spell:${target.id}`)

const parseTarget = (value: string | undefined): Target | null => {
    if (!value) return null
    const [kind, rest] = value.split(':')
    if (kind === 'slot' && Number.isInteger(Number(rest))) return { kind: 'slot', index: Number(rest) }
    if (kind === 'spell' && rest in SPELLS) return { kind: 'spell', id: rest as SpellId }
    return null
}

/**
 * The loadout editor. The 7-button bar sits where the battle bar does, at the same size, on a
 * stage of the same 960x600 proportions. The spellbook is laid directly above the bar section it
 * fills: Fire spells over Q W E R, general spells over D F. Counterspell is fixed.
 *
 * Move a spell by dragging (mouse or touch) from the spellbook onto the bar, or within the bar,
 * or by tapping one and then tapping its destination.
 */
export const spellPicker = (
    initial: SpellId[],
    onChange: (loadout: SpellId[]) => void,
    options: SpellPickerOptions = {},
): SpellPicker => {
    let element = options.element ?? loadoutElement(initial) ?? DEFAULT_ELEMENT
    let book = SPELLBOOKS[element]
    let loadout = [...initial]
    let selection: Selection = null
    let detail: SpellId = loadout[0]
    let locked = false
    let lockedReason: string | undefined
    let advanced = getAdvancedDescriptions()
    let suppressClick = false
    let dragging: { from: Target; ghost: HTMLElement } | null = null
    const el = h('div', { class: 'picker' })

    const commit = (next: SpellId[]) => {
        if (next === loadout) return
        loadout = next
        onChange([...loadout])
    }

    const activate = (target: Target) => {
        if (locked || suppressClick) return
        detail = target.kind === 'slot' ? loadout[target.index] : target.id
        const state = click({ loadout, selection }, target, element)
        selection = state.selection
        commit(state.loadout)
        render()
    }

    const hoverClass = 'drop-hover'
    const targetAt = (x: number, y: number) => {
        const hit = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-target]')
        return { node: hit, target: parseTarget(hit?.dataset.target) }
    }

    /** Pointer-event drag, so touch and mouse behave the same. A press that doesn't travel stays a click. */
    const press = (e: PointerEvent, from: Target) => {
        if (locked || (e.pointerType === 'mouse' && e.button !== 0)) return
        const startX = e.clientX
        const startY = e.clientY
        let hovered: Element | null = null

        const move = (ev: PointerEvent) => {
            if (!dragging) {
                if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD) return
                const source = (e.target as HTMLElement).closest('[data-target]')!
                const ghost = source.cloneNode(true) as HTMLElement
                ghost.classList.add('drag-ghost')
                ghost.removeAttribute('style')
                ghost.style.width = `${source.getBoundingClientRect().width}px`
                document.body.append(ghost)
                dragging = { from, ghost }
                selection = null
                detail = from.kind === 'slot' ? loadout[from.index] : from.id
                el.classList.add('dragging')
            }
            const { ghost } = dragging
            const w = ghost.getBoundingClientRect().width
            ghost.style.transform = `translate(${ev.clientX - w / 2}px, ${ev.clientY - w / 2}px)`
            const { node, target } = targetAt(ev.clientX, ev.clientY)
            const next = (target && drop(loadout, from, target, element) !== loadout ? node : null) ?? null
            if (next !== hovered) {
                hovered?.classList.remove(hoverClass)
                next?.classList.add(hoverClass)
                hovered = next
            }
        }

        const end = (ev: PointerEvent) => {
            window.removeEventListener('pointermove', move)
            window.removeEventListener('pointerup', end)
            window.removeEventListener('pointercancel', end)
            if (!dragging) return
            dragging.ghost.remove()
            dragging = null
            el.classList.remove('dragging')
            // the click that follows a drag must not also select something
            suppressClick = true
            setTimeout(() => (suppressClick = false), 0)
            const { target } = ev.type === 'pointerup' ? targetAt(ev.clientX, ev.clientY) : { target: null }
            if (target && !locked) commit(drop(loadout, from, target, element))
            render()
        }

        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', end)
        window.addEventListener('pointercancel', end)
    }

    const draggable = (target: Target) => ({
        'data-target': targetData(target),
        // a mouse press must not leave the button focused, or Space would activate it later
        onmousedown: (e: Event) => e.preventDefault(),
        onpointerdown: (e: Event) => press(e as PointerEvent, target),
        onclick: () => activate(target),
    })

    const hint = () =>
        locked
            ? (lockedReason ?? 'Spells locked in.')
            : selection
              ? selection.kind === 'slot'
                  ? 'Now tap a spell, or another slot to swap.'
                  : `Now tap a slot for ${SPELLS[selection.id].label}.`
              : 'Drag spells onto the bar, or tap a spell then a slot.'

    const render = () => {
        const slotSelected = (i: number) => selection?.kind === 'slot' && selection.index === i
        const spellSelected = (id: SpellId) => selection?.kind === 'spell' && selection.id === id
        const lit = (target: Target) => canTarget(loadout, selection, target, element)
        const def = SPELLS[detail]
        const description = advanced ? def.advancedDescription : def.description
        const detailContent = () => [
            h('img', { src: iconUrl(detail), alt: '' }),
            h(
                'div',
                null,
                h('strong', null, def.label),
                h('p', { title: description, 'aria-label': description }, description),
                h('span', { class: 'meta' }, stats(detail)),
            ),
        ]
        const { button, gap, buttonTop } = BAR

        const slots = loadout.map((id, i) => {
            const fixed = i === FIXED_SLOT
            const target: Target = { kind: 'slot', index: i }
            return h(
                'div',
                { class: 'slot-wrap', style: box(buttonX(i), buttonTop, button, button) + `;--slot:${i}` },
                h(
                    'button',
                    {
                        class: `slot${fixed ? ' fixed' : ''}${slotSelected(i) ? ' selected' : ''}${lit(target) ? ' target' : ''}`,
                        disabled: locked,
                        'aria-pressed': fixed ? undefined : String(slotSelected(i)),
                        'aria-label': `${HOTKEYS[i]}: ${SPELLS[id].label}${fixed ? ' (fixed)' : ''}`,
                        ...(fixed ? { 'data-target': targetData(target) } : draggable(target)),
                        ...(fixed ? { onclick: () => activate(target) } : {}),
                    },
                    h('img', { src: iconUrl(id), alt: '', draggable: 'false' }),
                    h('span', { class: 'key' }, HOTKEYS[i]),
                ),
                h('span', { class: 'name' }, SPELLS[id].label),
            )
        })

        const spellCards = (ids: readonly SpellId[], firstSlot: number, columns: number) => {
            const boxes = cardBoxes(ids.length, firstSlot, columns)
            return ids.map((id, n) => {
                const equipped = loadout.indexOf(id)
                const target: Target = { kind: 'spell', id }
                return h(
                    'button',
                    {
                        class: `spell${spellSelected(id) ? ' selected' : ''}${equipped !== -1 ? ' equipped' : ''}${lit(target) ? ' target' : ''}`,
                        style:
                            box(boxes[n].x, boxes[n].y, boxes[n].w, boxes[n].h) +
                            `;--row:${Math.floor(n / columns)};--column:${n % columns};--book-start:${firstSlot === 0 ? 2 : 62};--book-width:${firstSlot === 0 ? 56 : 36};--columns:${columns}`,
                        disabled: locked,
                        'aria-pressed': String(spellSelected(id)),
                        title: advanced ? SPELLS[id].advancedDescription : SPELLS[id].description,
                        ...draggable(target),
                    },
                    h('img', { src: iconUrl(id), alt: '', draggable: 'false' }),
                    equipped !== -1 ? h('span', { class: 'key' }, HOTKEYS[equipped]) : null,
                    h('span', { class: 'name' }, SPELLS[id].label),
                )
            })
        }

        const fireX = buttonX(0)
        const generalX = buttonX(5)
        const bookY = BOOK.top
        const labelBox = (x: number, w: number) => box(x, bookY - 22, w, 18)
        const keys = (slots: string) => h('span', { class: 'desktop-only' }, ` · ${slots}`)

        el.classList.toggle('locked', locked)
        el.replaceChildren(
            h(
                'div',
                { class: 'picker-top' },
                h(
                    'div',
                    { class: 'element', role: 'group', 'aria-label': 'Element' },
                    h('span', { class: 'muted' }, 'Element'),
                    ...ELEMENTS.filter(value => !options.elementLocked || value === element).map(value =>
                        h(
                            'button',
                            {
                                class: `chip${value === element ? ' active' : ''}`,
                                disabled: locked || !!options.elementLocked,
                                'aria-pressed': String(value === element),
                                onclick: () => {
                                    if (locked || options.elementLocked || value === element) return
                                    element = value
                                    book = SPELLBOOKS[element]
                                    selection = null
                                    // the element's default loadout, not just its first four spells
                                    const next = [...DEFAULT_LOADOUTS[element]]
                                    detail = next[0]
                                    commit(next)
                                    render()
                                },
                            },
                            `${ELEMENT_LABEL[value]}${options.elementLocked ? ' · locked for the match' : ''}`,
                        ),
                    ),
                    ...(!options.elementLocked
                        ? [
                              h(
                                  'button',
                                  {
                                      class: 'chip teaser',
                                      disabled: true,
                                      title: 'Lightning · Locked · coming later',
                                      'aria-label': 'Lightning · Locked · coming later',
                                  },
                                  h('span', { class: 'teaser-desktop' }, 'Lightning · Locked · coming later'),
                                  h('span', { class: 'teaser-compact' }, 'Lightning · Soon'),
                              ),
                          ]
                        : []),
                ),
                h('div', { class: 'header-details', 'aria-label': 'Spell details' }, ...detailContent()),
                options.overlayDetails
                    ? h('button', { class: 'details-trigger', popovertarget: 'picker-details' }, 'Spell details')
                    : null,
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
                'div',
                { class: 'picker-stage' },
                h(
                    'div',
                    {
                        class: 'details',
                        id: 'picker-details',
                        popover: options.overlayDetails ? 'auto' : undefined,
                        style: options.overlayDetails ? undefined : box(30, DETAILS.top, WIDTH - 60, DETAILS.height),
                    },
                    ...detailContent(),
                ),
                h(
                    'h3',
                    { class: 'book-label', style: labelBox(fireX, 4 * button + 3 * gap) },
                    `${ELEMENT_LABEL[element]} spellbook${options.elementLocked ? ' · locked for the match' : ''}`,
                    keys(HOTKEYS.slice(0, 4).join(' ')),
                ),
                ...spellCards(book.elementSpells, 0, 3),
                h(
                    'h3',
                    { class: 'book-label general-book-label', style: labelBox(generalX, 2 * button + gap) },
                    'General',
                    keys(HOTKEYS.slice(5).join(' ')),
                ),
                ...spellCards(book.generalSpells, 5, 2),
                // a plain divider between the sections, above the fixed Counterspell slot (no label)
                h('div', {
                    class: 'book-divider',
                    'aria-hidden': 'true',
                    style: box(buttonX(FIXED_SLOT) + button / 2 - 1, bookY - 22, 2, BOOK.height + 22),
                }),
                h('div', {
                    class: 'bar-panel',
                    style: box(
                        buttonX(0) - BAR.panelPad,
                        BAR.panelTop,
                        buttonX(6) + button - buttonX(0) + BAR.panelPad * 2,
                        BAR.panelHeight,
                    ),
                }),
                ...slots,
            ),
            h('p', { class: 'hint', 'aria-live': 'polite' }, hint()),
        )
    }

    render()
    return {
        el,
        setOverlayDetails(value: boolean) {
            if (value === !!options.overlayDetails) return
            options.overlayDetails = value
            render()
        },
        setLoadout(next) {
            if (next.join() === loadout.join()) return
            loadout = [...next]
            element = loadoutElement(next) ?? element
            book = SPELLBOOKS[element]
            selection = null
            detail = next[0]
            render()
        },
        setLocked(value, reason) {
            if (value === locked && reason === lockedReason) return
            locked = value
            lockedReason = reason
            selection = null
            render()
        },
    }
}
