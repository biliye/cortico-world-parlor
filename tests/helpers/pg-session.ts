/** One disposable PG cluster per managed invocation, never a production URL. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

let embedded: {initialise():Promise<void>;start():Promise<void>;stop():Promise<void>} | undefined;
let scratch = '';
const state = (running:boolean) => writeFileSync(join(scratch,'pg-state.json'),JSON.stringify({running}));

export async function setup():Promise<void> {
  scratch = process.env.PARLOR_TEST_RUN_ROOT || '';
  const owner = JSON.parse(readFileSync(join(scratch,'owner.json'),'utf8'));
  if (!scratch || owner.kind!=='parlor-test-run' || owner.id!==process.env.PARLOR_TEST_RUN_ID
    || resolve(process.env.TEMP || '')!==resolve(scratch) || process.env.PARLOR_TEST_PG_URL) {
    throw new Error('PG测试必须由 pnpm test:pg / test:all 启动并使用独立临时目录');
  }
  const dir = join(scratch,'postgres');mkdirSync(dir);
  const {default:EmbeddedPostgres} = await import('embedded-postgres');
  embedded = new EmbeddedPostgres({databaseDir:dir,user:'postgres',password:'postgres',
    port:Number(process.env.PARLOR_TEST_PG_PORT),persistent:true,
    initdbFlags:['--locale=C','--encoding=UTF8'],postgresFlags:['-c','max_connections=50'],onLog:()=>{},onError:()=>{},
  });
  state(true);
  try {
    await embedded.initialise();await embedded.start();
    process.env.PARLOR_TEST_PG_URL=`postgres://postgres:postgres@127.0.0.1:${process.env.PARLOR_TEST_PG_PORT}/postgres`;
    process.env.PARLOR_TEST_PG='1';
  } catch(error) {await teardown();throw error;}
}

export async function teardown():Promise<void> {
  if (!embedded) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([embedded.stop(),new Promise<never>((_,reject)=>{
      timer=setTimeout(()=>reject(new Error('隔离PG停止超时，保留目录供检查')),15_000);
    })]);
  } finally {if(timer) clearTimeout(timer);}
  embedded=undefined;
  state(false);
  // The parent owns and removes the entire stopped cluster plus Vite/test temp
  // files; no broad DROP DATABASE prefix scan on an external PostgreSQL server.
}
