import { randomUUID } from 'node:crypto';
import { EXPERIMENTS_SCHEMA, TABLE_EXPERIMENTS } from '@mastra/core/storage';
import type { SqliteClient, SqliteTransaction, SqliteValue } from '../../db/client';
import { withClientWriteLock } from '../../db/write-lock';

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const table = quote(TABLE_EXPERIMENTS);
const targetNames = new Set(
  ['targetType', 'targetId']
    .filter(name => EXPERIMENTS_SCHEMA[name]?.nullable === true)
    .map(name => name.toLowerCase()),
);

type Token = { text: string; start: number; end: number; depth: number };
function tokens(sql: string): Token[] {
  const pattern =
    /--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[A-Za-z_][A-Za-z_0-9]*|[^\s]/g;
  const result: Token[] = [];
  let depth = 0;
  for (const match of sql.matchAll(pattern)) {
    const text = match[0];
    if (text.startsWith('--') || text.startsWith('/*')) continue;
    if (text === ')') depth--;
    result.push({ text, start: match.index!, end: match.index! + text.length, depth });
    if (text === '(') depth++;
  }
  return result;
}
const word = (token: Token | undefined, value: string) => token?.text.toUpperCase() === value;

/** Change only the two column constraints. Keep unknown columns, defaults and table constraints. */
function nullableDefinition(sql: string, shadow: string, required: Set<string>) {
  const parsed = tokens(sql);
  const open = parsed.find(token => token.text === '(' && token.depth === 0);
  if (!word(parsed[0], 'CREATE') || !word(parsed[1], 'TABLE') || !open)
    throw new Error('The legacy experiment table definition is unsupported.');
  const edits: Array<{ start: number; end: number }> = [];
  const changed = new Set<string>();
  let column = '';
  let first = true;
  for (let i = parsed.indexOf(open) + 1; i < parsed.length; i++) {
    const token = parsed[i]!;
    if (token.depth !== 1) continue;
    if (token.text === ',') {
      first = true;
      column = '';
      continue;
    }
    if (first) {
      column = token.text.replace(/^["'`\[]|["'`\]]$/g, '').toLowerCase();
      first = false;
    }
    if (!required.has(column) || !word(token, 'NOT') || !word(parsed[i + 1], 'NULL') || parsed[i + 1]?.depth !== 1)
      continue;
    let start = token.start;
    let end = parsed[i + 1]!.end;
    if (word(parsed[i - 2], 'CONSTRAINT') && parsed[i - 2]?.depth === 1) start = parsed[i - 2]!.start;
    if (
      word(parsed[i + 2], 'ON') &&
      word(parsed[i + 3], 'CONFLICT') &&
      /^(ROLLBACK|ABORT|FAIL|IGNORE|REPLACE)$/i.test(parsed[i + 4]?.text ?? '')
    )
      end = parsed[i + 4]!.end;
    edits.push({ start, end });
    changed.add(column);
  }
  if ([...required].some(name => !changed.has(name)))
    throw new Error('The legacy experiment target constraints could not be relaxed safely.');
  let definition = sql;
  for (const edit of edits.sort((a, b) => b.start - a.start))
    definition = definition.slice(0, edit.start) + definition.slice(edit.end);
  return {
    sql: `CREATE TABLE ${quote(shadow)} ${definition.slice(open.start)}`,
    withoutRowid: parsed.some(
      (token, i) => token.depth === 0 && word(token, 'WITHOUT') && word(parsed[i + 1], 'ROWID'),
    ),
    autoIncrement: parsed.some(token => word(token, 'AUTOINCREMENT')),
  };
}

function drift(rows: Array<Record<string, SqliteValue>>) {
  return rows.filter(row => targetNames.has(String(row.name).toLowerCase()) && Number(row.notnull) === 1);
}

async function refuseEnforcedReferences(tx: SqliteTransaction) {
  const pragma = await tx.execute('PRAGMA foreign_keys');
  if (Number(pragma.rows[0]?.foreign_keys) !== 1) return;
  const tables = await tx.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'");
  for (const row of tables.rows) {
    const references = await tx.execute(`PRAGMA foreign_key_list(${quote(String(row.name))})`);
    if (references.rows.some(reference => String(reference.table).toLowerCase() === TABLE_EXPERIMENTS.toLowerCase())) {
      throw new Error('The experiment table has enforced references and cannot be rebuilt safely.');
    }
  }
}

/** Rebuild legacy targets atomically. Never remove a preexisting shadow table or change connection settings. */
export async function relaxExperimentTargetNullability(client: SqliteClient): Promise<void> {
  if (!drift((await client.execute(`PRAGMA table_info(${table})`)).rows).length) return;
  await withClientWriteLock(client, async () => {
    const tx = await client.transaction('write');
    try {
      const info = await tx.execute(`PRAGMA table_info(${table})`);
      const required = drift(info.rows);
      if (!required.length) {
        await tx.commit();
        return;
      }
      if (required.some(column => Number(column.pk) !== 0))
        throw new Error('A legacy experiment target is part of a primary key.');
      await refuseEnforcedReferences(tx);
      const source = await tx.execute({
        sql: "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
        args: [TABLE_EXPERIMENTS],
      });
      const sql = source.rows[0]?.sql;
      if (typeof sql !== 'string' || sql.length > 1_000_000)
        throw new Error('The legacy experiment table definition is unavailable.');
      const objects = await tx.execute({
        sql: "SELECT sql FROM sqlite_master WHERE tbl_name = ? AND type IN ('index', 'trigger') AND sql IS NOT NULL ORDER BY type, name",
        args: [TABLE_EXPERIMENTS],
      });
      const shadow = `${TABLE_EXPERIMENTS}__nullable_${randomUUID().replaceAll('-', '')}`;
      const definition = nullableDefinition(
        sql,
        shadow,
        new Set(required.map(column => String(column.name).toLowerCase())),
      );
      const names = info.rows.map(column => String(column.name));
      const rowid = definition.withoutRowid
        ? undefined
        : ['rowid', '_rowid_', 'oid'].find(name => !names.some(column => column.toLowerCase() === name));
      if (!definition.withoutRowid && !rowid)
        throw new Error('The legacy experiment row identifiers cannot be preserved.');
      const columns = [...(rowid ? [rowid] : []), ...names].map(quote).join(', ');
      const before = await tx.execute(`SELECT COUNT(*) AS count FROM ${table}`);
      const sequence = definition.autoIncrement
        ? await tx.execute({ sql: 'SELECT seq FROM sqlite_sequence WHERE name = ?', args: [TABLE_EXPERIMENTS] })
        : undefined;
      await tx.execute(definition.sql);
      await tx.execute(`INSERT INTO ${quote(shadow)} (${columns}) SELECT ${columns} FROM ${table}`);
      const copied = await tx.execute(`SELECT COUNT(*) AS count FROM ${quote(shadow)}`);
      if (String(before.rows[0]?.count) !== String(copied.rows[0]?.count))
        throw new Error('The experiment migration did not preserve every row.');
      await tx.execute(`DROP TABLE ${table}`);
      await tx.execute(`ALTER TABLE ${quote(shadow)} RENAME TO ${table}`);
      for (const object of objects.rows) {
        if (typeof object.sql !== 'string')
          throw new Error('An experiment index or trigger definition is unavailable.');
        await tx.execute(object.sql);
      }
      if (sequence?.rows[0]) {
        const updated = await tx.execute({
          sql: 'UPDATE sqlite_sequence SET seq = ? WHERE name = ?',
          args: [sequence.rows[0].seq!, TABLE_EXPERIMENTS],
        });
        if (!updated.rowsAffected)
          await tx.execute({
            sql: 'INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)',
            args: [TABLE_EXPERIMENTS, sequence.rows[0].seq!],
          });
      }
      await tx.commit();
    } catch (error) {
      if (!tx.closed)
        await tx.rollback().catch(rollbackError => {
          throw new AggregateError([error, rollbackError], 'Experiment migration and rollback both failed');
        });
      throw error;
    } finally {
      tx.close();
    }
  });
}
