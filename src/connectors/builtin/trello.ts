import { defineManifestConnector } from '../manifest/compile.js';
import type { CapabilityBinding, CapabilityOutput } from '../sdk.js';
import { type ConnectorUi, withUi } from '../sdk.js';

/** Trello REST API with an API key and a user token (sent in the OAuth-style header). */

const CARD_FIELDS = ['id', 'name', 'due', 'dueComplete', 'idList', 'idBoard', 'url', 'closed'];
const cardId = { type: 'string', minLength: 1, description: 'Card id or short link' };
const boardId = { type: 'string', minLength: 1, description: 'Board id from trello_list_boards' };

interface TrelloCard {
  id: string;
  name: string;
  due?: string | null;
  dueComplete?: boolean;
  closed?: boolean;
  url?: string;
}

/** The shared task list: your open cards, or open cards matching the words. */
const listTasks: CapabilityBinding = {
  id: 'tasks.list',
  mapInput: ({ query, limit }) => ({
    query: [typeof query === 'string' && query.trim() ? query.trim() : '@me', 'is:open'].join(' '),
    limit,
  }),
  mapOutput: (result, input) => {
    const due = typeof input.due_before === 'string' ? input.due_before : undefined;
    return (result as TrelloCard[])
      .map(
        (card): CapabilityOutput<'tasks.list'> => ({
          id: card.id,
          title: card.name,
          status: card.dueComplete ? 'done' : 'open',
          ...(card.due ? { due: card.due } : {}),
          ...(card.url ? { url: card.url } : {}),
        }),
      )
      .filter((t) => input.status === 'all' || t.status === (input.status ?? 'open'))
      .filter((t) => !due || (t.due !== undefined && t.due <= due));
  },
};

