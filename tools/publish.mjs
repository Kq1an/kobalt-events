// The publishing robot: run by GitHub when you commit an update into updates/. Checks each update with the same rules the mod uses,
// merges it into the feed, signs the feed with the key kept in this repo's secret vault (FEED_SIGNING_KEY), and files the update in
// updates/done (or updates/rejected, with a note saying what was wrong). No packages: just Node.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const FEED = "kobalt-feed.json", INBOX = "updates", DONE = "updates/done", BAD = "updates/rejected";
const MAX_EVENTS = 40, MAX_LOOKS = 150, MAX_NEWS = 100, MAX_UPDATE = 200 * 1024, MAX_FEED = 1024 * 1024;

// what the mod can count, which models a look can be made from (keep in step with trophy/Feed.java)
const TASKS = new Set(["mined", "ores", "ore_diamond", "ore_debris", "ore_iron", "ore_gold", "ore_coal", "mined.night", "mined.deepslate", "mined.nether",
	"mined.end", "mined.log", "placed", "builds", "areas", "steps", "plans", "amt.CRAFT", "amt.SMELT", "amt.FISH", "amt.FARM", "amt.BREED", "amt.TRADE",
	"amt.BARTER", "amt.BREW", "step.ENCHANT", "step.GO_TO", "kills", "kill.zombie", "kill.skeleton", "kill.creeper", "kill.enderman", "dragon", "days",
	"nights", "meals", "escapes", "fights", "pets", "tricks", "chats"]);
const HEADS = new Set(["beanie", "bucket_hat", "earmuffs", "bunny_ears", "party", "santa", "pumpkin", "hacker_mask", "heart_antenna"]);
const LAPTOPS = new Set(["silver", "gamer", "white_beast", "pumpkin_laptop"]);
const BUILT_IN = new Set(["auto", "none", "santa", "pumpkin", "party", "beanie", "hacker_mask", "heart_antenna", "bunny_ears", "bucket_hat", "earmuffs",
	"silver", "gamer", "pumpkin_laptop", "white_beast", "theme", "shadow"]);
const RARITY = new Set(["copper", "iron", "gold", "diamond", "netherite", "bedrock"]);
const KINDS = new Set(["update", "cosmetic", "event", "notice"]);
const ID = /^[a-z0-9][a-z0-9-]{0,47}$/, COLOR = /^#[0-9a-fA-F]{6}$/, ITEM = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/;

/** Plain text the way the mod shows it: no control characters, colour codes or emoji; at most n characters. */
function text(s, n, lines) {
	let out = "";
	for (const ch of String(s ?? "")) {
		const c = ch.codePointAt(0);
		if (ch === "\n" && lines) out += ch;
		else if (c >= 32 && c !== 0xA7 && c !== 0x7F && c <= 0xFFFF && !(c >= 0xD800 && c <= 0xDFFF)) out += ch;
		if (out.length >= n) break;
	}
	return out.trim();
}

function fail(what) {
	throw new Error(what);
}

function pixels(p, maxW, maxH, what) {
	if (!p || typeof p !== "object") fail(what + ": missing picture");
	const w = p.w | 0, h = p.h | 0, pal = p.palette, px = String(p.px ?? "");
	if (w < 1 || h < 1 || w > maxW || h > maxH) fail(what + ": must be at most " + maxW + " x " + maxH);
	if (!Array.isArray(pal) || pal.length < 1 || pal.length > 16 || !pal.every(c => COLOR.test(c))) fail(what + ": 1 to 16 colours like #ff8800");
	if (px.length !== w * h || ![...px].every(ch => ch === "." || (ch >= "a" && ch.charCodeAt(0) < 97 + pal.length))) fail(what + ": the pixels don't match the picture's size or colours");
	return {w, h, palette: pal.map(c => c.toLowerCase()), px};
}

