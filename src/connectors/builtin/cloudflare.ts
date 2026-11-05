import { defineManifestConnector } from '../manifest/compile.js';
import { type ConnectorUi, withUi } from '../sdk.js';

/** Cloudflare API v4 with a scoped API token: zones, DNS records and cache purges. */

const zoneId = {
  type: 'string',
  pattern: '^[0-9a-f]{32}$',
  description: 'Zone id from cloudflare_list_zones',
};
const recordId = {
  type: 'string',
  pattern: '^[0-9a-f]{32}$',
  description: 'Record id from cloudflare_list_dns_records',
};
const RECORD_FIELDS = [
  'id',
  'type',
  'name',
  'content',
  'proxied',
  'ttl',
  'priority',
  'comment',
  'modified_on',
];
const recordFields = {
  type: { type: 'string', enum: ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SRV', 'CAA'] },
  name: { type: 'string', minLength: 1, description: 'Full name, e.g. "www.acme.com", or "@" for the apex' },
  content: { type: 'string', minLength: 1, description: 'IP address, target host or text' },
  ttl: { type: 'integer', minimum: 1, maximum: 86400, description: '1 means automatic' },
  proxied: {
    type: 'boolean',
    description: 'Route through Cloudflare (orange cloud); A, AAAA and CNAME only',
  },
  priority: { type: 'integer', minimum: 0, maximum: 65535, description: 'MX priority' },
  comment: { type: 'string', maxLength: 100 },
};
const recordBody = Object.fromEntries(Object.keys(recordFields).map((k) => [k, `{{input.${k}}}`]));

const manifest = defineManifestConnector({
  id: 'cloudflare',
  name: 'Cloudflare',
  description:
    'Cloudflare zones and DNS: list domains, read, add, change and delete DNS records, purge the cache.',
  version: '1.0.0',
  homepage: 'https://developers.cloudflare.com/api/',
  instructions:
    'Get the zone id of a domain with cloudflare_list_zones first. Changing or deleting DNS records can take a site or its email offline, so read the current records before changing them.',
  baseUrl: 'https://api.cloudflare.com/client/v4',
  credentials: {
    type: 'object',
    properties: {
      token: {
        type: 'string',
        minLength: 30,
        description: 'API token: My Profile → API Tokens → Create Token',
      },
    },
    required: ['token'],
  },
  auth: { type: 'bearer', token: '{{credentials.token}}' },
  rateLimit: { requests: 200, perSeconds: 60 },
  errorMessagePaths: ['errors.0.message'],
  pagination: { type: 'page', param: 'page', start: 1 },
  test: { request: { method: 'GET', path: '/user/tokens/verify' }, identity: '{{response.result.id}}' },
  actions: [
    {
      name: 'list_zones',
      title: 'List zones',
      description: 'Domains (zones) the token can see, with their ids and status.',
      input: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Exact domain, e.g. "acme.com"' },
          per_page: { type: 'integer', minimum: 5, maximum: 50, default: 20 },
        },
      },
      hints: { readOnly: true, idempotent: true },
      request: { method: 'GET', path: '/zones' },
      response: { root: 'result', fields: ['id', 'name', 'status', 'paused', 'plan.name', 'name_servers'] },
      pagination: true,
    },
    {
      name: 'list_dns_records',
      title: 'List DNS records',
      description: 'DNS records of a zone, optionally by type or name.',
      input: {
        type: 'object',
        properties: {
          zone_id: zoneId,
          type: recordFields.type,
          name: { type: 'string', description: 'Exact full name, e.g. "www.acme.com"' },
          per_page: { type: 'integer', minimum: 5, maximum: 500, default: 100 },
        },
        required: ['zone_id'],
      },
      hints: { readOnly: true, idempotent: true },
      request: { method: 'GET', path: '/zones/{zone_id}/dns_records' },
      response: { root: 'result', fields: RECORD_FIELDS },
      pagination: true,
    },
    {
      name: 'create_dns_record',
      title: 'Add DNS record',
      description: 'Adds a DNS record to a zone.',
      input: {
        type: 'object',
        properties: { zone_id: zoneId, ...recordFields },
        required: ['zone_id', 'type', 'name', 'content'],
      },
      hints: { readOnly: false, destructive: false },
      risk: 'write',
      undo: { kind: 'action', action: 'delete_dns_record' },
      request: { method: 'POST', path: '/zones/{zone_id}/dns_records', body: recordBody },
      response: { root: 'result', fields: RECORD_FIELDS },
    },
    {
      name: 'update_dns_record',
      title: 'Change DNS record',
      description: 'Changes the given fields of a DNS record.',
      input: {
        type: 'object',
        properties: { zone_id: zoneId, record_id: recordId, ...recordFields },
        required: ['zone_id', 'record_id'],
      },
      hints: { readOnly: false, destructive: true, idempotent: true },
      risk: 'dangerous',
      request: { method: 'PATCH', path: '/zones/{zone_id}/dns_records/{record_id}', body: recordBody },
      response: { root: 'result', fields: RECORD_FIELDS },
    },
    {
      name: 'delete_dns_record',
      title: 'Delete DNS record',
      description: 'Deletes a DNS record.',
      input: {
        type: 'object',
        properties: { zone_id: zoneId, record_id: recordId },
        required: ['zone_id', 'record_id'],
      },
      hints: { readOnly: false, destructive: true, idempotent: true },
      risk: 'dangerous',
      request: { method: 'DELETE', path: '/zones/{zone_id}/dns_records/{record_id}' },
      response: { root: 'result', fields: ['id'] },
    },
    {
      name: 'purge_cache',
      title: 'Purge cache',
      description: 'Removes the given URLs from the Cloudflare cache, so visitors get fresh copies.',
      input: {
        type: 'object',
        properties: {
          zone_id: zoneId,
          urls: { type: 'array', items: { type: 'string', format: 'uri' }, minItems: 1, maxItems: 30 },
        },
        required: ['zone_id', 'urls'],
      },
      hints: { readOnly: false, destructive: false, idempotent: true },
      risk: 'write',
      request: { method: 'POST', path: '/zones/{zone_id}/purge_cache', body: { files: '{{input.urls}}' } },
      response: { root: 'result', fields: ['id'] },
    },
    {
      name: 'purge_everything',
      title: 'Purge all cache',
      description: 'Removes everything of a zone from the cache; the site is slower until it refills.',
      input: { type: 'object', properties: { zone_id: zoneId }, required: ['zone_id'] },
      hints: { readOnly: false, destructive: true, idempotent: true },
      risk: 'dangerous',
      request: { method: 'POST', path: '/zones/{zone_id}/purge_cache', body: { purge_everything: true } },
      response: { root: 'result', fields: ['id'] },
    },
  ],
});

