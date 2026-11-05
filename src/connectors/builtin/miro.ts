import { defineManifestConnector } from '../manifest/compile.js';
import { type ConnectorUi, withUi } from '../sdk.js';

/** Miro REST API v2 with the access token of the user's own Miro app. */

const boardId = {
  type: 'string',
  minLength: 5,
  description: 'Board id from miro_list_boards or the board link (…/board/<id>/)',
};
const position = {
  x: { type: 'number', description: 'Board coordinates; 0,0 is the center' },
  y: { type: 'number' },
};
const ITEM_FIELDS = ['id', 'type', 'data', 'position.x', 'position.y', 'parent.id', 'modifiedAt'];

const manifest = defineManifestConnector({
  id: 'miro',
  name: 'Miro',
  description:
    'Miro boards: find boards, read sticky notes, cards and text, add stickies, cards and text, create boards.',
  version: '1.0.0',
  homepage: 'https://developers.miro.com/reference',
  instructions:
    'Read a board with miro_list_items before adding to it, to place new items next to existing ones. Content is plain text or simple HTML.',
  baseUrl: 'https://api.miro.com/v2',
  credentials: {
    type: 'object',
    properties: {
      token: {
        type: 'string',
        minLength: 20,
        description: 'Access token of your Miro app (Install app and get OAuth token)',
      },
    },
    required: ['token'],
  },
  auth: { type: 'bearer', token: '{{credentials.token}}' },
  rateLimit: { requests: 100, perSeconds: 60 },
  errorMessagePaths: ['message'],
  test: { request: { method: 'GET', path: '/boards', query: { limit: '1' } } },
  actions: [
    {
      name: 'list_boards',
      title: 'List boards',
      description: 'Boards you can see, optionally by name, most recently changed first.',
      input: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Words in the board name' },
          limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
        },
      },
      hints: { readOnly: true, idempotent: true },
      request: {
        method: 'GET',
        path: '/boards',
        query: { query: '{{input.query}}', limit: '{{input.limit}}', sort: 'last_modified' },
      },
      response: {
        root: 'data',
        fields: ['id', 'name', 'description', 'viewLink', 'modifiedAt', 'team.name'],
      },
      pagination: { type: 'offset', param: 'offset', limitParam: 'limit', defaultLimit: 20 },
    },
    {
      name: 'list_items',
      title: 'List items',
      description:
        'Items on a board (sticky notes, cards, text, shapes, frames) with their content and position.',
      input: {
        type: 'object',
        properties: {
          board_id: boardId,
          type: {
            type: 'string',
            enum: ['sticky_note', 'card', 'text', 'shape', 'frame', 'image', 'document'],
          },
          limit: { type: 'integer', minimum: 10, maximum: 50, default: 50 },
        },
        required: ['board_id'],
      },
      hints: { readOnly: true, idempotent: true },
      request: {
        method: 'GET',
        path: '/boards/{board_id}/items',
        query: { type: '{{input.type}}', limit: '{{input.limit}}' },
      },
      response: { root: 'data', fields: ITEM_FIELDS },
      pagination: { type: 'cursor', param: 'cursor', nextPath: 'cursor' },
    },
    {
      name: 'add_sticky_note',
      title: 'Add sticky note',
      description: 'Adds a sticky note to a board.',
      input: {
        type: 'object',
        properties: {
          board_id: boardId,
          content: { type: 'string', minLength: 1, maxLength: 6000 },
          color: {
            type: 'string',
            enum: [
              'gray',
              'light_yellow',
              'yellow',
              'orange',
              'light_green',
              'green',
              'cyan',
              'light_blue',
              'blue',
              'violet',
              'red',
              'pink',
            ],
          },
          ...position,
        },
        required: ['board_id', 'content'],
      },
      hints: { readOnly: false, destructive: false },
      risk: 'write',
      request: {
        method: 'POST',
        path: '/boards/{board_id}/sticky_notes',
        body: {
          data: { content: '{{input.content}}', shape: 'square' },
          style: { fillColor: '{{input.color}}' },
          position: { x: '{{input.x}}', y: '{{input.y}}' },
        },
      },
      response: { fields: ITEM_FIELDS },
    },
    {
      name: 'add_card',
      title: 'Add card',
      description: 'Adds a card with a title and description, optionally with a due date.',
      input: {
        type: 'object',
        properties: {
          board_id: boardId,
          title: { type: 'string', minLength: 1 },
          description: { type: 'string' },
          due_date: { type: 'string', description: 'ISO date-time' },
          ...position,
        },
        required: ['board_id', 'title'],
      },
      hints: { readOnly: false, destructive: false },
      risk: 'write',
      request: {
        method: 'POST',
        path: '/boards/{board_id}/cards',
        body: {
          data: {
            title: '{{input.title}}',
            description: '{{input.description}}',
            dueDate: '{{input.due_date}}',
          },
          position: { x: '{{input.x}}', y: '{{input.y}}' },
        },
      },
      response: { fields: ITEM_FIELDS },
    },
    {
      name: 'add_text',
      title: 'Add text',
      description: 'Adds a text block to a board.',
      input: {
        type: 'object',
        properties: { board_id: boardId, content: { type: 'string', minLength: 1 }, ...position },
        required: ['board_id', 'content'],
      },
      hints: { readOnly: false, destructive: false },
      risk: 'write',
      request: {
        method: 'POST',
        path: '/boards/{board_id}/texts',
        body: { data: { content: '{{input.content}}' }, position: { x: '{{input.x}}', y: '{{input.y}}' } },
      },
      response: { fields: ITEM_FIELDS },
    },
    {
      name: 'create_board',
      title: 'Create board',
      description: 'Creates a new empty board.',
      input: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 60 },
          description: { type: 'string', maxLength: 300 },
        },
        required: ['name'],
      },
      hints: { readOnly: false, destructive: false },
      risk: 'write',
      request: { method: 'POST', path: '/boards' },
      response: { fields: ['id', 'name', 'viewLink'] },
    },
  ],
});

