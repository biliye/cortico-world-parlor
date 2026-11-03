import { afterEach } from 'vitest';
import { cleanupClosedPgTestDbs } from './pg.ts';

// Reclaim WorldServer-created ephemeral DBs after their pools close, rather
// than retaining hundreds until the end of a full run. Live pools are skipped.
afterEach(async () => { await cleanupClosedPgTestDbs(); });
