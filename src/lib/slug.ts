/** Latin spelling of Cyrillic letters (also used by the website's script that suggests addresses). */
export const CYRILLIC: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'h',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'sch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
  і: 'i',
  ї: 'yi',
  є: 'ye',
  ґ: 'g',
};

/**
 * "Рабочая почта" -> "rabochaya_pochta". Used to suggest account names from labels (`_`) and
 * persona addresses from names (`-`).
 */
export function slugify(input: string, maxLength = 32, separator: '_' | '-' = '_'): string {
  const transliterated = [...input.toLowerCase()].map((ch) => CYRILLIC[ch] ?? ch).join('');
  const trim = new RegExp(`^${separator}+|${separator}+$`, 'g');
  return transliterated
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, separator)
    .replace(trim, '')
    .slice(0, maxLength)
    .replace(trim, '');
}