const manifest = defineManifestConnector(
  {
    id: 'trello',
    name: 'Trello',
    description: 'Trello boards, lists and cards: find, read, create, move, comment on cards.',
    version: '1.0.0',
    homepage: 'https://developer.atlassian.com/cloud/trello/rest/',
    instructions:
      'Cards live in lists on boards: trello_list_boards → trello_list_lists gives the list id for creating or moving a card. trello_search_cards supports operators like "@me", "board:Roadmap", "list:Doing", "due:week", "is:open".',
    baseUrl: 'https://api.trello.com/1',
    credentials: {
      type: 'object',
      properties: {
        apiKey: {
          type: 'string',
          pattern: '^[0-9a-fA-F]{32}$',
          description: 'API key of your Power-Up: https://trello.com/power-ups/admin',
        },
        token: { type: 'string', minLength: 32, description: 'Token generated next to the API key' },
      },
      required: ['apiKey', 'token'],
    },
    auth: {
      type: 'api_key',
      in: 'header',
      name: 'Authorization',
      value: 'OAuth oauth_consumer_key="{{credentials.apiKey}}", oauth_token="{{credentials.token}}"',
    },
    rateLimit: { requests: 90, perSeconds: 10 },
    errorMessagePaths: ['message', 'error'],
    test: {
      request: { method: 'GET', path: '/members/me', query: { fields: 'username,fullName,email' } },
      identity: '{{response.username}}',
    },
    actions: [
      {
        name: 'list_boards',
        title: 'List boards',
        description: 'Lists your open boards.',
        hints: { readOnly: true, idempotent: true },
        request: { method: 'GET', path: '/members/me/boards', query: { filter: 'open', fields: 'name,url' } },
        response: { fields: ['id', 'name', 'url'] },
      },
      {
        name: 'list_lists',
        title: 'List lists',
        description: 'Lists the open lists (columns) of a board.',
        input: { type: 'object', properties: { board_id: boardId }, required: ['board_id'] },
        hints: { readOnly: true, idempotent: true },
        request: {
          method: 'GET',
          path: '/boards/{board_id}/lists',
          query: { filter: 'open', fields: 'name' },
        },
        response: { fields: ['id', 'name'] },
      },
      {
        name: 'list_cards',
        title: 'List cards',
        description: 'Lists the open cards of a board with their list ids.',
        input: { type: 'object', properties: { board_id: boardId }, required: ['board_id'] },
        hints: { readOnly: true, idempotent: true },
        request: {
          method: 'GET',
          path: '/boards/{board_id}/cards',
          query: { filter: 'open', fields: 'name,due,dueComplete,idList,url' },
        },
        response: { fields: ['id', 'name', 'due', 'dueComplete', 'idList', 'url'] },
      },
      {
        name: 'search_cards',
        title: 'Search cards',
        description: 'Searches cards on all your boards.',
        input: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              minLength: 1,
              description: 'Words and operators, e.g. "invoice is:open"',
            },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          },
          required: ['query'],
        },
        hints: { readOnly: true, idempotent: true },
        request: {
          method: 'GET',
          path: '/search',
          query: {
            query: '{{input.query}}',
            modelTypes: 'cards',
            cards_limit: '{{input.limit}}',
            card_fields: 'name,due,dueComplete,idList,idBoard,url,closed',
            partial: 'true',
          },
        },
        response: { root: 'cards', fields: CARD_FIELDS },
      },
      {
        name: 'get_card',
        title: 'Get card',
        description: 'Returns a card with its description and labels.',
        input: { type: 'object', properties: { card_id: cardId }, required: ['card_id'] },
        hints: { readOnly: true, idempotent: true },
        request: {
          method: 'GET',
          path: '/cards/{card_id}',
          query: { fields: 'name,desc,due,dueComplete,idList,idBoard,url,closed,labels' },
        },
        response: { fields: [...CARD_FIELDS, 'desc', 'labels'] },
      },
      {
        name: 'list_comments',
        title: 'List comments',
        description: 'Lists comments of a card, newest first.',
        input: { type: 'object', properties: { card_id: cardId }, required: ['card_id'] },
        hints: { readOnly: true, idempotent: true },
        request: { method: 'GET', path: '/cards/{card_id}/actions', query: { filter: 'commentCard' } },
        response: { fields: ['id', 'date', 'memberCreator.fullName', 'data.text'] },
      },
      {
        name: 'create_card',
        title: 'Create card',
        description: 'Creates a card in a list.',
        input: {
          type: 'object',
          properties: {
            list_id: { type: 'string', minLength: 1, description: 'List id from trello_list_lists' },
            name: { type: 'string', minLength: 1 },
            desc: { type: 'string', description: 'Description, Markdown' },
            due: { type: 'string', description: 'Due date, ISO 8601' },
            pos: { type: 'string', enum: ['top', 'bottom'], default: 'bottom' },
          },
          required: ['list_id', 'name'],
        },
        hints: { readOnly: false, destructive: false },
        risk: 'write',
        undo: { kind: 'action', action: 'delete_card' },
        request: {
          method: 'POST',
          path: '/cards',
          body: {
            idList: '{{input.list_id}}',
            name: '{{input.name}}',
            desc: '{{input.desc}}',
            due: '{{input.due}}',
            pos: '{{input.pos}}',
          },
        },
        response: { fields: CARD_FIELDS },
      },
      {
        name: 'update_card',
        title: 'Update card',
        description: 'Changes a card: name, description, due date, done mark, list (to move it) or archive.',
        input: {
          type: 'object',
          properties: {
            card_id: cardId,
            name: { type: 'string', minLength: 1 },
            desc: { type: 'string' },
            due: { type: 'string', description: 'ISO 8601' },
            due_complete: { type: 'boolean', description: 'Mark the due date done' },
            list_id: { type: 'string', description: 'Move to this list' },
            closed: { type: 'boolean', description: 'true archives the card' },
          },
          required: ['card_id'],
        },
        hints: { readOnly: false, destructive: false, idempotent: true },
        risk: 'write',
        request: {
          method: 'PUT',
          path: '/cards/{card_id}',
          body: {
            name: '{{input.name}}',
            desc: '{{input.desc}}',
            due: '{{input.due}}',
            dueComplete: '{{input.due_complete}}',
            idList: '{{input.list_id}}',
            closed: '{{input.closed}}',
          },
        },
        response: { fields: CARD_FIELDS },
      },
      {
        name: 'add_comment',
        title: 'Add comment',
        description: 'Adds a comment to a card.',
        input: {
          type: 'object',
          properties: { card_id: cardId, text: { type: 'string', minLength: 1 } },
          required: ['card_id', 'text'],
        },
        hints: { readOnly: false, destructive: false },
        risk: 'write',
        request: {
          method: 'POST',
          path: '/cards/{card_id}/actions/comments',
          body: { text: '{{input.text}}' },
        },
        response: { fields: ['id', 'date'] },
      },
      {
        name: 'delete_card',
        title: 'Delete card',
        description: 'Deletes a card permanently (to keep it, archive it with trello_update_card).',
        input: { type: 'object', properties: { card_id: cardId }, required: ['card_id'] },
        hints: { readOnly: false, destructive: true, idempotent: true },
        risk: 'dangerous',
        request: { method: 'DELETE', path: '/cards/{card_id}' },
        response: { empty: 'Deleted.' },
      },
    ],
  },
  { actions: { search_cards: { capability: listTasks } } },
);

