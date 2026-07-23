/// <reference types="@cloudflare/workers-types" />

interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
}

type UserRow = {
  id: string;
  username: string;
  nickname: string;
  password_hash: string;
  password_salt: string;
  password_iterations: number;
};

type AuthUser = Pick<UserRow, "id" | "username" | "nickname">;

type StoredStateRow = {
  stats_json: string;
  session_json: string | null;
  version: number;
  updated_at: number;
};

type CaptchaRow = {
  answer_hash: string;
  expires_at: number;
};

type StatsPayload = {
  answered: number;
  correct: number;
  wrong: number[];
  wrongCounts: Record<string, number>;
  favorites: number[];
  lastId: number;
  dates: string[];
};

type PracticeSessionPayload = {
  queue: number[];
  cursor: number;
  label: string;
  updatedAt: number;
};

class ApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const textEncoder = new TextEncoder();
const PASSWORD_ITERATIONS = 100_000;
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const SESSION_COOKIE = "__Host-training_session";
const MAX_BODY_BYTES = 160_000;
const CAPTCHA_TTL_SECONDS = 5 * 60;
const CAPTCHA_LENGTH = 5;
const CAPTCHA_CHARACTERS = "ACEFHKMNPRTUVWXY23456789";
const CAPTCHA_GLYPHS: Record<string, string[]> = {
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  C: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  W: ["10001", "10001", "10001", "10001", "10101", "11011", "10001"],
  X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  "2": ["11110", "00001", "00001", "01110", "10000", "10000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["10010", "10010", "10010", "11111", "00010", "00010", "00010"],
  "5": ["11111", "10000", "10000", "11110", "00001", "00001", "11110"],
  "6": ["01111", "10000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00001", "11110"],
};

function json(data: unknown, status = 200, extraHeaders?: HeadersInit) {
  const headers = new Headers(extraHeaders);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  return new Response(JSON.stringify(data), { status, headers });
}

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function randomToken(byteLength: number) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

function randomInteger(maximum: number) {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return value[0] % maximum;
}

function randomCaptchaCode() {
  let code = "";
  for (let index = 0; index < CAPTCHA_LENGTH; index += 1) {
    code += CAPTCHA_CHARACTERS[randomInteger(CAPTCHA_CHARACTERS.length)];
  }
  return code;
}

function captchaSvg(code: string) {
  // Give every character its own fixed-width cell and keep generous margins.
  // This prevents the first and last character from being clipped after scaling
  // or rotating on narrow mobile screens.
  const width = 300;
  const height = 84;
  const cellWidth = 52;
  const startX = 46;
  const centerY = 44;

  const lines = Array.from({ length: 7 }, () => {
    const x1 = 8 + randomInteger(width - 16);
    const y1 = 8 + randomInteger(height - 16);
    const x2 = 8 + randomInteger(width - 16);
    const y2 = 8 + randomInteger(height - 16);
    const opacity = (18 + randomInteger(24)) / 100;
    return `<path d="M${x1} ${y1} L${x2} ${y2}" stroke="#0b7d58" stroke-width="${1 + randomInteger(2)}" opacity="${opacity}"/>`;
  }).join("");

  const dots = Array.from({ length: 30 }, () => {
    const x = 7 + randomInteger(width - 14);
    const y = 7 + randomInteger(height - 14);
    const radius = 1 + randomInteger(2);
    return `<circle cx="${x}" cy="${y}" r="${radius}" fill="#658479" opacity=".28"/>`;
  }).join("");

  const characters = Array.from(code).map((character, index) => {
    const x = startX + index * cellWidth;
    const y = centerY + randomInteger(7) - 3;
    const rotate = randomInteger(15) - 7;
    return `<text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="middle" transform="rotate(${rotate} ${x} ${y})" fill="#173d31" font-size="43" font-weight="800" font-family="Arial, Helvetica, sans-serif" letter-spacing="0">${character}</text>`;
  }).join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet"><rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="12" fill="#eef8f3"/><path d="M8 61 C68 28 111 76 163 43 S244 26 292 58" fill="none" stroke="#90c7b2" stroke-width="3" opacity=".45"/>${dots}${lines}${characters}</svg>`;
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

async function hashPassword(password: string, salt: Uint8Array, iterations: number) {
  const key = await crypto.subtle.importKey("raw", textEncoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const saltBuffer = salt.buffer.slice(salt.byteOffset, salt.byteOffset + salt.byteLength) as ArrayBuffer;
  const derived = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: saltBuffer, iterations },
    key,
    256,
  );
  return new Uint8Array(derived);
}

function timingSafeEqual(first: Uint8Array, second: Uint8Array) {
  if (first.byteLength !== second.byteLength) return false;
  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual: (a: ArrayBufferView, b: ArrayBufferView) => boolean;
  };
  return subtle.timingSafeEqual(first, second);
}

