// src/web/story-archive.js
function e(e, { list: t, detail: n, time: r, active: i = () => !0 }) {
	let a = (t, n = "") => {
		let r = e.ownerDocument.createElement(t);
		return r.textContent = n, r;
	}, o = a("details"), s = a("p");
	s.setAttribute("aria-live", "polite");
	let c = a("div"), l = a("button", "更早的场次"), u = a("button", "刷新");
	l.type = u.type = "button", l.hidden = !0, o.append(a("summary", "说书记录"), u, s, c, l), e.append(o);
	let d = null, f = !1, p = !1, m = async (e = !1) => {
		if (!f && i()) {
			f = !0, l.disabled = u.disabled = !0, s.textContent = "正在读取说书记录…";
			try {
				let o = await t(e ? d : null);
				if (!i()) return;
				e || c.replaceChildren();
				for (let e of o.rounds) {
					let t = a("details"), o = a("article"), s = a("button", "重新读取正文");
					s.type = "button", t.append(a("summary", `${e.title} · ${e.speaker} · ${r(e.startedAt)}`), o), c.append(t);
					let l = !1, u = !1, d = async () => {
						if (t.open && !u && !l && i()) {
							l = !0, o.textContent = "正在读取正文…";
							try {
								let r = await n(e.id);
								if (!i() || !t.isConnected) return;
								o.replaceChildren(...r.parts.map((e) => a("p", e.text))), u = !0;
							} catch (e) {
								i() && o.replaceChildren(a("p", e.message), s);
							} finally {
								l = !1;
							}
						}
					};
					t.addEventListener("toggle", d), s.addEventListener("click", d);
				}
				d = o.next, l.hidden = !d, s.textContent = c.childElementCount ? "" : "还没有说书记录。", p = !0;
			} catch (e) {
				i() && (s.textContent = e.message);
			} finally {
				f = !1, l.disabled = u.disabled = !1;
			}
		}
	};
	o.addEventListener("toggle", () => {
		o.open && !p && m();
	}), u.addEventListener("click", () => void m()), l.addEventListener("click", () => void m(!0));
}
// src/webui/client.ts
var t = (e) => new Date(e + 288e5).toISOString().slice(0, 19).replace("T", " ");
async function n(n) {
	let r = n.root.ownerDocument;
	function i(e, t = "") {
		let n = r.createElement(e);
		return n.textContent = t, n;
	}
	let a = i("section");
	a.className = "parlor-history-panel";
	let o = i("form"), s = i("input");
	s.type = "datetime-local", s.required = !0, s.name = "from";
	let c = i("input");
	c.type = "datetime-local", c.required = !0, c.name = "until";
	let l = i("select");
	l.name = "room";
	let u = i("option", "全部客厅");
	u.value = "", l.append(u);
	let d = i("select");
	d.name = "direction";
	for (let [e, t] of [
		["", "全部"],
		["received", "孩子收到"],
		["sent", "孩子发出"]
	]) {
		let n = i("option", t);
		n.value = e, d.append(n);
	}
	let f = i("select");
	f.name = "presence";
	for (let [e, t] of [["", "显示全部"], ["hide", "隐藏 Coo／家长进出"]]) {
		let n = i("option", t);
		n.value = e, f.append(n);
	}
	for (let [e, t] of [
		["开始（北京时间）", s],
		["结束（不含此时刻）", c],
		["客厅", l],
		["收发", d],
		["进出提示", f]
	]) {
		let n = i("label", e);
		n.append(t), o.append(n);
	}
	let p = i("button", "查询");
	p.type = "submit";
	let m = i("button", "导出当前范围");
	m.type = "button";
	let h = i("div");
	h.className = "parlor-history-actions", h.append(p, m), o.append(h);
	let g = i("p");
	g.className = "parlor-history-info";
	let _ = i("p");
	_.setAttribute("role", "status"), _.setAttribute("aria-live", "polite");
	let v = i("section");
	v.setAttribute("aria-label", "消息记录");
	let y = i("button", "更早的消息");
	y.type = "button", y.hidden = !0;
	let b = i("section");
	b.setAttribute("aria-label", "说书记录"), a.append(i("h2", "本地消息档案"), i("p", "消息保存在孩子运行 Coo 的电脑上，不随客厅服务器的 7 天回放清理。网页关闭后扩展仍会记录；已经丢失的旧消息无法补回。"), i("p", "“收到”表示孩子有权接收，不代表模型逐条读过。局中或未连接时，私密牌桌通知暂不展示；连接后确认已结束可回看。"), b, o, g, _, v, y), n.root.append(a), e(b, {
		time: t,
		list: (e) => n.invoke("stories", [e ? { before: e } : {}]),
		detail: (e) => n.invoke("stories", [{ id: e }]),
		active: () => !n.signal.aborted
	});
	let x = [
		s,
		c,
		l,
		d,
		f,
		p,
		m,
		y
	], S = /* @__PURE__ */ new Set();
	n.own({ dispose() {
		for (let e of S) URL.revokeObjectURL(e);
		S.clear();
	} });
	let C = null, w = null, T = !1, E = 0, D = /* @__PURE__ */ new Set(), O = () => !n.signal.aborted;
	function k(e) {
		T = e;
		for (let t of x) t.disabled = e;
	}
	function A(e, t = !1) {
		_.textContent = e, _.className = t ? "parlor-history-error" : "";
	}
	function j() {
		let e = Date.parse(s.value + "+08:00"), t = Date.parse(c.value + "+08:00");
		if (!Number.isFinite(e) || !Number.isFinite(t) || t <= e) throw Error("请选择有效的起止时间，结束时间须晚于开始时间。");
		return {
			from: e,
			until: t,
			...l.value ? { room: l.value } : {},
			...d.value ? { direction: d.value } : {},
			...f.value === "hide" ? { hidePresence: !0 } : {}
		};
	}
	function M(e) {
		for (let n of e) {
			let e = i("article"), r = i("header"), a = i("span", `${n.direction === "sent" ? "发出" : "收到"} · ${n.sender} → ${n.recipient}`);
			r.append(i("time", t(n.ts)), a, i("span", `${n.room} · ${n.type}`)), e.append(r, i("p", n.text)), v.append(e);
		}
	}
	async function N() {
		try {
			let e = await n.invoke("info");
			if (!O()) return;
			g.textContent = `${e.name || "孩子"} · 档案总计 ${e.count} 条${e.first === null ? "" : ` · ${t(e.first)} 至 ${t(e.last)}`}${e.syncing ? " · 正在补收历史" : ""}${e.privateHidden ? " · 私密牌桌记录已隐藏" : ""}`;
			for (let t of e.rooms) {
				if (D.has(t)) continue;
				let e = i("option", t);
				e.value = t, l.append(e), D.add(t);
			}
			e.error && A(e.error, !0);
		} catch (e) {
			O() && (g.textContent = `档案总览暂不可用（${e.message || e}）`);
		}
	}
	async function P(e = !1) {
		if (!T && O()) {
			k(!0);
			try {
				let t = e && C ? C : j(), r = await n.invoke("query", [{
					...t,
					...e && w ? { before: w } : {}
				}]);
				if (!O()) return;
				e || (v.replaceChildren(), E = 0, C = t), M(r.messages), E += r.messages.length, w = r.next, y.hidden = !w, A(E ? `本次筛选已显示 ${E} 条，按消息时间从新到旧排列。` : "当前筛选条件下没有消息。"), e || await N();
			} catch (e) {
				O() && A(String(e.message || e), !0);
			} finally {
				O() && k(!1);
			}
		}
	}
	async function F() {
		if (!T && O()) {
			k(!0);
			try {
				let e = j(), t = [], r = null, o = 0;
				do {
					let i = await n.invoke("query", [{
						...e,
						limit: 200,
						...r ? { before: r } : {}
					}]);
					if (!O()) return;
					t.push(...i.messages.map((e) => JSON.stringify(e) + "\n")), o += i.messages.length, r = i.next, A(`正在导出 ${o} 条…`);
				} while (r);
				let c = URL.createObjectURL(new Blob(t, { type: "application/x-ndjson;charset=utf-8" }));
				S.add(c);
				let l = i("a");
				l.href = c, l.download = `parlor-history-${s.value.slice(0, 10)}.jsonl`, a.append(l), l.click(), l.remove(), n.timeout(() => {
					URL.revokeObjectURL(c), S.delete(c);
				}, 3e4), A(`已导出 ${o} 条消息。`);
			} catch (e) {
				O() && A(String(e.message || e), !0);
			} finally {
				O() && k(!1);
			}
		}
	}
	o.addEventListener("submit", (e) => {
		e.preventDefault(), P();
	}, { signal: n.signal }), y.addEventListener("click", () => {
		P(!0);
	}, { signal: n.signal }), m.addEventListener("click", () => {
		F();
	}, { signal: n.signal });
	let I = t(Date.now()).slice(0, 10);
	s.value = I + "T00:00", c.value = t(Date.parse(I + "T00:00:00+08:00") + 864e5).slice(0, 16).replace(" ", "T"), await P();
}
var r = { panels: { history: { mount: n } } };
export { r as default };
