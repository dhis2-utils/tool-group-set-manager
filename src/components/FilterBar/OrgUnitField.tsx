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
import { FilterBarField } from './FilterBar'
import { useScope } from '@/hooks/useScope'
import { useUserScope } from '@/hooks/useUserScope'

/**
 * The tree's onChange payload spreads the org unit node (id, displayName)
 * and adds the full path (checked in
 * node_modules/@dhis2/ui .../organisation-unit-node/label/label.js, which
 * builds `{ ...node, path: fullPath, checked, selected }`). The node itself
 * carries no level, but a DHIS2 path is "/root/child/grandchild", so its
 * segment count is the level. Without this the scope's level was guessed by
 * looking the id up among the user's own roots, which fails for every unit
 * chosen deeper in the tree.
 */
export const levelFromPath = (path: string | undefined): number | null => {
    if (!path) {
        return null
    }
    const segments = path.split('/').filter((s) => s.length > 0)
    return segments.length > 0 ? segments.length : null
}

/**
 * The app's single organisation unit control (spec 2026-09-15 §4.1). It is
 * rendered on every page that has a scope, so there is only ever one value
 * and the dashboard and the Objects tab cannot disagree about it. Labelled
 * "Organisation unit" rather than "Scope": in review the old label was
 * missed entirely, and then found unclear.
 */
export const OrgUnitField = () => {
    const { rootName, setRoot } = useScope()
    const { roots } = useUserScope()
    const [open, setOpen] = useState(false)

    return (
        <FilterBarField label={i18n.t('Organisation unit')}>
            <Button onClick={() => setOpen(true)}>
                {rootName || i18n.t('Choose an organisation unit')}
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
                            onChange={({ id, displayName, path }) => {
                                setRoot(id, displayName, levelFromPath(path))
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
        </FilterBarField>
    )
}