const ui: ConnectorUi = {
  locales: {
    ru: {
      description:
        'Домены и DNS в Cloudflare: зоны, чтение, добавление, изменение и удаление записей, сброс кэша.',
      setup: {
        form: {
          summary: 'API-токен Cloudflare с нужными правами. Около двух минут.',
          steps: [
            {
              text: 'Откройте Cloudflare → My Profile → API Tokens и нажмите Create Token.',
              link: {
                label: 'Открыть токены Cloudflare',
                url: 'https://dash.cloudflare.com/profile/api-tokens',
              },
            },
            {
              text: 'Возьмите шаблон Edit zone DNS. Добавьте право Zone → Cache Purge → Purge, если ИИ можно сбрасывать кэш.',
            },
            {
              text: 'В Zone Resources выберите все зоны или конкретные домены, нажмите Continue to summary → Create Token.',
            },
            { text: 'Скопируйте токен (он показывается один раз) и вставьте его в форму.' },
          ],
          tips: [
            'Не используйте Global API Key: токен с ограниченными правами безопаснее.',
            'Изменение и удаление DNS-записей ИИ делает только после вашего подтверждения.',
          ],
        },
      },
      prompts: [
        'Какие DNS-записи у acme.com в Cloudflare?',
        'Добавь CNAME docs.acme.com на acme.github.io без проксирования.',
        'Сбрось кэш для https://acme.com/pricing.',
        'Есть ли у домена SPF и DMARC записи?',
      ],
      fields: { token: { label: 'API-токен', hint: 'My Profile → API Tokens → Create Token.' } },
      actions: {
        list_zones: { title: 'Зоны', description: 'Домены с id и статусом.' },
        list_dns_records: { title: 'DNS-записи', description: 'Записи зоны по типу или имени.' },
        create_dns_record: { title: 'Новая запись', description: 'Добавляет DNS-запись.' },
        update_dns_record: { title: 'Изменение записи', description: 'Меняет поля DNS-записи.' },
        delete_dns_record: { title: 'Удаление записи', description: 'Удаляет DNS-запись.' },
        purge_cache: { title: 'Сброс кэша', description: 'Сбрасывает кэш выбранных адресов.' },
        purge_everything: { title: 'Сброс всего кэша', description: 'Сбрасывает весь кэш зоны.' },
      },
    },
    en: {
      setup: {
        form: {
          summary: 'A Cloudflare API token with the right permissions. Takes about two minutes.',
          steps: [
            {
              text: 'Open Cloudflare → My Profile → API Tokens and click Create Token.',
              link: {
                label: 'Open Cloudflare API tokens',
                url: 'https://dash.cloudflare.com/profile/api-tokens',
              },
            },
            {
              text: 'Use the Edit zone DNS template. Add Zone → Cache Purge → Purge if the AI may purge the cache.',
            },
            {
              text: 'Under Zone Resources pick all zones or specific domains, then Continue to summary → Create Token.',
            },
            { text: 'Copy the token (it is shown once) and paste it into the form.' },
          ],
          tips: [
            'Do not use the Global API Key: a token with limited permissions is safer.',
            'The AI changes or deletes DNS records only after you confirm.',
          ],
        },
      },
      prompts: [
        'Which DNS records does acme.com have in Cloudflare?',
        'Add a CNAME docs.acme.com pointing to acme.github.io, not proxied.',
        'Purge the cache for https://acme.com/pricing.',
        'Does the domain have SPF and DMARC records?',
      ],
      fields: { token: { label: 'API token', hint: 'My Profile → API Tokens → Create Token.' } },
      actions: {
        list_zones: { title: 'Zones', description: 'Domains with ids and status.' },
        list_dns_records: { title: 'DNS records', description: 'Records of a zone by type or name.' },
        create_dns_record: { title: 'Add a record', description: 'Adds a DNS record.' },
        update_dns_record: { title: 'Change a record', description: 'Changes fields of a DNS record.' },
        delete_dns_record: { title: 'Delete a record', description: 'Deletes a DNS record.' },
        purge_cache: { title: 'Purge cache', description: 'Purges the cache of chosen URLs.' },
        purge_everything: { title: 'Purge all cache', description: 'Purges the whole cache of a zone.' },
      },
    },
  },
};

export default withUi(manifest, ui);
