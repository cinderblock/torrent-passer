import { Electroview } from "electrobun/view";
import type {
	AppRPC,
	Config,
	DelugeDaemonDestination,
	DelugeWebDestination,
	Destination,
	DestinationKind,
	FileAssociationStatus,
	InitialState,
	PostUrlDestination,
	PreflightStatus,
	QbittorrentDestination,
	RutorrentDestination,
	TorrentInfo,
	TransmissionDestination,
	UpdateStatus,
	UtorrentDestination,
} from "../bun/rpc";

const rpc = Electroview.defineRPC<AppRPC>({
	maxRequestTime: Infinity,
	handlers: {
		messages: {
			preflightUpdate: ({ status }: { status: PreflightStatus }) => {
				view.preflight.set(status.destinationId, status);
				view.render();
			},
			configChanged: ({ config }: { config: Config }) => {
				view.config = config;
				view.render();
			},
			fileAssociationChanged: ({
				status,
			}: {
				status: FileAssociationStatus;
			}) => {
				view.fileAssociation = status;
				renderFooter();
			},
			torrentChanged: ({ torrent }: { torrent: TorrentInfo | null }) => {
				view.torrent = torrent;
				view.render();
			},
			updateChanged: ({ status }: { status: UpdateStatus }) => {
				view.update = status;
				renderUpdate();
			},
		},
	},
});
new Electroview({ rpc });

// ---- State ---------------------------------------------------------------

interface ViewState {
	torrent: TorrentInfo | null;
	config: Config;
	preflight: Map<string, PreflightStatus>;
	fileAssociation: FileAssociationStatus | null;
	update: UpdateStatus | null;
	selectedIndex: number;
	pending: boolean;
	pickerOpen: boolean;
	editMode: boolean;
	editingId: string | null; // null+overlayOpen=adding new
	overlayOpen: boolean;
	render: () => void;
}

const view: ViewState = {
	torrent: null,
	config: { destinations: [] },
	preflight: new Map(),
	fileAssociation: null,
	update: null,
	selectedIndex: 0,
	pending: false,
	pickerOpen: false,
	editMode: false,
	editingId: null,
	overlayOpen: false,
	render,
};

// ---- Element refs --------------------------------------------------------

function byId<T extends HTMLElement>(id: string): T {
	const el = document.getElementById(id);
	if (!el) throw new Error(`missing #${id}`);
	return el as T;
}

const els = {
	emptyState: byId<HTMLElement>("empty-state"),
	loadedState: byId<HTMLElement>("loaded-state"),
	emptyPickBtn: byId<HTMLButtonElement>("empty-pick-btn"),
	emptyEditBtn: byId<HTMLButtonElement>("empty-edit-btn"),
	name: byId<HTMLElement>("torrent-name"),
	meta: byId<HTMLElement>("torrent-meta"),
	list: byId<HTMLOListElement>("destinations"),
	addDestBtn: byId<HTMLButtonElement>("add-dest-btn"),
	emptyList: byId<HTMLElement>("empty-list"),
	editToggleBtn: byId<HTMLButtonElement>("edit-toggle-btn"),
	hint: byId<HTMLElement>("hint"),
	assocBtn: byId<HTMLButtonElement>("assoc-btn"),
	updateBtn: byId<HTMLButtonElement>("update-btn"),
	openTorrentBtn: byId<HTMLButtonElement>("open-torrent-btn"),
	form: byId<HTMLFormElement>("editor-form"),
	editorSave: byId<HTMLButtonElement>("editor-save"),
	editorCancel: byId<HTMLButtonElement>("editor-cancel"),
	editorDelete: byId<HTMLButtonElement>("editor-delete"),
	fName: byId<HTMLInputElement>("f-name"),
	fKind: byId<HTMLSelectElement>("f-kind"),
	puUrl: byId<HTMLInputElement>("pu-url"),
	puField: byId<HTMLInputElement>("pu-field"),
	puHeaders: byId<HTMLTextAreaElement>("pu-headers"),
	puExtra: byId<HTMLTextAreaElement>("pu-extra"),
	puInsecure: byId<HTMLInputElement>("pu-insecure"),
	dwUrl: byId<HTMLInputElement>("dw-url"),
	dwPass: byId<HTMLInputElement>("dw-pass"),
	dwLoc: byId<HTMLInputElement>("dw-loc"),
	dwPaused: byId<HTMLInputElement>("dw-paused"),
	dwInsecure: byId<HTMLInputElement>("dw-insecure"),
	qbUrl: byId<HTMLInputElement>("qb-url"),
	qbUser: byId<HTMLInputElement>("qb-user"),
	qbPass: byId<HTMLInputElement>("qb-pass"),
	qbCat: byId<HTMLInputElement>("qb-cat"),
	qbLoc: byId<HTMLInputElement>("qb-loc"),
	qbPaused: byId<HTMLInputElement>("qb-paused"),
	qbInsecure: byId<HTMLInputElement>("qb-insecure"),
	trUrl: byId<HTMLInputElement>("tr-url"),
	trUser: byId<HTMLInputElement>("tr-user"),
	trPass: byId<HTMLInputElement>("tr-pass"),
	trLoc: byId<HTMLInputElement>("tr-loc"),
	trPaused: byId<HTMLInputElement>("tr-paused"),
	trInsecure: byId<HTMLInputElement>("tr-insecure"),
	rtUrl: byId<HTMLInputElement>("rt-url"),
	rtUser: byId<HTMLInputElement>("rt-user"),
	rtPass: byId<HTMLInputElement>("rt-pass"),
	rtLabel: byId<HTMLInputElement>("rt-label"),
	rtLoc: byId<HTMLInputElement>("rt-loc"),
	rtPaused: byId<HTMLInputElement>("rt-paused"),
	rtInsecure: byId<HTMLInputElement>("rt-insecure"),
	utUrl: byId<HTMLInputElement>("ut-url"),
	utUser: byId<HTMLInputElement>("ut-user"),
	utPass: byId<HTMLInputElement>("ut-pass"),
	utInsecure: byId<HTMLInputElement>("ut-insecure"),
	ddHost: byId<HTMLInputElement>("dd-host"),
	ddPort: byId<HTMLInputElement>("dd-port"),
	ddUser: byId<HTMLInputElement>("dd-user"),
	ddPass: byId<HTMLInputElement>("dd-pass"),
	ddLoc: byId<HTMLInputElement>("dd-loc"),
	ddProto: byId<HTMLSelectElement>("dd-proto"),
	ddPaused: byId<HTMLInputElement>("dd-paused"),
	ddInsecure: byId<HTMLInputElement>("dd-insecure"),
	toast: byId<HTMLDivElement>("toast"),
};

