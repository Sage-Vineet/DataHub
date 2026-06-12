/**
 * Formats a number to US locale (en-US).
 * - Thousand separator: comma (,)
 * - Decimal separator: period (.)
 * - Handles null, undefined, NaN as '-'
 * - Zero as '0.00' (or as specified by decimals)
 * 
 * @param {number|string} value - The value to format
 * @param {number} [decimals=2] - Number of decimal places
 * @returns {string} Formatted number
 */
export const formatNumber = (value, decimals = 2) => {
    if (value === null || value === undefined || value === "") return '-';

    const numericValue = Number(value);
    if (isNaN(numericValue)) return '-';

    return numericValue.toLocaleString('en-US', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
    });
};