function timingSafeTextEqual(first: string, second: string) {
  return timingSafeEqual(textEncoder.encode(first), textEncoder.encode(second));
}

function parseCookies(request: Request) {
  const cookies = new Map<string, string>();
  for (const part of (request.headers.get("Cookie") || "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    cookies.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim());
  }
  return cookies;
}

function setSessionCookie(token: string) {
  return `${SESSION_COOKIE}=${token}; Max-Age=${SESSION_TTL_SECONDS}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

async function readJsonBody<T>(request: Request): Promise<T> {
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (contentLength > MAX_BODY_BYTES) throw new ApiError(413, "BODY_TOO_LARGE", "提交的数据过大");
  try {
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid body");
    return body as T;
  } catch {
    throw new ApiError(400, "INVALID_JSON", "请求内容格式不正确");
  }
}

function assertSameOrigin(request: Request) {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) {
    throw new ApiError(403, "INVALID_ORIGIN", "请求来源不合法");
  }
}

function normalizeUsername(value: unknown) {
  const username = String(value ?? "").trim();
  if (!/^[\p{L}\p{N}_-]{3,24}$/u.test(username)) {
    throw new ApiError(400, "INVALID_USERNAME", "用户名须为3至24位中文、字母、数字、下划线或短横线");
  }
  return username;
}

function normalizeNickname(value: unknown) {
  const nickname = String(value ?? "").trim();
  if (nickname.length < 1 || nickname.length > 12) {
    throw new ApiError(400, "INVALID_NICKNAME", "昵称须为1至12个字符");
  }
  return nickname;
}

function normalizePassword(value: unknown) {
  const password = String(value ?? "");
  if (password.length < 8 || password.length > 128) {
    throw new ApiError(400, "INVALID_PASSWORD", "密码须为8至128个字符");
  }
  return password;
}

function normalizeInteger(value: unknown, minimum: number, maximum: number, fallback: number) {
  const number = Number(value);
  return Number.isInteger(number) && number >= minimum && number <= maximum ? number : fallback;
}

function normalizeQuestionIds(value: unknown) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map(item => normalizeInteger(item, 1, 100_000, 0)).filter(Boolean))).slice(0, 2_000);
}

function normalizeStats(value: unknown): StatsPayload {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const answered = normalizeInteger(input.answered, 0, 1_000_000_000, 0);
  const correct = Math.min(answered, normalizeInteger(input.correct, 0, 1_000_000_000, 0));
  const wrong = normalizeQuestionIds(input.wrong);
  const favorites = normalizeQuestionIds(input.favorites);
  const wrongCountsInput = input.wrongCounts && typeof input.wrongCounts === "object" ? input.wrongCounts as Record<string, unknown> : {};
  const wrongCounts: Record<string, number> = {};
  for (const id of wrong) wrongCounts[String(id)] = normalizeInteger(wrongCountsInput[String(id)], 1, 1_000_000, 1);
  const dates = Array.isArray(input.dates)
    ? input.dates.filter(item => typeof item === "string" && /^\d{4}-\d{2}-\d{2}$/.test(item)).slice(-2_000)
    : [];
  return {
    answered,
    correct,
    wrong,
    wrongCounts,
    favorites,
    lastId: normalizeInteger(input.lastId, 1, 100_000, 1),
    dates,
  };
}

function normalizePracticeSession(value: unknown): PracticeSessionPayload | null {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new ApiError(400, "INVALID_SESSION", "练习进度格式不正确");
  const input = value as Record<string, unknown>;
  const queue = normalizeQuestionIds(input.queue);
  if (!queue.length) return null;
  return {
    queue,
    cursor: normalizeInteger(input.cursor, 0, queue.length - 1, 0),
    label: String(input.label ?? "练习").slice(0, 40),
    updatedAt: normalizeInteger(input.updatedAt, 0, Number.MAX_SAFE_INTEGER, Date.now()),
  };
}

async function createCaptcha(env: Env) {
  const captchaId = randomToken(18);
  const code = randomCaptchaCode();
  const now = Math.floor(Date.now() / 1000);
  const answerHash = await sha256(`${captchaId}:${code}`);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM registration_captchas WHERE expires_at <= ?").bind(now),
    env.DB.prepare(
      "INSERT INTO registration_captchas (id, answer_hash, expires_at, created_at) VALUES (?, ?, ?, ?)",
    ).bind(captchaId, answerHash, now + CAPTCHA_TTL_SECONDS, now),
  ]);
  return json({
    captchaId,
    imageUrl: `data:image/svg+xml;base64,${btoa(captchaSvg(code))}`,
    expiresIn: CAPTCHA_TTL_SECONDS,
  });
}

async function verifyRegistrationCaptcha(env: Env, captchaIdValue: unknown, captchaCodeValue: unknown) {
  const captchaId = String(captchaIdValue ?? "").trim();
  const captchaCode = String(captchaCodeValue ?? "").trim().toUpperCase();
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(captchaId) || !new RegExp(`^[A-Z0-9]{${CAPTCHA_LENGTH}}$`).test(captchaCode)) {
    throw new ApiError(400, "INVALID_CAPTCHA", "验证码格式不正确，请换一张后重试");
  }
  const row = await env.DB.prepare(
    "SELECT answer_hash, expires_at FROM registration_captchas WHERE id = ?",
  ).bind(captchaId).first<CaptchaRow>();
  await env.DB.prepare("DELETE FROM registration_captchas WHERE id = ?").bind(captchaId).run();
  const now = Math.floor(Date.now() / 1000);
  if (!row || row.expires_at <= now) {
    throw new ApiError(400, "CAPTCHA_EXPIRED", "验证码已过期，请换一张后重试");
  }
  const actualHash = await sha256(`${captchaId}:${captchaCode}`);
  if (!timingSafeTextEqual(actualHash, row.answer_hash)) {
    throw new ApiError(400, "CAPTCHA_INCORRECT", "验证码不正确，请重新输入");
  }
}

async function createSession(env: Env, userId: string) {
  const token = randomToken(32);
  const tokenHash = await sha256(token);
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    "INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
  ).bind(tokenHash, userId, now + SESSION_TTL_SECONDS, now).run();
  return token;
}

async function authenticatedUser(request: Request, env: Env): Promise<AuthUser | null> {
  const token = parseCookies(request).get(SESSION_COOKIE);
  if (!token) return null;
  const tokenHash = await sha256(token);
  const now = Math.floor(Date.now() / 1000);
  return env.DB.prepare(
    `SELECT users.id, users.username, users.nickname
     FROM sessions JOIN users ON users.id = sessions.user_id
     WHERE sessions.token_hash = ? AND sessions.expires_at > ?`,
  ).bind(tokenHash, now).first<AuthUser>();
}

async function requireUser(request: Request, env: Env) {
  const user = await authenticatedUser(request, env);
  if (!user) throw new ApiError(401, "UNAUTHORIZED", "登录状态已失效，请重新登录");
  return user;
}

async function register(request: Request, env: Env) {
  const body = await readJsonBody<{ username?: unknown; nickname?: unknown; password?: unknown; captchaId?: unknown; captchaCode?: unknown }>(request);
  const username = normalizeUsername(body.username);
  const nickname = normalizeNickname(body.nickname);
  const password = normalizePassword(body.password);
  await verifyRegistrationCaptcha(env, body.captchaId, body.captchaCode);
  const exists = await env.DB.prepare("SELECT id FROM users WHERE username = ?").bind(username).first();
  if (exists) throw new ApiError(409, "USERNAME_EXISTS", "该用户名已被注册");

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const passwordHash = await hashPassword(password, salt, PASSWORD_ITERATIONS);
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  try {
    await env.DB.prepare(
      `INSERT INTO users (id, username, nickname, password_hash, password_salt, password_iterations, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, username, nickname, bytesToBase64Url(passwordHash), bytesToBase64Url(salt), PASSWORD_ITERATIONS, now, now).run();
  } catch {
    throw new ApiError(409, "USERNAME_EXISTS", "该用户名已被注册");
  }
  const token = await createSession(env, id);
  return json({ user: { id, username, nickname } }, 201, { "Set-Cookie": setSessionCookie(token) });
}