function look(d) {
	if (!d || !ID.test(d.id ?? "") || BUILT_IN.has(d.id)) fail("a look needs an id of lowercase letters, numbers and dashes (and not a built-in one)");
	const slot = String(d.slot ?? "").toUpperCase(), name = text(d.name, 40), rarity = String(d.rarity ?? "").toLowerCase();
	if (!name) fail("look " + d.id + ": needs a name");
	if (!RARITY.has(rarity)) fail("look " + d.id + ": rarity must be copper, iron, gold, diamond, netherite or bedrock");
	const out = {id: d.id, name, slot, rarity, description: text(d.description, 120), icon: ITEM.test(d.icon ?? "") ? d.icon : "minecraft:paper"};
	const colors = (Array.isArray(d.colors) ? d.colors : []).slice(0, 6).map(c => COLOR.test(c) ? c.toLowerCase() : "#000000");
	if (slot === "HEAD") {
		if (!HEADS.has(d.base)) fail("look " + d.id + ": unknown hat model");
		Object.assign(out, {base: d.base, colors});
	} else if (slot === "LAPTOP") {
		if (!LAPTOPS.has(d.base)) fail("look " + d.id + ": unknown laptop model");
		Object.assign(out, {base: d.base, colors});
		if (d.lid) out.lid = pixels(d.lid, 24, 16, "look " + d.id + " lid picture");
		if (d.screen) out.screen = pixels(d.screen, 24, 16, "look " + d.id + " screen picture");
	} else if (slot === "OUTFIT") {
		if (colors.length < 3) fail("look " + d.id + ": an outfit needs 3 colours (body, trim, eyes)");
		Object.assign(out, {base: "custom", colors});
	} else if (slot === "STICKER") out.sticker = pixels(d.sticker, 16, 16, "look " + d.id + " sticker");
	else fail("look " + d.id + ": kind must be HEAD, LAPTOP, OUTFIT or STICKER");
	if (d.retired) out.retired = true;
	return out;
}

function event(d, looks) {
	if (!d || !ID.test(d.id ?? "")) fail("a challenge needs an id of lowercase letters, numbers and dashes");
	const title = text(d.title, 48);
	if (!title) fail("challenge " + d.id + ": needs a title");
	if (!TASKS.has(d.task)) fail("challenge " + d.id + ": unknown task " + d.task);
	const goal = Number(d.goal);
	if (!Number.isInteger(goal) || goal < 1 || goal > 1e9) fail("challenge " + d.id + ": the amount must be a whole number from 1 to 1,000,000,000");
	const s = Date.parse(d.start), e = Date.parse(d.end);
	if (!(s > 0) || !(e > s)) fail("challenge " + d.id + ": needs a start and an end after it");
	if (e - s > 366 * 86400000) fail("challenge " + d.id + ": can last at most a year");
	const rewards = (Array.isArray(d.rewards) ? d.rewards : []).filter(r => looks.has(r) || BUILT_IN.has(r)).slice(0, 4);
	return {id: d.id, title, description: text(d.description, 300), theme: COLOR.test(d.theme ?? "") ? d.theme.toLowerCase() : "#5b8cff",
		start: new Date(s).toISOString(), end: new Date(e).toISOString(), task: d.task, goal, icon: ITEM.test(d.icon ?? "") ? d.icon : "minecraft:clock",
		rewards, featured: !!d.featured};
}

function post(d) {
	if (!d || !ID.test(d.id ?? "")) fail("a news post needs an id of lowercase letters, numbers and dashes");
	const title = text(d.title, 80);
	if (!title) fail("news " + d.id + ": needs a title");
	return {id: d.id, date: /^\d{4}-\d{2}-\d{2}$/.test(d.date ?? "") ? d.date : new Date().toISOString().slice(0, 10), kind: KINDS.has(d.kind) ? d.kind : "notice",
		title, body: text(d.body, 2000, true), version: text(d.version, 20), pinned: !!d.pinned};
}

