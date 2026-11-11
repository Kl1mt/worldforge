import type { Database } from '../db/types.js';
import { writeAudit } from '../db/audit.js';
import { withTransaction } from '../db/transaction.js';
import { ApiError } from '../errors.js';
import { addReservedName, listReservedNames, removeReservedName } from './reserved-names.js';

/**
 * `pnpm admin:tools reserved-name list|add|remove` (ticket 6.9). Audited `admin.reserved_name.*`
 * with `via: 'cli'` (no account: the owner at the shell). Prints names only.
 */
export async function reservedNameCommand(db: Database, args: string[]): Promise<void> {
  const [sub, name, , note] = args;
  if (sub === 'list') {
    const names = await listReservedNames(db);
    for (const n of names)
      console.log(`${n.group.padEnd(7)} ${n.name}${n.note ? `  (${n.note})` : ''}`);
    console.log(`${names.length} reserved name(s); built-in names can't be removed.`);
    return;
  }
  try {
    await withTransaction(db, async (tx) => {
      if (sub === 'add') {
        const row = await addReservedName(tx, {
          name: name!,
          ...(note !== undefined ? { note } : {}),
          by: null,
          now: new Date(),
        });
        await writeAudit(tx, {
          event: 'admin.reserved_name.add',
          accountId: null,
          data: { via: 'cli', after: { name: row.name } },
        });
        console.log(`Reserved "${row.name}". Players who already carry it keep it.`);
      } else {
        const row = await removeReservedName(tx, { name: name! });
        if (!row) {
          console.error(`"${name}" is not an added reserved name (built-in names stay).`);
          process.exitCode = 1;
          return;
        }
        await writeAudit(tx, {
          event: 'admin.reserved_name.remove',
          accountId: null,
          data: { via: 'cli', before: { name: row.name } },
        });
        console.log(`"${row.name}" is no longer reserved.`);
      }
    });
  } catch (err) {
    if (err instanceof ApiError) {
      console.error(err.message);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}
