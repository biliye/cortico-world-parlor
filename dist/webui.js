// src/webui/client.ts
var e = (e) => new Date(e + 288e5).toISOString().slice(0, 19).replace("T", " ");
async function t(t) {
	let n = t.root.ownerDocument;
	function r(e, t = "") {
		let r = n.createElement(e);
		return r.textContent = t, r;
	}
	let i = r("section");
	i.className = "parlor-history-panel";
	let a = r("form"), o = r("input");
	o.type = "datetime-local", o.required = !0, o.name = "from";
	let s = r("input");
	s.type = "datetime-local", s.required = !0, s.name = "until";
	let c = r("select");
	c.name = "room";
	let l = r("option", "全部客厅");
	l.value = "", c.append(l);
	let u = r("select");
	u.name = "direction";
	for (let [e, t] of [
		["", "全部"],
		["received", "孩子收到"],
		["sent", "孩子发出"]
	]) {
		let n = r("option", t);
		n.value = e, u.append(n);
	}
	let d = r("select");
	d.name = "presence";
	for (let [e, t] of [["", "显示全部"], ["hide", "隐藏 Coo／家长进出"]]) {
		let n = r("option", t);
		n.value = e, d.append(n);
	}
	for (let [e, t] of [
		["开始（北京时间）", o],
		["结束（不含此时刻）", s],
		["客厅", c],
		["收发", u],
		["进出提示", d]
	]) {
		let n = r("label", e);
		n.append(t), a.append(n);
	}
	let f = r("button", "查询");
	f.type = "submit";
	let p = r("button", "导出当前范围");
	p.type = "button";
	let m = r("div");
	m.className = "parlor-history-actions", m.append(f, p), a.append(m);
	let h = r("p");
	h.className = "parlor-history-info";
	let g = r("p");
	g.setAttribute("role", "status"), g.setAttribute("aria-live", "polite");
	let _ = r("section");
	_.setAttribute("aria-label", "消息记录");
	let v = r("button", "更早的消息");
	v.type = "button", v.hidden = !0, i.append(r("h2", "本地消息档案"), r("p", "消息保存在孩子运行 Coo 的电脑上，不随客厅服务器的 7 天回放清理。网页关闭后扩展仍会记录；已经丢失的旧消息无法补回。"), r("p", "“收到”表示孩子有权接收，不代表模型逐条读过。局中或未连接时，私密牌桌通知暂不展示；连接后确认已结束可回看。"), a, h, g, _, v), t.root.append(i);
	let y = [
		o,
		s,
		c,
		u,
		d,
		f,
		p,
		v
	], b = /* @__PURE__ */ new Set();
	t.own({ dispose() {
		for (let e of b) URL.revokeObjectURL(e);
		b.clear();
	} });
	let x = null, S = null, C = !1, w = 0, T = /* @__PURE__ */ new Set(), E = () => !t.signal.aborted;
	function D(e) {
		C = e;
		for (let t of y) t.disabled = e;
	}
	function O(e, t = !1) {
		g.textContent = e, g.className = t ? "parlor-history-error" : "";
	}
	function k() {
		let e = Date.parse(o.value + "+08:00"), t = Date.parse(s.value + "+08:00");
		if (!Number.isFinite(e) || !Number.isFinite(t) || t <= e) throw Error("请选择有效的起止时间，结束时间须晚于开始时间。");
		return {
			from: e,
			until: t,
			...c.value ? { room: c.value } : {},
			...u.value ? { direction: u.value } : {},
			...d.value === "hide" ? { hidePresence: !0 } : {}
		};
	}
	function A(t) {
		for (let n of t) {
			let t = r("article"), i = r("header"), a = r("span", `${n.direction === "sent" ? "发出" : "收到"} · ${n.sender} → ${n.recipient}`);
			i.append(r("time", e(n.ts)), a, r("span", `${n.room} · ${n.type}`)), t.append(i, r("p", n.text)), _.append(t);
		}
	}
	async function j() {
		try {
			let n = await t.invoke("info");
			if (!E()) return;
			h.textContent = `${n.name || "孩子"} · 档案总计 ${n.count} 条${n.first === null ? "" : ` · ${e(n.first)} 至 ${e(n.last)}`}${n.syncing ? " · 正在补收历史" : ""}${n.privateHidden ? " · 私密牌桌记录已隐藏" : ""}`;
			for (let e of n.rooms) {
				if (T.has(e)) continue;
				let t = r("option", e);
				t.value = e, c.append(t), T.add(e);
			}
			n.error && O(n.error, !0);
		} catch (e) {
			E() && (h.textContent = `档案总览暂不可用（${e.message || e}）`);
		}
	}
	async function M(e = !1) {
		if (!C && E()) {
			D(!0);
			try {
				let n = e && x ? x : k(), r = await t.invoke("query", [{
					...n,
					...e && S ? { before: S } : {}
				}]);
				if (!E()) return;
				e || (_.replaceChildren(), w = 0, x = n), A(r.messages), w += r.messages.length, S = r.next, v.hidden = !S, O(w ? `本次筛选已显示 ${w} 条，按消息时间从新到旧排列。` : "当前筛选条件下没有消息。"), e || await j();
			} catch (e) {
				E() && O(String(e.message || e), !0);
			} finally {
				E() && D(!1);
			}
		}
	}
	async function N() {
		if (!C && E()) {
			D(!0);
			try {
				let e = k(), n = [], a = null, s = 0;
				do {
					let r = await t.invoke("query", [{
						...e,
						limit: 200,
						...a ? { before: a } : {}
					}]);
					if (!E()) return;
					n.push(...r.messages.map((e) => JSON.stringify(e) + "\n")), s += r.messages.length, a = r.next, O(`正在导出 ${s} 条…`);
				} while (a);
				let c = URL.createObjectURL(new Blob(n, { type: "application/x-ndjson;charset=utf-8" }));
				b.add(c);
				let l = r("a");
				l.href = c, l.download = `parlor-history-${o.value.slice(0, 10)}.jsonl`, i.append(l), l.click(), l.remove(), t.timeout(() => {
					URL.revokeObjectURL(c), b.delete(c);
				}, 3e4), O(`已导出 ${s} 条消息。`);
			} catch (e) {
				E() && O(String(e.message || e), !0);
			} finally {
				E() && D(!1);
			}
		}
	}
	a.addEventListener("submit", (e) => {
		e.preventDefault(), M();
	}, { signal: t.signal }), v.addEventListener("click", () => {
		M(!0);
	}, { signal: t.signal }), p.addEventListener("click", () => {
		N();
	}, { signal: t.signal });
	let P = e(Date.now()).slice(0, 10);
	o.value = P + "T00:00", s.value = e(Date.parse(P + "T00:00:00+08:00") + 864e5).slice(0, 16).replace(" ", "T"), await M();
}
var n = { panels: { history: { mount: t } } };
export { n as default };
