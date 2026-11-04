import { defineManifestConnector } from '../manifest/compile.js';
import type { CapabilityBinding, CapabilityOutput } from '../sdk.js';
import { type ConnectorUi, withUi } from '../sdk.js';

/** HubSpot CRM API v3 with a private app access token. */

const CONTACT_PROPS = ['email', 'firstname', 'lastname', 'phone', 'company', 'jobtitle', 'lifecyclestage'];
const COMPANY_PROPS = ['name', 'domain', 'industry', 'city', 'country', 'numberofemployees'];
const DEAL_PROPS = ['dealname', 'amount', 'dealstage', 'pipeline', 'closedate', 'hubspot_owner_id'];

const props = (names: string[]) => names.map((n) => `properties.${n}`);
const searchInput = (what: string) => ({
  type: 'object' as const,
  properties: {
    query: { type: 'string', minLength: 1, description: `Words to find ${what} by` },
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
  },
  required: ['query'],
});
const searchBody = (properties: string[]) => ({
  query: '{{input.query}}',
  limit: '{{input.limit}}',
  properties,
});
const contactFields = {
  email: { type: 'string', format: 'email' },
  firstname: { type: 'string' },
  lastname: { type: 'string' },
  phone: { type: 'string' },
  company: { type: 'string', description: 'Company name' },
  jobtitle: { type: 'string' },
};
const dealFields = {
  dealname: { type: 'string', minLength: 1 },
  amount: { type: 'number' },
  dealstage: { type: 'string', description: 'Stage id from hubspot_list_pipelines' },
  pipeline: { type: 'string', description: 'Pipeline id; "default" is the main pipeline' },
  closedate: { type: 'string', description: 'ISO 8601 date' },
};
const fieldTemplates = (keys: string[]) => Object.fromEntries(keys.map((k) => [k, `{{input.${k}}}`]));

interface Contact {
  id: string;
  properties?: Record<string, string | null | undefined>;
}

const searchContacts: CapabilityBinding = {
  id: 'contacts.search',
  mapInput: ({ query, limit }) => ({ query, limit }),
  mapOutput: (result) => {
    const { items } = result as { items: Contact[] };
    return items.map((c): CapabilityOutput<'contacts.search'> => {
      const p = c.properties ?? {};
      const name = [p.firstname, p.lastname].filter(Boolean).join(' ') || p.email || c.id;
      return {
        id: c.id,
        name,
        ...(p.email ? { emails: [p.email] } : {}),
        ...(p.phone ? { phones: [p.phone] } : {}),
        ...(p.company ? { company: p.company } : {}),
      };
    });
  },
};

