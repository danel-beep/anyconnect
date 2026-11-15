/**
 * A timestamp from a provider's webhook as a Date: an ISO string, or epoch milliseconds. Null when
 * it is absent or not a real date, so an Invalid Date never reaches the database (writing one
 * throws, which would fail the event on every redelivery).
 */
export function providerDate(value: string | number | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value);
  return Number.isNaN(date.getTime()) ? null : date;
}
