import { z } from 'zod';
import { HttpClient } from '../http/client.js';
import {
  type AccountContext,
  type CapabilityOutput,
  ConnectorError,
  compact,
  defineConnector,
  type ErrorKind,
  page,
  truncateText,
} from '../sdk.js';

/**
 * Linear GraphQL API with a personal API key. GraphQL reports most failures as `errors` in an HTTP
 * 200 answer, and team and status names have to be resolved to ids, so this is a code connector on
 * top of the shared HTTP client rather than a manifest.
 */

const Credentials = z.object({
  apiKey: z
    .string()
    .trim()
    .regex(/^lin_api_/, 'a Linear personal API key starts with lin_api_')
    .describe('Personal API key: Linear → Settings → Security & access → Personal API keys'),
});

type Ctx = AccountContext<Record<string, never>, z.output<typeof Credentials>>;

interface GraphQLError {
  message: string;
  extensions?: { type?: string; code?: string; userPresentableMessage?: string };
}

const ERROR_KINDS: Record<string, ErrorKind> = {
  'authentication error': 'auth',
  forbidden: 'permission',
  ratelimited: 'rate_limited',
  'invalid input': 'invalid_input',
  'entity not found': 'not_found',
};

/** Runs a GraphQL operation; `errors` in the answer become a `ConnectorError` of the right kind. */
export async function linearQuery<T>(ctx: Ctx, query: string, variables: Record<string, unknown> = {}) {
  const client = new HttpClient(ctx, {
    baseUrl: 'https://api.linear.app',
    // Personal API keys go without the "Bearer" prefix.
    headers: { authorization: ctx.credentials.apiKey },
    errorMessagePaths: ['errors.0.extensions.userPresentableMessage', 'errors.0.message'],
  });
  const response = await client.request<{ data?: T; errors?: GraphQLError[] }>({
    method: 'POST',
    url: '/graphql',
    json: { query, variables },
  });
  const error = response.data?.errors?.[0];
  if (error || !response.data?.data) {
    const type = (error?.extensions?.type ?? error?.extensions?.code ?? '').toLowerCase();
    const kind =
      ERROR_KINDS[type] ?? (/not found/i.test(error?.message ?? '') ? 'not_found' : 'invalid_input');
    const message = error?.extensions?.userPresentableMessage ?? error?.message ?? 'empty answer';
    throw new ConnectorError(
      kind,
      `Linear: ${message}`,
      kind === 'rate_limited' ? { retryAfterSeconds: 60 } : {},
    );
  }
  return response.data.data;
}

interface IssueNode {
  identifier: string;
  title: string;
  priority?: number;
  dueDate?: string | null;
  url: string;
  updatedAt?: string;
  state?: { name: string; type: string };
  assignee?: { name: string } | null;
  team?: { key: string };
}

const ISSUE_NODE =
  'identifier title priority dueDate url updatedAt state { name type } assignee { name } team { key }';
const CLOSED_STATES = ['completed', 'canceled'];

/** Compact form of an issue for the AI. */
const issueItem = (i: IssueNode) =>
  compact({
    id: i.identifier,
    title: i.title,
    state: i.state?.name,
    state_type: i.state?.type,
    priority: i.priority || undefined,
    due: i.dueDate ?? undefined,
    assignee: i.assignee?.name,
    team: i.team?.key,
    updated: i.updatedAt,
    url: i.url,
  });

// Linear priorities: 1 urgent … 4 low, 0 none. The shared scale is 1 (normal) … 4 (urgent).
const toLinearPriority = (p: number) => 5 - p;
const fromLinearPriority = (p: unknown) => (typeof p === 'number' && p >= 1 && p <= 4 ? 5 - p : undefined);

interface Team {
  id: string;
  key: string;
  name: string;
}