// ---- Wiring --------------------------------------------------------------

els.emptyPickBtn.addEventListener("click", () => void pickTorrent());
els.emptyEditBtn.addEventListener("click", () => setEditMode(true));
els.openTorrentBtn.addEventListener("click", () => void pickTorrent());
els.editToggleBtn.addEventListener("click", () => {
	setEditMode(!view.editMode);
});
els.addDestBtn.addEventListener("click", () => openEditor(null));
els.editorCancel.addEventListener("click", closeEditor);
els.editorDelete.addEventListener("click", () => void onDelete());
els.form.addEventListener("submit", (e) => {
	e.preventDefault();
	void onSave();
});
els.fKind.addEventListener("change", showKindFields);
els.assocBtn.addEventListener("click", () => void toggleAssoc());
els.updateBtn.addEventListener("click", () => void onUpdateClick());

document.addEventListener("keydown", (e) => {
	if (view.pending) return;
	if (view.overlayOpen) {
		if (e.key === "Escape") {
			closeEditor();
			e.preventDefault();
		}
		return;
	}
	if (e.key === "Escape") {
		if (view.editMode) {
			setEditMode(false);
			e.preventDefault();
			return;
		}
		void rpc.request.closeWindow();
		return;
	}
	if (!view.torrent) {
		if (e.key === "Enter" || e.key === " ") {
			void pickTorrent();
			e.preventDefault();
		}
		return;
	}
	if (view.editMode) return;
	if (e.key === "ArrowDown") {
		moveSelection(1);
		e.preventDefault();
		return;
	}
	if (e.key === "ArrowUp") {
		moveSelection(-1);
		e.preventDefault();
		return;
	}
	if (e.key === "Enter") {
		const dest = view.config.destinations[view.selectedIndex];
		if (dest) void upload(dest);
		e.preventDefault();
		return;
	}
	const digit = Number(e.key);
	if (Number.isInteger(digit) && digit >= 1 && digit <= 9) {
		const dest = view.config.destinations[digit - 1];
		if (dest) {
			view.selectedIndex = digit - 1;
			void upload(dest);
			e.preventDefault();
		}
	}
});

function moveSelection(delta: number): void {
	const count = view.config.destinations.length;
	if (count === 0) return;
	view.selectedIndex = (view.selectedIndex + delta + count) % count;
	render();
}

// ---- Torrent picking + upload --------------------------------------------

async function pickTorrent(): Promise<void> {
	if (view.pickerOpen) return;
	view.pickerOpen = true;
	els.openTorrentBtn.disabled = true;
	els.emptyPickBtn.disabled = true;
	try {
		const torrent = await rpc.request.pickTorrent();
		if (torrent) {
			view.torrent = torrent;
			render();
		}
	} catch (err) {
		showToast(`Open failed: ${(err as Error).message}`, "err");
	} finally {
		els.openTorrentBtn.disabled = false;
		els.emptyPickBtn.disabled = false;
		view.pickerOpen = false;
	}
}

