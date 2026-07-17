export function joinUrl(base: string, path: string): string {
	const b = base.endsWith("/") ? base.slice(0, -1) : base;
	const p = path.startsWith("/") ? path : `/${path}`;
	return `${b}${p}`;
}

export function basicAuthHeaders(
	username?: string,
	password?: string,
): Record<string, string> {
	if (!username && !password) return {};
	const cred = Buffer.from(`${username ?? ""}:${password ?? ""}`).toString(
		"base64",
	);
	return { Authorization: `Basic ${cred}` };
}