async function resolveTeam(ctx: Ctx, key: string | undefined): Promise<Team> {
  const { teams } = await linearQuery<{ teams: { nodes: Team[] } }>(
    ctx,
    'query Teams($filter: TeamFilter) { teams(first: 100, filter: $filter) { nodes { id key name } } }',
    key ? { filter: { key: { eqIgnoreCase: key } } } : {},
  );
  if (key) {
    const team = teams.nodes[0];
    if (!team)
      throw new ConnectorError('not_found', `No Linear team with key "${key}". Use linear_list_teams.`);
    return team;
  }
  if (teams.nodes.length === 1) return teams.nodes[0]!;
  throw new ConnectorError(
    'invalid_input',
    `Pass team: this workspace has several teams (${teams.nodes.map((t) => t.key).join(', ')}).`,
  );
}

async function resolveState(ctx: Ctx, teamId: string, name: string): Promise<string> {
  const { team } = await linearQuery<{ team: { states: { nodes: { id: string; name: string }[] } } }>(
    ctx,
    'query States($id: String!) { team(id: $id) { states { nodes { id name } } } }',
    { id: teamId },
  );
  const wanted = name.trim().toLowerCase();
  const state = team.states.nodes.find((s) => s.name.toLowerCase() === wanted);
  if (state) return state.id;
  throw new ConnectorError(
    'invalid_input',
    `No status "${name}" in this team. Statuses: ${team.states.nodes.map((s) => s.name).join(', ')}.`,
  );
}

async function viewerId(ctx: Ctx): Promise<string> {
  const { viewer } = await linearQuery<{ viewer: { id: string } }>(ctx, 'query { viewer { id } }');
  return viewer.id;
}

const IssueId = z.string().trim().min(1).max(60).describe('Issue identifier, e.g. "ENG-42"');
const Priority = z.number().int().min(0).max(4).describe('0 none, 1 urgent, 2 high, 3 medium, 4 low');
const DueDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe('YYYY-MM-DD');

type TaskItem = CapabilityOutput<'tasks.list'>;

