import { defineManifestConnector } from '../manifest/compile.js';
import { type ConnectorUi, withUi } from '../sdk.js';

/** Figma REST API with a personal access token. */

const fileKey = {
  type: 'string',
  pattern: '^[A-Za-z0-9]{10,}$',
  description: 'File key: the part after /file/ or /design/ in the file link',
};

const manifest = defineManifestConnector({
  id: 'figma',
  name: 'Figma',
  description:
    'Figma files: browse team projects, read pages and frames, export images, read and add comments.',
  version: '1.0.0',
  homepage: 'https://www.figma.com/developers/api',
  instructions:
    'Get a file key from its link: figma.com/design/<key>/… Node ids look like "12:34" (in links as node-id=12-34). Start with figma_get_file (pages and top-level frames), then export or comment on nodes.',
  baseUrl: 'https://api.figma.com/v1',
  credentials: {
    type: 'object',
    properties: {
      token: {
        type: 'string',
        pattern: '^figd_',
        description: 'Personal access token: Settings → Security → Personal access tokens',
      },
    },
    required: ['token'],
  },
  auth: { type: 'api_key', in: 'header', name: 'X-Figma-Token', value: '{{credentials.token}}' },
  rateLimit: { requests: 10, perSeconds: 60 },
  errorMessagePaths: ['err', 'message'],
  test: { request: { method: 'GET', path: '/me' }, identity: '{{response.email}}' },
  actions: [
    {
      name: 'list_projects',
      title: 'List team projects',
      description: 'Projects of a team; the team id is in the team link: figma.com/files/team/<id>/…',
      input: {
        type: 'object',
        properties: { team_id: { type: 'string', pattern: '^[0-9]+$' } },
        required: ['team_id'],
      },
      hints: { readOnly: true, idempotent: true },
      request: { method: 'GET', path: '/teams/{team_id}/projects' },
      response: { root: 'projects', fields: ['id', 'name'] },
    },
    {
      name: 'list_files',
      title: 'List project files',
      description: 'Files of a project with their keys and last change.',
      input: {
        type: 'object',
        properties: { project_id: { type: 'string', pattern: '^[0-9]+$' } },
        required: ['project_id'],
      },
      hints: { readOnly: true, idempotent: true },
      request: { method: 'GET', path: '/projects/{project_id}/files' },
      response: { root: 'files', fields: ['key', 'name', 'last_modified'] },
    },
    {
      name: 'get_file',
      title: 'Get file',
      description: 'Returns a file’s name, pages and their top-level frames (ids and names).',
      input: { type: 'object', properties: { file_key: fileKey }, required: ['file_key'] },
      hints: { readOnly: true, idempotent: true },
      request: { method: 'GET', path: '/files/{file_key}', query: { depth: '2' } },
      response: { fields: ['name', 'lastModified', 'version', 'editorType', 'document.children'] },
    },
    {
      name: 'get_nodes',
      title: 'Get nodes',
      description: 'Returns chosen nodes (frames, components) with their children, text and styles.',
      input: {
        type: 'object',
        properties: {
          file_key: fileKey,
          ids: { type: 'string', description: 'Node ids, comma-separated, e.g. "12:34,12:40"' },
          depth: { type: 'integer', minimum: 1, maximum: 4, default: 2 },
        },
        required: ['file_key', 'ids'],
      },
      hints: { readOnly: true, idempotent: true },
      request: { method: 'GET', path: '/files/{file_key}/nodes' },
      response: { root: 'nodes' },
    },
    {
      name: 'export_images',
      title: 'Export images',
      description: 'Renders nodes to PNG, JPG, SVG or PDF and returns temporary download links (30 days).',
      input: {
        type: 'object',
        properties: {
          file_key: fileKey,
          ids: { type: 'string', description: 'Node ids, comma-separated' },
          format: { type: 'string', enum: ['png', 'jpg', 'svg', 'pdf'], default: 'png' },
          scale: { type: 'number', minimum: 0.01, maximum: 4, default: 1 },
        },
        required: ['file_key', 'ids'],
      },
      hints: { readOnly: true, idempotent: true },
      request: { method: 'GET', path: '/images/{file_key}' },
      response: { root: 'images' },
    },
    {
      name: 'list_comments',
      title: 'List comments',
      description: 'Comments of a file with their authors, text and whether they are resolved.',
      input: { type: 'object', properties: { file_key: fileKey }, required: ['file_key'] },
      hints: { readOnly: true, idempotent: true },
      request: { method: 'GET', path: '/files/{file_key}/comments' },
      response: {
        root: 'comments',
        fields: [
          'id',
          'message',
          'user.handle',
          'created_at',
          'resolved_at',
          'parent_id',
          'client_meta.node_id',
        ],
      },
    },
    {
      name: 'add_comment',
      title: 'Add comment',
      description: 'Adds a comment to a file, or a reply to another comment.',
      input: {
        type: 'object',
        properties: {
          file_key: fileKey,
          message: { type: 'string', minLength: 1 },
          reply_to: { type: 'string', description: 'Id of the comment to reply to' },
        },
        required: ['file_key', 'message'],
      },
      hints: { readOnly: false, destructive: false },
      risk: 'write',
      request: {
        method: 'POST',
        path: '/files/{file_key}/comments',
        body: { message: '{{input.message}}', comment_id: '{{input.reply_to}}' },
      },
      response: { fields: ['id', 'message', 'created_at'] },
    },
    {
      name: 'comment_on_node',
      title: 'Comment on a frame',
      description: 'Adds a comment pinned to a frame or another node.',
      input: {
        type: 'object',
        properties: {
          file_key: fileKey,
          node_id: { type: 'string', minLength: 1, description: 'e.g. "12:34"' },
          message: { type: 'string', minLength: 1 },
        },
        required: ['file_key', 'node_id', 'message'],
      },
      hints: { readOnly: false, destructive: false },
      risk: 'write',
      request: {
        method: 'POST',
        path: '/files/{file_key}/comments',
        body: {
          message: '{{input.message}}',
          client_meta: { node_id: '{{input.node_id}}', node_offset: { x: 0, y: 0 } },
        },
      },
      response: { fields: ['id', 'message', 'created_at'] },
    },
  ],
});

