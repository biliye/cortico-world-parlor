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
	c.name = "room", c.append(r("option", "全部客厅"));
	let l = r("select");
	l.name = "direction";
	for (let [e, t] of [
		["", "全部"],
		["received", "孩子收到"],
		["sent", "孩子发出"]
	]) {
		let n = r("option", t);
		n.value = e, l.append(n);
	}
	for (let [e, t] of [
		["开始（北京时间）", o],
		["结束（不含此时刻）", s],
		["客厅", c],
		["收发", l]
	]) {
		let n = r("label", e);
		n.append(t), a.append(n);
	}
	let u = r("button", "查询");
	u.type = "submit";
	let d = r("button", "导出当前范围");
	d.type = "button";
	let f = r("div");
	f.className = "parlor-history-actions", f.append(u, d), a.append(f);
	let p = r("p");
	p.className = "parlor-history-info";
	let m = r("p");
	m.setAttribute("role", "status"), m.setAttribute("aria-live", "polite");
	let h = r("section");
	h.setAttribute("aria-label", "消息记录");
	let g = r("button", "更早的消息");
	g.type = "button", g.hidden = !0, i.append(r("h2", "本地消息档案"), r("p", "消息保存在孩子运行 Coo 的电脑上，不随客厅服务器的 7 天回放清理。网页关闭后扩展仍会记录；已经丢失的旧消息无法补回。"), r("p", "“收到”表示孩子有权接收，不代表模型逐条读过。局中或未连接时，私密牌桌通知暂不展示；连接后确认已结束可回看。"), a, p, m, h, g), t.root.append(i);
	let _ = [
		o,
		s,
		c,
		l,
		u,
		d,
		g
	], v = /* @__PURE__ */ new Set();
	t.own({ dispose() {
		for (let e of v) URL.revokeObjectURL(e);
		v.clear();
	} });
	let y = null, b = null, x = !1, S = 0, C = () => !t.signal.aborted;
	function w(e) {
		x = e;
		for (let t of _) t.disabled = e;
	}
	function T(e, t = !1) {
		m.textContent = e, m.className = t ? "parlor-history-error" : "";
	}
	function E() {
		let e = Date.parse(o.value + "+08:00"), t = Date.parse(s.value + "+08:00");
		if (!Number.isFinite(e) || !Number.isFinite(t) || t <= e) throw Error("请选择有效的起止时间，结束时间须晚于开始时间。");
		return {
			from: e,
			until: t,
			...c.value ? { room: c.value } : {},
			...l.value ? { direction: l.value } : {}
		};
	}
	function D(t) {
		for (let n of t) {
			let t = r("article"), i = r("header"), a = r("span", `${n.direction === "sent" ? "发出" : "收到"} · ${n.sender} → ${n.recipient}`);
			i.append(r("time", e(n.ts)), a, r("span", `${n.room} · ${n.type}`)), t.append(i, r("p", n.text)), h.append(t);
		}
	}
	async function O(e = !1) {
		if (!x && C()) {
			w(!0);
			try {
				let n = e && y ? y : E(), r = await t.invoke("query", [{
					...n,
					...e && b ? { before: b } : {}
				}]);
				if (!C()) return;
				e || (h.replaceChildren(), S = 0, y = n), D(r.messages), S += r.messages.length, b = r.next, g.hidden = !b, T(S ? `已显示 ${S} 条，按消息时间从新到旧排列。` : "这个时间范围没有已保存的消息。");
			} catch (e) {
				C() && T(String(e.message || e), !0);
			} finally {
				C() && w(!1);
			}
		}
	}
	async function k() {
		if (!x && C()) {
			w(!0);
			try {
				let e = E(), n = [], a = null, s = 0;
				do {
					let r = await t.invoke("query", [{
						...e,
						limit: 200,
						...a ? { before: a } : {}
					}]);
					if (!C()) return;
					n.push(...r.messages.map((e) => JSON.stringify(e) + "\n")), s += r.messages.length, a = r.next, T(`正在导出 ${s} 条…`);
				} while (a);
				let c = URL.createObjectURL(new Blob(n, { type: "application/x-ndjson;charset=utf-8" }));
				v.add(c);
				let l = r("a");
				l.href = c, l.download = `parlor-history-${o.value.slice(0, 10)}.jsonl`, i.append(l), l.click(), l.remove(), t.timeout(() => {
					URL.revokeObjectURL(c), v.delete(c);
				}, 3e4), T(`已导出 ${s} 条消息。`);
			} catch (e) {
				C() && T(String(e.message || e), !0);
			} finally {
				C() && w(!1);
			}
		}
	}
	a.addEventListener("submit", (e) => {
		e.preventDefault(), O();
	}, { signal: t.signal }), g.addEventListener("click", () => {
		O(!0);
	}, { signal: t.signal }), d.addEventListener("click", () => {
		k();
	}, { signal: t.signal });
	let A = e(Date.now()).slice(0, 10);
	o.value = A + "T00:00", s.value = e(Date.parse(A + "T00:00:00+08:00") + 864e5).slice(0, 16).replace(" ", "T"), w(!0);
	let j;
	try {
		if (j = await t.invoke("info"), !C()) return;
		p.textContent = `${j.name || "孩子"} · 已存 ${j.count} 条${j.first === null ? "" : ` · ${e(j.first)} 至 ${e(j.last)}`}${j.syncing ? " · 正在补收历史" : ""}${j.privateHidden ? " · 私密牌桌记录已隐藏" : ""}`;
		for (let e of j.rooms) {
			let t = r("option", e);
			t.value = e, c.append(t);
		}
	} catch (e) {
		C() && T(String(e.message || e), !0);
		return;
	} finally {
		C() && w(!1);
	}
	await O(), C() && j.error && T(j.error, !0);
}
var n = { panels: { history: { mount: t } } };
export { n as default };
