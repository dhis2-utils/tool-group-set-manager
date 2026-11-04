import i18n from '@dhis2/d2-i18n'
import {
    Button,
    NoticeBox,
    SingleSelectField,
    SingleSelectOption,
} from '@dhis2/ui'
import React, { useId, useState } from 'react'
import styles from './Settings.module.css'
import { useIsSuperuser } from './useIsSuperuser'
import type { GroupSetMeta } from '@/engine/types'
import { useEngine } from '@/hooks/useEngine'
import { useGsiConfig } from '@/hooks/useGsiConfig'
import { interpolate } from '@/utils/interpolate'

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

const CatchAllRow = ({
    set,
    canEdit,
    showReason,
    onError,
}: {
    set: GroupSetMeta
    /** the user can write the set, or has ALL */
    canEdit: boolean
    /** say why the row is read-only: not while authorities are loading */
    showReason: boolean
    onError: (message: string | null) => void
}) => {
    const { config, isLoaded, setCatchAllGroup, clearCatchAllGroup } =
        useGsiConfig()
    const labelId = useId()
    const configured = config.catchAllGroup[set.id]
    // L6: a group deleted or moved out of the set since it was chosen. The
    // select gets only a value that is one of its options: @dhis2/ui shows
    // an unknown one as its raw id.
    const stale =
        configured !== undefined && !set.groups.some((g) => g.id === configured)

    return (
        <div className={styles.row}>
            <span id={labelId} className={styles.setLabel}>
                {set.displayName}
            </span>
            {/* The set name labels the select (M12): the select takes no
                `label` prop here, which would print the name a second time. */}
            <fieldset className={styles.field} aria-labelledby={labelId}>
                <SingleSelectField
                    dense
                    placeholder={i18n.t('Choose catch-all group')}
                    selected={configured && !stale ? configured : ''}
                    disabled={!(isLoaded && canEdit)}
                    onChange={({ selected }: { selected: string }) => {
                        if (!canEdit) {
                            return
                        }
                        onError(null)
                        setCatchAllGroup(set.id, selected).catch((e: unknown) =>
                            onError(errorText(e))
                        )
                    }}
                >
                    {set.groups.map((g) => (
                        <SingleSelectOption
                            key={g.id}
                            value={g.id}
                            label={g.displayName}
                        />
                    ))}
                </SingleSelectField>
            </fieldset>
            {stale && (
                <span className={styles.note}>
                    {i18n.t(
                        'The configured catch-all group no longer exists in this set.'
                    )}
                </span>
            )}
            {/* A select cannot unset itself: @dhis2/ui's SingleSelect has no
                empty option once a value is chosen. Shown only when there is
                something to clear. */}
            {!canEdit && showReason && (
                <span className={styles.note}>
                    {i18n.t(
                        'You cannot change the catch-all group because you cannot edit this group set.'
                    )}
                </span>
            )}
            {configured && canEdit && (
                <Button
                    small
                    secondary
                    disabled={!isLoaded}
                    aria-label={interpolate(
                        i18n.t('Clear the catch-all group of {name}'),
                        { name: set.displayName }
                    )}
                    onClick={() => {
                        onError(null)
                        clearCatchAllGroup(set.id).catch((e: unknown) =>
                            onError(errorText(e))
                        )
                    }}
                >
                    {i18n.t('Clear')}
                </Button>
            )}
        </div>
    )
}

export const CatchAllSection = () => {
    const { groupSets } = useEngine()
    // The catch-all group applies to every user: it is what the bulk fix
    // suggests to all of them. So only a user who can edit the set itself
    // (or a superuser) may choose it; every group of the set stays on
    // offer, since the choice is not about this user's own write access.
    const isSuperuser = useIsSuperuser()
    // I3: a failed save is reported, never dropped.
    const [error, setError] = useState<string | null>(null)
    return (
        <>
            {groupSets.map((set) => (
                <CatchAllRow
                    key={set.id}
                    set={set}
                    canEdit={set.canWrite || isSuperuser === true}
                    showReason={isSuperuser !== null}
                    onError={setError}
                />
            ))}
            {error && (
                <NoticeBox
                    error
                    title={i18n.t('Could not save the catch-all group')}
                >
                    {error}
                </NoticeBox>
            )}
        </>
    )
}
