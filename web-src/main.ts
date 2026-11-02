/**
 * Vue 客户端的入口。
 *
 * 迁移期：只有带 ?vue=1 才挂载，正常访问仍走旧的 play.js；等视图一页页搬完，
 * vue-loader.js 改成无条件载入，这里就成为唯一入口。
 */
import { createApp } from 'vue';
import App from './App.vue';

const host = document.createElement('div');
host.id = 'vue-probe';
document.body.append(host);

createApp(App).mount(host);
