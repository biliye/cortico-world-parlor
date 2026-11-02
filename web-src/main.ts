/**
 * Vue 客户端的入口。
 *
 * 迁移期只有带 ?vue=1 才会被 vue-loader.js 载入；正常访问仍走旧的 play.js。
 * 挂载点用页面自带的 #app，先把旧版留下的占位内容清掉。
 */
import { createApp } from 'vue';
import App from './App.vue';

const host = document.getElementById('app') || document.body;
host.replaceChildren();

createApp(App).mount(host);
