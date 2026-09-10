/**
 * Splices values into a string that was translated as one complete sentence.
 *
 * Why this exists: sentences must reach the translator whole. Building one by
 * joining separately translated fragments in English word order -- a
 * translated "Includes organisation units above the", then the level name,
 * then a translated "level" -- cannot be translated into a language that
 * orders those parts differently, and the fragments arrive in the .pot file
 * as meaningless scraps with no context.
 *
 * Why not i18next's own interpolation: this project's i18next-scanner only
 * recognises a translation call that takes a single string argument, so
 * passing an options object with the values in it makes the whole call
 * invisible to extraction and the string never reaches the .pot file (see
 * the comment in GroupSetCard.tsx). And i18next interpolates its own
 * double-brace placeholders even when called with no options: it finds no
 * value for the variable and substitutes an empty string, so a double-brace
 * placeholder is gone by the time the string comes back (verified against
 * the installed @dhis2/d2-i18n@1.2.0). Single braces are left untouched,
 * which is why that is the placeholder syntax here.
 *
 * So the pattern is: one whole, argument-free translation call whose string
 * contains `{name}` placeholders, then this function to fill them in --
 * see OverviewTab.tsx or LoadProgress.tsx for how that reads in practice.
 *
 * A translator may move a placeholder anywhere in their sentence, or drop
 * it. A placeholder with no matching value is left as it is rather than
 * blanked, so a typo shows up as a visible `{levl}` instead of a silently
 * truncated sentence.
 */
export function interpolate(
    text: string,
    values: Record<string, string | number>
): string {
    return text.replace(/\{(\w+)\}/g, (match, name: string) => {
        const value = values[name]
        return value === undefined ? match : String(value)
    })
}
