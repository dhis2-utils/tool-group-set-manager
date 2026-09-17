import i18n from '@dhis2/d2-i18n'
import React from 'react'
import styles from './ScopeTrail.module.css'

export interface ScopeCrumb {
    id: string
    name: string
}

/**
 * The way back out of a drill-down (manual-review spec §4.3). Clicking a
 * matrix row label re-scopes the page to that organisation unit and moves
 * the row level one deeper; without this, the only route back to the parent
 * was reopening the organisation unit tree and reselecting it by hand --
 * which the Plan 10 multi-version review found on all four supported
 * versions (check 11).
 *
 * The trail is the path actually walked in this session, not the unit's
 * ancestry: it is the undo history for drilling, so it holds the row level
 * each step was left at too (see GroupSetDetail) and a jump restores both.
 * An ancestry-derived breadcrumb would show units the user never chose and
 * could not say what row level to return them to.
 *
 * Crumbs are identified by position, never by id or name. Two organisation
 * units can share a display name, and the same unit can legitimately appear
 * twice in one path, so position is the only unambiguous handle -- and it is
 * what the caller needs anyway, since jumping truncates the trail there.
 */
export const ScopeTrail = ({
    trail,
    currentName,
    onJump,
}: {
    trail: ScopeCrumb[]
    currentName: string
    onJump: (index: number) => void
}) => {
    if (trail.length === 0) {
        return null
    }
    return (
        <nav
            className={styles.trail}
            aria-label={i18n.t('Scope trail')}
            data-test="scope-trail"
        >
            {trail.map((crumb, index) => (
                <React.Fragment key={`${index}-${crumb.id}`}>
                    <button
                        type="button"
                        className={styles.crumb}
                        onClick={() => onJump(index)}
                    >
                        {crumb.name}
                    </button>
                    <span className={styles.separator} aria-hidden="true">
                        /
                    </span>
                </React.Fragment>
            ))}
            {/* The scope you are already in: shown so the path reads whole,
                but not a button, because it leads nowhere. */}
            <span className={styles.current} aria-current="location">
                {currentName}
            </span>
        </nav>
    )
}
