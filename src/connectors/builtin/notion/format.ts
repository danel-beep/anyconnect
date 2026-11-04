/**
 * Conversion between Notion's JSON and compact text for the AI: page properties as plain values,
 * blocks as Markdown, and simple Markdown back to blocks.
 */

export interface RichText {
  plain_text?: string;
  href?: string | null;
  text?: { content: string; link?: { url: string } | null };
}

export const plain = (rich: RichText[] | undefined): string =>
  (rich ?? []).map((r) => r.plain_text ?? r.text?.content ?? '').join('');

type PropertyValue = { type: string } & Record<string, any>;

/** A property value as a plain JSON value: text, number, names, dates, booleans. */
export function flattenProperty(value: PropertyValue): unknown {
  const v = value[value.type];
  switch (value.type) {
    case 'title':
    case 'rich_text':
      return plain(v);
    case 'number':
    case 'checkbox':
    case 'url':
    case 'email':
    case 'phone_number':
    case 'created_time':
    case 'last_edited_time':
      return v ?? null;
    case 'select':
    case 'status':
      return v?.name ?? null;
    case 'multi_select':
      return (v ?? []).map((o: { name: string }) => o.name);
    case 'date':
      return v ? (v.end ? `${v.start}/${v.end}` : v.start) : null;
    case 'people':
      return (v ?? []).map((p: { name?: string; id: string }) => p.name ?? p.id);
    case 'relation':
      return (v ?? []).map((r: { id: string }) => r.id);
    case 'files':
      return (v ?? []).map((f: { name: string }) => f.name);
    case 'created_by':
    case 'last_edited_by':
      return v?.name ?? v?.id ?? null;
    case 'formula':
      return v ? v[v.type] : null;
    case 'rollup':
      return v ? (v.type === 'array' ? v.array.map(flattenProperty) : v[v.type]) : null;
    case 'unique_id':
      return v ? `${v.prefix ? `${v.prefix}-` : ''}${v.number}` : null;
    default:
      return null;
  }
}

export function flattenProperties(
  properties: Record<string, PropertyValue> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(properties ?? {})) {
    const flat = flattenProperty(value);
    if (flat === null || flat === '' || (Array.isArray(flat) && flat.length === 0)) continue;
    out[name] = flat;
  }
  return out;
}

/** The title of a page or database object. */
export function titleOf(object: { properties?: Record<string, PropertyValue>; title?: RichText[] }): string {
  if (object.title) return plain(object.title);
  for (const value of Object.values(object.properties ?? {})) {
    if (value.type === 'title') return plain(value.title);
  }
  return '';
}

const text = (content: string): RichText[] => {
  // Notion limits a rich text item to 2000 characters.
  const chunks: RichText[] = [];
  for (let i = 0; i < content.length; i += 2000)
    chunks.push({ text: { content: content.slice(i, i + 2000) } });
  return chunks.length ? chunks : [{ text: { content: '' } }];
};

/**
 * Builds a property value from a plain value, using the database schema type. Lets the AI write
 * `{"Status": "Done", "Due": "2026-11-05", "Tags": ["work"]}` instead of Notion's nested JSON.
 */
export function buildProperty(type: string, value: unknown): unknown {
  if (value === null) {
    if (type === 'title' || type === 'rich_text') return { [type]: [] };
    if (type === 'multi_select' || type === 'people' || type === 'relation') return { [type]: [] };
    return { [type]: null };
  }
  switch (type) {
    case 'title':
    case 'rich_text':
      return { [type]: text(String(value)) };
    case 'number':
      return { number: typeof value === 'number' ? value : Number(value) };
    case 'checkbox':
      return { checkbox: value === true || value === 'true' };
    case 'select':
    case 'status':
      return { [type]: { name: String(value) } };
    case 'multi_select':
      return {
        multi_select: (Array.isArray(value) ? value : [value]).map((name) => ({ name: String(name) })),
      };
    case 'date': {
      const [start, end] = String(value).split('/');
      return { date: { start, ...(end ? { end } : {}) } };
    }
    case 'url':
    case 'email':
    case 'phone_number':
      return { [type]: String(value) };
    case 'relation':
      return { relation: (Array.isArray(value) ? value : [value]).map((id) => ({ id: String(id) })) };
    case 'people':
      return { people: (Array.isArray(value) ? value : [value]).map((id) => ({ id: String(id) })) };
    default:
      return undefined;
  }
}