const manifest = defineManifestConnector(
  {
    id: 'hubspot',
    name: 'HubSpot',
    description: 'HubSpot CRM: find, create and update contacts, companies and deals.',
    version: '1.0.0',
    homepage: 'https://developers.hubspot.com/docs/api/crm/understanding-the-crm',
    instructions:
      'Searches match words in the main properties (name, email, phone, domain). Deal stages are ids: get them from hubspot_list_pipelines.',
    baseUrl: 'https://api.hubapi.com',
    credentials: {
      type: 'object',
      properties: {
        token: {
          type: 'string',
          pattern: '^pat-',
          description: 'Private app access token (pat-…): HubSpot → Settings → Integrations → Private apps',
        },
      },
      required: ['token'],
    },
    auth: { type: 'bearer', token: '{{credentials.token}}' },
    rateLimit: { requests: 100, perSeconds: 10 },
    errorMessagePaths: ['message'],
    pagination: { type: 'cursor', param: 'after', in: 'body', nextPath: 'paging.next.after' },
    test: {
      request: { method: 'GET', path: '/account-info/v3/details' },
      identity: 'HubSpot {{response.portalId}}',
    },
    actions: [
      {
        name: 'search_contacts',
        title: 'Search contacts',
        description: 'Finds contacts by name, email, phone or company.',
        input: searchInput('contacts'),
        hints: { readOnly: true, idempotent: true },
        request: { method: 'POST', path: '/crm/v3/objects/contacts/search', body: searchBody(CONTACT_PROPS) },
        response: { root: 'results', fields: ['id', ...props(CONTACT_PROPS)] },
        pagination: true,
      },
      {
        name: 'search_companies',
        title: 'Search companies',
        description: 'Finds companies by name or domain.',
        input: searchInput('companies'),
        hints: { readOnly: true, idempotent: true },
        request: {
          method: 'POST',
          path: '/crm/v3/objects/companies/search',
          body: searchBody(COMPANY_PROPS),
        },
        response: { root: 'results', fields: ['id', ...props(COMPANY_PROPS)] },
        pagination: true,
      },
      {
        name: 'search_deals',
        title: 'Search deals',
        description: 'Finds deals by name.',
        input: searchInput('deals'),
        hints: { readOnly: true, idempotent: true },
        request: { method: 'POST', path: '/crm/v3/objects/deals/search', body: searchBody(DEAL_PROPS) },
        response: { root: 'results', fields: ['id', ...props(DEAL_PROPS)] },
        pagination: true,
      },
      {
        name: 'list_pipelines',
        title: 'List deal pipelines',
        description: 'Deal pipelines with their stage ids.',
        hints: { readOnly: true, idempotent: true },
        request: { method: 'GET', path: '/crm/v3/pipelines/deals' },
        response: { root: 'results', fields: ['id', 'label', 'stages'] },
      },
      {
        name: 'create_contact',
        title: 'Create contact',
        description: 'Creates a contact.',
        input: { type: 'object', properties: contactFields },
        hints: { readOnly: false, destructive: false },
        risk: 'write',
        request: {
          method: 'POST',
          path: '/crm/v3/objects/contacts',
          body: { properties: fieldTemplates(Object.keys(contactFields)) },
        },
        response: { fields: ['id', ...props(CONTACT_PROPS)] },
      },
      {
        name: 'update_contact',
        title: 'Update contact',
        description: 'Changes the given properties of a contact.',
        input: {
          type: 'object',
          properties: { contact_id: { type: 'string', minLength: 1 }, ...contactFields },
          required: ['contact_id'],
        },
        hints: { readOnly: false, destructive: false, idempotent: true },
        risk: 'write',
        request: {
          method: 'PATCH',
          path: '/crm/v3/objects/contacts/{contact_id}',
          body: { properties: fieldTemplates(Object.keys(contactFields)) },
        },
        response: { fields: ['id', ...props(CONTACT_PROPS)] },
      },
      {
        name: 'create_deal',
        title: 'Create deal',
        description: 'Creates a deal.',
        input: { type: 'object', properties: dealFields, required: ['dealname', 'dealstage'] },
        hints: { readOnly: false, destructive: false },
        risk: 'write',
        request: {
          method: 'POST',
          path: '/crm/v3/objects/deals',
          body: { properties: fieldTemplates(Object.keys(dealFields)) },
        },
        response: { fields: ['id', ...props(DEAL_PROPS)] },
      },
      {
        name: 'update_deal',
        title: 'Update deal',
        description: 'Changes the given properties of a deal, e.g. moves it to another stage.',
        input: {
          type: 'object',
          properties: { deal_id: { type: 'string', minLength: 1 }, ...dealFields },
          required: ['deal_id'],
        },
        hints: { readOnly: false, destructive: false, idempotent: true },
        risk: 'write',
        request: {
          method: 'PATCH',
          path: '/crm/v3/objects/deals/{deal_id}',
          body: { properties: fieldTemplates(Object.keys(dealFields)) },
        },
        response: { fields: ['id', ...props(DEAL_PROPS)] },
      },
    ],
  },
  { actions: { search_contacts: { capability: searchContacts } } },
);

