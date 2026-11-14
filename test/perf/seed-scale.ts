// Fills an empty database with synthetic data for 1000 users (or `--users N`), to look at query
// plans by hand (EXPLAIN ANALYZE) at the size the hub is built for. Never touches a database that
// already has users. Usage (docs/TESTING.md, "Нагрузка на базу"):
//   createdb manyplug_scale
//   npm run db:scale -- postgres://postgres@localhost:5432/manyplug_scale [--users 1000]
import pg from 'pg';
import { runMigrations } from '../../src/db/migrate.js';
import { SCALE_1000, seedScale } from './scale-data.js';

const url = process.argv.slice(2).find((arg) => arg.startsWith('postgres'));
const usersArg = process.argv.indexOf('--users');
const users = usersArg > 0 ? Number(process.argv[usersArg + 1]) : SCALE_1000.users;
if (!url || !Number.isInteger(users) || users < 1) {
  console.error('Usage: npm run db:scale -- <postgres url of an empty database> [--users 1000]');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: url, max: 1 });
try {
  await runMigrations(pool);
  const { rows } = await pool.query<{ n: number }>('select count(*)::int as n from users');
  if (rows[0]!.n > 0) throw new Error('This database already has users: give an empty one.');
  const started = Date.now();
  await seedScale(pool, { ...SCALE_1000, users });
  const sizes = await pool.query<{ table: string; rows: string; size: string }>(`
    select relname as table, n_live_tup::text as rows, pg_size_pretty(pg_total_relation_size(relid)) as size
    from pg_stat_user_tables where n_live_tup > 0 order by pg_total_relation_size(relid) desc`);
  console.table(sizes.rows);
  console.log(`Seeded ${users} users in ${Math.round((Date.now() - started) / 1000)} s.`);
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
