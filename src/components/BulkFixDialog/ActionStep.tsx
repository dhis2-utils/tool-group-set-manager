import i18n from '@dhis2/d2-i18n'
import {
    Button,
    CircularLoader,
    InputField,
    NoticeBox,
    Radio,
    SingleSelectField,
    SingleSelectOption,
} from '@dhis2/ui'
import React from 'react'
import styles from './BulkFixDialog.module.css'
import { Action } from './constants'
import { CatchAllCreation } from './useCatchAllCreation'

export interface ActionStepProps {
    action: Action
    onAction: (next: Action) => void
    configLoaded: boolean
    targetGroupId: string
    onTargetChange: (id: string) => void
    targetGroups: { id: string; displayName: string }[]
    showCreateOffer: boolean
    catchAll: CatchAllCreation
}

export const ActionStep: React.FC<ActionStepProps> = ({
    action,
    onAction,
    configLoaded,
    targetGroupId,
    onTargetChange,
    targetGroups,
    showCreateOffer,
    catchAll,
}) => {
    const targetOptions = targetGroups.map((g) => (
        <SingleSelectOption key={g.id} value={g.id} label={g.displayName} />
    ))

    return (
        <div className={styles.actionOptions}>
            {!configLoaded && <CircularLoader small />}
            <Radio
                label={i18n.t('Move to catch-all group')}
                checked={action === 'moveToCatchAll'}
                onChange={() => onAction('moveToCatchAll')}
            />
            <Radio
                label={i18n.t('Assign all to one group')}
                checked={action === 'assignAll'}
                onChange={() => onAction('assignAll')}
            />
            <div className={styles.targetRow}>
                <SingleSelectField
                    label={
                        action === 'moveToCatchAll'
                            ? i18n.t('Catch-all group')
                            : i18n.t('Target group')
                    }
                    selected={targetGroupId}
                    placeholder={i18n.t('Choose target group')}
                    onChange={({ selected }) => {
                        onTargetChange(selected ?? '')
                    }}
                >
                    {targetOptions}
                </SingleSelectField>
            </div>
            {showCreateOffer && (
                <div className={styles.createCatchAll}>
                    {/* Spec 5.2: the user names the group rather
                    than accepting a generated name they
                    cannot see until it exists. Prefilled
                    with exactly what would have been
                    generated, so leaving both alone is the
                    old behaviour. */}
                    <InputField
                        dense
                        // `name` is what @dhis2/ui uses as the
                        // input's id and the label's `for`, so
                        // without it the label names nothing --
                        // a screen reader announces an unlabelled
                        // text box.
                        name="catchAllDisplayName"
                        label={i18n.t('Group name')}
                        value={catchAll.names.displayName}
                        onChange={({ value }) =>
                            catchAll.setNames((n) => ({
                                ...n,
                                displayName: value ?? '',
                            }))
                        }
                    />
                    <InputField
                        dense
                        name="catchAllShortName"
                        label={i18n.t('Short name')}
                        value={catchAll.names.shortName}
                        error={catchAll.nameTooLong}
                        validationText={
                            catchAll.nameTooLong
                                ? i18n.t(
                                      'A short name can be at most 50 characters'
                                  )
                                : undefined
                        }
                        onChange={({ value }) =>
                            catchAll.setNames((n) => ({
                                ...n,
                                shortName: value ?? '',
                            }))
                        }
                    />
                    <Button
                        small
                        disabled={catchAll.creating || !catchAll.namesValid}
                        onClick={catchAll.create}
                    >
                        {catchAll.creating
                            ? i18n.t('Creating…')
                            : i18n.t('Create group')}
                    </Button>
                </div>
            )}
            {catchAll.error && (
                <NoticeBox error title={i18n.t('Could not create the group')}>
                    {catchAll.error}
                </NoticeBox>
            )}
        </div>
    )
}
