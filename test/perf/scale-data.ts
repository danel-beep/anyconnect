import type pg from 'pg';

/**
 * Synthetic data shaped like a busy hub, written straight in SQL (`generate_series`), so even the
 * full 1000-user profile loads in about two minutes. Used by the query-plan test (`test/perf/`) at a
 * small scale and by `npm run db:scale` at full scale (docs/TESTING.md, "Нагрузка на базу").
 *
 * The rows are not meant to be read by the app (encrypted columns hold placeholders); they give the
 * planner real table sizes and value spreads: many workspaces, a few busy ones, old and new rows.
 * They are also quiet for the background jobs, which can run over them: every account checked
 * just now with tokens valid for weeks, every event, outgoing message and held-back call finished.
 * A new table that grows with use belongs here too, so its queries are checked at a realistic size.
 */
export interface ScaleProfile {
  users: number;
  /** Accounts per user (spread over a few connectors). */
  accountsPerUser: number;
  /** Days of history the time-stamped tables cover. */
  days: number;
  /** Activity-log rows (`tool_calls`) per user over `days`. */
  toolCallsPerUser: number;
  /** Share of users with a messenger account. */
  messengerShare: number;
  chatsPerMessenger: number;
  messagesPerMessenger: number;
  triggersPerUser: number;
  triggerEventsPerTrigger: number;
  pendingCallsPerUser: number;
  grantsPerUser: number;
  tokensPerGrant: number;
}

/** What 1000 active users look like after three months (the target in the roadmap). */
export const SCALE_1000: ScaleProfile = {
  users: 1000,
  accountsPerUser: 6,
  days: 90,
  toolCallsPerUser: 3000,
  messengerShare: 0.3,
  chatsPerMessenger: 200,
  messagesPerMessenger: 5000,
  triggersPerUser: 2,
  triggerEventsPerTrigger: 200,
  pendingCallsPerUser: 30,
  grantsPerUser: 3,
  tokensPerGrant: 10,
};

/** Small enough for a test (a few seconds), big enough that the planner prefers an index. */
export const SCALE_TEST: ScaleProfile = {
  users: 300,
  accountsPerUser: 6,
  days: 90,
  toolCallsPerUser: 300,
  messengerShare: 0.3,
  chatsPerMessenger: 60,
  messagesPerMessenger: 600,
  triggersPerUser: 2,
  triggerEventsPerTrigger: 60,
  pendingCallsPerUser: 20,
  grantsPerUser: 2,
  tokensPerGrant: 5,
};

/** Connectors the synthetic accounts use, by account slot (slot 1 is the messenger). */
const CONNECTORS = ['telegram', 'gmail', 'gcal', 'slack', 'notion', 'github', 'demo', 'jira'];

