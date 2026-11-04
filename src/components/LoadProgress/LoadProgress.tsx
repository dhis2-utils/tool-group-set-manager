import i18n from '@dhis2/d2-i18n'
import { LinearLoader, NoticeBox } from '@dhis2/ui'
import React from 'react'
import type { LoadStatus } from '@/data/loadAll'
import type { ObjectType } from '@/engine/types'
import { interpolate } from '@/utils/interpolate'
import { typeLabel, typeObjectsLabel } from '@/utils/objectTypeLabels'

/**
 * The progress line used to be assembled from a translated phase name, a
 * literal colon, a translated type name and a parenthesised counter -- an
 * English sentence built out of pieces no translator could reorder, with the
 * punctuation holding it together decided here rather than by them. Each
 * case below is instead one complete sentence carrying its own punctuation,
 * with the object type spliced into a placeholder afterwards. The two
 * variants per phase exist because a phase can run either for one type or
 * for the whole load.
 */
const phaseLabel = (
    phase: LoadStatus['phase'],
    type: ObjectType | null
): string => {
    const values = { type: type ? typeObjectsLabel(type) : '' }
    switch (phase) {
        case 'groupSets':
            return i18n.t('Loading group sets')
        case 'objects':
            return type
                ? interpolate(i18n.t('Loading {type}'), values)
                : i18n.t('Loading objects')
        case 'memberships':
            return type
                ? interpolate(
                      i18n.t('Loading group memberships for {type}'),
                      values
                  )
                : i18n.t('Loading group memberships')
        case 'names':
            return type
                ? interpolate(i18n.t('Loading names for {type}'), values)
                : i18n.t('Loading names')
        case 'evaluate':
            return type
                ? interpolate(i18n.t('Checking rules for {type}'), values)
                : i18n.t('Checking rules')
        case 'done':
            return i18n.t('Done')
        // Exhaustive: TypeScript rejects this function if a case is missing.
        // no default
    }
}

/**
 * L5: the phase and its counter as one complete sentence, rather than the
 * phase sentence with " · 3 of 7" glued on. Only the per-type phases that
 * report progress have a counter; anything else keeps the plain phase.
 */
const progressLabel = (
    phase: LoadStatus['phase'],
    type: ObjectType | null,
    { done, total }: { done: number; total: number }
): string => {
    if (!type) {
        return phaseLabel(phase, type)
    }
    const values = {
        type: typeObjectsLabel(type),
        done: done.toLocaleString(),
        total: total.toLocaleString(),
    }
    switch (phase) {
        case 'objects':
            return interpolate(
                i18n.t('Loading {type}, {done} of {total}'),
                values
            )
        case 'memberships':
            return interpolate(
                i18n.t(
                    'Loading group memberships for {type}, {done} of {total}'
                ),
                values
            )
        case 'names':
            return interpolate(
                i18n.t('Loading names for {type}, {done} of {total}'),
                values
            )
        default:
            return phaseLabel(phase, type)
    }
}

export const LoadProgress = ({ status }: { status: LoadStatus | null }) => {
    if (!status) {
        return <LinearLoader amount={0} />
    }
    const errors = Object.entries(status.errors) as [ObjectType, string][]
    const namesErrors = Object.entries(status.namesErrors) as [
        ObjectType,
        string,
    ][]
    if (status.phase === 'done') {
        if (errors.length === 0 && namesErrors.length === 0) {
            return null
        }
        return (
            <>
                {errors.length > 0 && (
                    <NoticeBox
                        error
                        title={i18n.t('Some data could not be loaded')}
                    >
                        {errors.map(([type, message]) => (
                            <div key={type}>
                                <div>
                                    {interpolate(
                                        i18n.t('{type} could not be loaded'),
                                        { type: typeLabel(type) }
                                    )}
                                </div>
                                <div>{message}</div>
                            </div>
                        ))}
                    </NoticeBox>
                )}
                {namesErrors.length > 0 && (
                    // Distinct from `errors` above on purpose: the counts
                    // for this type are correct (objects, memberships and
                    // evaluate all succeeded) -- only the display names
                    // failed to load, so this must never read as "this
                    // type's summary could not be computed".
                    <NoticeBox
                        warning
                        title={i18n.t('Some names could not be loaded')}
                    >
                        {namesErrors.map(([type, message]) => (
                            <div key={type}>
                                <div>
                                    {interpolate(
                                        i18n.t(
                                            'Names for {type} could not be loaded; the counts shown are still correct'
                                        ),
                                        { type: typeObjectsLabel(type) }
                                    )}
                                </div>
                                <div>{message}</div>
                            </div>
                        ))}
                    </NoticeBox>
                )}
            </>
        )
    }
    const p = status.progress
    const amount = p && p.total ? Math.round((100 * p.done) / p.total) : 0
    // The raw `p.label` (an untranslated API resource name such as
    // "organisationUnitGroups") used to be shown here too; the sentence above
    // already names the type in the user's own language, so the counter is
    // all this adds.
    return (
        <div>
            <LinearLoader amount={amount} />
            <small>
                {p && p.total
                    ? progressLabel(status.phase, status.type, {
                          done: p.done,
                          total: p.total,
                      })
                    : phaseLabel(status.phase, status.type)}
            </small>
        </div>
    )
}