// ---------------------------------------------------------------- the feed as it is now
let prev = {format: 1, seq: 0, events: [], cosmetics: [], news: []};
if (fs.existsSync(FEED)) {
	try {
		const p = JSON.parse(JSON.parse(fs.readFileSync(FEED, "utf8")).payload);
		prev = {format: 1, seq: Number(p.seq) || 0, events: p.events ?? [], cosmetics: p.cosmetics ?? [], news: p.news ?? []};
	} catch (e) {
		console.log("The old feed couldn't be read - starting a fresh one.");
	}
}
const events = new Map(prev.events.map(e => [e.id, e])), cosmetics = new Map(prev.cosmetics.map(c => [c.id, c])), news = new Map(prev.news.map(n => [n.id, n]));
const report = [];

// ---------------------------------------------------------------- the updates waiting in the inbox, oldest first
fs.mkdirSync(DONE, {recursive: true});
fs.mkdirSync(BAD, {recursive: true});
const inbox = fs.existsSync(INBOX) ? fs.readdirSync(INBOX).filter(f => f.endsWith(".json")).sort() : [];
for (const f of inbox) {
	const from = path.join(INBOX, f);
	try {
		if (fs.statSync(from).size > MAX_UPDATE) fail("the update is too big (200 KB at most)");
		const u = JSON.parse(fs.readFileSync(from, "utf8"));
		if (u.kobalt !== "update") fail("this isn't a Kobalt update file");
		// checked as a whole first: one bad item and nothing from this file goes in
		const looks = (u.cosmetics ?? []).map(look), ids = new Set([...cosmetics.keys(), ...looks.map(l => l.id)]);
		const evs = (u.events ?? []).map(e => event(e, ids)), posts = (u.news ?? []).map(post);
		const gone = (u.remove ?? []).filter(id => typeof id === "string");
		for (const id of gone) {
			events.delete(id);
			cosmetics.delete(id);
			news.delete(id);
		}
		for (const l of looks) cosmetics.set(l.id, l);
		for (const e of evs) events.set(e.id, e);
		for (const n of posts) news.set(n.id, n);
		fs.renameSync(from, path.join(DONE, f));
		report.push("OK " + f + ": " + [looks.length && looks.length + " look(s)", evs.length && evs.length + " challenge(s)", posts.length && posts.length + " news post(s)",
			gone.length && gone.length + " removed"].filter(Boolean).join(", "));
	} catch (e) {
		fs.renameSync(from, path.join(BAD, f));
		fs.writeFileSync(path.join(BAD, f + ".why.txt"), "Not published: " + e.message + "\n");
		report.push("REJECTED " + f + ": " + e.message);
	}
}

// ---------------------------------------------------------------- tidy, sign, save
const now = Date.now();
// challenges over for more than 30 days drop off (anyone who won their look keeps it)
for (const [id, e] of events) if (Date.parse(e.end) < now - 30 * 86400000) events.delete(id);
const payload = {
	format: 1,
	seq: Math.max((prev.seq || 0) + 1, now),
	events: [...events.values()].slice(-MAX_EVENTS),
	cosmetics: [...cosmetics.values()].slice(-MAX_LOOKS),
	news: [...news.values()].sort((a, b) => b.date.localeCompare(a.date)).slice(0, MAX_NEWS),
};
const text_ = JSON.stringify(payload);
if (text_.length > MAX_FEED) fail("the feed is over 1 MB - remove some old looks or news");
const pem = process.env.FEED_KEY;
if (!pem) fail("FEED_SIGNING_KEY isn't set in this repo's secrets");
const key = crypto.createPrivateKey(pem);
const sig = crypto.sign(null, Buffer.from(text_, "utf8"), key).toString("base64");
fs.writeFileSync(FEED, JSON.stringify({format: 1, signer: process.env.FEED_SIGNER || "main", payload: text_, sig}));

const lines = ["## Kobalt feed published", "", ...(report.length ? report.map(r => "- " + r) : ["- (no new updates - signed again)"]), "",
	"Now in the feed: " + payload.events.length + " challenge(s), " + payload.cosmetics.length + " look(s), " + payload.news.length + " news post(s)."];
console.log(lines.join("\n"));
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