/** Fills an empty, migrated database. Ids are predictable: `u00001`, `w00001`, `a00001_1`… */
export async function seedScale(pool: pg.Pool, profile: ScaleProfile): Promise<void> {
  const p = profile;
  const messengers = Math.max(1, Math.round(p.users * p.messengerShare));
  const span = `${p.days} days`;
  // Trigger events are kept 30 days (`triggers.prune`).
  const eventDays = Math.min(p.days, 29);
  // `n` = user number, `k` = account slot; user n owns workspace w<n> and accounts a<n>_<k>.
  const steps: string[] = [
    `insert into users (id, email, name, created_at, last_login_at)
       select 'u' || lpad(n::text, 5, '0'), 'user' || n || '@example.com', 'User ' || n,
              now() - (random() * interval '${span}'), now() - (random() * interval '7 days')
       from generate_series(1, ${p.users}) n`,
    `insert into workspaces (id, name, slug, billing_user_id, created_at)
       select 'w' || lpad(n::text, 5, '0'), 'Workspace ' || n, 'ws-' || n, 'u' || lpad(n::text, 5, '0'),
              now() - interval '${span}'
       from generate_series(1, ${p.users}) n`,
    `insert into workspace_members (workspace_id, user_id, role)
       select 'w' || lpad(n::text, 5, '0'), 'u' || lpad(n::text, 5, '0'), 'owner'
       from generate_series(1, ${p.users}) n`,
    `insert into subscriptions (workspace_id, plan_id, status)
       select 'w' || lpad(n::text, 5, '0'), case when n % 5 = 0 then 'pro' else 'free' end, 'active'
       from generate_series(1, ${p.users}) n`,
    `insert into accounts (id, workspace_id, owner_user_id, connector_id, name, label, status, enabled,
                           last_used_at, checked_at, created_at)
       select 'a' || lpad(n::text, 5, '0') || '_' || k, 'w' || lpad(n::text, 5, '0'), 'u' || lpad(n::text, 5, '0'),
              (array[${CONNECTORS.map((c) => `'${c}'`).join(',')}])[1 + (k - 1) % ${CONNECTORS.length}],
              'acc' || k, 'Account ' || k,
              'ok', (n + k) % 25 <> 0,
              now() - (random() * interval '30 days'), now(),
              now() - (random() * interval '${span}')
       from generate_series(1, ${p.users}) n, generate_series(1, ${p.accountsPerUser}) k`,
    `insert into account_oauth (account_id, provider_id, app_ref, tokens_encrypted, expires_at)
       select id, connector_id, 'builtin', 'x', now() + interval '20 days' + (random() * interval '10 days')
       from accounts where connector_id in ('gmail', 'gcal', 'slack', 'github')`,
    `insert into ai_clients (id, workspace_id, name, kind, match_key, last_used_at)
       select 'c' || lpad(n::text, 5, '0') || '_' || k, 'w' || lpad(n::text, 5, '0'),
              (array['Claude','ChatGPT','Claude Code'])[k], 'oauth', 'client-' || k, now() - (random() * interval '7 days')
       from generate_series(1, ${p.users}) n, generate_series(1, 3) k`,
    `insert into oauth_clients (id, registration_type, metadata)
       select 'oc' || k, 'dynamic', '{}'::jsonb from generate_series(1, 20) k`,
    `insert into oauth_grants (id, client_id, user_id, workspace_id, resource, ai_client_id, last_used_at,
                               revoked_at, created_at)
       select 'g' || lpad(n::text, 5, '0') || '_' || k, 'oc' || (1 + (n + k) % 20), 'u' || lpad(n::text, 5, '0'),
              'w' || lpad(n::text, 5, '0'), 'https://hub.example/mcp', 'c' || lpad(n::text, 5, '0') || '_' || (1 + (k - 1) % 3),
              now() - (random() * interval '7 days'), case when k > 2 then now() end, now() - interval '${span}'
       from generate_series(1, ${p.users}) n, generate_series(1, ${p.grantsPerUser}) k`,
    `insert into oauth_tokens (token_hash, grant_id, type, created_at, expires_at)
       select md5(g.id || t), g.id, case when t = 1 then 'refresh' else 'access' end,
              now() - (random() * interval '30 days'), now() + (random() * interval '30 days') - interval '15 days'
       from oauth_grants g, generate_series(1, ${p.tokensPerGrant}) t`,
    `insert into web_sessions (token_hash, user_id, expires_at, last_seen_at)
       select md5('s' || n || k), 'u' || lpad(n::text, 5, '0'), now() + interval '20 days', now() - (random() * interval '3 days')
       from generate_series(1, ${p.users}) n, generate_series(1, 3) k`,
    // The activity log: most calls hit three accounts, a few users are far busier than the rest.
    `insert into tool_calls (workspace_id, account_id, connector_id, action, tool_name, principal_type,
                             principal_id, client_id, status, duration_ms, created_at, outcome, risk)
       select 'w' || lpad(u::text, 5, '0'), 'a' || lpad(u::text, 5, '0') || '_' || k,
              (array[${CONNECTORS.map((c) => `'${c}'`).join(',')}])[1 + (k - 1) % ${CONNECTORS.length}], 'search',
              'gmail_search', 'oauth', 'g' || lpad(u::text, 5, '0') || '_1', 'oc1',
              case when i % 20 = 0 then 'error' else 'ok' end, 50 + (i % 900),
              now() - (random() * interval '${span}'), 'done', 'read'
       from generate_series(1, ${p.users * p.toolCallsPerUser}) i,
            lateral (select 1 + floor(power(random(), 2) * ${p.users})::int as u,
                            1 + (i % least(3, ${p.accountsPerUser})) as k) pick`,
    `insert into usage_counters (workspace_id, day, caller, connector_id, action, calls, errors)
       select 'w' || lpad(n::text, 5, '0'), (current_date - d), 'oauth:c' || (1 + (n + d) % 3), c, 'search',
              1 + (n * d) % 60, (n * d) % 3
       from generate_series(1, ${p.users}) n, generate_series(0, ${p.days - 1}) d,
            unnest(array['gmail','gcal','slack']) c`,
    `insert into billing_usage (payer_id, day, workspace_id, calls)
       select 'w' || lpad(n::text, 5, '0'), (current_date - d), 'w' || lpad(n::text, 5, '0'), 1 + (n * d) % 120
       from generate_series(1, ${p.users}) n, generate_series(0, ${p.days - 1}) d`,
    `insert into pending_calls (id, workspace_id, principal, tool_name, connector_id, action, account_id, risk,
                                args_encrypted, args_hash, status, expires_at, execute_at, created_at)
       select 'pc' || n || '_' || k, 'w' || lpad(n::text, 5, '0'), '{}'::jsonb, 'gmail_send', 'gmail', 'send',
              'a' || lpad(n::text, 5, '0') || '_2', 'dangerous', 'x', md5(n || '-' || k),
              (array['succeeded','expired','denied','cancelled'])[1 + k % 4],
              now() + interval '1 day' - (k * interval '1 day'), null, now() - (k * interval '1 day')
       from generate_series(1, ${p.users}) n, generate_series(1, ${p.pendingCallsPerUser}) k`,
    // Messengers live in slot 1 of the first users.
    `insert into messenger_accounts (account_id, lease_owner, lease_expires_at, state, last_online_at)
       select 'a' || lpad(n::text, 5, '0') || '_1', 'gw-1', now() + interval '1 day', 'online', now()
       from generate_series(1, ${messengers}) n`,
    `insert into messenger_chats (id, account_id, external_key, info_encrypted, kind, title_index, unread,
                                  has_inbound, last_message_at)
       select 'ch' || n || '_' || c, 'a' || lpad(n::text, 5, '0') || '_1', md5('chat' || n || c), 'x',
              case when c % 7 = 0 then 'group' else 'direct' end, array[(n * 1000 + c) % 2147483647, c],
              case when c % 9 = 0 then 3 else 0 end, c % 4 <> 0,
              case when c % 50 = 0 then null else now() - (c * interval '1 hour') end
       from generate_series(1, ${messengers}) n, generate_series(1, ${p.chatsPerMessenger}) c`,
    `insert into messenger_messages (id, account_id, chat_id, external_key, direction, sent_at, body_encrypted,
                                     search_index)
       select 'm' || n || '_' || i, 'a' || lpad(n::text, 5, '0') || '_1',
              'ch' || n || '_' || (1 + floor(power(random(), 3) * ${p.chatsPerMessenger})::int), md5('msg' || n || i),
              case when i % 2 = 0 then 'in' else 'out' end, now() - (random() * interval '${span}'), 'x',
              array[(n * 7919 + i % 500) % 2147483647, (n * 104729 + i % 37) % 2147483647]
       from generate_series(1, ${messengers}) n, generate_series(1, ${p.messagesPerMessenger}) i`,
    `insert into messenger_outbox (id, account_id, chat_id, kind, payload_encrypted, content_key, status,
                                   not_before, sent_at, created_at)
       select 'ob' || n || '_' || i, 'a' || lpad(n::text, 5, '0') || '_1', 'ch' || n || '_' || (1 + i % 10), 'message',
              'x', md5('ob' || n || i), 'sent', now(), now() - (i * interval '1 hour'), now() - (i * interval '1 hour')
       from generate_series(1, ${messengers}) n, generate_series(1, 50) i`,
    `insert into triggers (id, workspace_id, user_id, name, enabled, source, connector_id, account_ids,
                           action_kind, spec_encrypted)
       select 't' || n || '_' || k, 'w' || lpad(n::text, 5, '0'), 'u' || lpad(n::text, 5, '0'), 'Trigger ' || k,
              k <> 3, (array['messages','mail','calendar'])[1 + (n + k) % 3],
              (array['telegram','gmail','gcal'])[1 + (n + k) % 3],
              array['a' || lpad(n::text, 5, '0') || '_' || (1 + (n + k) % 3)], 'notify', 'x'
       from generate_series(1, ${p.users}) n, generate_series(1, ${p.triggersPerUser}) k`,
    `insert into trigger_cursors (trigger_id, account_id, cursor)
       select t.id, unnest(t.account_ids), '0' from triggers t`,
    `insert into trigger_events (id, trigger_id, workspace_id, account_id, event_key, counterpart_key, status,
                                 body_encrypted, created_at, started_at, finished_at)
       select t.id || '_e' || i, t.id, t.workspace_id, t.account_ids[1], md5(t.id || i), md5(t.id || (i % 15)),
              'done', 'x', ev.at, ev.at, ev.at + interval '2 seconds'
       from triggers t, generate_series(1, ${p.triggerEventsPerTrigger}) i,
            lateral (select now() - (i * interval '${eventDays * 24} hours' / ${p.triggerEventsPerTrigger}) as at) ev`,
  ];
  for (const step of steps) await pool.query(step);
  await pool.query('analyze');
}