async function login(request: Request, env: Env) {
  const body = await readJsonBody<{ username?: unknown; password?: unknown }>(request);
  const username = normalizeUsername(body.username);
  const password = normalizePassword(body.password);
  const user = await env.DB.prepare(
    "SELECT id, username, nickname, password_hash, password_salt, password_iterations FROM users WHERE username = ?",
  ).bind(username).first<UserRow>();

  const salt = user ? base64UrlToBytes(user.password_salt) : new Uint8Array(16);
  const iterations = user?.password_iterations || PASSWORD_ITERATIONS;
  const actualHash = await hashPassword(password, salt, iterations);
  const expectedHash = user ? base64UrlToBytes(user.password_hash) : new Uint8Array(actualHash.length);
  if (!user || !timingSafeEqual(actualHash, expectedHash)) {
    throw new ApiError(401, "INVALID_CREDENTIALS", "用户名或密码不正确");
  }
  const token = await createSession(env, user.id);
  return json({ user: { id: user.id, username: user.username, nickname: user.nickname } }, 200, { "Set-Cookie": setSessionCookie(token) });
}

async function logout(request: Request, env: Env) {
  const token = parseCookies(request).get(SESSION_COOKIE);
  if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
  return json({ ok: true }, 200, { "Set-Cookie": clearSessionCookie() });
}

