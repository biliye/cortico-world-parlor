/**
 * 每日新闻：运营一天发一版，「会馆小报」用列表，正文点开才取。
 * 列表 5 分钟内不重复请求（切分栏、回头再进大厅都够用）；
 * 正文取过就记在内存里，来回展开不再打网络。
 */
import { ref } from 'vue';
import { api } from '../api/client.ts';
import { seat } from './session.ts';

export interface NewsSummary {
  id: string;
  issueDate: string;
  title: string;
  summary: string;
  publishAt: number;
}

export interface NewsItem extends NewsSummary {
  body: string;
  autoPush: boolean;
  createdAt: number;
}

const LIST_TTL = 5 * 60_000;

export const items = ref<NewsSummary[]>([]);
export const loading = ref(false);
/** 第一次列表请求结束（成功或失败）就置 true：小报据此决定「现在是不是真的没内容」。 */
export const loaded = ref(false);
export const failed = ref('');

const bodies = new Map<string, NewsItem>();
let fetchedAt = 0;
let task: Promise<void> | undefined;

/** 只拉列表。force 留给「切回前台/手动刷新」；并发调用共用同一趟请求。 */
export async function loadNews(force = false): Promise<void> {
  if (!seat.value?.token) return;
  if (!force && fetchedAt && Date.now() - fetchedAt < LIST_TTL) return;
  if (task) return task;
  loading.value = true;
  task = (async () => {
    try {
      // 一天一版，服务端上限 10；摆 8 期，超出的历史本来也不给查。
      const data = await api<{ news?: NewsSummary[] }>('/v1/support/news?list=1&limit=8');
      items.value = Array.isArray(data.news) ? data.news : [];
      failed.value = '';
      fetchedAt = Date.now();
    } catch (error) {
      failed.value = (error as Error).message || '取不到新闻';
    } finally {
      loading.value = false;
      loaded.value = true;
      task = undefined;
    }
  })();
  return task;
}

/** 取一期全文；服务端还没到可见时刻或者被撤下时给 null。 */
export async function loadBody(id: string): Promise<NewsItem | null> {
  const hit = bodies.get(id);
  if (hit) return hit;
  const data = await api<{ news?: NewsItem | null }>('/v1/support/news?id=' + encodeURIComponent(id));
  const item = data.news ?? null;
  if (item) bodies.set(id, item);
  return item;
}