const ui: ConnectorUi = {
  locales: {
    ru: {
      description: 'CRM HubSpot: поиск, создание и изменение контактов, компаний и сделок.',
      setup: {
        form: {
          summary: 'Токен частного приложения HubSpot. Около трёх минут, нужны права супер-администратора.',
          steps: [
            {
              text: 'В HubSpot откройте «Настройки» → «Интеграции» → «Частные приложения» (Private apps) и нажмите «Создать частное приложение».',
              link: { label: 'Открыть HubSpot', url: 'https://app.hubspot.com/' },
            },
            { text: 'На вкладке «Основная информация» назовите приложение Manyplug.' },
            {
              text: 'На вкладке «Области» (Scopes) отметьте в CRM чтение и запись для contacts, companies и deals: crm.objects.contacts.read/write, crm.objects.companies.read/write, crm.objects.deals.read/write.',
            },
            {
              text: 'Нажмите «Создать приложение», затем на вкладке «Токен доступа» — «Показать токен» и «Копировать». Вставьте токен (pat-…) в форму.',
            },
          ],
          tips: [
            'В новых аккаунтах HubSpot этот раздел называется «Разработка» → «Устаревшие приложения» (Legacy apps): там нажмите «Создать» → «Частное».',
            'Чтобы ИИ только читал, отметьте одни права read. Токен можно сменить в настройках приложения.',
          ],
        },
      },
      prompts: [
        'Найди в HubSpot всё про компанию ACME: контакты и сделки.',
        'Добавь контакт: Анна Смит, anna@acme.com, ACME, директор по закупкам.',
        'Переведи сделку «ACME — годовой контракт» на этап «Договор отправлен».',
        'Какие сделки должны закрыться в этом месяце?',
      ],
      fields: {
        token: {
          label: 'Токен частного приложения',
          hint: 'Настройки → Интеграции → Частные приложения → Токен доступа.',
        },
      },
      actions: {
        search_contacts: {
          title: 'Поиск контактов',
          description: 'Находит контакты по имени, почте, телефону или компании.',
        },
        search_companies: {
          title: 'Поиск компаний',
          description: 'Находит компании по названию или домену.',
        },
        search_deals: { title: 'Поиск сделок', description: 'Находит сделки по названию.' },
        list_pipelines: { title: 'Воронки сделок', description: 'Воронки с этапами и их идентификаторами.' },
        create_contact: { title: 'Новый контакт', description: 'Создаёт контакт.' },
        update_contact: { title: 'Изменение контакта', description: 'Меняет указанные свойства контакта.' },
        create_deal: { title: 'Новая сделка', description: 'Создаёт сделку.' },
        update_deal: {
          title: 'Изменение сделки',
          description: 'Меняет указанные свойства сделки, например переводит на другой этап.',
        },
      },
    },
    en: {
      setup: {
        form: {
          summary: 'A HubSpot private app token. Takes about three minutes and needs super admin rights.',
          steps: [
            {
              text: 'In HubSpot, open Settings → Integrations → Private apps and click Create a private app.',
              link: { label: 'Open HubSpot', url: 'https://app.hubspot.com/' },
            },
            { text: 'On the Basic info tab, name the app Manyplug.' },
            {
              text: 'On the Scopes tab, under CRM, tick read and write for contacts, companies and deals: crm.objects.contacts.read/write, crm.objects.companies.read/write, crm.objects.deals.read/write.',
            },
            {
              text: 'Click Create app, then on the Access token tab click Show token and Copy. Paste the token (pat-…) into the form.',
            },
          ],
          tips: [
            'In newer HubSpot accounts this lives under Development → Legacy apps: click Create → Private there.',
            'For read-only access, tick only the read scopes. You can rotate the token in the app settings.',
          ],
        },
      },
      prompts: [
        'Find everything on ACME in HubSpot: contacts and deals.',
        'Add a contact: Anna Smith, anna@acme.com, ACME, Head of Procurement.',
        'Move the deal “ACME annual contract” to Contract sent.',
        'Which deals are due to close this month?',
      ],
      fields: {
        token: { label: 'Private app token', hint: 'Settings → Integrations → Private apps → Access token.' },
      },
      actions: {
        search_contacts: {
          title: 'Search contacts',
          description: 'Finds contacts by name, email, phone or company.',
        },
        search_companies: { title: 'Search companies', description: 'Finds companies by name or domain.' },
        search_deals: { title: 'Search deals', description: 'Finds deals by name.' },
        list_pipelines: { title: 'Deal pipelines', description: 'Pipelines with their stages and ids.' },
        create_contact: { title: 'Create a contact', description: 'Creates a contact.' },
        update_contact: {
          title: 'Update a contact',
          description: 'Changes the given properties of a contact.',
        },
        create_deal: { title: 'Create a deal', description: 'Creates a deal.' },
        update_deal: {
          title: 'Update a deal',
          description: 'Changes the given properties of a deal, e.g. moves it to another stage.',
        },
      },
    },
  },
};

export default withUi(manifest, ui);
