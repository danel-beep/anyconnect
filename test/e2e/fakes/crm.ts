import { Hono } from 'hono';
import type { FakeInternet } from '../fake-internet.js';

/**
 * A REST API without an MCP server ("Acme CRM" at api.crm.example): what a user adds to the hub
 * with an HTTP manifest. API-key auth in a header, a profile endpoint, contacts to search, create
 * and delete. Answers 401 to a wrong key, like the real thing would.
 */
export class FakeCrm {
  readonly host = 'api.crm.example';
  readonly apiKey = 'crm_live_4f9a';
  readonly contacts = [
    {
      id: 'c1',
      name: 'Dana Whitfield',
      company: 'Contoso',
      email: 'dana@contoso.example',
      internal_notes: 'VIP',
    },
    { id: 'c2', name: 'Lee Park', company: 'Fabrikam', email: 'lee@fabrikam.example', internal_notes: '' },
  ];
  private next = 3;

  install(internet: FakeInternet): this {
    const app = new Hono().basePath('/v1');
    app.use('*', async (c, next) => {
      if (c.req.header('x-api-key') !== this.apiKey)
        return c.json({ error: { detail: 'Invalid API key' } }, 401);
      await next();
    });
    app.get('/me', (c) => c.json({ email: 'owner@northwind.example', plan: 'pro' }));
    app.get('/contacts', (c) => {
      const q = (c.req.query('q') ?? '').toLowerCase();
      return c.json({
        data: this.contacts.filter((x) => `${x.name} ${x.company}`.toLowerCase().includes(q)),
      });
    });
    app.post('/contacts', async (c) => {
      const body = (await c.req.json()) as { name: string; company?: string };
      const contact = {
        id: `c${this.next++}`,
        name: body.name,
        company: body.company ?? '',
        email: '',
        internal_notes: '',
      };
      this.contacts.push(contact);
      return c.json(contact, 201);
    });
    app.delete('/contacts/:id', (c) => {
      const index = this.contacts.findIndex((x) => x.id === c.req.param('id'));
      if (index < 0) return c.json({ error: { detail: 'No such contact' } }, 404);
      this.contacts.splice(index, 1);
      return c.body(null, 204);
    });
    internet.serve(this.host, app.fetch);
    return this;
  }

  /** The manifest the user (or the AI, from the API docs) writes for this API. */
  manifest() {
    return {
      id: 'acme_crm',
      name: 'Acme CRM',
      description: 'Contacts in Acme CRM',
      baseUrl: `https://${this.host}/v1`,
      auth: { type: 'api_key', in: 'header', name: 'X-Api-Key' },
      errorMessagePaths: ['error.detail'],
      test: { request: { method: 'GET', path: '/me' }, identity: '{{response.email}}' },
      actions: [
        {
          name: 'search_contacts',
          description: 'Finds contacts by name or company.',
          input: { type: 'object', properties: { q: { type: 'string', description: 'Name or company' } } },
          hints: { readOnly: true },
          request: { method: 'GET', path: '/contacts' },
          response: { root: 'data', fields: ['id', 'name', 'company', 'email'] },
        },
        {
          name: 'create_contact',
          description: 'Adds a contact.',
          input: {
            type: 'object',
            properties: { name: { type: 'string' }, company: { type: 'string' } },
            required: ['name'],
          },
          risk: 'write',
          request: { method: 'POST', path: '/contacts' },
        },
        {
          name: 'delete_contact',
          description: 'Deletes a contact for good.',
          input: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
          risk: 'dangerous',
          request: { method: 'DELETE', path: '/contacts/{id}' },
        },
      ],
    };
  }
}
