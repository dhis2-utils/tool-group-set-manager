import i18n from '@dhis2/d2-i18n'
import type { SqlViewFailureReason } from '@/data/sources/sqlViewSharing'
import { interpolate } from '@/utils/interpolate'

/** Two complete strings, never a fragment glued to a number: see CLAUDE.md. */
export const createdSummary = (count: number) =>
    count === 1
        ? i18n.t('Created 1 SQL view')
        : interpolate(i18n.t('Created {count} SQL views'), { count })

export const repairedSummary = (count: number) =>
    count === 1
        ? i18n.t('Repaired 1 SQL view')
        : interpolate(i18n.t('Repaired {count} SQL views'), { count })

/**
 * One sentence per failed view, saying what to do where the app knows. No
 * colon in any template (the i18n scanner reads a colon as its namespace
 * separator and drops the key -- see CLAUDE.md).
 */
export const failedDetail = (failed: {
    code: string
    reason?: SqlViewFailureReason
    message: string
}): string => {
    const values = { code: failed.code, message: failed.message }
    switch (failed.reason) {
        case 'forbidden':
            return interpolate(
                i18n.t(
                    '{code} could not be changed because you may not edit it. Another administrator probably owns it. Ask them or a superuser to repair it here.'
                ),
                values
            )
        case 'conflicting':
            return interpolate(
                i18n.t(
                    '{code} exists but does not match what the app needs, and could not be set back. Delete it in the Maintenance app, then create the SQL views here again.'
                ),
                values
            )
        case 'hiddenDuplicate':
            return interpolate(
                i18n.t(
                    '{code} already exists but is not shared with you. Ask the administrator who created it, or a superuser, to repair it here.'
                ),
                values
            )
        default:
            return interpolate(
                i18n.t('{code} could not be created or repaired — {message}'),
                values
            )
    }
}
