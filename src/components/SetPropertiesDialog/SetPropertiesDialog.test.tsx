import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { SetPropertiesDialog } from './SetPropertiesDialog'
import type { GroupSetMeta } from '@/engine/types'
import { actAndFlush } from '@/testing/actAndFlush'

jest.mock('@dhis2/app-runtime', () => ({
    useConfig: () => ({ baseUrl: 'http://server', apiVersion: 42 }),
}))

const mockSetGroupSetProperties = jest.fn()
jest.mock('@/data/metadataWrites', () => ({
    setGroupSetProperties: (...args: unknown[]) =>
        mockSetGroupSetProperties(...args),
}))

const set: GroupSetMeta = {
    id: 'own',
    displayName: 'Ownership',
    objectType: 'organisationUnit',
    compulsory: true,
    dataDimension: false,
    canWrite: true,
    groups: [{ id: 'g1', displayName: 'Alpha', canWrite: true }],
}

const onClose = jest.fn()
const onApplied = jest.fn()

const renderDialog = (override: Partial<GroupSetMeta> = {}) =>
    render(
        <SetPropertiesDialog
            set={{ ...set, ...override }}
            onClose={onClose}
            onApplied={onApplied}
        />
    )

const toggle = (name: RegExp) =>
    fireEvent.click(screen.getByRole('checkbox', { name }))

beforeEach(() => {
    jest.clearAllMocks()
    mockSetGroupSetProperties.mockResolvedValue(undefined)
})

describe('SetPropertiesDialog', () => {
    it('shows the group set’s current properties', () => {
        renderDialog()
        expect(
            screen.getByRole('checkbox', { name: /compulsory/i })
        ).toBeChecked()
        expect(
            screen.getByRole('checkbox', { name: /data dimension/i })
        ).not.toBeChecked()
    })

    it('writes nothing until the change is confirmed', async () => {
        renderDialog()
        toggle(/data dimension/i)
        fireEvent.click(screen.getByRole('button', { name: /save/i }))

        expect(mockSetGroupSetProperties).not.toHaveBeenCalled()
        expect(
            await screen.findByRole('button', { name: /confirm/i })
        ).toBeInTheDocument()
    })

    it('patches only the properties that actually changed', async () => {
        renderDialog()
        toggle(/data dimension/i)
        fireEvent.click(screen.getByRole('button', { name: /save/i }))
        await actAndFlush(() => {
            fireEvent.click(screen.getByRole('button', { name: /confirm/i }))
        })

        expect(mockSetGroupSetProperties).toHaveBeenCalledWith(
            expect.any(Function),
            { id: 'own', objectType: 'organisationUnit' },
            { dataDimension: true }
        )
        await waitFor(() => expect(onApplied).toHaveBeenCalled())
    })

    it('reports the write and does not close itself on success', async () => {
        renderDialog()
        toggle(/compulsory/i)
        fireEvent.click(screen.getByRole('button', { name: /save/i }))
        await actAndFlush(() => {
            fireEvent.click(screen.getByRole('button', { name: /confirm/i }))
        })

        expect(await screen.findByText(/updated/i)).toBeInTheDocument()
        expect(onClose).not.toHaveBeenCalled()
    })

    it('reports a failed write rather than letting it vanish', async () => {
        mockSetGroupSetProperties.mockRejectedValue(new Error('HTTP 409'))
        renderDialog()
        toggle(/compulsory/i)
        fireEvent.click(screen.getByRole('button', { name: /save/i }))
        await actAndFlush(() => {
            fireEvent.click(screen.getByRole('button', { name: /confirm/i }))
        })

        expect(await screen.findByText(/HTTP 409/)).toBeInTheDocument()
        expect(onApplied).not.toHaveBeenCalled()
    })

    it('offers no write at all on a group set the user cannot write to', () => {
        renderDialog({ canWrite: false })

        expect(
            screen.getByRole('checkbox', { name: /compulsory/i })
        ).toBeDisabled()
        expect(screen.queryByRole('button', { name: /save/i })).toBeNull()
    })

    it('does not offer to save when nothing was changed', () => {
        renderDialog()
        expect(screen.getByRole('button', { name: /save/i })).toBeDisabled()
    })
})