const ui: ConnectorUi = {
  locales: {
    ru: {
      description:
        'Доски Miro: поиск досок, чтение стикеров, карточек и текста, новые стикеры, карточки и доски.',
      setup: {
        form: {
          summary:
            'Вы создаёте своё приложение в настройках Miro, устанавливаете его в команду и вставляете сюда его токен.',
          minutes: 4,
          needs: ['Аккаунт Miro с доступом к нужным доскам'],
          notice:
            'Токен видит доски только одной команды Miro. Для другой команды подключите ещё один аккаунт.',
          steps: [
            {
              text: 'Откройте Miro → **Profile settings** → **Your apps** и нажмите **Create new app**. Если Miro попросит создать **Developer team**, создайте её.',
              link: {
                label: 'Открыть приложения Miro',
                url: 'https://miro.com/app/settings/user-profile/apps',
              },
            },
            {
              text: 'Назовите приложение Manyplug и в **Permissions** отметьте **boards:read** и **boards:write**.',
            },
            {
              text: 'Нажмите **Install app and get OAuth token**, выберите команду с нужными досками и нажмите **Install & authorize**.',
            },
            { text: 'Скопируйте показанный токен.', fills: ['token'] },
          ],
          tips: [
            'Токен действует от вашего имени. Чтобы отозвать доступ, удалите приложение в **Your apps**.',
          ],
          problems: [
            {
              problem: 'Через час токен перестал работать',
              fix: 'В настройках приложения выключите **Expire user authorization token**, снова нажмите **Install app and get OAuth token** и вставьте новый токен через **Переподключить**.',
            },
            {
              problem: 'ИИ видит доски, но не может их менять',
              fix: 'У приложения нет права **boards:write**. Отметьте его в **Permissions**, переустановите приложение и вставьте новый токен.',
            },
            {
              problem: 'Нужной доски нет в списке',
              fix: 'Доска в другой команде. Установите приложение в эту команду и подключите её токен как ещё один аккаунт.',
            },
          ],
        },
      },
      prompts: [
        'Что написано на стикерах доски «Ретро ноябрь» в Miro? Сгруппируй по темам.',
        'Добавь на доску «Идеи» жёлтый стикер «Партнёрская программа».',
        'Создай доску «Запуск Q1» и добавь карточки с задачами из этого списка.',
      ],
      fields: {
        token: {
          label: 'Токен',
          hint: 'Install app and get OAuth token в настройках вашего приложения Miro.',
        },
      },
      actions: {
        list_boards: { title: 'Доски', description: 'Доски, с поиском по названию.' },
        list_items: { title: 'Элементы доски', description: 'Стикеры, карточки, текст и рамки.' },
        add_sticky_note: { title: 'Стикер', description: 'Добавляет стикер.' },
        add_card: { title: 'Карточка', description: 'Добавляет карточку.' },
        add_text: { title: 'Текст', description: 'Добавляет текст.' },
        create_board: { title: 'Новая доска', description: 'Создаёт пустую доску.' },
      },
    },
    en: {
      setup: {
        form: {
          summary:
            'You create your own app in Miro settings, install it in your team and paste its token here.',
          minutes: 4,
          needs: ['A Miro account with access to the boards you need'],
          notice:
            'The token sees the boards of one Miro team only. Connect another account for another team.',
          steps: [
            {
              text: 'Open Miro → **Profile settings** → **Your apps** and click **Create new app**. If Miro asks you to create a **Developer team**, create it.',
              link: { label: 'Open Miro apps', url: 'https://miro.com/app/settings/user-profile/apps' },
            },
            {
              text: 'Name the app Manyplug and tick **boards:read** and **boards:write** under **Permissions**.',
            },
            {
              text: 'Click **Install app and get OAuth token**, pick the team with your boards and click **Install & authorize**.',
            },
            { text: 'Copy the token Miro shows.', fills: ['token'] },
          ],
          tips: ['The token acts as you. To cut access, delete the app under **Your apps**.'],
          problems: [
            {
              problem: 'The token stopped working after an hour',
              fix: 'In the app settings, turn off **Expire user authorization token**, click **Install app and get OAuth token** again and paste the new token with **Reconnect**.',
            },
            {
              problem: 'The AI sees boards but cannot change them',
              fix: 'The app lacks **boards:write**. Tick it under **Permissions**, reinstall the app and paste the new token.',
            },
            {
              problem: 'A board is missing from the list',
              fix: 'The board belongs to another team. Install the app in that team and connect its token as another account.',
            },
          ],
        },
      },
      prompts: [
        'What do the stickies on the “November retro” Miro board say? Group them by theme.',
        'Add a yellow sticky “Partner program” to the Ideas board.',
        'Create a board “Q1 launch” and add a card for each task in this list.',
      ],
      fields: {
        token: { label: 'Token', hint: 'Install app and get OAuth token in your Miro app settings.' },
      },
      actions: {
        list_boards: { title: 'Boards', description: 'Boards, with a name search.' },
        list_items: { title: 'Board items', description: 'Stickies, cards, text and frames.' },
        add_sticky_note: { title: 'Sticky note', description: 'Adds a sticky note.' },
        add_card: { title: 'Card', description: 'Adds a card.' },
        add_text: { title: 'Text', description: 'Adds a text block.' },
        create_board: { title: 'New board', description: 'Creates an empty board.' },
      },
    },
  },
};

export default withUi(manifest, ui);
