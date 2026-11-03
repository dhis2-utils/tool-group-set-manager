import i18n from '@dhis2/d2-i18n'
import type { FavouriteType } from '@/data/sources/usageSqlView'

/**
 * DHIS2's own object names are not what a user of this app recognises: a
 * `visualization` is what they made in Data Visualizer (a chart or a pivot
 * table), and an `eventVisualization` is what they made in Line Listing or
 * the older Event Reports and Event Charts apps. Each label is one complete,
 * argument-free string.
 */
export function favouriteTypeLabel(type: FavouriteType): string {
    switch (type) {
        case 'visualization':
            return i18n.t('Charts and pivot tables')
        case 'map':
            return i18n.t('Maps')
        case 'eventVisualization':
            return i18n.t('Event reports and line lists')
        // Exhaustive: TypeScript rejects this function if a case is missing.
        // no default
    }
}