const ui: ConnectorUi = {
  locales: {
    ru: {
      description: 'Доски, списки и карточки Trello: поиск, чтение, создание, перенос и комментарии.',
      setup: {
        form: {
          summary:
            'Вы создаёте личный Power-Up в Trello, чтобы получить ключ API и токен, и вставляете оба сюда.',
          minutes: 4,
          needs: ['Аккаунт Trello хотя бы с одним рабочим пространством (Workspace)'],
          steps: [
            {
              text: 'Откройте страницу администрирования Power-Ups и нажмите **New**: Trello выдаёт ключи API только для Power-Ups.',
              link: { label: 'Открыть Power-Ups', url: 'https://trello.com/power-ups/admin' },
            },
            {
              text: 'Заполните форму: название Manyplug, любое рабочее пространство, ваша почта. Оставьте **Iframe connector URL** пустым и нажмите **Create**.',
            },
            {
              text: 'На вкладке **API key** нажмите **Generate a new API key** и скопируйте ключ.',
              fills: ['apiKey'],
            },
            {
              text: 'Нажмите ссылку **Token** рядом с ключом, затем **Allow** и скопируйте токен.',
              fills: ['token'],
            },
          ],
          tips: ['Токен открывает все ваши доски. Отозвать его можно в Trello: **Settings → Applications**.'],
          problems: [
            {
              problem: 'Проверка пишет, что ключ или токен неверный (401)',
              fix: 'Ключ и токен связаны: скопируйте оба заново из одного и того же Power-Up. Токен от другого ключа не подойдёт.',
            },
            {
              problem: 'Нет ссылки **Token**',
              fix: 'Она появляется рядом с ключом, когда ключ создан на вкладке **API key**. Если её всё ещё нет, обновите страницу.',
            },
            {
              problem: 'ИИ не видит доску',
              fix: 'Токен видит доски того аккаунта Trello, который нажал **Allow**. Войдите как участник этой доски и создайте токен заново.',
            },
          ],
        },
      },
      prompts: [
        'Какие карточки в Trello на мне?',
        'Добавь на доску «Маркетинг» в «Идеи» карточку «Вебинар в декабре».',
        'Перенеси карточку про лендинг в «Готово».',
        'Что сейчас в «В работе» на доске «Продукт»?',
      ],
      fields: {
        apiKey: { label: 'Ключ API', hint: 'Вкладка API key вашего Power-Up на trello.com/power-ups/admin.' },
        token: { label: 'Токен', hint: 'Ссылка Token рядом с ключом API.' },
      },
      actions: {
        list_boards: { title: 'Список досок', description: 'Ваши открытые доски.' },
        list_lists: { title: 'Списки доски', description: 'Открытые списки (колонки) доски.' },
        list_cards: { title: 'Карточки доски', description: 'Открытые карточки доски.' },
        search_cards: { title: 'Поиск карточек', description: 'Ищет карточки на всех ваших досках.' },
        get_card: { title: 'Карточка', description: 'Показывает карточку с описанием и метками.' },
        list_comments: { title: 'Комментарии', description: 'Комментарии к карточке, сначала новые.' },
        create_card: { title: 'Новая карточка', description: 'Создаёт карточку в списке.' },
        update_card: {
          title: 'Изменение карточки',
          description: 'Меняет название, описание, срок, переносит в другой список или в архив.',
        },
        add_comment: { title: 'Новый комментарий', description: 'Добавляет комментарий к карточке.' },
        delete_card: {
          title: 'Удаление карточки',
          description: 'Удаляет карточку без возможности восстановления.',
        },
      },
    },
    en: {
      setup: {
        form: {
          summary:
            'You create a private Power-Up in Trello to get an API key and a token, then paste both here.',
          minutes: 4,
          needs: ['A Trello account with at least one Workspace'],
          steps: [
            {
              text: 'Open the Power-Ups admin page and click **New**: Trello gives API keys only to Power-Ups.',
              link: { label: 'Open the Power-Ups admin', url: 'https://trello.com/power-ups/admin' },
            },
            {
              text: 'Fill in the form: name Manyplug, any Workspace, your email. Leave **Iframe connector URL** empty and click **Create**.',
            },
            {
              text: 'On the **API key** tab, click **Generate a new API key** and copy the key.',
              fills: ['apiKey'],
            },
            {
              text: 'Click the **Token** link next to the key, click **Allow** and copy the token.',
              fills: ['token'],
            },
          ],
          tips: [
            'The token opens all your boards. You can revoke it in Trello under **Settings → Applications**.',
          ],
          problems: [
            {
              problem: 'The check says the key or token is invalid (401)',
              fix: 'The key and the token belong together: copy both again from the same Power-Up. A token made for another key does not work.',
            },
            {
              problem: 'There is no **Token** link',
              fix: 'It appears next to the key once the key is generated on the **API key** tab. Reload the page if you still do not see it.',
            },
            {
              problem: 'The AI does not see a board',
              fix: 'The token sees the boards of the Trello account that clicked **Allow**. Sign in as a member of that board and create the token again.',
            },
          ],
        },
      },
      prompts: [
        'Which Trello cards are assigned to me?',
        'Add a card “December webinar” to Ideas on the Marketing board.',
        'Move the landing page card to Done.',
        'What is in Doing on the Product board right now?',
      ],
      fields: {
        apiKey: { label: 'API key', hint: 'The API key tab of your Power-Up at trello.com/power-ups/admin.' },
        token: { label: 'Token', hint: 'The Token link next to the API key.' },
      },
      actions: {
        list_boards: { title: 'List boards', description: 'Your open boards.' },
        list_lists: { title: 'List lists', description: 'Open lists (columns) of a board.' },
        list_cards: { title: 'List cards', description: 'Open cards of a board.' },
        search_cards: { title: 'Search cards', description: 'Searches cards on all your boards.' },
        get_card: { title: 'Get a card', description: 'Shows a card with its description and labels.' },
        list_comments: { title: 'List comments', description: 'Comments of a card, newest first.' },
        create_card: { title: 'Create a card', description: 'Creates a card in a list.' },
        update_card: {
          title: 'Update a card',
          description:
            'Changes the name, description or due date, moves a card to another list or archives it.',
        },
        add_comment: { title: 'Add a comment', description: 'Adds a comment to a card.' },
        delete_card: { title: 'Delete a card', description: 'Deletes a card permanently.' },
      },
    },
  },
};

export default withUi(manifest, ui);
