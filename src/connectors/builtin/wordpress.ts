import { defineManifestConnector } from '../manifest/compile.js';
import { type ConnectorUi, withUi } from '../sdk.js';

/**
 * WordPress REST API (`/wp-json/wp/v2`) with an application password, for self-hosted sites and
 * hosted ones that allow application passwords.
 */

const postId = { type: 'integer', minimum: 1 };
const POST_FIELDS = [
  'id',
  'date',
  'modified',
  'status',
  'slug',
  'link',
  'title.rendered',
  'excerpt.rendered',
  'categories',
  'tags',
  'author',
];
const postBody = {
  title: '{{input.title}}',
  content: '{{input.content}}',
  excerpt: '{{input.excerpt}}',
  slug: '{{input.slug}}',
  categories: '{{input.categories}}',
  tags: '{{input.tags}}',
};
const postFields = {
  title: { type: 'string', minLength: 1 },
  content: { type: 'string', description: 'HTML or block markup' },
  excerpt: { type: 'string' },
  slug: { type: 'string', pattern: '^[a-z0-9-]+$' },
  categories: {
    type: 'array',
    items: { type: 'integer' },
    description: 'Ids from wordpress_list_categories',
  },
  tags: { type: 'array', items: { type: 'integer' }, description: 'Tag ids' },
};
const perPage = { type: 'integer', minimum: 1, maximum: 100, default: 20 };

