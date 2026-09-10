import i18n from '@dhis2/d2-i18n'
import {
    Button,
    Modal,
    ModalActions,
    ModalContent,
    ModalTitle,
    OrganisationUnitTree,
} from '@dhis2/ui'
import React, { useState } from 'react'
import { useScope } from '@/hooks/useScope'
import { useUserScope } from '@/hooks/useUserScope'

export const ScopeSelector = () => {
    const { rootName, setRoot } = useScope()
    const { roots } = useUserScope()
    const [open, setOpen] = useState(false)

    return (
        <div>
            <span>{i18n.t('Scope')}: </span>
            <strong>{rootName}</strong>{' '}
            <Button small onClick={() => setOpen(true)}>
                {i18n.t('Change')}
            </Button>
            {open && (
                <Modal onClose={() => setOpen(false)} position="middle">
                    <ModalTitle>
                        {i18n.t('Choose the organisation unit to work in')}
                    </ModalTitle>
                    <ModalContent>
                        <OrganisationUnitTree
                            roots={roots.map((r) => r.id)}
                            singleSelection
                            onChange={({ id, displayName }) => {
                                setRoot(id, displayName)
                                setOpen(false)
                            }}
                        />
                    </ModalContent>
                    <ModalActions>
                        <Button onClick={() => setOpen(false)}>
                            {i18n.t('Cancel')}
                        </Button>
                    </ModalActions>
                </Modal>
            )}
        </div>
    )
}