const ui: ConnectorUi = {
  locales: {
    ru: {
      description: 'Файлы Figma: проекты команды, страницы и фреймы, экспорт картинок, комментарии.',
      setup: {
        form: {
          summary: 'Личный токен Figma. Меньше минуты.',
          steps: [
            {
              text: 'В Figma нажмите на своё имя слева вверху → Settings → вкладка Security.',
              link: { label: 'Открыть Figma', url: 'https://www.figma.com/settings' },
            },
            {
              text: 'В разделе Personal access tokens нажмите Generate new token, дайте права на чтение файлов (File content: Read) и комментарии (Comments: Read and write).',
            },
            { text: 'Скопируйте токен (он начинается с figd_) и вставьте его в форму.' },
          ],
          tips: [
            'Токен видит те же файлы, что и вы, и действует от вашего имени.',
            'У токенов Figma есть срок действия: когда он истечёт, создайте новый.',
          ],
        },
      },
      prompts: [
        'Какие страницы и фреймы в файле по этой ссылке на Figma?',
        'Выгрузи главный экран из макета в PNG.',
        'Какие нерешённые комментарии в макете лендинга?',
        'Оставь комментарий на фрейме «Оплата»: «Кнопка должна быть оранжевой».',
      ],
      fields: { token: { label: 'Личный токен', hint: 'Settings → Security → Personal access tokens.' } },
      actions: {
        list_projects: { title: 'Проекты команды', description: 'Проекты по id команды.' },
        list_files: { title: 'Файлы проекта', description: 'Файлы с ключами и датой изменения.' },
        get_file: { title: 'Файл', description: 'Страницы и фреймы файла.' },
        get_nodes: { title: 'Элементы', description: 'Выбранные фреймы и компоненты с текстом и стилями.' },
        export_images: { title: 'Экспорт картинок', description: 'PNG, JPG, SVG или PDF по ссылкам.' },
        list_comments: { title: 'Комментарии', description: 'Комментарии файла и их статус.' },
        add_comment: { title: 'Новый комментарий', description: 'Комментарий к файлу или ответ на другой.' },
        comment_on_node: {
          title: 'Комментарий на фрейме',
          description: 'Комментарий, прикреплённый к фрейму.',
        },
      },
    },
    en: {
      setup: {
        form: {
          summary: 'Your Figma personal access token. Takes under a minute.',
          steps: [
            {
              text: 'In Figma, click your name at the top left → Settings → the Security tab.',
              link: { label: 'Open Figma', url: 'https://www.figma.com/settings' },
            },
            {
              text: 'Under Personal access tokens, click Generate new token and allow File content: Read and Comments: Read and write.',
            },
            { text: 'Copy the token (it starts with figd_) and paste it into the form.' },
          ],
          tips: [
            'The token sees the same files as you and acts as you.',
            'Figma tokens expire: make a new one when it does.',
          ],
        },
      },
      prompts: [
        'Which pages and frames are in the Figma file at this link?',
        'Export the home screen from the mockup as PNG.',
        'Which comments in the landing page design are still unresolved?',
        'Comment on the “Checkout” frame: “The button should be orange.”',
      ],
      fields: {
        token: { label: 'Personal access token', hint: 'Settings → Security → Personal access tokens.' },
      },
      actions: {
        list_projects: { title: 'Team projects', description: 'Projects of a team by its id.' },
        list_files: { title: 'Project files', description: 'Files with their keys and last change.' },
        get_file: { title: 'Get a file', description: 'Pages and frames of a file.' },
        get_nodes: { title: 'Get nodes', description: 'Chosen frames and components with text and styles.' },
        export_images: { title: 'Export images', description: 'PNG, JPG, SVG or PDF download links.' },
        list_comments: { title: 'Comments', description: 'Comments of a file and their status.' },
        add_comment: { title: 'Add a comment', description: 'A comment on a file or a reply to another.' },
        comment_on_node: { title: 'Comment on a frame', description: 'A comment pinned to a frame.' },
      },
    },
  },
};

export default withUi(manifest, ui);