async function upload(dest: Destination): Promise<void> {
	if (view.pending) return;
	view.pending = true;
	showToast(`Sending to ${dest.name}…`, "info");
	const result = await rpc.request.upload({ destinationId: dest.id });
	if (result.ok) {
		showToast(result.message ?? `Sent to ${dest.name}`, "ok");
		setTimeout(() => void rpc.request.closeWindow(), 900);
	} else {
		view.pending = false;
		showToast(result.error ?? "Upload failed", "err");
	}
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
function showToast(msg: string, kind: "ok" | "err" | "info"): void {
	els.toast.textContent = msg;
	els.toast.className = `toast ${kind === "err" ? "err" : ""}`.trim();
	els.toast.hidden = false;
	if (toastTimer) clearTimeout(toastTimer);
	if (kind !== "ok") {
		toastTimer = setTimeout(() => {
			els.toast.hidden = true;
		}, 4000);
	}
}

// ---- Edit mode toggle ----------------------------------------------------

function setEditMode(on: boolean): void {
	view.editMode = on;
	if (!on && view.overlayOpen) closeEditor();
	els.editToggleBtn.setAttribute("aria-pressed", String(on));
	els.editToggleBtn.title = on ? "Done editing" : "Edit destinations";
	els.editToggleBtn.textContent = on ? "✓" : "⚙";
	if (!view.torrent) {
		// In empty state, edit-mode means "show the loaded UI so user can manage
		// destinations without picking a torrent first".
		if (on) {
			showLoadedState();
			els.list.classList.add("editing");
			els.addDestBtn.hidden = false;
			renderList();
			renderFooter();
		} else {
			showEmptyState();
		}
		return;
	}
	if (on) {
		els.list.classList.add("editing");
		els.addDestBtn.hidden = false;
	} else {
		els.list.classList.remove("editing");
		els.addDestBtn.hidden = true;
	}
	renderList();
	renderFooter();
}

// ---- Editor (inline overlay) --------------------------------------------

const NEW_ROW_ID = "__new__";

function openEditor(id: string | null): void {
	// Close any currently-open drawer first (to enforce one-open-at-a-time).
	if (view.overlayOpen) closeEditor();

	const targetId = id ?? NEW_ROW_ID;
	view.editingId = id;
	view.overlayOpen = true;

	// For "add new" we need to insert a placeholder row at the end of the
	// destinations list. The list renderer already creates rows for real
	// destinations; new is appended directly here.
	let li: HTMLLIElement | null;
	if (id === null) {
		li = document.createElement("li");
		li.className = "dest-row";
		li.dataset["id"] = NEW_ROW_ID;
		const summary = document.createElement("div");
		summary.className = "dest";
		const hotkey = document.createElement("span");
		hotkey.className = "hotkey";
		hotkey.textContent = "+";
		const body = document.createElement("div");
		body.className = "body";
		const nameEl = document.createElement("div");
		nameEl.className = "name muted";
		nameEl.textContent = "New destination";
		const subEl = document.createElement("div");
		subEl.className = "sub";
		subEl.textContent = "Fill in the form below and save";
		body.append(nameEl, subEl);
		summary.append(hotkey, body);
		const slot = document.createElement("div");
		slot.className = "dest-drawer-slot";
		li.append(summary, slot);
		els.list.appendChild(li);
		els.list.hidden = false;
		els.emptyList.hidden = true;
	} else {
		li = els.list.querySelector<HTMLLIElement>(
			`li[data-id="${cssEscape(targetId)}"]`,
		);
	}
	if (!li) return;

	const slot = li.querySelector<HTMLElement>(".dest-drawer-slot");
	if (!slot) return;

	const dest = id
		? view.config.destinations.find((d) => d.id === id) ?? null
		: null;
	els.editorDelete.hidden = !dest;
	els.fName.value = dest?.name ?? "";
	els.fKind.value = dest?.kind ?? "post-url";
	resetFormFields();
	if (dest) populateForm(dest);
	showKindFields();

	slot.appendChild(els.form);
	els.form.hidden = false;
	// Trigger the grid-template-rows transition.
	requestAnimationFrame(() => {
		li!.classList.add("expanded");
		els.fName.focus();
	});
}

function closeEditor(): void {
	if (!view.overlayOpen) return;
	const li = els.list.querySelector<HTMLLIElement>("li.expanded");
	const wasNew = view.editingId === null;
	view.overlayOpen = false;
	view.editingId = null;

	if (li) {
		li.classList.remove("expanded");
		// Wait for the collapse transition before tearing down.
		const cleanup = () => {
			els.form.hidden = true;
			document.body.appendChild(els.form);
			if (wasNew) {
				li
					.querySelector<HTMLLIElement>(`li[data-id="${NEW_ROW_ID}"]`)
					?.remove();
				const temp = els.list.querySelector(`li[data-id="${NEW_ROW_ID}"]`);
				temp?.remove();
			}
		};
		setTimeout(cleanup, 200);
	} else {
		els.form.hidden = true;
		document.body.appendChild(els.form);
	}
}

// CSS.escape polyfill — webview should already have CSS.escape but be safe.
function cssEscape(s: string): string {
	if (typeof (globalThis as unknown as { CSS?: { escape?: (s: string) => string } }).CSS?.escape === "function") {
		return (globalThis as unknown as { CSS: { escape: (s: string) => string } }).CSS.escape(s);
	}
	return s.replace(/["\\]/g, "\\$&");
}

function resetFormFields(): void {
	els.puUrl.value = "";
	els.puField.value = "";
	els.puHeaders.value = "";
	els.puExtra.value = "";
	els.puInsecure.checked = false;
	els.dwUrl.value = "";
	els.dwPass.value = "";
	els.dwLoc.value = "";
	els.dwPaused.checked = false;
	els.dwInsecure.checked = false;
	els.qbUrl.value = "";
	els.qbUser.value = "";
	els.qbPass.value = "";
	els.qbCat.value = "";
	els.qbLoc.value = "";
	els.qbPaused.checked = false;
	els.qbInsecure.checked = false;
	els.trUrl.value = "";
	els.trUser.value = "";
	els.trPass.value = "";
	els.trLoc.value = "";
	els.trPaused.checked = false;
	els.trInsecure.checked = false;
	els.rtUrl.value = "";
	els.rtUser.value = "";
	els.rtPass.value = "";
	els.rtLabel.value = "";
	els.rtLoc.value = "";
	els.rtPaused.checked = false;
	els.rtInsecure.checked = false;
	els.utUrl.value = "";
	els.utUser.value = "";
	els.utPass.value = "";
	els.utInsecure.checked = false;
	els.ddHost.value = "";
	els.ddPort.value = "58846";
	els.ddUser.value = "";
	els.ddPass.value = "";
	els.ddLoc.value = "";
	els.ddProto.value = "auto";
	els.ddPaused.checked = false;
	els.ddInsecure.checked = false;
}

function populateForm(d: Destination): void {
	switch (d.kind) {
		case "post-url":
			els.puUrl.value = d.url;
			els.puField.value = d.formField ?? "";
			els.puHeaders.value = recordToLines(d.headers, ": ");
			els.puExtra.value = recordToLines(d.extraFields, "=");
			els.puInsecure.checked = !!d.insecure;
			return;
		case "deluge-web":
			els.dwUrl.value = d.url;
			els.dwPass.value = d.password;
			els.dwLoc.value = d.downloadLocation ?? "";
			els.dwPaused.checked = !!d.addPaused;
			els.dwInsecure.checked = !!d.insecure;
			return;
		case "deluge-daemon":
			els.ddHost.value = d.host;
			els.ddPort.value = String(d.port);
			els.ddUser.value = d.username;
			els.ddPass.value = d.password;
			els.ddLoc.value = d.downloadLocation ?? "";
			els.ddProto.value =
				d.protocolVersion === undefined ? "auto" : String(d.protocolVersion);
			els.ddPaused.checked = !!d.addPaused;
			els.ddInsecure.checked = !!d.insecure;
			return;
		case "qbittorrent":
			els.qbUrl.value = d.url;
			els.qbUser.value = d.username ?? "";
			els.qbPass.value = d.password ?? "";
			els.qbCat.value = d.category ?? "";
			els.qbLoc.value = d.downloadLocation ?? "";
			els.qbPaused.checked = !!d.addPaused;
			els.qbInsecure.checked = !!d.insecure;
			return;
		case "transmission":
			els.trUrl.value = d.url;
			els.trUser.value = d.username ?? "";
			els.trPass.value = d.password ?? "";
			els.trLoc.value = d.downloadLocation ?? "";
			els.trPaused.checked = !!d.addPaused;
			els.trInsecure.checked = !!d.insecure;
			return;
		case "rutorrent":
			els.rtUrl.value = d.url;
			els.rtUser.value = d.username ?? "";
			els.rtPass.value = d.password ?? "";
			els.rtLabel.value = d.label ?? "";
			els.rtLoc.value = d.downloadLocation ?? "";
			els.rtPaused.checked = !!d.addPaused;
			els.rtInsecure.checked = !!d.insecure;
			return;
		case "utorrent":
			els.utUrl.value = d.url;
			els.utUser.value = d.username;
			els.utPass.value = d.password;
			els.utInsecure.checked = !!d.insecure;
			return;
	}
}

function showKindFields(): void {
	const kind = els.fKind.value;
	els.form
		.querySelectorAll<HTMLElement>("[data-fields]")
		.forEach((node) => {
			node.hidden = node.dataset["fields"] !== kind;
		});
}

function recordToLines(
	rec: Record<string, string> | undefined,
	sep: string,
): string {
	if (!rec) return "";
	return Object.entries(rec)
		.map(([k, v]) => `${k}${sep}${v}`)
		.join("\n");
}

function linesToRecord(
	text: string,
	sep: string,
): Record<string, string> | undefined {
	const out: Record<string, string> = {};
	let any = false;
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line) continue;
		const idx = line.indexOf(sep);
		if (idx < 0) continue;
		const k = line.slice(0, idx).trim();
		const v = line.slice(idx + sep.length).trim();
		if (!k) continue;
		out[k] = v;
		any = true;
	}
	return any ? out : undefined;
}

async function onSave(): Promise<void> {
	const wasNew = view.editingId === null;
	const name = els.fName.value.trim();
	if (!name) {
		els.fName.focus();
		return;
	}
	const kind = els.fKind.value as DestinationKind;
	const id = view.editingId ?? cryptoRandomId();
	let dest: Destination;
	switch (kind) {
		case "post-url": {
			const url = els.puUrl.value.trim();
			if (!url) return;
			const built: PostUrlDestination = { id, name, kind: "post-url", url };
			const field = els.puField.value.trim();
			if (field) built.formField = field;
			const headers = linesToRecord(els.puHeaders.value, ":");
			if (headers) built.headers = headers;
			const extra = linesToRecord(els.puExtra.value, "=");
			if (extra) built.extraFields = extra;
			if (els.puInsecure.checked) built.insecure = true;
			dest = built;
			break;
		}
		case "deluge-web": {
			const url = els.dwUrl.value.trim();
			if (!url) return;
			const built: DelugeWebDestination = {
				id,
				name,
				kind: "deluge-web",
				url,
				password: els.dwPass.value,
			};
			const loc = els.dwLoc.value.trim();
			if (loc) built.downloadLocation = loc;
			if (els.dwPaused.checked) built.addPaused = true;
			if (els.dwInsecure.checked) built.insecure = true;
			dest = built;
			break;
		}
		case "deluge-daemon": {
			const host = els.ddHost.value.trim();
			if (!host) return;
			const protoRaw = els.ddProto.value;
			const protocolVersion: 0 | 1 | "auto" =
				protoRaw === "0" ? 0 : protoRaw === "1" ? 1 : "auto";
			const built: DelugeDaemonDestination = {
				id,
				name,
				kind: "deluge-daemon",
				host,
				port: Number(els.ddPort.value) || 58846,
				username: els.ddUser.value,
				password: els.ddPass.value,
				protocolVersion,
			};
			const loc = els.ddLoc.value.trim();
			if (loc) built.downloadLocation = loc;
			if (els.ddPaused.checked) built.addPaused = true;
			if (els.ddInsecure.checked) built.insecure = true;
			dest = built;
			break;
		}
		case "qbittorrent": {
			const url = els.qbUrl.value.trim();
			if (!url) return;
			const built: QbittorrentDestination = {
				id,
				name,
				kind: "qbittorrent",
				url,
			};
			const user = els.qbUser.value.trim();
			if (user) {
				built.username = user;
				built.password = els.qbPass.value;
			}
			const cat = els.qbCat.value.trim();
			if (cat) built.category = cat;
			const loc = els.qbLoc.value.trim();
			if (loc) built.downloadLocation = loc;
			if (els.qbPaused.checked) built.addPaused = true;
			if (els.qbInsecure.checked) built.insecure = true;
			dest = built;
			break;
		}
		case "transmission": {
			const url = els.trUrl.value.trim();
			if (!url) return;
			const built: TransmissionDestination = {
				id,
				name,
				kind: "transmission",
				url,
			};
			const user = els.trUser.value.trim();
			if (user) {
				built.username = user;
				built.password = els.trPass.value;
			}
			const loc = els.trLoc.value.trim();
			if (loc) built.downloadLocation = loc;
			if (els.trPaused.checked) built.addPaused = true;
			if (els.trInsecure.checked) built.insecure = true;
			dest = built;
			break;
		}
		case "rutorrent": {
			const url = els.rtUrl.value.trim();
			if (!url) return;
			const built: RutorrentDestination = {
				id,
				name,
				kind: "rutorrent",
				url,
			};
			const user = els.rtUser.value.trim();
			if (user) {
				built.username = user;
				built.password = els.rtPass.value;
			}
			const label = els.rtLabel.value.trim();
			if (label) built.label = label;
			const loc = els.rtLoc.value.trim();
			if (loc) built.downloadLocation = loc;
			if (els.rtPaused.checked) built.addPaused = true;
			if (els.rtInsecure.checked) built.insecure = true;
			dest = built;
			break;
		}
		case "utorrent": {
			const url = els.utUrl.value.trim();
			if (!url) return;
			const built: UtorrentDestination = {
				id,
				name,
				kind: "utorrent",
				url,
				username: els.utUser.value,
				password: els.utPass.value,
			};
			if (els.utInsecure.checked) built.insecure = true;
			dest = built;
			break;
		}
	}
	const existing = Array.isArray(view.config.destinations)
		? view.config.destinations
		: [];
	const destinations = view.editingId
		? existing.map((d) => (d.id === view.editingId ? dest : d))
		: [...existing, dest];
	const config: Config = { ...view.config, destinations };
	await rpc.request.saveConfig({ config });
	view.config = config;
	closeEditor();
	// renderList rebuilds from view.config, dropping any temp NEW_ROW_ID node.
	if (wasNew) {
		els.list.querySelector(`li[data-id="${NEW_ROW_ID}"]`)?.remove();
	}
	renderList();
}

async function onDelete(): Promise<void> {
	if (!view.editingId) return;
	const id = view.editingId;
	const destinations = view.config.destinations.filter((d) => d.id !== id);
	const config: Config = { ...view.config, destinations };
	if (config.lastUsedId === id) delete config.lastUsedId;
	await rpc.request.saveConfig({ config });
	view.config = config;
	closeEditor();
	renderList();
}

function cryptoRandomId(): string {
	const bytes = new Uint8Array(8);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- File association (footer button in edit mode) ----------------------

async function toggleAssoc(): Promise<void> {
	const cur = view.fileAssociation;
	if (!cur || !cur.supported) return;
	els.assocBtn.disabled = true;
	try {
		const next = cur.installed
			? await rpc.request.uninstallFileAssociation()
			: await rpc.request.installFileAssociation();
		view.fileAssociation = next;
		renderFooter();
		showToast(
			next.installed
				? "File association installed"
				: "File association removed",
			"ok",
		);
	} catch (err) {
		showToast(`Association change failed: ${(err as Error).message}`, "err");
	} finally {
		els.assocBtn.disabled = false;
	}
}

// ---- Self-update affordance (footer button) -----------------------------

async function onUpdateClick(): Promise<void> {
	const u = view.update;
	if (!u) return;
	if (u.phase === "error" && !u.updateAvailable) {
		// Nothing downloaded yet — a failed check. Re-check.
		await rpc.request.checkForUpdate();
		return;
	}
	if (u.phase === "available" || u.phase === "error") {
		// Kick off download + install. Progress arrives via updateChanged
		// messages; on success the app relaunches into the new version.
		void rpc.request.installUpdate().then((res) => {
			if (!res.ok && res.error) showToast(`Update failed: ${res.error}`, "err");
		});
	}
}

function renderUpdate(): void {
	const u = view.update;
	const btn = els.updateBtn;
	if (!u || !u.supported) {
		btn.hidden = true;
		return;
	}
	switch (u.phase) {
		case "available":
			btn.hidden = false;
			btn.disabled = false;
			btn.textContent = u.latestVersion
				? `⬆ Update to v${u.latestVersion}`
				: "⬆ Update available";
			btn.title = "Download and install the update, then restart";
			break;
		case "downloading":
			btn.hidden = false;
			btn.disabled = true;
			btn.textContent =
				u.progress !== undefined
					? `Downloading update… ${u.progress}%`
					: "Downloading update…";
			btn.title = u.detail ?? "";
			break;
		case "installing":
			btn.hidden = false;
			btn.disabled = true;
			btn.textContent = "Installing… app will restart";
			btn.title = u.detail ?? "";
			break;
		case "error":
			btn.hidden = false;
			btn.disabled = false;
			btn.textContent = u.updateAvailable
				? "⚠ Update failed — retry"
				: "⚠ Update check failed — retry";
			btn.title = u.detail ?? "";
			break;
		default:
			// idle / checking — nothing worth showing.
			btn.hidden = true;
	}
}

function renderFooter(): void {
	const s = view.fileAssociation;
	if (view.editMode && s && s.supported) {
		els.hint.hidden = true;
		els.assocBtn.hidden = false;
		els.assocBtn.disabled = false;
		els.assocBtn.textContent = s.installed
			? "✓ File association installed"
			: "Install .torrent association";
		if (s.detail) els.assocBtn.title = s.detail;
	} else if (view.editMode) {
		// Edit mode on an unsupported platform — show platform note instead.
		els.hint.hidden = false;
		els.hint.textContent = s?.detail ?? "Drag to reorder · click Edit on a row";
		els.assocBtn.hidden = true;
	} else {
		els.hint.hidden = false;
		els.hint.textContent =
			"↑↓ navigate · Enter to send · 1-9 quick pick";
		els.assocBtn.hidden = true;
	}
}

// ---- Live drag-and-drop reorder (no blue indicator) ---------------------

let dragEl: HTMLLIElement | null = null;

async function persistOrderFromDOM(): Promise<void> {
	const ids = Array.from(els.list.children)
		.map((li) => (li as HTMLElement).dataset["id"])
		.filter((id): id is string => !!id);
	// Defensive: dedupe in case the DOM ever ends up with two rows pointing
	// at the same destination id, and skip our temp NEW_ROW_ID placeholder.
	const seen = new Set<string>();
	const reordered: Destination[] = [];
	for (const id of ids) {
		if (id === NEW_ROW_ID || seen.has(id)) continue;
		seen.add(id);
		const d = view.config.destinations.find((d) => d.id === id);
		if (d) reordered.push(d);
	}
	if (
		reordered.length === view.config.destinations.length &&
		reordered.every((d, i) => d.id === view.config.destinations[i]?.id)
	) {
		return; // unchanged
	}
	const config: Config = { ...view.config, destinations: reordered };
	await rpc.request.saveConfig({ config });
	view.config = config;
}

els.list.addEventListener("dragover", (e) => {
	if (!dragEl || !view.editMode) return;
	e.preventDefault();
	if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
	const target = (e.target as HTMLElement | null)?.closest(
		"li[data-id]",
	) as HTMLLIElement | null;
	if (!target || target === dragEl) return;
	const rect = target.getBoundingClientRect();
	const after = e.clientY > rect.top + rect.height / 2;
	if (after) {
		target.parentNode?.insertBefore(dragEl, target.nextSibling);
	} else {
		target.parentNode?.insertBefore(dragEl, target);
	}
});

// ---- Render --------------------------------------------------------------

function render(): void {
	if (!view.torrent && !view.editMode) {
		showEmptyState();
		return;
	}
	showLoadedState();

	if (view.torrent) {
		els.name.textContent = view.torrent.name ?? view.torrent.filename;
		els.meta.textContent = `${humanSize(view.torrent.size)} · ${
			view.torrent.filename
		}`;
	} else {
		// Edit mode without a torrent — header shows a "managing destinations"
		// hint instead of torrent info.
		els.name.textContent = "Manage destinations";
		els.meta.textContent = "No torrent loaded";
	}

	renderList();
	renderFooter();
	renderUpdate();
}

let currentState: "empty" | "loaded" | null = null;
function showEmptyState(): void {
	if (currentState === "empty") return;
	currentState = "empty";
	els.loadedState.hidden = true;
	els.emptyState.hidden = false;
	els.emptyState.style.animation = "none";
	void els.emptyState.offsetWidth;
	els.emptyState.style.animation = "";
}
function showLoadedState(): void {
	if (currentState === "loaded") return;
	currentState = "loaded";
	els.emptyState.hidden = true;
	els.loadedState.hidden = false;
	els.loadedState.style.animation = "none";
	void els.loadedState.offsetWidth;
	els.loadedState.style.animation = "";
}

function renderList(): void {
	const destinations = view.config.destinations;
	if (destinations.length === 0) {
		els.list.hidden = true;
		els.emptyList.hidden = !view.editMode ? false : true;
		els.addDestBtn.hidden = !view.editMode;
		return;
	}
	els.list.hidden = false;
	els.emptyList.hidden = true;
	els.addDestBtn.hidden = !view.editMode;
	if (view.selectedIndex >= destinations.length) view.selectedIndex = 0;
	els.list.replaceChildren(
		...destinations.map((d, i) => renderRow(d, i)),
	);
}

function renderRow(dest: Destination, index: number): HTMLLIElement {
	const li = document.createElement("li");
	li.className = "dest-row";
	li.dataset["id"] = dest.id;
	li.style.animationDelay = `${Math.min(index, 8) * 25}ms`;

	const btn = document.createElement("button");
	btn.type = "button";
	btn.className = "dest";
	btn.setAttribute("aria-selected", String(index === view.selectedIndex));

	if (view.editMode) {
		const handle = document.createElement("span");
		handle.className = "drag-handle";
		handle.textContent = "⋮⋮";
		handle.title = "Drag to reorder";
		btn.append(handle);
	} else {
		const hotkey = document.createElement("span");
		hotkey.className = "hotkey";
		hotkey.textContent = index < 9 ? String(index + 1) : "·";
		btn.append(hotkey);
	}

	const body = document.createElement("div");
	body.className = "body";
	const name = document.createElement("div");
	name.className = "name";
	name.textContent = dest.name;
	const sub = document.createElement("div");
	sub.className = "sub";
	const pre = view.preflight.get(dest.id);
	sub.textContent = describeDest(dest, pre);
	body.append(name, sub);
	btn.append(body);

	// Auto-start toggle for destinations that support add-paused, in view
	// mode (the upload-mode list). CSS hides it on narrow windows. Click is
	// stopPropagated so it doesn't trigger the row's upload action.
	if (!view.editMode && supportsAddPaused(dest)) {
		const auto = document.createElement("label");
		auto.className = "autostart-toggle";
		auto.title = "Auto-start (toggle off to add paused)";
		const cb = document.createElement("input");
		cb.type = "checkbox";
		cb.className = "toggle-input";
		cb.checked = !dest.addPaused;
		const track = document.createElement("span");
		track.className = "toggle-track";
		const thumb = document.createElement("span");
		thumb.className = "toggle-thumb";
		track.append(thumb);
		const lbl = document.createElement("span");
		lbl.className = "toggle-label";
		lbl.textContent = "auto-start";
		const stop = (e: Event) => e.stopPropagation();
		auto.addEventListener("click", stop);
		cb.addEventListener("change", (e) => {
			e.stopPropagation();
			void setAddPaused(dest.id, !cb.checked);
		});
		auto.append(cb, track, lbl);
		btn.append(auto);
	}

	if (view.editMode) {
		const edit = document.createElement("button");
		edit.type = "button";
		edit.className = "row-action";
		edit.textContent = "Edit";
		edit.addEventListener("click", (e) => {
			e.stopPropagation();
			openEditor(dest.id);
		});
		const del = document.createElement("button");
		del.type = "button";
		del.className = "row-action";
		del.textContent = "Delete";
		del.addEventListener("click", (e) => {
			e.stopPropagation();
			void deleteDest(dest.id);
		});
		btn.append(edit, del);
	} else {
		const status = document.createElement("span");
		status.className = "status";
		if (pre) {
			status.classList.add(pre.ok ? "ok" : "err");
			if (pre.detail) status.title = pre.detail;
		}
		btn.append(status);
	}

	if (view.editMode) {
		li.draggable = true;
		li.addEventListener("dragstart", (e) => {
			dragEl = li;
			li.classList.add("dragging");
			if (e.dataTransfer) {
				e.dataTransfer.effectAllowed = "move";
				e.dataTransfer.setData("text/plain", dest.id);
				// Kill the default HTML5 drag image (which renders a faded
				// copy of the dragged element following the cursor). The row
				// itself moves live via insertBefore during dragover, so the
				// ghost is redundant and reads as a "duplicate row".
				const empty = document.createElement("canvas");
				empty.width = 1;
				empty.height = 1;
				e.dataTransfer.setDragImage(empty, 0, 0);
			}
		});
		li.addEventListener("dragend", () => {
			li.classList.remove("dragging");
			if (dragEl) {
				dragEl = null;
				void persistOrderFromDOM();
			}
		});
	} else {
		btn.addEventListener("click", () => {
			view.selectedIndex = index;
			void upload(dest);
		});
	}

	const drawerSlot = document.createElement("div");
	drawerSlot.className = "dest-drawer-slot";

	li.append(btn, drawerSlot);
	return li;
}

async function deleteDest(id: string): Promise<void> {
	const destinations = view.config.destinations.filter((d) => d.id !== id);
	const config: Config = { ...view.config, destinations };
	if (config.lastUsedId === id) delete config.lastUsedId;
	await rpc.request.saveConfig({ config });
	view.config = config;
	renderList();
}

function describeDest(d: Destination, pre?: PreflightStatus): string {
	const v = pre?.version ? ` · v${pre.version}` : "";
	switch (d.kind) {
		case "post-url":
			return `POST · ${d.url}${v}`;
		case "deluge-web": {
			const loc = d.downloadLocation ?? pre?.defaultDownloadLocation;
			return `Deluge WebUI · ${d.url}${loc ? ` → ${loc}` : ""}${v}`;
		}
		case "deluge-daemon": {
			const loc = d.downloadLocation ?? pre?.defaultDownloadLocation;
			return `Deluge daemon · ${d.host}:${d.port}${
				loc ? ` → ${loc}` : ""
			}${v}`;
		}
		case "qbittorrent": {
			const loc = d.downloadLocation ?? pre?.defaultDownloadLocation;
			return `qBittorrent · ${d.url}${loc ? ` → ${loc}` : ""}${v}`;
		}
		case "transmission": {
			const loc = d.downloadLocation ?? pre?.defaultDownloadLocation;
			return `Transmission · ${d.url}${loc ? ` → ${loc}` : ""}${v}`;
		}
		case "rutorrent":
			return `ruTorrent · ${d.url}${
				d.downloadLocation ? ` → ${d.downloadLocation}` : ""
			}`;
		case "utorrent":
			return `µTorrent · ${d.url}`;
	}
}

function supportsAddPaused(
	d: Destination,
): d is Destination & { addPaused?: boolean } {
	return (
		d.kind === "deluge-daemon" ||
		d.kind === "deluge-web" ||
		d.kind === "qbittorrent" ||
		d.kind === "transmission" ||
		d.kind === "rutorrent"
	);
}

async function setAddPaused(id: string, addPaused: boolean): Promise<void> {
	const destinations = view.config.destinations.map((d) => {
		if (d.id !== id) return d;
		if (supportsAddPaused(d)) {
			return { ...d, addPaused };
		}
		return d;
	});
	const config: Config = { ...view.config, destinations };
	await rpc.request.saveConfig({ config });
	view.config = config;
}

function humanSize(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
	return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// ---- Bootstrap -----------------------------------------------------------

function vlog(msg: string): void {
	void rpc.request.logToBun({ msg: `mainview: ${msg}` }).catch(() => {});
}

(async () => {
	const initial: InitialState = await rpc.request.getInitialState();
	view.torrent = initial.torrent;
	view.config = initial.config;
	view.fileAssociation = initial.fileAssociation;
	view.update = initial.update;
	for (const p of initial.preflight) view.preflight.set(p.destinationId, p);
	if (view.config.lastUsedId) {
		const idx = view.config.destinations.findIndex(
			(d) => d.id === view.config.lastUsedId,
		);
		if (idx >= 0) view.selectedIndex = idx;
	}
	render();

	if (view.config.destinations.length === 0) {
		setEditMode(true);
	}

	vlog(
		`bootstrap done: editMode=${view.editMode} overlayOpen=${view.overlayOpen}`,
	);

	const initialW = window.innerWidth;
	const initialH = window.innerHeight;
	window.addEventListener("resize", () => {
		if (window.innerWidth < initialW - 4) {
			document.documentElement.style.setProperty("--safe-right", "0px");
		}
		if (window.innerHeight < initialH - 4) {
			document.documentElement.style.setProperty("--safe-bottom", "0px");
		}
	});
})();