const manifest = defineManifestConnector({
  id: 'wordpress',
  name: 'WordPress',
  description: 'WordPress site: find, read, draft, edit and publish posts and pages, moderate comments.',
  version: '1.0.0',
  homepage: 'https://developer.wordpress.org/rest-api/',
  instructions:
    'New posts are drafts: wordpress_publish_post makes one public (or schedules it with a date). Content is HTML.',
  baseUrl: 'https://{{config.site}}/wp-json/wp/v2',
  config: {
    type: 'object',
    properties: {
      site: {
        type: 'string',
        pattern: '^[a-zA-Z0-9.-]+(:[0-9]+)?(/[\\w.~-]+)*$',
        description: 'Site address without https://, e.g. "blog.acme.com" or "acme.com/blog"',
      },
      username: { type: 'string', minLength: 1, description: 'Your WordPress user name' },
    },
    required: ['site', 'username'],
  },
  credentials: {
    type: 'object',
    properties: {
      appPassword: {
        type: 'string',
        pattern: '^[A-Za-z0-9 ]{24,}$',
        description: 'Application password: Users → Profile → Application Passwords',
      },
    },
    required: ['appPassword'],
  },
  auth: { type: 'basic', username: '{{config.username}}', password: '{{credentials.appPassword}}' },
  rateLimit: { requests: 60, perSeconds: 60 },
  errorMessagePaths: ['message'],
  pagination: { type: 'link' },
  test: {
    request: { method: 'GET', path: '/users/me', query: { context: 'edit' } },
    identity: '{{response.email}}',
  },
  actions: [
    {
      name: 'list_posts',
      title: 'List posts',
      description: 'Finds posts by words, status or category, newest first.',
      input: {
        type: 'object',
        properties: {
          search: { type: 'string' },
          status: {
            type: 'string',
            enum: ['publish', 'draft', 'pending', 'future', 'private', 'any'],
            default: 'any',
          },
          categories: { type: 'integer', description: 'Category id' },
          per_page: perPage,
        },
      },
      hints: { readOnly: true, idempotent: true },
      request: {
        method: 'GET',
        path: '/posts',
        query: { context: 'edit', ...queryOf(['search', 'status', 'categories', 'per_page']) },
      },
      response: { fields: POST_FIELDS },
      pagination: true,
    },
    {
      name: 'get_post',
      title: 'Get post',
      description: 'Returns a post with its full content.',
      input: { type: 'object', properties: { post_id: postId }, required: ['post_id'] },
      hints: { readOnly: true, idempotent: true },
      request: { method: 'GET', path: '/posts/{post_id}', query: { context: 'edit' } },
      response: { fields: [...POST_FIELDS, 'content.raw'] },
    },
    {
      name: 'create_post',
      title: 'Create draft',
      description: 'Creates a post as a draft (or pending review); nothing is published.',
      input: {
        type: 'object',
        properties: {
          ...postFields,
          status: { type: 'string', enum: ['draft', 'pending', 'private'], default: 'draft' },
        },
        required: ['title'],
      },
      hints: { readOnly: false, destructive: false },
      risk: 'write',
      request: { method: 'POST', path: '/posts', body: { ...postBody, status: '{{input.status}}' } },
      response: { fields: POST_FIELDS },
    },
    {
      name: 'update_post',
      title: 'Update post',
      description: 'Changes the title, content, excerpt, slug, categories or tags of a post.',
      input: { type: 'object', properties: { post_id: postId, ...postFields }, required: ['post_id'] },
      hints: { readOnly: false, destructive: false, idempotent: true },
      risk: 'write',
      // The post may already be published: see the `publishes` tag.
      tags: ['publishes'],
      request: { method: 'POST', path: '/posts/{post_id}', body: postBody },
      response: { fields: POST_FIELDS },
    },
    {
      name: 'publish_post',
      title: 'Publish post',
      description: 'Publishes a post now, or schedules it when date is in the future.',
      input: {
        type: 'object',
        properties: {
          post_id: postId,
          date: { type: 'string', description: 'Site-local date-time to schedule, e.g. 2026-11-20T09:00:00' },
        },
        required: ['post_id'],
      },
      hints: { readOnly: false, destructive: false, idempotent: true },
      risk: 'dangerous',
      request: {
        method: 'POST',
        path: '/posts/{post_id}',
        body: { status: 'publish', date: '{{input.date}}' },
      },
      response: { fields: POST_FIELDS },
    },
    {
      name: 'list_pages',
      title: 'List pages',
      description: 'Finds pages by words or status.',
      input: {
        type: 'object',
        properties: {
          search: { type: 'string' },
          status: { type: 'string', enum: ['publish', 'draft', 'pending', 'private', 'any'], default: 'any' },
          per_page: perPage,
        },
      },
      hints: { readOnly: true, idempotent: true },
      request: {
        method: 'GET',
        path: '/pages',
        query: { context: 'edit', ...queryOf(['search', 'status', 'per_page']) },
      },
      response: { fields: ['id', 'date', 'modified', 'status', 'slug', 'link', 'title.rendered', 'parent'] },
      pagination: true,
    },
    {
      name: 'list_categories',
      title: 'List categories',
      description: 'Categories with their ids and post counts.',
      input: { type: 'object', properties: { search: { type: 'string' }, per_page: perPage } },
      hints: { readOnly: true, idempotent: true },
      request: { method: 'GET', path: '/categories' },
      response: { fields: ['id', 'name', 'slug', 'count', 'parent'] },
      pagination: true,
    },
    {
      name: 'list_comments',
      title: 'List comments',
      description: 'Comments by status (pending ones wait for moderation), optionally of one post.',
      input: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['hold', 'approve', 'spam'], default: 'hold' },
          post: { type: 'integer', description: 'Post id' },
          per_page: perPage,
        },
      },
      hints: { readOnly: true, idempotent: true },
      request: {
        method: 'GET',
        path: '/comments',
        query: { context: 'edit', ...queryOf(['status', 'post', 'per_page']) },
      },
      response: {
        fields: ['id', 'post', 'author_name', 'author_email', 'date', 'status', 'content.raw', 'link'],
      },
      pagination: true,
    },
    {
      name: 'moderate_comment',
      title: 'Moderate comment',
      description: 'Approves a comment, sends it back to moderation, or marks it as spam.',
      input: {
        type: 'object',
        properties: {
          comment_id: { type: 'integer', minimum: 1 },
          status: { type: 'string', enum: ['approve', 'hold', 'spam'] },
        },
        required: ['comment_id', 'status'],
      },
      hints: { readOnly: false, destructive: false, idempotent: true },
      risk: 'write',
      request: { method: 'POST', path: '/comments/{comment_id}' },
      response: { fields: ['id', 'post', 'status'] },
    },
  ],
});

