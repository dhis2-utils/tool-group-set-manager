import { useConfig } from '@dhis2/app-runtime'
import i18n from '@dhis2/d2-i18n'
import {
    Button,
    ButtonStrip,
    Checkbox,
    Modal,
    ModalActions,
    ModalContent,
    ModalTitle,
    NoticeBox,
} from '@dhis2/ui'
import React, { useMemo, useState } from 'react'
import styles from './SetPropertiesDialog.module.css'
import { createFetcher } from '@/data/fetcher'
import { setGroupSetProperties } from '@/data/metadataWrites'
import { GroupSetMeta } from '@/engine/types'
import { interpolate } from '@/utils/interpolate'

interface Props {
    set: GroupSetMeta
    onClose: () => void
    /** Called once the server confirmed the patch, so the caller can reload. */
    onApplied: () => void
}

type Stage = 'edit' | 'confirm'

/**
 * I4/spec 3.5's "Set properties" action -- the one place a user managing a
 * single group set can toggle `compulsory` and `dataDimension`, which is
 * what decides whether "in no group" is a violation at all (spec 3.2) and
 * therefore what every count on this set's screens means.
 *
 * It follows the same discipline as every other write on this branch: the
 * user confirms the exact change before anything is sent, only the
 * properties that actually differ are patched, the result -- success or
 * failure -- is reported in the dialog rather than the dialog closing
 * itself, and the group set's own `canWrite` is respected (the caller also
 * gates the entry point, but a dialog that can be reached some other way
 * must not offer a write the server will reject).
 */
export const SetPropertiesDialog = ({ set, onClose, onApplied }: Props) => {
    const { baseUrl, apiVersion } = useConfig() as {
        baseUrl: string
        apiVersion: number
    }
    const fetcher = useMemo(
        () => createFetcher(baseUrl, apiVersion),
        [baseUrl, apiVersion]
    )
    // What the server is believed to hold. Seeded from the group set the
    // caller has, and advanced to what was just patched once the server
    // confirms it -- so after a successful save the dialog shows "no
    // pending changes" immediately, without waiting for the caller's
    // reload to hand it a fresh `set`.
    const [saved, setSaved] = useState({
        compulsory: set.compulsory,
        dataDimension: set.dataDimension,
    })
    const [compulsory, setCompulsory] = useState(set.compulsory)
    const [dataDimension, setDataDimension] = useState(set.dataDimension)
    const [stage, setStage] = useState<Stage>('edit')
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [done, setDone] = useState(false)

    const changed: { compulsory?: boolean; dataDimension?: boolean } = {}
    if (compulsory !== saved.compulsory) {
        changed.compulsory = compulsory
    }
    if (dataDimension !== saved.dataDimension) {
        changed.dataDimension = dataDimension
    }
    const hasChanges = Object.keys(changed).length > 0

    const describe = (value: boolean, on: string, off: string) =>
        value ? on : off

    const confirmLines: string[] = []
    if (changed.compulsory !== undefined) {
        confirmLines.push(
            describe(
                changed.compulsory,
                i18n.t(
                    'Compulsory on — every object in scope must be in exactly one group of this set, so objects in no group become errors'
                ),
                i18n.t(
                    'Compulsory off — objects in no group of this set stop being reported as errors'
                )
            )
        )
    }
    if (changed.dataDimension !== undefined) {
        confirmLines.push(
            describe(
                changed.dataDimension,
                i18n.t(
                    'Data dimension on — this set becomes available as an analytics dimension, and objects in no group are reported as errors'
                ),
                i18n.t(
                    'Data dimension off — this set stops being available as an analytics dimension'
                )
            )
        )
    }

    const handleApply = async () => {
        setBusy(true)
        setError(null)
        try {
            await setGroupSetProperties(
                fetcher,
                { id: set.id, objectType: set.objectType },
                changed
            )
            setSaved({ compulsory, dataDimension })
            setDone(true)
            setStage('edit')
            onApplied()
        } catch (e) {
            // `setGroupSetProperties` throws untranslated text carrying only
            // an HTTP status, so it is placed inside one whole translated
            // sentence rather than shown raw.
            setError(
                interpolate(
                    i18n.t('The group set could not be updated — {message}'),
                    { message: e instanceof Error ? e.message : String(e) }
                )
            )
            setStage('edit')
        } finally {
            setBusy(false)
        }
    }

    return (
        <Modal position="middle" onClose={busy ? () => undefined : onClose}>
            <ModalTitle>
                {interpolate(i18n.t('Properties of {name}'), {
                    name: set.displayName,
                })}
            </ModalTitle>
            <ModalContent>
                {!set.canWrite && (
                    <NoticeBox warning>
                        {i18n.t(
                            'You do not have permission to change this group set, so its properties are shown read-only.'
                        )}
                    </NoticeBox>
                )}
                {error && <NoticeBox error>{error}</NoticeBox>}
                {done && (
                    <NoticeBox valid>
                        {i18n.t('The group set was updated on the server.')}
                    </NoticeBox>
                )}
                {stage === 'edit' ? (
                    <div className={styles.options}>
                        <div>
                            <Checkbox
                                label={i18n.t('Compulsory')}
                                checked={compulsory}
                                disabled={!set.canWrite || busy}
                                onChange={({ checked }) => {
                                    setDone(false)
                                    setCompulsory(checked)
                                }}
                            />
                            <p className={styles.hint}>
                                {i18n.t(
                                    'Every object in scope must belong to exactly one group of a compulsory set.'
                                )}
                            </p>
                        </div>
                        <div>
                            <Checkbox
                                label={i18n.t('Data dimension')}
                                checked={dataDimension}
                                disabled={!set.canWrite || busy}
                                onChange={({ checked }) => {
                                    setDone(false)
                                    setDataDimension(checked)
                                }}
                            />
                            <p className={styles.hint}>
                                {i18n.t(
                                    'A data dimension set is used to disaggregate data in analytics, so gaps in it distort reports.'
                                )}
                            </p>
                        </div>
                    </div>
                ) : (
                    <div>
                        <p>
                            {i18n.t(
                                'This changes the group set itself on the server, and with it what counts as a violation on every screen for this set.'
                            )}
                        </p>
                        <ul className={styles.confirmList}>
                            {confirmLines.map((line) => (
                                <li key={line}>{line}</li>
                            ))}
                        </ul>
                    </div>
                )}
            </ModalContent>
            <ModalActions>
                <ButtonStrip end>
                    <Button secondary onClick={onClose} disabled={busy}>
                        {i18n.t('Close')}
                    </Button>
                    {stage === 'confirm' && (
                        <Button
                            secondary
                            onClick={() => setStage('edit')}
                            disabled={busy}
                        >
                            {i18n.t('Back')}
                        </Button>
                    )}
                    {set.canWrite &&
                        (stage === 'edit' ? (
                            <Button
                                primary
                                disabled={!hasChanges || busy}
                                onClick={() => {
                                    setDone(false)
                                    setError(null)
                                    setStage('confirm')
                                }}
                            >
                                {i18n.t('Save')}
                            </Button>
                        ) : (
                            <Button
                                primary
                                loading={busy}
                                disabled={busy}
                                onClick={() => {
                                    void handleApply()
                                }}
                            >
                                {i18n.t('Confirm')}
                            </Button>
                        ))}
                </ButtonStrip>
            </ModalActions>
        </Modal>
    )
}