export default defineConnector({
  id: 'linear',
  name: 'Linear',
  description: 'Linear issues and teams: find, read, create, update, comment on issues.',
  version: '1.0.0',
  homepage: 'https://linear.app/developers',
  instructions:
    'Issues are addressed by identifier ("ENG-42"). Status is set by its name in the team (e.g. "In Progress", "Done").',
  credentials: Credentials,
  rateLimit: { requests: 120, perSeconds: 60 },
  async test(ctx) {
    const { viewer } = await linearQuery<{ viewer: { email?: string; name?: string } }>(
      ctx,
      'query { viewer { name email } }',
    );
    return { ok: true, identity: viewer.email ?? viewer.name ?? 'Linear' };
  },
  ui: {
    locales: {
      ru: {
        description: 'Задачи и команды Linear: поиск, чтение, создание, изменение и комментарии.',
        setup: {
          form: {
            summary: 'Личный ключ API Linear. Около минуты.',
            steps: [
              {
                text: 'Откройте Linear → Settings → Security & access и в разделе Personal API keys нажмите New API key.',
                link: {
                  label: 'Открыть настройки Linear',
                  url: 'https://linear.app/settings/account/security',
                },
              },
              {
                text: 'Назовите ключ Manyplug и оставьте полный доступ (Full access) или выберите нужные команды.',
              },
              { text: 'Скопируйте ключ (lin_api_…) и вставьте его в форму.' },
            ],
            tips: [
              'Ключ действует от вашего имени. Отозвать его можно на той же странице.',
              'Несколько рабочих пространств Linear? Подключите ключ от каждого отдельным аккаунтом.',
            ],
          },
        },
        prompts: [
          'Что на мне в Linear на этой неделе?',
          'Заведи в ENG задачу «Ускорить экспорт» с высоким приоритетом.',
          'Переведи ENG-42 в In Progress и напиши в комментарии, что я начал.',
          'Какие срочные задачи в команде DES ещё не закрыты?',
        ],
        fields: {
          apiKey: { label: 'Ключ API', hint: 'Linear → Settings → Security & access → Personal API keys.' },
        },
        actions: {
          search_issues: {
            title: 'Поиск задач',
            description: 'Находит задачи по словам, команде, исполнителю и статусу.',
          },
          get_issue: { title: 'Задача', description: 'Показывает задачу с описанием и комментариями.' },
          list_teams: { title: 'Список команд', description: 'Команды с ключами и статусами.' },
          create_issue: { title: 'Новая задача', description: 'Создаёт задачу в команде.' },
          update_issue: {
            title: 'Изменение задачи',
            description: 'Меняет название, описание, статус, приоритет, срок или исполнителя.',
          },
          add_comment: { title: 'Новый комментарий', description: 'Добавляет комментарий к задаче.' },
          delete_issue: { title: 'Удаление задачи', description: 'Переносит задачу в корзину Linear.' },
        },
      },
      en: {
        setup: {
          form: {
            summary: 'A Linear personal API key. Takes about a minute.',
            steps: [
              {
                text: 'Open Linear → Settings → Security & access and click New API key under Personal API keys.',
                link: { label: 'Open Linear settings', url: 'https://linear.app/settings/account/security' },
              },
              { text: 'Name it Manyplug and keep Full access, or pick the teams it may use.' },
              { text: 'Copy the key (lin_api_…) and paste it into the form.' },
            ],
            tips: [
              'The key acts as you. You can revoke it on the same page.',
              'Several Linear workspaces? Connect a key from each as its own account.',
            ],
          },
        },
        prompts: [
          'What is on my plate in Linear this week?',
          'Create a high-priority issue in ENG: “Speed up export”.',
          'Move ENG-42 to In Progress and comment that I have started.',
          'Which urgent issues in the DES team are still open?',
        ],
        fields: {
          apiKey: { label: 'API key', hint: 'Linear → Settings → Security & access → Personal API keys.' },
        },
        actions: {
          search_issues: {
            title: 'Search issues',
            description: 'Finds issues by words, team, assignee and status.',
          },
          get_issue: {
            title: 'Get an issue',
            description: 'Shows an issue with its description and comments.',
          },
          list_teams: { title: 'List teams', description: 'Teams with their keys and statuses.' },
          create_issue: { title: 'Create an issue', description: 'Creates an issue in a team.' },
          update_issue: {
            title: 'Update an issue',
            description: 'Changes the title, description, status, priority, due date or assignee.',
          },
          add_comment: { title: 'Add a comment', description: 'Adds a comment to an issue.' },
          delete_issue: { title: 'Delete an issue', description: 'Moves an issue to the Linear trash.' },
        },
      },
    },
  },
  actions: (action) => [
    action({
      name: 'search_issues',
      title: 'Search issues',
      description: 'Finds issues, most recently updated first.',
      input: z.object({
        query: z.string().trim().max(200).optional().describe('Words in the title or description'),
        team: z.string().trim().max(20).optional().describe('Team key, e.g. "ENG"'),
        assignee: z.enum(['me', 'anyone']).default('me'),
        state: z.enum(['open', 'done', 'all']).default('open'),
        due_before: DueDate.optional(),
        limit: z.number().int().min(1).max(100).default(25),
        cursor: z.string().max(500).optional().describe('nextCursor from the previous result'),
      }),
      hints: { readOnly: true, idempotent: true },
      capability: {
        id: 'tasks.list',
        mapInput: ({ query, status, due_before, limit }) => ({
          ...(typeof query === 'string' && query ? { query } : {}),
          state: status,
          ...(typeof due_before === 'string' ? { due_before: due_before.slice(0, 10) } : {}),
          limit,
        }),
        mapOutput: (result) => {
          const { items, nextCursor } = result as {
            items: ReturnType<typeof issueItem>[];
            nextCursor?: string;
          };
          return {
            items: items.map((i): TaskItem => {
              const priority = fromLinearPriority(i.priority);
              return {
                id: String(i.id),
                title: String(i.title),
                status: CLOSED_STATES.includes(String(i.state_type)) ? 'done' : 'open',
                ...(i.due ? { due: String(i.due) } : {}),
                ...(priority ? { priority } : {}),
                ...(i.team ? { project: String(i.team) } : {}),
                url: String(i.url),
              };
            }),
            ...(nextCursor ? { nextCursor } : {}),
          };
        },
      },
      run: async ({ query, team, assignee, state, due_before, limit, cursor }, ctx) => {
        const and: Record<string, unknown>[] = [];
        if (query) {
          and.push({
            or: [{ title: { containsIgnoreCase: query } }, { description: { containsIgnoreCase: query } }],
          });
        }
        if (team) and.push({ team: { key: { eqIgnoreCase: team } } });
        if (assignee === 'me') and.push({ assignee: { isMe: { eq: true } } });
        if (state === 'open') and.push({ state: { type: { nin: CLOSED_STATES } } });
        if (state === 'done') and.push({ state: { type: { in: CLOSED_STATES } } });
        if (due_before) and.push({ dueDate: { lte: due_before } });
        const { issues } = await linearQuery<{
          issues: { nodes: IssueNode[]; pageInfo: { hasNextPage: boolean; endCursor?: string } };
        }>(
          ctx,
          `query Issues($filter: IssueFilter, $first: Int, $after: String) {
            issues(filter: $filter, first: $first, after: $after, orderBy: updatedAt) {
              nodes { ${ISSUE_NODE} } pageInfo { hasNextPage endCursor } } }`,
          { filter: { and }, first: limit, ...(cursor ? { after: cursor } : {}) },
        );
        return page(issues.nodes.map(issueItem), {
          nextCursor: issues.pageInfo.hasNextPage ? issues.pageInfo.endCursor : undefined,
        });
      },
    }),
    action({
      name: 'get_issue',
      title: 'Get issue',
      description: 'Returns an issue with its description and latest comments.',
      input: z.object({ id: IssueId }),
      hints: { readOnly: true, idempotent: true },
      run: async ({ id }, ctx) => {
        const { issue } = await linearQuery<{
          issue: IssueNode & {
            description?: string | null;
            createdAt?: string;
            creator?: { name: string } | null;
            project?: { name: string } | null;
            labels?: { nodes: { name: string }[] };
            comments?: { nodes: { body: string; createdAt: string; user?: { name: string } | null }[] };
          };
        }>(
          ctx,
          `query Issue($id: String!) { issue(id: $id) { ${ISSUE_NODE} description createdAt creator { name }
            project { name } labels { nodes { name } } comments(first: 20) { nodes { body createdAt user { name } } } } }`,
          { id },
        );
        return compact({
          ...issueItem(issue),
          description: issue.description ? truncateText(issue.description, 6000) : undefined,
          created: issue.createdAt,
          creator: issue.creator?.name,
          project: issue.project?.name,
          labels: issue.labels?.nodes.map((l) => l.name),
          comments: issue.comments?.nodes.map((c) => ({
            from: c.user?.name ?? 'unknown',
            date: c.createdAt,
            text: truncateText(c.body, 1500),
          })),
        });
      },
    }),
    action({
      name: 'list_teams',
      title: 'List teams',
      description: 'Lists teams with their keys and statuses.',
      input: z.object({}),
      hints: { readOnly: true, idempotent: true },
      run: async (_input, ctx) => {
        const { teams } = await linearQuery<{
          teams: { nodes: (Team & { states: { nodes: { name: string; position: number }[] } })[] };
        }>(ctx, 'query { teams(first: 100) { nodes { id key name states { nodes { name position } } } } }');
        return teams.nodes.map((t) => ({
          key: t.key,
          name: t.name,
          statuses: [...t.states.nodes].sort((a, b) => a.position - b.position).map((s) => s.name),
        }));
      },
    }),
    action({
      name: 'create_issue',
      title: 'Create issue',
      description: 'Creates an issue. Without team, uses the only team of the workspace.',
      input: z.object({
        title: z.string().trim().min(1).max(255),
        team: z.string().trim().max(20).optional().describe('Team key, e.g. "ENG"'),
        description: z.string().max(50_000).optional().describe('Markdown'),
        status: z.string().max(60).optional().describe('Status name; default is the team default'),
        priority: Priority.optional(),
        due_date: DueDate.optional(),
        assign_to_me: z.boolean().default(false),
      }),
      hints: { readOnly: false, destructive: false },
      risk: 'write',
      undo: { kind: 'action', action: 'delete_issue' },
      capability: {
        id: 'tasks.create',
        mapInput: ({ title, description, due, project, priority }) => ({
          title,
          ...(description ? { description } : {}),
          ...(typeof project === 'string' && project ? { team: project } : {}),
          ...(typeof due === 'string' ? { due_date: due.slice(0, 10) } : {}),
          ...(typeof priority === 'number' ? { priority: toLinearPriority(priority) } : {}),
        }),
        mapOutput: (result) => {
          const { id, url } = result as { id: string; url: string };
          return { id, url };
        },
      },
      run: async ({ title, team, description, status, priority, due_date, assign_to_me }, ctx) => {
        const { id: teamId } = await resolveTeam(ctx, team);
        const input = compact({
          teamId,
          title,
          description,
          priority,
          dueDate: due_date,
          stateId: status ? await resolveState(ctx, teamId, status) : undefined,
          assigneeId: assign_to_me ? await viewerId(ctx) : undefined,
        });
        const { issueCreate } = await linearQuery<{ issueCreate: { issue: IssueNode } }>(
          ctx,
          `mutation Create($input: IssueCreateInput!) { issueCreate(input: $input) { issue { ${ISSUE_NODE} } } }`,
          { input },
        );
        return issueItem(issueCreate.issue);
      },
    }),
    action({
      name: 'update_issue',
      title: 'Update issue',
      description: 'Changes title, description, status, priority, due date or assignee of an issue.',
      input: z.object({
        id: IssueId,
        title: z.string().trim().min(1).max(255).optional(),
        description: z.string().max(50_000).optional().describe('Markdown; replaces the description'),
        status: z.string().max(60).optional().describe('Status name, e.g. "In Progress", "Done"'),
        priority: Priority.optional(),
        due_date: DueDate.nullable().optional().describe('YYYY-MM-DD, or null to clear'),
        assignee: z.enum(['me', 'nobody']).optional(),
      }),
      hints: { readOnly: false, destructive: false, idempotent: true },
      risk: 'write',
      run: async ({ id, title, description, status, priority, due_date, assignee }, ctx) => {
        let stateId: string | undefined;
        if (status) {
          const { issue } = await linearQuery<{ issue: { team: { id: string } } }>(
            ctx,
            'query IssueTeam($id: String!) { issue(id: $id) { team { id } } }',
            { id },
          );
          stateId = await resolveState(ctx, issue.team.id, status);
        }
        const input: Record<string, unknown> = compact({ title, description, priority, stateId });
        if (due_date !== undefined) input.dueDate = due_date;
        if (assignee) input.assigneeId = assignee === 'me' ? await viewerId(ctx) : null;
        const { issueUpdate } = await linearQuery<{ issueUpdate: { issue: IssueNode } }>(
          ctx,
          `mutation Update($id: String!, $input: IssueUpdateInput!) {
            issueUpdate(id: $id, input: $input) { issue { ${ISSUE_NODE} } } }`,
          { id, input },
        );
        return issueItem(issueUpdate.issue);
      },
    }),
    action({
      name: 'add_comment',
      title: 'Add comment',
      description: 'Adds a comment to an issue.',
      input: z.object({ id: IssueId, body: z.string().trim().min(1).max(50_000).describe('Markdown') }),
      hints: { readOnly: false, destructive: false },
      risk: 'write',
      run: async ({ id, body }, ctx) => {
        const { commentCreate } = await linearQuery<{
          commentCreate: { comment: { id: string; url: string } };
        }>(
          ctx,
          'mutation Comment($input: CommentCreateInput!) { commentCreate(input: $input) { comment { id url } } }',
          { input: { issueId: id, body } },
        );
        return commentCreate.comment;
      },
    }),
    action({
      name: 'delete_issue',
      title: 'Delete issue',
      description: 'Moves an issue to the trash (restorable in Linear for 30 days).',
      input: z.object({ id: IssueId }),
      hints: { readOnly: false, destructive: true, idempotent: true },
      risk: 'dangerous',
      run: async ({ id }, ctx) => {
        await linearQuery<{ issueDelete: { success: boolean } }>(
          ctx,
          'mutation Delete($id: String!) { issueDelete(id: $id) { success } }',
          { id },
        );
        return { deleted: id };
      },
    }),
  ],
});
