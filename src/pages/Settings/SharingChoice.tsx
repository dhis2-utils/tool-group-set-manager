import i18n from '@dhis2/d2-i18n'
import {
    Button,
    FieldSet,
    Legend,
    NoticeBox,
    Radio,
    SingleSelectField,
    SingleSelectOption,
} from '@dhis2/ui'
import React, { useEffect, useState } from 'react'
import styles from './Settings.module.css'
import type { Fetcher } from '@/data/sources/DataSource'
import { fetchJson } from '@/data/sources/DataSource'
import type { SqlViewSharing } from '@/data/sources/sqlViewSharing'

interface UserGroup {
    id: string
    displayName: string
}

type GroupsState =
    | { status: 'idle' | 'loading' }
    | { status: 'ready'; groups: UserGroup[] }
    | { status: 'error'; message: string }

/** Loads the user groups only once group sharing is picked. */
function useUserGroups(fetcher: Fetcher, wanted: boolean): GroupsState {
    const [state, setState] = useState<GroupsState>({ status: 'idle' })
    const started = state.status !== 'idle'
    useEffect(() => {
        if (!wanted || started) {
            return
        }
        setState({ status: 'loading' })
        fetchJson<{ userGroups: UserGroup[] }>(
            fetcher,
            'userGroups?fields=id,displayName&order=displayName:asc&paging=false'
        )
            .then((body) =>
                setState({ status: 'ready', groups: body.userGroups })
            )
            .catch((e: unknown) =>
                setState({
                    status: 'error',
                    message: e instanceof Error ? e.message : String(e),
                })
            )
    }, [fetcher, wanted, started])
    return state
}

const sameChoice = (a: SqlViewSharing, b: SqlViewSharing) =>
    a.kind === b.kind &&
    (a.kind === 'public' ||
        (b.kind === 'userGroup' && a.userGroupId === b.userGroupId))

/**
 * M6: who may read the SQL views' rows. Shown only to a user who can
 * create SQL views; the choice is saved, and applied to the views that
 * exist, by `onApply`. The saved choice applies to every user, so a user
 * without ALL sees it `readOnly`: the current choice, and no save.
 */
export const SharingChoice = ({
    fetcher,
    current,
    busy,
    readOnly,
    onApply,
}: {
    fetcher: Fetcher
    current: SqlViewSharing
    busy: boolean
    readOnly: boolean
    onApply: (choice: SqlViewSharing) => void
}) => {
    const [kind, setKind] = useState<SqlViewSharing['kind']>(current.kind)
    const [groupId, setGroupId] = useState<string | null>(
        current.kind === 'userGroup' ? current.userGroupId : null
    )
    const groups = useUserGroups(fetcher, kind === 'userGroup')

    let choice: SqlViewSharing | null = { kind: 'public' }
    if (kind === 'userGroup') {
        choice = groupId ? { kind: 'userGroup', userGroupId: groupId } : null
    }
    const known =
        groups.status === 'ready' &&
        groupId !== null &&
        groups.groups.some((g) => g.id === groupId)
    const canApply =
        choice !== null &&
        !sameChoice(choice, current) &&
        (kind === 'public' || known)

    return (
        <FieldSet>
            <Legend>{i18n.t('Who can read the SQL views')}</Legend>
            <Radio
                name="sql-view-sharing"
                value="public"
                label={i18n.t('Every logged-in user')}
                checked={kind === 'public'}
                disabled={readOnly}
                onChange={() => setKind('public')}
            />
            <p className={styles.note}>
                {i18n.t(
                    'The fast path for everyone. Any logged-in user can also read the rows of these views through the API, which list the members of every organisation unit group and the usage of every favourite, including groups and favourites that are not shared with them.'
                )}
            </p>
            <Radio
                name="sql-view-sharing"
                value="userGroup"
                label={i18n.t('Only the members of one user group')}
                checked={kind === 'userGroup'}
                disabled={readOnly}
                onChange={() => setKind('userGroup')}
            />
            <p className={styles.note}>
                {i18n.t(
                    'Members of the group get the fast path. Everyone else can still use the app; it loads their data through the slower metadata API, and they see no usage figures.'
                )}
            </p>
            {kind === 'userGroup' && (
                <div className={styles.field}>
                    <SingleSelectField
                        dense
                        filterable
                        label={i18n.t('User group')}
                        loading={groups.status === 'loading'}
                        placeholder={i18n.t('Choose a user group')}
                        disabled={readOnly}
                        // Only a value that is one of the options: @dhis2/ui
                        // shows an unknown one as its raw id.
                        selected={known && groupId ? groupId : ''}
                        onChange={({ selected }: { selected: string }) =>
                            setGroupId(selected)
                        }
                    >
                        {(groups.status === 'ready' ? groups.groups : []).map(
                            (g) => (
                                <SingleSelectOption
                                    key={g.id}
                                    value={g.id}
                                    label={g.displayName}
                                />
                            )
                        )}
                    </SingleSelectField>
                </div>
            )}
            {kind === 'userGroup' &&
                groups.status === 'ready' &&
                groupId !== null &&
                !known && (
                    <NoticeBox warning>
                        {i18n.t(
                            'The user group the SQL views are shared with no longer exists, or you cannot see it. Choose another.'
                        )}
                    </NoticeBox>
                )}
            {groups.status === 'error' && (
                <NoticeBox error title={i18n.t('Could not load user groups')}>
                    {groups.message}
                </NoticeBox>
            )}
            {readOnly ? (
                <p className={styles.note}>
                    {i18n.t(
                        'Only a superuser can change who can read the SQL views, because the choice applies to every user.'
                    )}
                </p>
            ) : (
                <div className={styles.actions}>
                    <Button
                        small
                        disabled={!canApply || busy}
                        loading={busy}
                        onClick={() => choice && onApply(choice)}
                    >
                        {i18n.t('Save and apply to the SQL views')}
                    </Button>
                </div>
            )}
        </FieldSet>
    )
}