async function getState(request: Request, env: Env) {
  const user = await requireUser(request, env);
  const row = await env.DB.prepare(
    "SELECT stats_json, session_json, version, updated_at FROM user_states WHERE user_id = ?",
  ).bind(user.id).first<StoredStateRow>();
  if (!row) return json({ user, hasState: false, version: 0, stats: null, session: null });
  try {
    return json({
      user,
      hasState: true,
      version: row.version,
      updatedAt: row.updated_at,
      stats: normalizeStats(JSON.parse(row.stats_json)),
      session: row.session_json ? normalizePracticeSession(JSON.parse(row.session_json)) : null,
    });
  } catch {
    throw new ApiError(500, "INVALID_STORED_STATE", "云端学习数据异常，请联系管理员");
  }
}

async function saveState(request: Request, env: Env, importOnly: boolean) {
  const user = await requireUser(request, env);
  const body = await readJsonBody<{ stats?: unknown; session?: unknown; nickname?: unknown }>(request);
  const stats = normalizeStats(body.stats);
  const practiceSession = normalizePracticeSession(body.session);
  const nickname = normalizeNickname(body.nickname ?? user.nickname);
  const now = Math.floor(Date.now() / 1000);

  if (importOnly) {
    const existing = await env.DB.prepare("SELECT version FROM user_states WHERE user_id = ?").bind(user.id).first();
    if (existing) throw new ApiError(409, "STATE_EXISTS", "账号已有云端学习记录，未覆盖现有数据");
  }

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO user_states (user_id, stats_json, session_json, version, updated_at)
       VALUES (?, ?, ?, 1, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         stats_json = excluded.stats_json,
         session_json = excluded.session_json,
         version = user_states.version + 1,
         updated_at = excluded.updated_at`,
    ).bind(user.id, JSON.stringify(stats), practiceSession ? JSON.stringify(practiceSession) : null, now),
    env.DB.prepare("UPDATE users SET nickname = ?, updated_at = ? WHERE id = ?").bind(nickname, now, user.id),
  ]);
  const row = await env.DB.prepare("SELECT version FROM user_states WHERE user_id = ?").bind(user.id).first<{ version: number }>();
  return json({ ok: true, version: row?.version || 1, updatedAt: now, user: { ...user, nickname } });
}

async function handleApi(request: Request, env: Env) {
  assertSameOrigin(request);
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/api/config" && request.method === "GET") {
    return json({ registrationEnabled: true });
  }
  if (path === "/api/captcha" && request.method === "GET") return createCaptcha(env);
  if (path === "/api/auth/register" && request.method === "POST") return register(request, env);
  if (path === "/api/auth/login" && request.method === "POST") return login(request, env);
  if (path === "/api/auth/logout" && request.method === "POST") return logout(request, env);
  if (path === "/api/auth/me" && request.method === "GET") {
    const user = await authenticatedUser(request, env);
    return user ? json({ user }) : json({ error: "尚未登录", code: "UNAUTHORIZED" }, 401);
  }
  if (path === "/api/user/state" && request.method === "GET") return getState(request, env);
  if (path === "/api/user/state" && (request.method === "PUT" || request.method === "POST")) return saveState(request, env, false);
  if (path === "/api/user/import" && request.method === "POST") return saveState(request, env, true);
  return json({ error: "接口不存在", code: "NOT_FOUND" }, 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    try {
      return await handleApi(request, env);
    } catch (error) {
      if (error instanceof ApiError) return json({ error: error.message, code: error.code }, error.status);
      console.error(error);
      return json({ error: "服务器暂时无法处理请求", code: "INTERNAL_ERROR" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
