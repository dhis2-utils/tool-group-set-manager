import { useConfig } from '@dhis2/app-runtime'
import i18n from '@dhis2/d2-i18n'
import {
    Button,
    ButtonStrip,
    CircularLoader,
    Modal,
    ModalActions,
    ModalContent,
    ModalTitle,
    NoticeBox,
} from '@dhis2/ui'
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import styles from './History.module.css'
import {
    missingGroupSetLabel,
    notRecordedLabel,
    propertyChangeLabel,
    revertWindowClosedLabel,
} from './labels'
import { createFetcher } from '@/data/fetcher'
import { setPropertiesErrorMessage } from '@/data/metadataWriteMessages'
import { readGroupSetProperties } from '@/data/metadataWrites'
import { canStillRevert } from '@/data/revertWindow'
import type { ChangeSet, GroupSetProperties } from '@/engine/changeSet'
import { GROUP_SET_PROPERTY_KEYS } from '@/engine/changeSet'
import { useEngine } from '@/hooks/useEngine'
import { useSetPropertiesWrite } from '@/hooks/useSetPropertiesWrite'

type Key = keyof GroupSetProperties

interface RevertPlan {
    /** The values to put back, for properties still as the change left them. */
    restore: Partial<GroupSetProperties>
    /** Their current values, recorded as the revert's own "before". */
    current: Partial<GroupSetProperties>
    /** Properties changed again since, which the revert leaves alone. */
    skipped: Key[]
}

/**
 * What reverting a property change would do now: restore each property the
 * change set recorded, but only where the server still holds the value the
 * change set set -- one that someone has changed again since is left
 * alone, the same rule `planRevert` applies to memberships.
 */
function planPropertiesRevert(
    changeSet: ChangeSet,
    server: GroupSetProperties
): RevertPlan {
    const plan: RevertPlan = { restore: {}, current: {}, skipped: [] }
    const { before = {}, after = {} } = changeSet.properties ?? {}
    for (const key of GROUP_SET_PROPERTY_KEYS) {
        const was = before[key]
        const became = after[key]
        if (was === undefined || became === undefined) {
            continue
        }
        if (server[key] === became) {
            plan.restore[key] = was
            plan.current[key] = server[key]
        } else {
            plan.skipped.push(key)
        }
    }
    return plan
}

const samePlan = (a: RevertPlan, b: RevertPlan) =>
    JSON.stringify(a.restore) === JSON.stringify(b.restore)

const skippedLabel = (key: Key) =>
    key === 'compulsory'
        ? i18n.t(
              'Compulsory has been changed again since, so it is left as it is'
          )
        : i18n.t(
              'Data dimension has been changed again since, so it is left as it is'
          )

const PlanList = ({ plan }: { plan: RevertPlan }) => (
    <ul className={styles.planList}>
        {GROUP_SET_PROPERTY_KEYS.flatMap((key) => {
            const value = plan.restore[key]
            return value === undefined
                ? []
                : [<li key={key}>{propertyChangeLabel(key, value)}</li>]
        })}
        {plan.skipped.map((key) => (
            <li key={key}>{skippedLabel(key)}</li>
        ))}
    </ul>
)

const isEmpty = (plan: RevertPlan) => Object.keys(plan.restore).length === 0

const DialogBody = ({
    setMissing,
    error,
    changedSince,
    done,
    plan,
}: {
    setMissing: boolean
    error: string | null
    changedSince: boolean
    done: { historyError: boolean } | null
    plan: RevertPlan | null
}) => (
    <>
        {setMissing && (
            <NoticeBox error title={i18n.t('This change cannot be reverted')}>
                {missingGroupSetLabel()}
            </NoticeBox>
        )}
        {error && <NoticeBox error>{error}</NoticeBox>}
        {changedSince && !done && (
            <NoticeBox
                warning
                title={i18n.t('The metadata changed while you were reviewing')}
            >
                {i18n.t(
                    'Someone else has changed this group set since this dialog opened. Check what the revert will now do before reverting.'
                )}
            </NoticeBox>
        )}
        {done && (
            <NoticeBox valid>
                {i18n.t('The group set was updated on the server.')}
            </NoticeBox>
        )}
        {done?.historyError && (
            <NoticeBox warning title={i18n.t('Not recorded in History')}>
                {notRecordedLabel()}
            </NoticeBox>
        )}
        {!plan && !error && <CircularLoader small />}
        {plan && !done && isEmpty(plan) && (
            <NoticeBox title={i18n.t('Nothing to revert')}>
                {i18n.t(
                    'Every property this change set changed has been changed again since, so reverting it now would not change anything'
                )}
            </NoticeBox>
        )}
        {plan && !done && <PlanList plan={plan} />}
    </>
)

