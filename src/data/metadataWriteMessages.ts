import i18n from '@dhis2/d2-i18n'
import { MetadataWriteError, NAME_OWNED_BY_ANOTHER_SET } from './metadataWrites'
import { interpolate } from '@/utils/interpolate'

/**
 * The HTTP status buried in an error's message, for errors that do not
 * carry one structurally (`fetchJson`'s `<path> failed with HTTP 500`).
 */
function statusOf(error: unknown): number | undefined {
    if (error instanceof MetadataWriteError) {
        return error.status
    }
    const match =
        error instanceof Error ? /HTTP (\d{3})/.exec(error.message) : null
    return match ? Number(match[1]) : undefined
}

function conflictMessage(conflicts: string[]): string {
    if (conflicts.includes('code')) {
        return i18n.t(
            'The catch-all group could not be created because another group already uses its code. Rename or recode that group, then try again.'
        )
    }
    if (conflicts.includes('shortName')) {
        return i18n.t(
            'The catch-all group could not be created because another group already uses this short name. Choose another short name.'
        )
    }
    if (conflicts.includes('name')) {
        return i18n.t(
            'The catch-all group could not be created because another group already uses this name. Choose another name.'
        )
    }
    return i18n.t(
        'The catch-all group could not be created because another group already uses its name, short name or code. Choose other names and try again.'
    )
}

/**
 * One translated sentence for a failed catch-all group creation. Every
 * status the server is known to answer with gets its own wording; anything
 * else names the status in an otherwise translated sentence.
 */
export function catchAllCreationErrorMessage(error: unknown): string {
    if (error instanceof Error && error.message === NAME_OWNED_BY_ANOTHER_SET) {
        return i18n.t(
            'A group with this name already belongs to a different group set. Choose another name — one group must not be shared between two sets.'
        )
    }
    const status = statusOf(error)
    const step = error instanceof MetadataWriteError ? error.step : undefined
    if (status === 401 || status === 403) {
        return step === 'addToSet'
            ? i18n.t(
                  'The catch-all group was created, but you do not have permission to add it to this group set.'
              )
            : i18n.t(
                  'You do not have permission to create a group of this type.'
              )
    }
    if (step === 'addToSet') {
        return interpolate(
            i18n.t(
                'The catch-all group was created, but could not be added to the group set (HTTP {status}). Try again to finish.'
            ),
            { status: status ?? '' }
        )
    }
    if (status === 409 && error instanceof MetadataWriteError) {
        return conflictMessage(error.conflicts)
    }
    if (status === undefined || status === 0) {
        return i18n.t(
            'The catch-all group could not be created. Check your connection and try again.'
        )
    }
    return interpolate(
        i18n.t('The catch-all group could not be created (HTTP {status}).'),
        { status }
    )
}

/** One translated sentence for a failed change to a group set's properties. */
export function setPropertiesErrorMessage(error: unknown): string {
    const status = statusOf(error)
    if (status === 401 || status === 403) {
        return i18n.t('You do not have permission to change this group set.')
    }
    if (status === 404) {
        return i18n.t(
            'The group set no longer exists on the server, so it could not be updated.'
        )
    }
    if (status === undefined || status === 0) {
        return i18n.t(
            'The group set could not be updated. Check your connection and try again.'
        )
    }
    return interpolate(
        i18n.t('The group set could not be updated (HTTP {status}).'),
        { status }
    )
}
