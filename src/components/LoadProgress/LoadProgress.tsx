import i18n from '@dhis2/d2-i18n'
import { LinearLoader, NoticeBox } from '@dhis2/ui'
import React from 'react'
import { LoadStatus } from '@/data/loadAll'
import { ObjectType } from '@/engine/types'
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
    const counter =
        p && p.total
            ? interpolate(i18n.t('{done} of {total}'), {
                  done: p.done,
                  total: p.total,
              })
            : null
    return (
        <div>
            <LinearLoader amount={amount} />
            <small>
                {phaseLabel(status.phase, status.type)}
                {counter && ` · ${counter}`}
            </small>
        </div>
    )
}