/** Query templates that pass the named inputs through (dropped when not set). */
function queryOf(names: string[]): Record<string, string> {
  return Object.fromEntries(names.map((n) => [n, `{{input.${n}}}`]));
}

const ui: ConnectorUi = {
  primaryFields: ['site', 'username', 'appPassword'],
  locales: {
    ru: {
      description:
        'Сайт на WordPress: поиск и чтение записей, черновики, правка и публикация, модерация комментариев.',
      setup: {
        form: {
          summary:
            'Вы создаёте пароль приложения в профиле WordPress и вставляете его сюда вместе с адресом сайта и именем пользователя.',
          minutes: 3,
          needs: [
            'Сайт на WordPress 5.6 или новее, который открывается по HTTPS',
            'Пользователь, который может писать записи (Author, Editor или Administrator)',
          ],
          steps: [
            {
              text: 'Войдите в админку сайта (вашсайт.com/wp-admin) и откройте **Users → Profile** (**Пользователи → Профиль**).',
              link: {
                label: 'Как работают пароли приложений',
                url: 'https://make.wordpress.org/core/2020/11/05/application-passwords-integration-guide/',
              },
            },
            {
              text: 'Внизу, в разделе **Application Passwords**, введите Manyplug и нажмите **Add New Application Password**.',
            },
            { text: 'Скопируйте пароль из 24 символов (пробелы можно оставить).', fills: ['appPassword'] },
            {
              text: 'В форме укажите адрес сайта без https:// (например, blog.acme.com) и имя пользователя, под которым вы входите.',
              fills: ['site', 'username'],
            },
          ],
          tips: [
            'ИИ создаёт только черновики. Публикация — отдельное действие, которое ждёт вашего подтверждения.',
            'Пароль приложения можно отозвать в том же разделе профиля; обычный пароль не меняется.',
          ],
          problems: [
            {
              problem: 'Нет раздела **Application Passwords**',
              fix: 'Нужен WordPress 5.6 или новее и HTTPS. Возможно, его выключил плагин безопасности: поищите в нём настройку паролей приложений или REST API.',
            },
            {
              problem: 'Проверка пишет, что имя пользователя или пароль неверные',
              fix: 'Укажите имя пользователя, а не почту или отображаемое имя, и пароль приложения, а не обычный пароль.',
            },
            {
              problem: 'Проверка падает с 401, хотя пароль верный',
              fix: 'Некоторые хостинги срезают заголовок входа до WordPress. Попросите хостинг передавать заголовок Authorization в WordPress.',
            },
          ],
        },
      },
      prompts: [
        'Какие черновики лежат у меня в WordPress?',
        'Напиши черновик поста о запуске новой функции по этим заметкам.',
        'Опубликуй пост «Итоги года» завтра в 9 утра.',
        'Какие комментарии ждут модерации? Спам отметь.',
      ],
      fields: {
        site: { label: 'Адрес сайта', hint: 'Без https://, например blog.acme.com или acme.com/blog.' },
        username: { label: 'Имя пользователя', hint: 'Логин в WordPress, не почта.' },
        appPassword: { label: 'Пароль приложения', hint: 'Пользователи → Профиль → Пароли приложений.' },
      },
      actions: {
        list_posts: { title: 'Записи', description: 'Поиск записей по словам, статусу, рубрике.' },
        get_post: { title: 'Запись', description: 'Запись с полным текстом.' },
        create_post: { title: 'Новый черновик', description: 'Создаёт запись-черновик, ничего не публикуя.' },
        update_post: { title: 'Правка записи', description: 'Меняет заголовок, текст, рубрики или метки.' },
        publish_post: { title: 'Публикация', description: 'Публикует запись сейчас или по расписанию.' },
        list_pages: { title: 'Страницы', description: 'Поиск страниц сайта.' },
        list_categories: { title: 'Рубрики', description: 'Рубрики с id и числом записей.' },
        list_comments: {
          title: 'Комментарии',
          description: 'Комментарии на модерации, одобренные или спам.',
        },
        moderate_comment: { title: 'Модерация', description: 'Одобряет комментарий или отмечает спамом.' },
      },
    },
    en: {
      setup: {
        form: {
          summary:
            'You create an application password in your WordPress profile and paste it here with the site address and your user name.',
          minutes: 3,
          needs: [
            'A WordPress site, version 5.6 or newer, that opens over HTTPS',
            'A user that can write posts (Author, Editor or Administrator)',
          ],
          steps: [
            {
              text: 'Sign in to your site’s admin (yoursite.com/wp-admin) and open **Users → Profile**.',
              link: {
                label: 'How application passwords work',
                url: 'https://make.wordpress.org/core/2020/11/05/application-passwords-integration-guide/',
              },
            },
            {
              text: 'At the bottom, under **Application Passwords**, type Manyplug and click **Add New Application Password**.',
            },
            { text: 'Copy the 24-character password (the spaces can stay).', fills: ['appPassword'] },
            {
              text: 'In the form, enter the site address without https:// (for example blog.acme.com) and the user name you sign in with.',
              fills: ['site', 'username'],
            },
          ],
          tips: [
            'The AI only creates drafts. Publishing is a separate action that needs your confirmation.',
            'You can revoke the application password in the same profile section; your normal password stays.',
          ],
          problems: [
            {
              problem: 'There is no **Application Passwords** section',
              fix: 'The site needs WordPress 5.6 or newer and HTTPS. A security plugin may have turned the feature off: look for an application passwords or REST API setting in that plugin.',
            },
            {
              problem: 'The check says the user name or password is incorrect',
              fix: 'Enter the user name, not the email or display name, and the application password, not your normal password.',
            },
            {
              problem: 'The check fails with 401 although the password is right',
              fix: 'Some hosts drop the login header before it reaches WordPress. Ask your host to pass the Authorization header through to WordPress.',
            },
          ],
        },
      },
      prompts: [
        'Which drafts do I have in WordPress?',
        'Write a draft post about the new feature launch from these notes.',
        'Publish the “Year in review” post tomorrow at 9 am.',
        'Which comments are waiting for moderation? Mark the spam.',
      ],
      fields: {
        site: { label: 'Site address', hint: 'Without https://, e.g. blog.acme.com or acme.com/blog.' },
        username: { label: 'User name', hint: 'Your WordPress login, not the email.' },
        appPassword: { label: 'Application password', hint: 'Users → Profile → Application Passwords.' },
      },
      actions: {
        list_posts: { title: 'Posts', description: 'Finds posts by words, status or category.' },
        get_post: { title: 'Get a post', description: 'A post with its full content.' },
        create_post: { title: 'New draft', description: 'Creates a draft post without publishing.' },
        update_post: { title: 'Edit a post', description: 'Changes the title, content, categories or tags.' },
        publish_post: { title: 'Publish', description: 'Publishes a post now or on a schedule.' },
        list_pages: { title: 'Pages', description: 'Finds pages of the site.' },
        list_categories: { title: 'Categories', description: 'Categories with ids and post counts.' },
        list_comments: { title: 'Comments', description: 'Comments awaiting moderation, approved or spam.' },
        moderate_comment: { title: 'Moderate', description: 'Approves a comment or marks it as spam.' },
      },
    },
  },
};

export default withUi(manifest, ui);
