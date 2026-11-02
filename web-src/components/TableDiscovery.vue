<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { TableSummary } from '../api/types.ts';
import { act, snapshot, tableIdOf } from '../stores/parlor.ts';
import { seat } from '../stores/session.ts';
const props = defineProps<{ table: TableSummary }>();
const text = ref('');
const busy = ref(false);
const notice = ref('');
const host = computed(() => props.table.host === snapshot.value?.seat?.id);
const publicRoom = computed(() => snapshot.value?.visibility === 'public');
const canWithdraw = computed(() => !!props.table.recruitText && (host.value || props.table.recruitAuthor === seat.value?.cooId));
const canEdit = computed(() => !props.table.recruitText || canWithdraw.value);
const link = computed(() => new URL('/play?' + new URLSearchParams({ room: snapshot.value?.id || '', view: 'table', table: tableIdOf(props.table) }), location.origin).href);
watch(() => props.table.recruitText, (next) => { text.value = next || ''; }, { immediate: true });
async function update(fields: Record<string, unknown>): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  notice.value = '';
  try {
    const result = await act({ type: 'table_discovery', table: tableIdOf(props.table), ...fields });
    if (result) notice.value = fields.withdraw ? '已撤回大厅招募。' : (fields.text ? '已分享到大厅，其他人和 Coo 可以通过链接来这桌。' : '开放匹配设置已更新。');
  } catch (error) { notice.value = (error as Error).message || '更新失败'; }
  finally { busy.value = false; }
}
async function copy(): Promise<void> {
  try { await navigator.clipboard.writeText(link.value); notice.value = '牌桌链接已复制，人和 Coo 都能使用。'; }
  catch { notice.value = '可以复制下方的牌桌链接。'; }
}
</script>

<template>
  <section class="panel table-recruit" aria-label="牌桌匹配与分享">
    <h2>叫朋友来一局</h2>
    <div v-if="host" class="actions">
      <button class="btn ghost" type="button" :disabled="busy || ((!publicRoom || !!table.stake) && !table.matchOpen)" :aria-pressed="!!table.matchOpen" @click="update({ matchOpen: !table.matchOpen })">{{ table.matchOpen ? '关闭快速匹配' : '开放快速匹配' }}</button>
      <span class="muted">{{ table.matchOpen ? '已开放：其他人和 Coo 可以快速匹配到这桌。' : '未开放快速匹配' }}</span>
    </div>
    <p v-else class="muted">{{ table.matchOpen ? '这张桌已开放快速匹配。' : '开放匹配由开桌的人或 Coo 决定。' }}</p>
    <p v-if="table.stake" class="muted">快速匹配只支持无押注桌。这张桌可以通过招募或分享链接加入。</p>
    <p v-if="!publicRoom" class="muted">当前客厅不公开，不能分享到大厅或开放匹配；链接仍遵守客厅准入权限。</p>
    <template v-else>
      <label class="table-recruit-label" for="table-recruit-text">写一段招募内容，分享到大厅</label>
      <textarea id="table-recruit-text" v-model="text" maxlength="200" rows="3" :disabled="busy || !canEdit" placeholder="例如：缺两位，来一局斗地主！" />
      <div class="actions">
        <button class="btn primary" type="button" :disabled="busy || !canEdit || !text.trim()" @click="update({ text: text.trim() })">{{ table.recruitText ? '更新大厅招募' : '分享到大厅' }}</button>
        <button v-if="canWithdraw" class="btn ghost" type="button" :disabled="busy" @click="update({ withdraw: true })">撤回招募</button>
        <small class="muted">{{ text.length }}/200 · 同一桌每分钟可更新一次</small>
      </div>
      <p v-if="!canEdit" class="muted">已有同桌伙伴发布招募，可由作者或桌主修改。</p>
    </template>
    <div class="table-recruit-link"><button class="btn ghost small" type="button" @click="copy">复制牌桌链接</button><a :href="link">{{ link }}</a></div>
    <p v-if="notice" class="muted" role="status">{{ notice }}</p>
  </section>
</template>

<style scoped>
.table-recruit { margin-block: 16px; }
.table-recruit-label { display: block; margin-block: 18px 8px; }
.table-recruit textarea { display: block; box-sizing: border-box; width: 100%; resize: vertical; padding: 12px; font: inherit; color: inherit; background: transparent; border: 1px solid var(--line, #7778); border-radius: 10px; margin-bottom: 12px; }
.table-recruit-link { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; margin-top: 18px; }
.table-recruit-link a { color: inherit; overflow-wrap: anywhere; font-size: 12px; }
</style>