/**
 * Reverts a change to a group set's properties (finding M11) by putting
 * back the values it replaced. The current values are read from the server
 * when the dialog opens and again right before writing; if they changed in
 * between, the new plan is shown and nothing is written until Revert is
 * clicked again.
 */
export const PropertiesRevertDialog = ({
    changeSet,
    onClose,
    onApplied,
}: {
    changeSet: ChangeSet
    onClose: () => void
    onApplied: () => void
}) => {
    const { baseUrl, apiVersion } = useConfig() as {
        baseUrl: string
        apiVersion: number
    }
    const fetcher = useMemo(
        () => createFetcher(baseUrl, apiVersion),
        [baseUrl, apiVersion]
    )
    const { groupSets, groupSetsLoaded, reload } = useEngine()
    const { write, isWriting } = useSetPropertiesWrite()
    const set = groupSets.find((s) => s.id === changeSet.groupSetId)
    const setMissing = groupSetsLoaded && !set

    const [plan, setPlan] = useState<RevertPlan | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [changedSince, setChangedSince] = useState(false)
    const [checking, setChecking] = useState(false)
    const [done, setDone] = useState<{ historyError: boolean } | null>(null)

    const readPlan = useCallback(async () => {
        const server = await readGroupSetProperties(fetcher, {
            id: changeSet.groupSetId,
            objectType: changeSet.objectType,
        })
        return planPropertiesRevert(changeSet, server)
    }, [fetcher, changeSet])

    useEffect(() => {
        let cancelled = false
        const load = async () => {
            try {
                const next = await readPlan()
                if (!cancelled) {
                    setPlan(next)
                }
            } catch (e) {
                if (!cancelled) {
                    setError(setPropertiesErrorMessage(e))
                }
            }
        }
        void load()
        return () => {
            cancelled = true
        }
    }, [readPlan])

    const handleRevert = async () => {
        if (!plan || !set) {
            return
        }
        if (!canStillRevert(changeSet, Date.now())) {
            setError(revertWindowClosedLabel())
            return
        }
        setError(null)
        setChecking(true)
        try {
            const fresh = await readPlan()
            if (!samePlan(fresh, plan)) {
                setPlan(fresh)
                setChangedSince(true)
                return
            }
            const result = await write({
                set,
                before: fresh.current,
                after: fresh.restore,
                action: 'revert',
                revertOf: changeSet.id,
            })
            setDone({ historyError: Boolean(result.historyError) })
            onApplied()
            // Group set metadata is re-read on every load, so a non-forced
            // reload brings the restored values, and every count that
            // depends on them, back into the engine.
            void reload(false)
        } catch (e) {
            setError(setPropertiesErrorMessage(e))
        } finally {
            setChecking(false)
        }
    }

    const busy = isWriting || checking
    const nothingToDo = plan !== null && isEmpty(plan)

    return (
        <Modal position="middle" onClose={busy ? () => undefined : onClose}>
            <ModalTitle>{i18n.t('Revert change')}</ModalTitle>
            <ModalContent>
                <DialogBody
                    setMissing={setMissing}
                    error={error}
                    changedSince={changedSince}
                    done={done}
                    plan={plan}
                />
            </ModalContent>
            <ModalActions>
                <ButtonStrip end>
                    <Button onClick={onClose} disabled={busy}>
                        {done ? i18n.t('Close') : i18n.t('Cancel')}
                    </Button>
                    {!done && (
                        <Button
                            primary
                            destructive
                            loading={busy}
                            disabled={!plan || !set || nothingToDo || busy}
                            onClick={() => {
                                void handleRevert()
                            }}
                        >
                            {i18n.t('Revert')}
                        </Button>
                    )}
                </ButtonStrip>
            </ModalActions>
        </Modal>
    )
}