type Block = { id: string; type: string; has_children?: boolean; children?: Block[] } & Record<string, any>;

const PREFIX: Record<string, string> = {
  heading_1: '# ',
  heading_2: '## ',
  heading_3: '### ',
  bulleted_list_item: '- ',
  quote: '> ',
  callout: '> ',
  toggle: '▸ ',
};

/** Renders blocks as Markdown. Unsupported blocks become a short placeholder, never raw JSON. */
export function blocksToMarkdown(blocks: Block[], depth = 0): string {
  const indent = '  '.repeat(depth);
  const lines: string[] = [];
  let number = 0;
  for (const block of blocks) {
    const data = block[block.type] ?? {};
    const content = plain(data.rich_text);
    number = block.type === 'numbered_list_item' ? number + 1 : 0;
    let line: string;
    switch (block.type) {
      case 'paragraph':
        line = content;
        break;
      case 'numbered_list_item':
        line = `${number}. ${content}`;
        break;
      case 'to_do':
        line = `- [${data.checked ? 'x' : ' '}] ${content}`;
        break;
      case 'code':
        line = `\`\`\`${data.language ?? ''}\n${content}\n\`\`\``;
        break;
      case 'divider':
        line = '---';
        break;
      case 'child_page':
        line = `📄 ${data.title} (page ${block.id})`;
        break;
      case 'child_database':
        line = `🗃 ${data.title} (database ${block.id})`;
        break;
      case 'bookmark':
      case 'embed':
      case 'link_preview':
        line = data.url ?? '';
        break;
      case 'image':
      case 'file':
      case 'pdf':
      case 'video': {
        const caption = plain(data.caption);
        line = `[${block.type}${caption ? `: ${caption}` : ''}]`;
        break;
      }
      case 'equation':
        line = `$${data.expression ?? ''}$`;
        break;
      case 'table_row':
        line = `| ${(data.cells ?? []).map((cell: RichText[]) => plain(cell)).join(' | ')} |`;
        break;
      default:
        line =
          PREFIX[block.type] !== undefined ? `${PREFIX[block.type]}${content}` : content || `[${block.type}]`;
    }
    lines.push(
      line
        .split('\n')
        .map((l) => indent + l)
        .join('\n'),
    );
    if (block.children?.length) lines.push(blocksToMarkdown(block.children, depth + 1));
  }
  return lines.join('\n');
}

const block = (type: string, content: string, extra: Record<string, unknown> = {}) => ({
  object: 'block',
  type,
  [type]: { rich_text: text(content), ...extra },
});

/** Simple Markdown (headings, lists, to-dos, quotes, code fences, dividers, paragraphs) → blocks. */
export function markdownToBlocks(markdown: string): unknown[] {
  const blocks: unknown[] = [];
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      const body: string[] = [];
      while (++i < lines.length && !/^```\s*$/.test(lines[i]!)) body.push(lines[i]!);
      blocks.push(block('code', body.join('\n'), { language: fence[1] || 'plain text' }));
      continue;
    }
    if (!line.trim()) continue;
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^(#{1,3})\s+(.*)$/))) blocks.push(block(`heading_${m[1]!.length}`, m[2]!));
    else if ((m = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.*)$/)))
      blocks.push(block('to_do', m[2]!, { checked: m[1] !== ' ' }));
    else if ((m = line.match(/^\s*[-*]\s+(.*)$/))) blocks.push(block('bulleted_list_item', m[1]!));
    else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) blocks.push(block('numbered_list_item', m[1]!));
    else if ((m = line.match(/^>\s?(.*)$/))) blocks.push(block('quote', m[1]!));
    else if (/^-{3,}\s*$/.test(line)) blocks.push({ object: 'block', type: 'divider', divider: {} });
    else blocks.push(block('paragraph', line));
  }
  return blocks;
}
