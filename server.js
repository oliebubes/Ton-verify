// =====================================================================================================
// BETCRYPTO BACKEND  -  ONE FILE.   Run:  node server.js          (start the API)
//                                         node server.js migrate  (create/update database tables)
//                                         node server.js selftest (check your database works)
// Accounts (Telegram + browser) - email codes - money ledger - Plisio USDT deposits (mainnet only)
// buy BTC/ETH/SOL - 7-day bets + settlement - referrals - withdrawals - admin API - translations
// Secrets are read from environment variables ONLY. Never put them in the frontend or on GitHub.
// =====================================================================================================
import http from 'node:http';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

/* =============================== 1. CONFIG =============================== */
const truthy = (v, d) => (v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));
const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

export function loadConfig(env = process.env, { strict = true } = {}) {
  const c = {
    nodeEnv: env.NODE_ENV || 'development',
    port: num(env.PORT, 8787),
    databaseUrl: env.DATABASE_URL || '',
    allowedOrigins: String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean),
    botToken: env.TELEGRAM_BOT_TOKEN || '',
    botUsername: env.TELEGRAM_BOT_USERNAME || 'Betcryptoassetbot',
    codePepper: env.CODE_PEPPER || '',
    emailMode: env.EMAIL_MODE || 'smtp',
    smtp: { host: env.SMTP_HOST || 'smtp.gmail.com', port: num(env.SMTP_PORT, 465), user: env.SMTP_USER || '', pass: env.SMTP_PASS || '', fromName: env.EMAIL_FROM_NAME || 'BETCRYPTO' },
    emailDailyCap: num(env.EMAIL_DAILY_CAP, 450),
    plisioKey: env.PLISIO_SECRET_KEY || '',
    // ONLY these Plisio currency IDs can ever credit a deposit. They are the four real (mainnet) USDT networks.
    plisioAllowed: String(env.PLISIO_ALLOWED_PSYS || 'USDT_TRX,USDT,USDT_BSC,USDT_TON').split(',').map((s) => s.trim()).filter(Boolean),
    cronSecret: env.CRON_SECRET || '',
    adminTelegramIds: String(env.ADMIN_TELEGRAM_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
    adminSecretKey: env.ADMIN_SECRET_KEY || '',
    azureKey: env.AZURE_TRANSLATOR_KEY || '',
    azureRegion: env.AZURE_TRANSLATOR_REGION || '',
    azureMonthlyCharCap: num(env.AZURE_MONTHLY_CHAR_CAP, 1800000),
    referralBaseUrl: String(env.REFERRAL_BASE_URL || '').replace(/\/+$/, ''),
    trustProxy: truthy(env.TRUST_PROXY, true),
    cookieSecure: truthy(env.COOKIE_SECURE, true),
    enableScheduler: truthy(env.ENABLE_SCHEDULER, false),
    sessionDaysWeb: num(env.SESSION_DAYS_WEB, 30),
    sessionDaysTelegram: num(env.SESSION_DAYS_TELEGRAM, 7),
    adminSessionHours: num(env.ADMIN_SESSION_HOURS, 8),
    // business rules (from the approved frontend)
    minWithdrawUsdt: num(env.MIN_WITHDRAW_USDT, 50000),
    requiredReferrals: num(env.REQUIRED_REFERRALS, 5),
    referralRewardUsdt: String(env.REFERRAL_REWARD_USDT || '10'),
    minPurchaseUsdt: String(env.MIN_PURCHASE_USDT || '1'),
    quoteTtlSeconds: num(env.QUOTE_TTL_SECONDS, 60),
    betDays: 7,
    voidAfterHours: 24,          // no price for a whole day after settlement time -> full stake back to Earnings
    codeTtlSeconds: 600, codeMaxAttempts: 5, codeResendSeconds: 60, codesPerHour: 5, codesPerIpHour: 20,
    verifyPer15Min: 15, verifyIpPer15Min: 40, loginPer15Min: 10, ticketTtlSeconds: 1800, linkTokenTtlSeconds: 900,
    tgAuthMaxAgeSec: 86400
  };
  if (strict) {
    const m = [];
    if (!c.databaseUrl) m.push('DATABASE_URL');
    if (!c.allowedOrigins.length) m.push('ALLOWED_ORIGINS');
    if (!c.botToken) m.push('TELEGRAM_BOT_TOKEN');
    if (c.codePepper.length < 24) m.push('CODE_PEPPER (24+ characters)');
    if (c.emailMode === 'smtp' && (!c.smtp.user || !c.smtp.pass)) m.push('SMTP_USER and SMTP_PASS');
    if (c.nodeEnv === 'production' && c.emailMode !== 'smtp') m.push('EMAIL_MODE must be smtp in production');
    if (!c.plisioKey) m.push('PLISIO_SECRET_KEY');
    if (c.cronSecret.length < 16) m.push('CRON_SECRET (16+ characters)');
    if (c.adminSecretKey.length < 32) m.push('ADMIN_SECRET_KEY (32+ characters)');
    if (m.length) throw new Error('Missing or invalid settings: ' + m.join(', '));
  }
  return c;
}

/* =============================== 2. UTILITIES =============================== */
export class AppError extends Error {
  constructor(status, code, message, extra) { super(message || code); this.status = status; this.code = code; this.extra = extra; }
}
const ONE = 10n ** 18n;
export function dec(value) {
  if (typeof value === 'bigint') return value;
  const s = String(value).trim();
  if (!/^-?\d+(\.\d{1,18})?$/.test(s)) throw new AppError(400, 'BAD_AMOUNT', 'invalid amount');
  const neg = s.startsWith('-');
  const [i, f = ''] = s.replace('-', '').split('.');
  const v = BigInt(i) * ONE + BigInt((f + '0'.repeat(18)).slice(0, 18));
  return neg ? -v : v;
}
export function fmt(v) {
  const neg = v < 0n; const a = neg ? -v : v;
  const f = (a % ONE).toString().padStart(18, '0').replace(/0+$/, '');
  return (neg ? '-' : '') + (a / ONE).toString() + (f ? '.' + f : '');
}
// Safe decimal parse for text that may come from outside (rejects floats like 1e-7, negatives, junk)
export function decOrNull(v) { try { return /^\d+(\.\d{1,18})?$/.test(String(v).trim()) ? dec(String(v).trim()) : null; } catch { return null; } }
const mulDiv = (a, b, c) => (a * b) / c;                         // all scaled-by-1e18 integers
export const mulDec = (a, b) => mulDiv(a, b, ONE);               // a*b
export const divDec = (a, b) => mulDiv(a, ONE, b);               // a/b (truncates)
const floorTo8 = (v) => (v / 10n ** 10n) * 10n ** 10n;           // keep 8 decimals, round DOWN

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export function normalizeEmail(raw) { const e = String(raw || '').trim().toLowerCase(); return e.length <= 254 && EMAIL_RE.test(e) ? e : null; }
const RESERVED = new Set(['admin', 'administrator', 'root', 'support', 'help', 'staff', 'moderator', 'mod', 'system', 'official', 'betcrypto', 'betcrypt', 'buycrypt', 'earnings', 'withdraw', 'wallet', 'null', 'undefined', 'telegram', 'plisio', 'security', 'service', 'team', 'bot', 'api', 'www']);
export function normalizeUsername(raw) {
  const u = String(raw || '').trim().replace(/^@/, '');
  return /^[A-Za-z0-9_]{3,32}$/.test(u) && !RESERVED.has(u.toLowerCase()) ? u : null;
}
const WEAK = new Set(['password', 'password1', 'password123', '12345678', '123456789', '1234567890', 'qwertyui', 'qwerty123', 'iloveyou', '11111111', '00000000']);
export const passwordProblem = (pw) => { const p = String(pw || ''); return p.length < 8 ? 'short' : p.length > 128 ? 'long' : WEAK.has(p.toLowerCase()) ? 'weak' : null; };
export const normalizeRef = (raw) => { const r = String(raw || '').trim(); return /^[A-Za-z0-9_-]{1,64}$/.test(r) && !r.startsWith('link_') ? r : null; };
const ALPHA = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
const randId = (prefix, n = 10) => prefix + Array.from({ length: n }, () => ALPHA[crypto.randomInt(0, ALPHA.length)]).join('');

/* =============================== 3. CRYPTO HELPERS =============================== */
const scryptAsync = (pw, salt, len, opts) => new Promise((res, rej) => crypto.scrypt(pw, salt, len, opts, (e, k) => (e ? rej(e) : res(k))));
const SCRYPT = { N: 32768, r: 8, p: 3 }; const MAXMEM = 256 * 1024 * 1024;
export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scryptAsync(String(pw).normalize('NFKC'), salt, 32, { ...SCRYPT, maxmem: MAXMEM });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}
export async function verifyPassword(pw, stored) {
  try {
    const [tag, N, r, p, s, k] = String(stored).split('$');
    if (tag !== 'scrypt') return false;
    const exp = Buffer.from(k, 'base64');
    const key = await scryptAsync(String(pw).normalize('NFKC'), Buffer.from(s, 'base64'), exp.length, { N: +N, r: +r, p: +p, maxmem: MAXMEM });
    return key.length === exp.length && crypto.timingSafeEqual(key, exp);
  } catch { return false; }
}
let DUMMY = null;
const dummyVerify = async (pw) => { if (!DUMMY) DUMMY = await hashPassword('dummy-password-for-timing'); await verifyPassword(pw, DUMMY); return false; };
export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const newToken = (n = 32) => crypto.randomBytes(n).toString('base64url');
const hmacHex = (key, msg, algo = 'sha256') => crypto.createHmac(algo, key).update(msg).digest('hex');
export const safeEq = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const newCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');
const hashCode = (pepper, purpose, subject, code) => hmacHex(pepper, `${purpose}|${subject}|${code}`);
// encrypt small secrets (admin TOTP secret) at rest with AES-256-GCM
const aesKey = (cfg) => crypto.createHash('sha256').update(cfg.adminSecretKey).digest();
function encryptSecret(cfg, text) { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', aesKey(cfg), iv); const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]); return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.'); }
function decryptSecret(cfg, blob) { const [iv, tag, enc] = String(blob).split('.').map((s) => Buffer.from(s, 'base64')); const d = crypto.createDecipheriv('aes-256-gcm', aesKey(cfg), iv); d.setAuthTag(tag); return Buffer.concat([d.update(enc), d.final()]).toString('utf8'); }
// TOTP (RFC 6238) for the authenticator app used by admins
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const b32encode = (buf) => { let bits = ''; for (const b of buf) bits += b.toString(2).padStart(8, '0'); let out = ''; for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)]; return out; };
const b32decode = (s) => { let bits = ''; for (const ch of s.replace(/=+$/, '')) bits += B32.indexOf(ch).toString(2).padStart(5, '0'); const bytes = []; for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(bytes); };
export function totpAt(secretB32, tMs) { const c = Buffer.alloc(8); c.writeBigUInt64BE(BigInt(Math.floor(tMs / 30000))); const h = crypto.createHmac('sha1', b32decode(secretB32)).update(c).digest(); const o = h[h.length - 1] & 15; const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]; return String(n % 1000000).padStart(6, '0'); }
export const totpVerify = (secret, code, nowMs) => [-1, 0, 1].some((w) => safeEq(totpAt(secret, nowMs + w * 30000), String(code).trim()));
export const newTotpSecret = () => b32encode(crypto.randomBytes(20));

/* =============================== 4. TELEGRAM VERIFICATION =============================== */
const hmacRaw = (key, msg) => crypto.createHmac('sha256', key).update(msg).digest();
export function verifyInitData(initData, botToken, { maxAgeSec = 86400, nowSec = Math.floor(Date.now() / 1000) } = {}) {
  if (!botToken) throw new AppError(500, 'SERVER_MISCONFIGURED');
  if (typeof initData !== 'string' || initData.length < 10 || initData.length > 8192) throw new AppError(401, 'BAD_TELEGRAM_AUTH');
  const params = new URLSearchParams(initData); const hash = params.get('hash');
  if (!hash) throw new AppError(401, 'BAD_TELEGRAM_AUTH');
  params.delete('hash');
  const check = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const computed = crypto.createHmac('sha256', hmacRaw('WebAppData', botToken)).update(check).digest('hex');
  if (!safeEq(computed, hash)) throw new AppError(401, 'BAD_TELEGRAM_AUTH');
  const ad = Number(params.get('auth_date'));
  if (!Number.isFinite(ad) || nowSec - ad > maxAgeSec || ad - nowSec > 300) throw new AppError(401, 'TELEGRAM_AUTH_EXPIRED');
  let user; try { user = JSON.parse(params.get('user') || ''); } catch { user = null; }
  if (!user || !Number.isSafeInteger(user.id)) throw new AppError(401, 'BAD_TELEGRAM_AUTH');
  const sp = params.get('start_param');
  return { tgId: String(user.id), username: typeof user.username === 'string' ? user.username.slice(0, 64) : null, startParam: typeof sp === 'string' ? sp.slice(0, 128) : null };
}
export function verifyLoginWidget(data, botToken, { maxAgeSec = 86400, nowSec = Math.floor(Date.now() / 1000) } = {}) {
  if (!botToken) throw new AppError(500, 'SERVER_MISCONFIGURED');
  if (!data || typeof data !== 'object' || typeof data.hash !== 'string') throw new AppError(401, 'BAD_TELEGRAM_AUTH');
  const check = Object.keys(data).filter((k) => k !== 'hash' && data[k] != null).sort().map((k) => `${k}=${data[k]}`).join('\n');
  const computed = crypto.createHmac('sha256', crypto.createHash('sha256').update(botToken).digest()).update(check).digest('hex');
  if (!safeEq(computed, data.hash)) throw new AppError(401, 'BAD_TELEGRAM_AUTH');
  const ad = Number(data.auth_date);
  if (!Number.isFinite(ad) || nowSec - ad > maxAgeSec || ad - nowSec > 300) throw new AppError(401, 'TELEGRAM_AUTH_EXPIRED');
  const id = Number(data.id);
  if (!Number.isSafeInteger(id)) throw new AppError(401, 'BAD_TELEGRAM_AUTH');
  return { tgId: String(id), username: typeof data.username === 'string' ? data.username.slice(0, 64) : null };
}

/* =============================== 5. MONEY LEDGER RULES =============================== */
// Every balance change is a "journal": entries that add up to exactly zero per asset (double entry).
export const ASSETS = ['USDT', 'BTC', 'ETH', 'SOL'];
export const accountKey = (e) => (e.ownerUserId != null ? `u:${e.ownerUserId}:${e.bucket}:${e.asset}` : `s:${e.systemKey}:${e.bucket}:${e.asset}`);
export function planJournal({ kind, idempotencyKey, entries, meta }) {
  if (!kind || !idempotencyKey || String(idempotencyKey).length > 200) throw new AppError(500, 'BAD_JOURNAL', 'kind and idempotency key required');
  if (!Array.isArray(entries) || entries.length < 2) throw new AppError(500, 'BAD_JOURNAL', 'need two entries');
  const sums = new Map(); const out = [];
  for (const e of entries) {
    if (e.ownerUserId == null && !e.systemKey) throw new AppError(500, 'BAD_JOURNAL', 'owner required');
    if (!/^[a-z_]{2,32}$/.test(String(e.bucket)) || !ASSETS.includes(e.asset)) throw new AppError(500, 'BAD_JOURNAL', 'bucket/asset');
    const amount = dec(e.amount);
    if (amount === 0n) throw new AppError(500, 'BAD_JOURNAL', 'zero amount');
    out.push({ ownerUserId: e.ownerUserId ?? null, systemKey: e.systemKey ?? null, bucket: e.bucket, asset: e.asset, amount, key: accountKey(e), allowNegative: e.ownerUserId == null });
    sums.set(e.asset, (sums.get(e.asset) || 0n) + amount);
  }
  for (const [asset, s] of sums) if (s !== 0n) throw new AppError(500, 'UNBALANCED_JOURNAL', `journal does not balance for ${asset}`);
  return { kind, idempotencyKey, meta: meta || {}, entries: out };
}
export function checkNoOverdraft(plan, balances) {
  const delta = new Map();
  for (const e of plan.entries) delta.set(e.key, (delta.get(e.key) || 0n) + e.amount);
  for (const e of plan.entries) if (!e.allowNegative && (balances.get(e.key) || 0n) + delta.get(e.key) < 0n) throw new AppError(409, 'INSUFFICIENT_FUNDS', 'not enough balance');
}
// user buckets: deposit(USDT) earnings(USDT) holding(BTC/ETH/SOL) reserved(any, funds waiting for an admin decision)
const U = (userId, bucket, asset, amount) => ({ ownerUserId: userId, bucket, asset, amount: typeof amount === 'bigint' ? fmt(amount) : amount });
const SYS = (systemKey, bucket, asset, amount) => ({ systemKey, bucket, asset, amount: typeof amount === 'bigint' ? fmt(amount) : amount });
const neg = (v) => fmt(-dec(v));

/* =============================== 6. DATABASE TABLES =============================== */
// Column lists double as the safety whitelist for every query the store builds.
const T = (pk, cols, json = [], unique = [], defaults = {}) => ({ pk, cols, json, unique, defaults });
export const SCHEMA = {
  users: T('id', ['id', 'public_id', 'username', 'status', 'age_confirmed_at', 'age_policy_version', 'signup_referral_code', 'referral_code', 'created_at'], [], [['public_id'], ['referral_code']], { status: 'active' }),
  credentials: T('user_id', ['user_id', 'email', 'email_verified_at', 'password_hash', 'created_at'], [], [['email']]),
  tg_identities: T('tg_id', ['tg_id', 'user_id', 'username', 'linked_at'], [], [['user_id']]),
  sessions: T('id', ['id', 'token_hash', 'user_id', 'kind', 'created_at', 'expires_at', 'last_seen_at', 'revoked_at'], [], [['token_hash']]),
  codes: T('id', ['id', 'purpose', 'subject', 'user_id', 'code_hash', 'attempts', 'max_attempts', 'expires_at', 'used_at', 'invalidated_at', 'meta', 'created_at'], ['meta'], [], { attempts: 0, meta: {} }),
  tickets: T('id', ['id', 'token_hash', 'email', 'password_hash', 'referral_code', 'expires_at', 'used_at', 'created_at'], [], [['token_hash']]),
  link_tokens: T('id', ['id', 'token_hash', 'user_id', 'expires_at', 'used_at', 'created_at'], [], [['token_hash']]),
  deposit_addresses: T('id', ['id', 'user_id', 'network', 'psys_cid', 'address', 'uid', 'created_at'], [], [['user_id', 'network'], ['address']]),
  provider_events: T('id', ['id', 'event_key', 'provider', 'txn_id', 'payload', 'outcome', 'created_at'], ['payload'], [['event_key']]),
  deposits: T('id', ['id', 'user_id', 'address_id', 'network', 'txn_id', 'psys_cid', 'amount_sent', 'amount_credited', 'status', 'confirmations', 'provider_status', 'journal_id', 'raw', 'created_at', 'credited_at'], ['raw'], [['txn_id']], { status: 'pending' }),
  price_snapshots: T('id', ['id', 'symbol', 'price', 'source', 'sources', 'ts', 'purpose', 'created_at'], ['sources']),
  quotes: T('id', ['id', 'public_id', 'user_id', 'coin', 'usdt_amount', 'price', 'qty', 'expires_at', 'status', 'created_at'], [], [['public_id']], { status: 'open' }),
  purchases: T('id', ['id', 'user_id', 'quote_id', 'coin', 'usdt_amount', 'qty', 'price', 'journal_id', 'created_at'], [], [['quote_id']]),
  bets: T('id', ['id', 'public_id', 'user_id', 'idem_key', 'coin', 'prediction', 'stake', 'payout_total', 'start_price', 'start_source', 'start_ts', 'settles_at', 'status', 'result', 'final_price', 'final_source', 'final_ts', 'stake_journal_id', 'settle_journal_id', 'settled_at', 'created_at'], [], [['public_id'], ['user_id', 'idem_key']], { status: 'open' }),
  referrals: T('id', ['id', 'inviter_id', 'invitee_id', 'status', 'reward_amount', 'reward_journal_id', 'created_at', 'qualified_at'], [], [['invitee_id']], { status: 'pending' }),
  withdrawals: T('id', ['id', 'public_id', 'user_id', 'idem_key', 'asset', 'network', 'amount', 'usd_value', 'address', 'status', 'reason', 'txn_hash', 'admin_id', 'hold_journal_id', 'final_journal_id', 'requested_at', 'decided_at', 'paid_at'], [], [['public_id'], ['user_id', 'idem_key'], { cols: ['user_id', 'asset'], when: { status: { in: ['pending', 'approved'] } } }], { status: 'pending' }),
  notifications: T('id', ['id', 'user_id', 'audience', 'kind', 'payload', 'read_at', 'created_at'], ['payload'], [], { audience: 'user', payload: {} }),
  admins: T('id', ['id', 'tg_id', 'label', 'password_hash', 'totp_secret', 'totp_enabled', 'created_at'], [], [['tg_id']], { totp_enabled: false }),
  admin_sessions: T('id', ['id', 'token_hash', 'admin_id', 'stage', 'expires_at', 'reauth_at', 'revoked_at', 'created_at'], [], [['token_hash']], { stage: 'password' }),
  translations: T('id', ['id', 'lang', 'key', 'text', 'provider', 'created_at'], [], [['lang', 'key']]),
  audit_log: T('id', ['id', 'actor_type', 'actor_id', 'action', 'target_type', 'target_id', 'details', 'created_at'], ['details'], [], { details: {} }),
  user_locations: T('id', ['id', 'user_id', 'source', 'country', 'region', 'city', 'lat', 'lng', 'accuracy_m', 'ip_hash', 'consent_at', 'created_at'], []),
  settings: T('key', ['key', 'value', 'updated_at'], ['value'], [], { value: {} })
};

export const MIGRATIONS = [{ name: '001_initial', sql: `
CREATE TABLE IF NOT EXISTS users (
  id bigserial PRIMARY KEY, public_id text NOT NULL UNIQUE, username text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','banned')),
  age_confirmed_at timestamptz, age_policy_version text, signup_referral_code text, referral_code text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_username_format CHECK (username IS NULL OR username ~ '^[A-Za-z0-9_]{3,32}$'));
CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_uq ON users (lower(username)) WHERE username IS NOT NULL;
CREATE TABLE IF NOT EXISTS credentials (
  user_id bigint PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, email text NOT NULL,
  email_verified_at timestamptz, password_hash text, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT credentials_email_lower CHECK (email = lower(email)));
CREATE UNIQUE INDEX IF NOT EXISTS credentials_email_uq ON credentials (email);
CREATE TABLE IF NOT EXISTS tg_identities (
  tg_id text PRIMARY KEY, user_id bigint NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  username text, linked_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS sessions (
  id bigserial PRIMARY KEY, token_hash text NOT NULL UNIQUE, user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('telegram','web')), created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL, last_seen_at timestamptz, revoked_at timestamptz);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);
CREATE TABLE IF NOT EXISTS codes (
  id bigserial PRIMARY KEY, purpose text NOT NULL, subject text NOT NULL, user_id bigint,
  code_hash text NOT NULL, attempts int NOT NULL DEFAULT 0, max_attempts int NOT NULL DEFAULT 5,
  expires_at timestamptz NOT NULL, used_at timestamptz, invalidated_at timestamptz,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS codes_lookup_idx ON codes (purpose, subject, id DESC);
CREATE TABLE IF NOT EXISTS tickets (
  id bigserial PRIMARY KEY, token_hash text NOT NULL UNIQUE, email text NOT NULL, password_hash text NOT NULL,
  referral_code text, expires_at timestamptz NOT NULL, used_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS link_tokens (
  id bigserial PRIMARY KEY, token_hash text NOT NULL UNIQUE, user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL, used_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS rate_limits (key text PRIMARY KEY, window_start timestamptz NOT NULL, count int NOT NULL);
CREATE TABLE IF NOT EXISTS email_daily_counter (day date PRIMARY KEY, count int NOT NULL);
CREATE TABLE IF NOT EXISTS translation_usage (month text PRIMARY KEY, chars bigint NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS accounts (
  id bigserial PRIMARY KEY, account_key text NOT NULL UNIQUE, owner_user_id bigint REFERENCES users(id) ON DELETE RESTRICT,
  system_key text, bucket text NOT NULL, asset text NOT NULL, balance numeric(38,18) NOT NULL DEFAULT 0,
  allow_negative boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT accounts_no_overdraft CHECK (allow_negative OR balance >= 0),
  CONSTRAINT accounts_owner_xor CHECK ((owner_user_id IS NOT NULL AND system_key IS NULL) OR (owner_user_id IS NULL AND system_key IS NOT NULL)));
CREATE INDEX IF NOT EXISTS accounts_owner_idx ON accounts (owner_user_id);
CREATE TABLE IF NOT EXISTS journals (
  id bigserial PRIMARY KEY, kind text NOT NULL, idempotency_key text NOT NULL UNIQUE,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS journal_entries (
  id bigserial PRIMARY KEY, journal_id bigint NOT NULL REFERENCES journals(id), account_id bigint NOT NULL REFERENCES accounts(id),
  amount numeric(38,18) NOT NULL CHECK (amount <> 0), created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS journal_entries_account_idx ON journal_entries (account_id, id DESC);
CREATE INDEX IF NOT EXISTS journal_entries_journal_idx ON journal_entries (journal_id);

CREATE OR REPLACE FUNCTION bc_forbid_mutation() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'ledger and audit rows are append-only'; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS journal_entries_immutable ON journal_entries;
CREATE TRIGGER journal_entries_immutable BEFORE UPDATE OR DELETE ON journal_entries FOR EACH ROW EXECUTE FUNCTION bc_forbid_mutation();
DROP TRIGGER IF EXISTS journals_immutable ON journals;
CREATE TRIGGER journals_immutable BEFORE UPDATE OR DELETE ON journals FOR EACH ROW EXECUTE FUNCTION bc_forbid_mutation();
CREATE OR REPLACE FUNCTION bc_check_journal_balanced() RETURNS trigger AS $$
DECLARE bad int;
BEGIN
  SELECT count(*) INTO bad FROM (
    SELECT a.asset FROM journal_entries e JOIN accounts a ON a.id = e.account_id
     WHERE e.journal_id = NEW.journal_id GROUP BY a.asset HAVING sum(e.amount) <> 0) t;
  IF bad > 0 THEN RAISE EXCEPTION 'journal % is not balanced', NEW.journal_id; END IF;
  RETURN NULL;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS journal_balanced ON journal_entries;
CREATE CONSTRAINT TRIGGER journal_balanced AFTER INSERT ON journal_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bc_check_journal_balanced();

CREATE TABLE IF NOT EXISTS deposit_addresses (
  id bigserial PRIMARY KEY, user_id bigint NOT NULL REFERENCES users(id), network text NOT NULL CHECK (network IN ('TRC20','ERC20','BEP20','TON')),
  psys_cid text NOT NULL, address text NOT NULL, uid text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, network), UNIQUE (address));
CREATE TABLE IF NOT EXISTS provider_events (
  id bigserial PRIMARY KEY, event_key text NOT NULL UNIQUE, provider text NOT NULL, txn_id text, payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  outcome text, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS deposits (
  id bigserial PRIMARY KEY, user_id bigint NOT NULL REFERENCES users(id), address_id bigint, network text NOT NULL,
  txn_id text NOT NULL UNIQUE, psys_cid text NOT NULL, amount_sent numeric(38,18), amount_credited numeric(38,18),
  status text NOT NULL DEFAULT 'pending', confirmations int, provider_status text, journal_id bigint,
  raw jsonb, created_at timestamptz NOT NULL DEFAULT now(), credited_at timestamptz);
CREATE INDEX IF NOT EXISTS deposits_user_idx ON deposits (user_id, id DESC);
CREATE TABLE IF NOT EXISTS price_snapshots (
  id bigserial PRIMARY KEY, symbol text NOT NULL, price numeric(38,18) NOT NULL, source text NOT NULL, sources jsonb,
  ts timestamptz NOT NULL, purpose text, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS quotes (
  id bigserial PRIMARY KEY, public_id text NOT NULL UNIQUE, user_id bigint NOT NULL REFERENCES users(id), coin text NOT NULL,
  usdt_amount numeric(38,18) NOT NULL, price numeric(38,18) NOT NULL, qty numeric(38,18) NOT NULL, expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'open', created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS purchases (
  id bigserial PRIMARY KEY, user_id bigint NOT NULL REFERENCES users(id), quote_id bigint NOT NULL UNIQUE REFERENCES quotes(id),
  coin text NOT NULL, usdt_amount numeric(38,18) NOT NULL, qty numeric(38,18) NOT NULL, price numeric(38,18) NOT NULL,
  journal_id bigint, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS bets (
  id bigserial PRIMARY KEY, public_id text NOT NULL UNIQUE, user_id bigint NOT NULL REFERENCES users(id), idem_key text NOT NULL,
  coin text NOT NULL, prediction text NOT NULL CHECK (prediction IN ('UP','DROP','STEADY')),
  stake numeric(38,18) NOT NULL, payout_total numeric(38,18) NOT NULL, start_price numeric(38,18) NOT NULL, start_source text, start_ts timestamptz NOT NULL,
  settles_at timestamptz NOT NULL, status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','settled','void')),
  result text, final_price numeric(38,18), final_source text, final_ts timestamptz, stake_journal_id bigint, settle_journal_id bigint,
  settled_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (user_id, idem_key));
CREATE INDEX IF NOT EXISTS bets_due_idx ON bets (status, settles_at);
CREATE TABLE IF NOT EXISTS referrals (
  id bigserial PRIMARY KEY, inviter_id bigint NOT NULL REFERENCES users(id), invitee_id bigint NOT NULL UNIQUE REFERENCES users(id),
  status text NOT NULL DEFAULT 'pending', reward_amount numeric(38,18), reward_journal_id bigint,
  created_at timestamptz NOT NULL DEFAULT now(), qualified_at timestamptz);
CREATE TABLE IF NOT EXISTS withdrawals (
  id bigserial PRIMARY KEY, public_id text NOT NULL UNIQUE, user_id bigint NOT NULL REFERENCES users(id), idem_key text NOT NULL,
  asset text NOT NULL, network text, amount numeric(38,18) NOT NULL CHECK (amount > 0), usd_value numeric(38,18), address text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','paid','cancelled')),
  reason text, txn_hash text, admin_id bigint, hold_journal_id bigint, final_journal_id bigint,
  requested_at timestamptz NOT NULL DEFAULT now(), decided_at timestamptz, paid_at timestamptz, UNIQUE (user_id, idem_key));
CREATE UNIQUE INDEX IF NOT EXISTS withdrawals_one_open_per_balance ON withdrawals (user_id, asset) WHERE status IN ('pending','approved');
CREATE TABLE IF NOT EXISTS notifications (
  id bigserial PRIMARY KEY, user_id bigint, audience text NOT NULL DEFAULT 'user', kind text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb, read_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications (user_id, id DESC);
CREATE TABLE IF NOT EXISTS admins (
  id bigserial PRIMARY KEY, tg_id text NOT NULL UNIQUE, label text, password_hash text, totp_secret text,
  totp_enabled boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS admin_sessions (
  id bigserial PRIMARY KEY, token_hash text NOT NULL UNIQUE, admin_id bigint NOT NULL REFERENCES admins(id),
  stage text NOT NULL DEFAULT 'password', expires_at timestamptz NOT NULL, reauth_at timestamptz, revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS translations (
  id bigserial PRIMARY KEY, lang text NOT NULL, key text NOT NULL, text text NOT NULL, provider text,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (lang, key));
CREATE TABLE IF NOT EXISTS audit_log (
  id bigserial PRIMARY KEY, actor_type text NOT NULL, actor_id text, action text NOT NULL, target_type text, target_id text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now());
DROP TRIGGER IF EXISTS audit_immutable ON audit_log;
CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION bc_forbid_mutation();
CREATE TABLE IF NOT EXISTS user_locations (
  id bigserial PRIMARY KEY, user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE, source text NOT NULL CHECK (source IN ('ip','gps')),
  country text, region text, city text, lat double precision, lng double precision, accuracy_m double precision,
  ip_hash text, consent_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS user_locations_user_idx ON user_locations (user_id, id DESC);
CREATE INDEX IF NOT EXISTS user_locations_ip_idx ON user_locations (ip_hash);
CREATE TABLE IF NOT EXISTS settings (key text PRIMARY KEY, value jsonb NOT NULL DEFAULT '{}'::jsonb, updated_at timestamptz NOT NULL DEFAULT now());
` }];

/* =============================== 7. POSTGRESQL STORE =============================== */
const q1 = (c) => `"${c}"`;
function whereSql(table, where, vals) {
  const sc = SCHEMA[table]; const parts = [];
  for (const [k, v] of Object.entries(where || {})) {
    if (!sc.cols.includes(k)) throw new Error(`bad column ${table}.${k}`);
    if (v === null) parts.push(`${q1(k)} IS NULL`);
    else if (v && typeof v === 'object' && !(v instanceof Date)) {
      for (const [op, val] of Object.entries(v)) {
        if (op === 'in') { vals.push(val); parts.push(`${q1(k)} = ANY($${vals.length})`); }
        else if (op === 'isnull') parts.push(`${q1(k)} IS ${val ? '' : 'NOT '}NULL`);
        else { const sym = { lt: '<', lte: '<=', gt: '>', gte: '>=', ne: '<>' }[op]; if (!sym) throw new Error('bad operator'); vals.push(val); parts.push(`${q1(k)} ${sym} $${vals.length}`); }
      }
    } else { vals.push(v); parts.push(`${q1(k)} = $${vals.length}`); }
  }
  return parts.length ? ' WHERE ' + parts.join(' AND ') : '';
}
const orderSql = (table, order) => {
  const m = String(order || SCHEMA[table].pk + ' ASC').match(/^([a-z_]+)\s*(ASC|DESC)?$/i);
  if (!m || !SCHEMA[table].cols.includes(m[1])) throw new Error('bad order');
  return ` ORDER BY ${q1(m[1])} ${(m[2] || 'ASC').toUpperCase()}`;
};
const normRow = (table, r) => {
  if (!r) return null;
  const o = { ...r };
  for (const c of SCHEMA[table].cols) if ((c === 'id' || (c.endsWith('_id') && c !== 'tg_id')) && o[c] != null && typeof o[c] === 'string') o[c] = Number(o[c]);
  return o;
};
function buildStore(q) {
  const rows = async (text, params) => (await q.query(text, params)).rows;
  const one = async (text, params) => (await rows(text, params))[0] || null;
  const dupe = (e) => { if (e && e.code === '23505') { const err = new AppError(409, 'DUPLICATE', 'duplicate'); err.constraint = e.constraint; throw err; } throw e; };
  const api = {
    async ping() { await q.query('SELECT 1'); return true; },
    async insert(table, row) {
      const sc = SCHEMA[table]; const cols = Object.keys(row).filter((k) => sc.cols.includes(k) && row[k] !== undefined);
      const vals = cols.map((k) => (sc.json.includes(k) && row[k] != null ? JSON.stringify(row[k]) : row[k]));
      const text = cols.length ? `INSERT INTO ${q1(table)} (${cols.map(q1).join(',')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING *` : `INSERT INTO ${q1(table)} DEFAULT VALUES RETURNING *`;
      try { return normRow(table, await one(text, vals)); } catch (e) { return dupe(e); }
    },
    async get(table, where, { lock = false, order } = {}) {
      const vals = []; const w = whereSql(table, where, vals);
      return normRow(table, await one(`SELECT * FROM ${q1(table)}${w}${orderSql(table, order)} LIMIT 1${lock ? ' FOR UPDATE' : ''}`, vals));
    },
    async list(table, where, { order, limit = 100, offset = 0 } = {}) {
      const vals = []; const w = whereSql(table, where, vals);
      return (await rows(`SELECT * FROM ${q1(table)}${w}${orderSql(table, order)} LIMIT ${Math.min(Number(limit) || 100, 1000)} OFFSET ${Number(offset) || 0}`, vals)).map((r) => normRow(table, r));
    },
    async count(table, where) { const vals = []; const w = whereSql(table, where, vals); return Number((await one(`SELECT count(*)::int AS n FROM ${q1(table)}${w}`, vals)).n); },
    async update(table, where, patch) {
      const sc = SCHEMA[table]; const keys = Object.keys(patch).filter((k) => sc.cols.includes(k));
      if (!keys.length) return 0;
      const vals = keys.map((k) => (sc.json.includes(k) && patch[k] != null ? JSON.stringify(patch[k]) : patch[k]));
      const sets = keys.map((k, i) => `${q1(k)} = $${i + 1}`).join(', ');
      const w = whereSql(table, where, vals);
      try { return (await q.query(`UPDATE ${q1(table)} SET ${sets}${w}`, vals)).rowCount; } catch (e) { return dupe(e); }
    },
    async increment(table, where, col, by = 1) {
      if (!SCHEMA[table].cols.includes(col)) throw new Error('bad column');
      const vals = [by]; const w = whereSql(table, where, vals);
      return (await one(`UPDATE ${q1(table)} SET ${q1(col)} = ${q1(col)} + $1${w} RETURNING ${q1(col)}`, vals))[col];
    },
    async del(table, where) { const vals = []; const w = whereSql(table, where, vals); return (await q.query(`DELETE FROM ${q1(table)}${w}`, vals)).rowCount; },
    async userByUsername(name) { return normRow('users', await one('SELECT * FROM users WHERE lower(username)=lower($1)', [name])); },
    async rateHit(key, windowSec) {
      return (await one(`INSERT INTO rate_limits(key, window_start, count) VALUES ($1, now(), 1)
        ON CONFLICT (key) DO UPDATE SET
          count = CASE WHEN rate_limits.window_start < now() - make_interval(secs => $2::double precision) THEN 1 ELSE rate_limits.count + 1 END,
          window_start = CASE WHEN rate_limits.window_start < now() - make_interval(secs => $2::double precision) THEN now() ELSE rate_limits.window_start END
        RETURNING count`, [key, windowSec])).count;
    },
    async emailCapHit(cap) {
      const r = await one(`INSERT INTO email_daily_counter(day, count) VALUES (current_date, 1)
        ON CONFLICT (day) DO UPDATE SET count = email_daily_counter.count + 1 WHERE email_daily_counter.count < $1 RETURNING count`, [cap]);
      return r ? { ok: true, count: r.count } : { ok: false, count: cap };
    },
    async translationChars(month, add) {
      return Number((await one(`INSERT INTO translation_usage(month, chars) VALUES ($1,$2) ON CONFLICT (month) DO UPDATE SET chars = translation_usage.chars + $2 RETURNING chars`, [month, add])).chars);
    },
    async postJournal(input) {
      const plan = planJournal(input);
      const ex = await one('SELECT id FROM journals WHERE idempotency_key=$1', [plan.idempotencyKey]);
      if (ex) return { journalId: Number(ex.id), duplicate: true };
      const keys = [...new Set(plan.entries.map((e) => e.key))];
      for (const key of keys) {
        const e = plan.entries.find((x) => x.key === key);
        await q.query(`INSERT INTO accounts(account_key, owner_user_id, system_key, bucket, asset, allow_negative) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (account_key) DO NOTHING`,
          [key, e.ownerUserId, e.systemKey, e.bucket, e.asset, e.allowNegative]);
      }
      const accs = await rows('SELECT id, account_key, balance FROM accounts WHERE account_key = ANY($1::text[]) ORDER BY id FOR UPDATE', [keys]);
      const byKey = new Map(accs.map((a) => [a.account_key, a]));
      checkNoOverdraft(plan, new Map(accs.map((a) => [a.account_key, dec(a.balance)])));
      let jid;
      try { jid = Number((await one('INSERT INTO journals(kind, idempotency_key, meta) VALUES ($1,$2,$3) RETURNING id', [plan.kind, plan.idempotencyKey, JSON.stringify(plan.meta)])).id); }
      catch (e) { if (e && e.code === '23505') { const d = await one('SELECT id FROM journals WHERE idempotency_key=$1', [plan.idempotencyKey]); return { journalId: Number(d.id), duplicate: true }; } throw e; }
      const delta = new Map();
      for (const e of plan.entries) { await q.query('INSERT INTO journal_entries(journal_id, account_id, amount) VALUES ($1,$2,$3)', [jid, byKey.get(e.key).id, fmt(e.amount)]); delta.set(e.key, (delta.get(e.key) || 0n) + e.amount); }
      for (const [key, d] of delta) await q.query('UPDATE accounts SET balance = balance + $2::numeric WHERE id=$1', [byKey.get(key).id, fmt(d)]);
      return { journalId: jid, duplicate: false };
    },
    async balances(userId) {
      const out = {}; for (const r of await rows('SELECT bucket, asset, balance FROM accounts WHERE owner_user_id=$1', [userId])) out[`${r.bucket}|${r.asset}`] = fmt(dec(r.balance)); return out;
    },
    async systemBalances() {
      const out = {}; for (const r of await rows('SELECT system_key, bucket, asset, balance FROM accounts WHERE owner_user_id IS NULL')) out[`${r.system_key}|${r.bucket}|${r.asset}`] = fmt(dec(r.balance)); return out;
    },
    async ledgerRows(userId, limit = 50, offset = 0) {
      return (await rows(`SELECT e.id, j.kind, a.bucket, a.asset, e.amount, j.created_at, j.meta, j.id AS journal_id FROM journal_entries e JOIN accounts a ON a.id=e.account_id JOIN journals j ON j.id=e.journal_id
        WHERE a.owner_user_id=$1 ORDER BY e.id DESC LIMIT $2 OFFSET $3`, [userId, Math.min(limit, 500), offset])).map((r) => ({ id: Number(r.id), journal_id: Number(r.journal_id), kind: r.kind, bucket: r.bucket, asset: r.asset, amount: fmt(dec(r.amount)), created_at: new Date(r.created_at), meta: r.meta || {} }));
    },
    async ledgerActivity(userId) { return !!(await one('SELECT 1 FROM journal_entries e JOIN accounts a ON a.id=e.account_id WHERE a.owner_user_id=$1 LIMIT 1', [userId])); },
    async verifyLedger() {
      return (await rows(`SELECT a.account_key FROM accounts a LEFT JOIN (SELECT account_id, sum(amount) s FROM journal_entries GROUP BY account_id) e ON e.account_id=a.id WHERE a.balance <> COALESCE(e.s,0)`)).map((r) => r.account_key);
    },
    async purge() { return (await q.query(`DELETE FROM rate_limits WHERE window_start < now() - interval '1 day'`)).rowCount; },
    // ---- admin reports (aggregations) ----
    async locationSummary() {
      return {
        countries: await rows(`SELECT coalesce(country,'Unknown') AS country, count(DISTINCT user_id)::int AS users FROM user_locations WHERE source='ip' GROUP BY 1 ORDER BY users DESC LIMIT 100`),
        cities: await rows(`SELECT coalesce(country,'Unknown') AS country, coalesce(city,'Unknown') AS city, count(DISTINCT user_id)::int AS users FROM user_locations WHERE source='ip' GROUP BY 1,2 ORDER BY users DESC LIMIT 100`),
        gpsUsers: Number((await one(`SELECT count(DISTINCT user_id)::int AS n FROM user_locations WHERE source='gps'`)).n)
      };
    },
    async sharedIps(minUsers = 2) {
      return rows(`SELECT ip_hash, count(DISTINCT user_id)::int AS users, array_agg(DISTINCT user_id) AS user_ids FROM user_locations WHERE ip_hash IS NOT NULL GROUP BY ip_hash HAVING count(DISTINCT user_id) >= $1 ORDER BY users DESC LIMIT 100`, [minUsers]);
    },
    async dailyStats(days) {
      const d = Math.min(Math.max(Number(days) || 30, 1), 365); const out = {};
      const put = (rowsIn, f) => { for (const r of rowsIn) { const k = new Date(r.d).toISOString().slice(0, 10); out[k] = { ...(out[k] || {}), ...f(r) }; } };
      put(await rows(`SELECT date_trunc('day', created_at)::date AS d, count(*)::int AS n FROM users WHERE created_at > now() - ($1 || ' days')::interval GROUP BY 1`, [d]), (r) => ({ signups: r.n }));
      put(await rows(`SELECT date_trunc('day', credited_at)::date AS d, count(*)::int AS n, coalesce(sum(amount_credited),0)::text AS s FROM deposits WHERE credited_at > now() - ($1 || ' days')::interval GROUP BY 1`, [d]), (r) => ({ deposits: r.n, depositsUsdt: fmt(dec(r.s)) }));
      put(await rows(`SELECT date_trunc('day', created_at)::date AS d, count(*)::int AS n, coalesce(sum(stake),0)::text AS s FROM bets WHERE created_at > now() - ($1 || ' days')::interval GROUP BY 1`, [d]), (r) => ({ bets: r.n, betStakeUsdt: fmt(dec(r.s)) }));
      put(await rows(`SELECT date_trunc('day', settled_at)::date AS d, sum((status='settled' AND result=prediction)::int)::int AS won, sum((status='settled' AND result<>prediction)::int)::int AS lost, sum((status='void')::int)::int AS voided FROM bets WHERE settled_at > now() - ($1 || ' days')::interval GROUP BY 1`, [d]), (r) => ({ betsWon: r.won, betsLost: r.lost, betsVoid: r.voided }));
      put(await rows(`SELECT date_trunc('day', requested_at)::date AS d, count(*)::int AS n FROM withdrawals WHERE requested_at > now() - ($1 || ' days')::interval GROUP BY 1`, [d]), (r) => ({ withdrawalRequests: r.n }));
      put(await rows(`SELECT date_trunc('day', paid_at)::date AS d, count(*)::int AS n FROM withdrawals WHERE paid_at > now() - ($1 || ' days')::interval GROUP BY 1`, [d]), (r) => ({ withdrawalsPaid: r.n }));
      return Object.keys(out).sort().map((day) => ({ day, ...out[day] }));
    }
  };
  return api;
}
export async function createPgStore(databaseUrl, { schema = null, max = 5 } = {}) {
  const pg = (await import('pg')).default;
  const pool = new pg.Pool({ connectionString: databaseUrl, max, idleTimeoutMillis: 20000, connectionTimeoutMillis: 10000 });
  if (schema) pool.on('connect', (c) => c.query(`SET search_path TO ${schema}, public`));
  const store = buildStore(pool);
  store.tx = async (fn) => {
    const client = await pool.connect();
    try { await client.query('BEGIN'); const res = await fn(buildStore(client)); await client.query('COMMIT'); return res; }
    catch (e) { try { await client.query('ROLLBACK'); } catch { /* ignore */ } throw e; }
    finally { client.release(); }
  };
  store.close = () => pool.end();
  store.pool = pool;
  return store;
}
export async function runMigrations(store) {
  await store.pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const done = new Set((await store.pool.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  const applied = [];
  for (const m of MIGRATIONS) {
    if (done.has(m.name)) continue;
    const c = await store.pool.connect();
    try { await c.query('BEGIN'); await c.query(m.sql); await c.query('INSERT INTO schema_migrations(name) VALUES ($1)', [m.name]); await c.query('COMMIT'); applied.push(m.name); }
    catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }
  return applied;
}

/* =============================== 8. EMAIL (verification and reset CODES only) =============================== */
export function createMailer(cfg) {
  if (cfg.emailMode === 'console') return { async sendCode({ to, code, purpose }) { console.log(`[EMAIL-DEV] ${purpose} code for ${to}: ${code}`); } };
  let transport;
  const SUBJECT = { signup: 'Your BETCRYPTO verification code', reset: 'Your BETCRYPTO password reset code', link_email: 'Confirm your email for BETCRYPTO', link_tg: 'Confirm linking your Telegram to BETCRYPTO' };
  return {
    async sendCode({ to, code, purpose, ttlMinutes }) {
      if (!transport) {
        const nodemailer = (await import('nodemailer')).default;
        transport = nodemailer.createTransport({ host: cfg.smtp.host, port: cfg.smtp.port, secure: cfg.smtp.port === 465, auth: { user: cfg.smtp.user, pass: cfg.smtp.pass }, connectionTimeout: 10000, socketTimeout: 15000 });
      }
      await transport.sendMail({
        from: `"${cfg.smtp.fromName}" <${cfg.smtp.user}>`, to, subject: SUBJECT[purpose] || 'Your BETCRYPTO code',
        text: `Your BETCRYPTO code is ${code}\n\nIt works once and expires in ${ttlMinutes} minutes. If you did not ask for it, ignore this email and never share the code.`,
        html: `<p>Your BETCRYPTO code is:</p><p style="font-size:28px;letter-spacing:6px"><b>${code}</b></p><p>It works once and expires in ${ttlMinutes} minutes. If you did not ask for it, ignore this email and never share the code.</p>`
      });
    }
  };
}

/* =============================== 9. SHARED SERVICE HELPERS =============================== */
const rlKey = (...p) => 'rl:' + sha256(p.join('|'));
async function limit(ctx, parts, windowSec, max) { if ((await ctx.store.rateHit(rlKey(...parts), windowSec)) > max) throw new AppError(429, 'TOO_MANY', 'too many attempts'); }
const nowD = (ctx) => ctx.now();
const addSec = (ctx, s) => new Date(ctx.now().getTime() + s * 1000);
const audit = (ctx, rec) => ctx.store.insert('audit_log', { actor_type: rec.actorType || 'system', actor_id: rec.actorId == null ? null : String(rec.actorId), action: rec.action, target_type: rec.targetType || null, target_id: rec.targetId == null ? null : String(rec.targetId), details: rec.details || {} }).catch((e) => ctx.log('audit failed', e.message));
export async function isPaused(ctx, name) { const s = await ctx.store.get('settings', { key: name }); return !!(s && s.value && s.value.on); }

const NOTE_TEXT = {
  deposit_credited: (p) => `Deposit confirmed: ${p.amount} USDT was added to your Deposit Balance.`,
  bet_placed: (p) => `Bet accepted: ${p.coin} ${p.prediction}, stake ${p.stake} USDT. Result in 7 days.`,
  bet_won: (p) => `You won! ${p.payout} USDT was added to your Earnings Balance.`,
  bet_lost: (p) => `Bet lost: ${p.returned} USDT of your stake was returned to your Earnings Balance.`,
  bet_void: (p) => `Bet cancelled (no price available): your full stake of ${p.stake} USDT was returned to your Earnings Balance.`,
  purchase_done: (p) => `Purchase confirmed: ${p.qty} ${p.coin} added to your holdings.`,
  referral_reward: (p) => `Referral reward: ${p.amount} USDT was added to your Earnings Balance.`,
  withdrawal_submitted: (p) => `Withdrawal request received: ${p.amount} ${p.asset}. It is pending review.`,
  withdrawal_approved: (p) => `Withdrawal approved: ${p.amount} ${p.asset}. Payment is being processed.`,
  withdrawal_rejected: (p) => `Withdrawal rejected: ${p.amount} ${p.asset} was returned to your balance.${p.reason ? ' Reason: ' + p.reason : ''}`,
  withdrawal_paid: (p) => `Withdrawal paid: ${p.amount} ${p.asset} was sent.`,
  account_status: (p) => `Your account status is now: ${p.status}.`
};
export async function notify(ctx, { userId = null, audience = 'user', kind, payload = {} }) {
  try {
    await ctx.store.insert('notifications', { user_id: userId, audience, kind, payload });
    if (audience === 'user' && userId && ctx.cfg.botToken && NOTE_TEXT[kind]) {
      const tg = await ctx.store.get('tg_identities', { user_id: userId });
      if (tg) await tgSend(ctx, tg.tg_id, NOTE_TEXT[kind](payload));
    }
  } catch (e) { ctx.log('notify failed', e.message); }
}
async function tgSend(ctx, chatId, text) {
  try {
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 6000);
    await ctx.fetch(`https://api.telegram.org/bot${ctx.cfg.botToken}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text }), signal: ac.signal });
    clearTimeout(t);
  } catch { /* best effort: users who never started the bot cannot be messaged */ }
}
export async function alertAdmins(ctx, kind, payload) {
  await notify(ctx, { audience: 'admin', kind, payload });
  for (const id of ctx.cfg.adminTelegramIds) await tgSend(ctx, id, `[BETCRYPTO admin] ${kind}: ${JSON.stringify(payload).slice(0, 500)}`);
}

/* =============================== 10. EMAIL CODES =============================== */
export async function issueCode(ctx, { purpose, subject, userId = null, to, meta = {}, ip }) {
  const { store, cfg } = ctx;
  const last = (await store.list('codes', { purpose, subject }, { order: 'id DESC', limit: 1 }))[0];
  if (last && ctx.now().getTime() - new Date(last.created_at).getTime() < cfg.codeResendSeconds * 1000) throw new AppError(429, 'TOO_MANY', 'wait before asking again');
  if ((await store.count('codes', { purpose, subject, created_at: { gte: new Date(ctx.now().getTime() - 3600e3) } })) >= cfg.codesPerHour) throw new AppError(429, 'TOO_MANY', 'too many codes');
  await limit(ctx, ['codeip', ip], 3600, cfg.codesPerIpHour);
  const cap = await store.emailCapHit(cfg.emailDailyCap);
  if (!cap.ok) throw new AppError(503, 'EMAIL_CAP', 'daily email limit reached');
  const code = newCode();
  await store.update('codes', { purpose, subject, used_at: null, invalidated_at: null }, { invalidated_at: nowD(ctx) });
  const row = await store.insert('codes', { purpose, subject, user_id: userId, code_hash: hashCode(cfg.codePepper, purpose, subject, code), expires_at: addSec(ctx, cfg.codeTtlSeconds), max_attempts: cfg.codeMaxAttempts, meta });
  try { await ctx.mailer.sendCode({ to, code, purpose, ttlMinutes: Math.round(cfg.codeTtlSeconds / 60) }); }
  catch (e) { await store.update('codes', { id: row.id }, { invalidated_at: nowD(ctx) }); ctx.log('email send failed', e.message); throw new AppError(502, 'EMAIL_FAILED', 'could not send email'); }
}
export async function verifyCode(ctx, { purpose, subject, code, ip }) {
  const { store, cfg } = ctx;
  await limit(ctx, ['verify', purpose, subject], 900, cfg.verifyPer15Min);
  await limit(ctx, ['verifyip', ip], 900, cfg.verifyIpPer15Min);
  // The attempt counter is saved even when the guess is wrong (the transaction does not roll back on a wrong code).
  const row = await store.tx(async (tx) => {
    const c = await tx.get('codes', { purpose, subject, used_at: null, invalidated_at: null }, { order: 'id DESC', lock: true });
    if (!c || new Date(c.expires_at).getTime() <= ctx.now().getTime()) return null;
    const attempts = await tx.increment('codes', { id: c.id }, 'attempts', 1);
    if (attempts > c.max_attempts) { await tx.update('codes', { id: c.id }, { invalidated_at: nowD(ctx) }); return null; }
    if (!safeEq(hashCode(cfg.codePepper, purpose, subject, String(code).trim()), c.code_hash)) return null;
    return (await tx.update('codes', { id: c.id, used_at: null }, { used_at: nowD(ctx) })) === 1 ? c : null;
  });
  if (!row) throw new AppError(400, 'BAD_CODE', 'invalid or expired code');
  return row;
}

/* =============================== 11. SESSIONS, PROFILE, LOCATION =============================== */
export async function createSession(ctx, userId, kind) {
  const token = newToken(); const days = kind === 'web' ? ctx.cfg.sessionDaysWeb : ctx.cfg.sessionDaysTelegram;
  const expires = addSec(ctx, days * 86400);
  await ctx.store.insert('sessions', { token_hash: sha256(token), user_id: userId, kind, expires_at: expires, last_seen_at: nowD(ctx) });
  return { token, expires };
}
export async function profileOf(ctx, user) {
  const [cred, tg] = await Promise.all([ctx.store.get('credentials', { user_id: user.id }), ctx.store.get('tg_identities', { user_id: user.id })]);
  return { accountId: user.public_id, username: user.username, status: user.status, ageConfirmed: !!user.age_confirmed_at, email: cred ? cred.email : null, emailVerified: !!(cred && cred.email_verified_at), telegramLinked: !!tg, telegramUsername: tg ? tg.username : null, hasPassword: !!(cred && cred.password_hash) };
}
export async function authenticate(ctx, token, { allowRestricted = false } = {}) {
  if (!token) throw new AppError(401, 'UNAUTHENTICATED');
  const s = await ctx.store.get('sessions', { token_hash: sha256(token), revoked_at: null });
  if (!s || new Date(s.expires_at).getTime() <= ctx.now().getTime()) throw new AppError(401, 'UNAUTHENTICATED');
  const user = await ctx.store.get('users', { id: s.user_id });
  if (!user) throw new AppError(401, 'UNAUTHENTICATED');
  if (!allowRestricted && user.status === 'banned') throw new AppError(403, 'ACCOUNT_BANNED');
  if (!allowRestricted && user.status === 'suspended') throw new AppError(403, 'ACCOUNT_SUSPENDED');
  if (ctx.now().getTime() - new Date(s.last_seen_at || 0).getTime() > 600000) ctx.store.update('sessions', { id: s.id }, { last_seen_at: nowD(ctx) }).catch(() => {});
  return { user, session: s };
}
async function newUser(store, { username = null, signupRef = null }) {
  for (let i = 0; i < 8; i++) {
    try { return await store.insert('users', { public_id: randId('BC-', 10), username, signup_referral_code: signupRef }); }
    catch (e) { if (!(e.code === 'DUPLICATE' && !/username/.test(e.constraint || ''))) throw e; }
  }
  throw new AppError(500, 'ID_GENERATION_FAILED');
}
export async function isEmptyUser(store, userId) {
  if (await store.ledgerActivity(userId)) return false;
  for (const [t, w] of [['referrals', { invitee_id: userId }], ['referrals', { inviter_id: userId }], ['deposit_addresses', { user_id: userId }], ['bets', { user_id: userId }], ['quotes', { user_id: userId }], ['withdrawals', { user_id: userId }], ['credentials', { user_id: userId }]]) if (await store.count(t, w)) return false;
  return true;
}
// Country/city come from the hosting network's headers (no permission needed, no external lookups). The IP itself is stored only as a keyed hash.
export function geoFromHeaders(h) {
  const dec1 = (v) => { try { return decodeURIComponent(String(v || '')).slice(0, 80) || null; } catch { return null; } };
  const country = String(h['cf-ipcountry'] || h['x-vercel-ip-country'] || h['x-country-code'] || '').toUpperCase().slice(0, 2) || null;
  return { country: country && country !== 'XX' ? country : null, region: dec1(h['x-vercel-ip-country-region'] || h['cf-region-code']), city: dec1(h['x-vercel-ip-city'] || h['cf-ipcity']) };
}
export async function trackLocation(ctx, userId, { ip, geo }) {
  try {
    const ipHash = hmacHex(ctx.cfg.codePepper, 'ip|' + ip).slice(0, 32);
    const prev = (await ctx.store.list('user_locations', { user_id: userId, source: 'ip' }, { order: 'id DESC', limit: 1 }))[0];
    if (prev && prev.ip_hash === ipHash && prev.country === ((geo && geo.country) || null) && ctx.now().getTime() - new Date(prev.created_at).getTime() < 6 * 3600e3) return;
    await ctx.store.insert('user_locations', { user_id: userId, source: 'ip', country: geo && geo.country, region: geo && geo.region, city: geo && geo.city, ip_hash: ipHash });
  } catch (e) { ctx.log('location tracking failed', e.message); }
}
// Exact GPS is saved ONLY when the user explicitly allowed it in their phone/Telegram. They can delete it at any time.
export async function saveGps(ctx, user, { lat, lng, accuracy, consent }) {
  if (consent !== true) throw new AppError(400, 'CONSENT_REQUIRED');
  const la = Number(lat); const lo = Number(lng); const ac = accuracy == null ? null : Number(accuracy);
  if (!Number.isFinite(la) || !Number.isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180 || (ac != null && (!Number.isFinite(ac) || ac < 0))) throw new AppError(400, 'BAD_LOCATION');
  await limit(ctx, ['gps', user.id], 3600, 10);
  await ctx.store.insert('user_locations', { user_id: user.id, source: 'gps', lat: la, lng: lo, accuracy_m: ac, consent_at: nowD(ctx) });
  return { saved: true };
}
export async function deleteGps(ctx, user) {
  const n = await ctx.store.del('user_locations', { user_id: user.id, source: 'gps' });
  await audit(ctx, { actorType: 'user', actorId: user.id, action: 'gps_deleted', details: { rows: n } });
  return { deleted: n };
}

/* =============================== 12. REFERRALS =============================== */
export async function referralCodeFor(ctx, user) {
  if (user.referral_code) return user.referral_code;
  for (let i = 0; i < 8; i++) {
    try { if (await ctx.store.update('users', { id: user.id, referral_code: null }, { referral_code: randId('', 8) })) break; } catch (e) { if (e.code !== 'DUPLICATE') throw e; }
    const u = await ctx.store.get('users', { id: user.id }); if (u.referral_code) return u.referral_code;
  }
  return (await ctx.store.get('users', { id: user.id })).referral_code;
}
// A referral qualifies when the invited person has a unique username (and therefore their permanent ID). A click alone never counts.
export async function onRegistered(ctx, user) {
  const code = user.signup_referral_code; if (!code) return;
  const inviter = await ctx.store.get('users', { referral_code: code });
  if (!inviter || inviter.id === user.id || inviter.status !== 'active') return;
  const reward = ctx.cfg.referralRewardUsdt;
  try {
    await ctx.store.tx(async (tx) => {
      const r = await tx.insert('referrals', { inviter_id: inviter.id, invitee_id: user.id, status: 'pending' });
      const j = await tx.postJournal({ kind: 'referral_reward', idempotencyKey: `referral:${user.id}`, entries: [SYS('referral', 'budget', 'USDT', neg(reward)), U(inviter.id, 'earnings', 'USDT', reward)], meta: { invitee: user.id } });
      await tx.update('referrals', { id: r.id }, { status: 'qualified', qualified_at: nowD(ctx), reward_amount: reward, reward_journal_id: j.journalId });
    });
    await notify(ctx, { userId: inviter.id, kind: 'referral_reward', payload: { amount: reward } });
  } catch (e) { if (e.code !== 'DUPLICATE') ctx.log('referral failed', e.message); }
}
export async function referralInfo(ctx, user) {
  const code = await referralCodeFor(ctx, user);
  const list = await ctx.store.list('referrals', { inviter_id: user.id }, { order: 'id DESC', limit: 100 });
  const items = [];
  for (const r of list) { const inv = await ctx.store.get('users', { id: r.invitee_id }); items.push({ id: r.id, label: inv && inv.username ? inv.username : inv ? inv.public_id : '', status: r.status === 'qualified' ? 'completed' : 'pending', reward: r.reward_amount ? fmt(dec(r.reward_amount)) : null, createdAt: r.created_at }); }
  return { link: ctx.cfg.referralBaseUrl ? `${ctx.cfg.referralBaseUrl}/?ref=${code}` : null, code, qualifyingCount: list.filter((r) => r.status === 'qualified').length, items };
}
export const qualifyingCount = (ctx, userId) => ctx.store.count('referrals', { inviter_id: userId, status: 'qualified' });

/* =============================== 13. ACCOUNTS: browser sign-up, login, reset =============================== */
export async function startSignup(ctx, { email, ref, ip }) {
  const e = normalizeEmail(email); if (!e) throw new AppError(400, 'BAD_EMAIL');
  const cred = await ctx.store.get('credentials', { email: e });
  if (cred && cred.email_verified_at) throw new AppError(409, 'EMAIL_TAKEN');
  await issueCode(ctx, { purpose: 'signup', subject: e, to: e, meta: { ref: normalizeRef(ref) }, ip });
}
export async function verifySignup(ctx, { email, code, password, ip }) {
  const e = normalizeEmail(email); if (!e) throw new AppError(400, 'BAD_EMAIL');
  if (passwordProblem(password)) throw new AppError(400, 'WEAK_PASSWORD');
  const row = await verifyCode(ctx, { purpose: 'signup', subject: e, code, ip });
  const ticket = newToken();
  await ctx.store.insert('tickets', { token_hash: sha256(ticket), email: e, password_hash: await hashPassword(password), referral_code: (row.meta && row.meta.ref) || null, expires_at: addSec(ctx, ctx.cfg.ticketTtlSeconds) });
  return { verified: true, ticket };
}
export async function registerAccount(ctx, { ticket, username, ref, ip, geo }) {
  const name = normalizeUsername(username); if (!name) throw new AppError(400, 'BAD_USERNAME');
  await limit(ctx, ['register', ip], 3600, 30);
  const user = await ctx.store.tx(async (tx) => {
    const t = await tx.get('tickets', { token_hash: sha256(String(ticket || '')) }, { lock: true });
    if (!t || t.used_at || new Date(t.expires_at).getTime() <= ctx.now().getTime()) throw new AppError(401, 'BAD_TICKET');
    if (!(await tx.update('tickets', { id: t.id, used_at: null }, { used_at: nowD(ctx) }))) throw new AppError(401, 'BAD_TICKET');
    let u;
    try { u = await newUser(tx, { username: name, signupRef: normalizeRef(ref) || t.referral_code || null }); }
    catch (e) { if (e.code === 'DUPLICATE') throw new AppError(409, 'USERNAME_TAKEN'); throw e; }
    try { await tx.insert('credentials', { user_id: u.id, email: t.email, email_verified_at: nowD(ctx), password_hash: t.password_hash }); }
    catch (e) { if (e.code === 'DUPLICATE') throw new AppError(409, 'EMAIL_TAKEN'); throw e; }
    return u;
  });
  await audit(ctx, { actorType: 'user', actorId: user.id, action: 'register', targetType: 'user', targetId: user.id });
  await onRegistered(ctx, user);
  await trackLocation(ctx, user.id, { ip, geo });
  const s = await createSession(ctx, user.id, 'web');
  return { user: await profileOf(ctx, user), session: s };
}
export async function login(ctx, { identifier, password, ip, geo }) {
  const id = String(identifier || '').trim().toLowerCase();
  if (!id || !password) throw new AppError(401, 'BAD_LOGIN');
  await limit(ctx, ['login', ip, id], 900, ctx.cfg.loginPer15Min);
  await limit(ctx, ['loginid', id], 900, ctx.cfg.loginPer15Min * 2);
  let user = null; let cred = null;
  if (id.includes('@')) { cred = await ctx.store.get('credentials', { email: id }); if (cred) user = await ctx.store.get('users', { id: cred.user_id }); }
  else { user = await ctx.store.userByUsername(id); if (user) cred = await ctx.store.get('credentials', { user_id: user.id }); }
  const ok = user && cred && cred.password_hash ? await verifyPassword(password, cred.password_hash) : await dummyVerify(password);
  if (!ok) { await audit(ctx, { action: 'login_failed', details: { id: sha256(id).slice(0, 12) } }); throw new AppError(401, 'BAD_LOGIN'); }
  await trackLocation(ctx, user.id, { ip, geo });
  const s = await createSession(ctx, user.id, 'web');
  return { user: await profileOf(ctx, user), session: s };
}
export async function resetStart(ctx, { email, ip }) {
  const e = normalizeEmail(email); if (!e) throw new AppError(400, 'BAD_EMAIL');
  const cred = await ctx.store.get('credentials', { email: e });
  if (!cred || !cred.email_verified_at) { await limit(ctx, ['resetfake', ip], 3600, 30); return; }   // same answer whether or not the account exists
  await issueCode(ctx, { purpose: 'reset', subject: e, userId: cred.user_id, to: e, ip });
}
export async function resetConfirm(ctx, { email, code, password, ip }) {
  const e = normalizeEmail(email); if (!e) throw new AppError(400, 'BAD_EMAIL');
  if (passwordProblem(password)) throw new AppError(400, 'WEAK_PASSWORD');
  const cred = await ctx.store.get('credentials', { email: e });
  const row = await verifyCode(ctx, { purpose: 'reset', subject: e, code, ip });
  if (!cred || cred.user_id !== row.user_id) throw new AppError(400, 'BAD_CODE');
  await ctx.store.update('credentials', { user_id: cred.user_id }, { password_hash: await hashPassword(password) });
  await ctx.store.update('sessions', { user_id: cred.user_id, revoked_at: null }, { revoked_at: nowD(ctx) });
  await audit(ctx, { actorType: 'user', actorId: cred.user_id, action: 'password_reset' });
}
export async function logout(ctx, token) { if (token) await ctx.store.update('sessions', { token_hash: sha256(token), revoked_at: null }, { revoked_at: nowD(ctx) }); }

/* =============================== 14. ACCOUNTS: Telegram =============================== */
async function linkTelegramToWeb(ctx, tx, { tgId, tgUsername, webUserId, tgUserId }) {
  // Moves the Telegram identity onto an existing browser account (never creates a second account).
  const webTg = await tx.get('tg_identities', { user_id: webUserId });
  if (webTg && webTg.tg_id !== String(tgId)) throw new AppError(409, 'TELEGRAM_ALREADY_LINKED');
  if (tgUserId != null && tgUserId !== webUserId) {
    if (!(await isEmptyUser(tx, tgUserId))) throw new AppError(409, 'TELEGRAM_ALREADY_LINKED');
    await tx.update('sessions', { user_id: tgUserId }, { user_id: webUserId });
    await tx.del('tg_identities', { tg_id: String(tgId) });
    await tx.del('users', { id: tgUserId });
  }
  if (!(await tx.get('tg_identities', { tg_id: String(tgId) }))) await tx.insert('tg_identities', { tg_id: String(tgId), user_id: webUserId, username: tgUsername });
}
export async function telegramAuth(ctx, { initData, ip, geo }) {
  await limit(ctx, ['tgauth', ip], 600, 60);
  const t = verifyInitData(initData, ctx.cfg.botToken, { maxAgeSec: ctx.cfg.tgAuthMaxAgeSec, nowSec: Math.floor(ctx.now().getTime() / 1000) });
  let linkError = null; let user;
  const param = t.startParam || '';
  const linkTok = param.startsWith('link_') ? await ctx.store.get('link_tokens', { token_hash: sha256(param.slice(5)) }) : null;
  const ident = await ctx.store.get('tg_identities', { tg_id: t.tgId });
  if (ident) {
    user = await ctx.store.get('users', { id: ident.user_id });
    if (ident.username !== t.username) await ctx.store.update('tg_identities', { tg_id: t.tgId }, { username: t.username });
  }
  if (linkTok && !linkTok.used_at && new Date(linkTok.expires_at).getTime() > ctx.now().getTime()) {
    try {
      await ctx.store.tx(async (tx) => {
        if (!(await tx.update('link_tokens', { id: linkTok.id, used_at: null }, { used_at: nowD(ctx) }))) throw new AppError(409, 'LINK_USED');
        await linkTelegramToWeb(ctx, tx, { tgId: t.tgId, tgUsername: t.username, webUserId: linkTok.user_id, tgUserId: user ? user.id : null });
      });
      user = await ctx.store.get('users', { id: linkTok.user_id });
      await audit(ctx, { actorType: 'user', actorId: user.id, action: 'telegram_linked' });
    } catch (e) { if (e instanceof AppError) linkError = e.code; else throw e; }
  }
  if (!user) {
    user = await ctx.store.tx(async (tx) => {
      const u = await newUser(tx, { signupRef: normalizeRef(param) });
      await tx.insert('tg_identities', { tg_id: t.tgId, user_id: u.id, username: t.username });
      return u;
    }).catch(async (e) => { if (e.code === 'DUPLICATE') { const i2 = await ctx.store.get('tg_identities', { tg_id: t.tgId }); return ctx.store.get('users', { id: i2.user_id }); } throw e; });
  }
  await trackLocation(ctx, user.id, { ip, geo });
  const s = await createSession(ctx, user.id, 'telegram');
  return { token: s.token, user: await profileOf(ctx, user), linkError };
}
export async function telegramWidgetLogin(ctx, { authData, ip, geo }) {
  await limit(ctx, ['tgwidget', ip], 600, 30);
  const t = verifyLoginWidget(authData, ctx.cfg.botToken, { maxAgeSec: ctx.cfg.tgAuthMaxAgeSec, nowSec: Math.floor(ctx.now().getTime() / 1000) });
  const ident = await ctx.store.get('tg_identities', { tg_id: t.tgId });
  if (!ident) throw new AppError(404, 'NO_ACCOUNT');
  const user = await ctx.store.get('users', { id: ident.user_id });
  await trackLocation(ctx, user.id, { ip, geo });
  const s = await createSession(ctx, user.id, 'web');
  return { user: await profileOf(ctx, user), session: s };
}

/* =============================== 15. PROFILE, AGE, EMAIL, ACCOUNT LINKING =============================== */
export async function setUsername(ctx, user, raw) {
  const name = normalizeUsername(raw); if (!name) throw new AppError(400, 'BAD_USERNAME');
  if (user.username) throw new AppError(409, 'USERNAME_LOCKED');
  try { if (!(await ctx.store.update('users', { id: user.id, username: null }, { username: name }))) throw new AppError(409, 'USERNAME_LOCKED'); }
  catch (e) { if (e.code === 'DUPLICATE') throw new AppError(409, 'USERNAME_TAKEN'); throw e; }
  const fresh = await ctx.store.get('users', { id: user.id });
  await audit(ctx, { actorType: 'user', actorId: user.id, action: 'username_set' });
  await onRegistered(ctx, fresh);
  return { username: name };
}
export async function confirmAge(ctx, user, policy) {
  await ctx.store.update('users', { id: user.id, age_confirmed_at: null }, { age_confirmed_at: nowD(ctx), age_policy_version: String(policy || '1').slice(0, 20) });
  await audit(ctx, { actorType: 'user', actorId: user.id, action: 'age_confirmed' });
  return { confirmed: true };
}
export async function emailLinkStart(ctx, user, { email, ip }) {
  const e = normalizeEmail(email); if (!e) throw new AppError(400, 'BAD_EMAIL');
  const mine = await ctx.store.get('credentials', { user_id: user.id });
  if (mine && mine.email_verified_at) throw new AppError(409, 'EMAIL_ALREADY_SET');
  const other = await ctx.store.get('credentials', { email: e });
  if (other && other.user_id !== user.id) throw new AppError(409, 'EMAIL_TAKEN');
  await issueCode(ctx, { purpose: 'link_email', subject: `${user.id}:${e}`, userId: user.id, to: e, ip });
}
export async function emailLinkVerify(ctx, user, { email, code, ip }) {
  const e = normalizeEmail(email); if (!e) throw new AppError(400, 'BAD_EMAIL');
  await verifyCode(ctx, { purpose: 'link_email', subject: `${user.id}:${e}`, code, ip });
  try {
    const mine = await ctx.store.get('credentials', { user_id: user.id });
    if (mine) await ctx.store.update('credentials', { user_id: user.id }, { email: e, email_verified_at: nowD(ctx) });
    else await ctx.store.insert('credentials', { user_id: user.id, email: e, email_verified_at: nowD(ctx) });
  } catch (err) { if (err.code === 'DUPLICATE') throw new AppError(409, 'EMAIL_TAKEN'); throw err; }
  await audit(ctx, { actorType: 'user', actorId: user.id, action: 'email_linked' });
  return { user: await profileOf(ctx, await ctx.store.get('users', { id: user.id })) };
}
// Telegram user -> existing browser account: prove the password, then confirm a code sent to that account's email.
export async function linkStart(ctx, user, { identifier, password, ip }) {
  const id = String(identifier || '').trim().toLowerCase();
  await limit(ctx, ['linkstart', user.id], 900, 10);
  let web = null; let cred = null;
  if (id.includes('@')) { cred = await ctx.store.get('credentials', { email: id }); if (cred) web = await ctx.store.get('users', { id: cred.user_id }); }
  else { web = await ctx.store.userByUsername(id); if (web) cred = await ctx.store.get('credentials', { user_id: web.id }); }
  const ok = web && cred && cred.password_hash ? await verifyPassword(password, cred.password_hash) : await dummyVerify(password);
  if (!ok) throw new AppError(401, 'BAD_LOGIN');
  if (web.id === user.id) throw new AppError(409, 'ALREADY_LINKED');
  if (await ctx.store.get('tg_identities', { user_id: web.id })) throw new AppError(409, 'TELEGRAM_ALREADY_LINKED');
  if (!(await isEmptyUser(ctx.store, user.id))) throw new AppError(409, 'TELEGRAM_ALREADY_LINKED');
  await issueCode(ctx, { purpose: 'link_tg', subject: `tg:${user.id}`, userId: web.id, to: cred.email, ip });
}
export async function linkConfirm(ctx, user, { code, ip }) {
  const row = await verifyCode(ctx, { purpose: 'link_tg', subject: `tg:${user.id}`, code, ip });
  const tg = await ctx.store.get('tg_identities', { user_id: user.id });
  if (!tg) throw new AppError(409, 'NO_TELEGRAM_SESSION');
  await ctx.store.tx((tx) => linkTelegramToWeb(ctx, tx, { tgId: tg.tg_id, tgUsername: tg.username, webUserId: row.user_id, tgUserId: user.id }));
  await audit(ctx, { actorType: 'user', actorId: row.user_id, action: 'telegram_linked_by_password' });
  return { user: await profileOf(ctx, await ctx.store.get('users', { id: row.user_id })) };
}
export async function telegramLinkToken(ctx, user) {
  if (await ctx.store.get('tg_identities', { user_id: user.id })) throw new AppError(409, 'ALREADY_LINKED');
  await limit(ctx, ['linktok', user.id], 3600, 10);
  const token = newToken(24);
  await ctx.store.insert('link_tokens', { token_hash: sha256(token), user_id: user.id, expires_at: addSec(ctx, ctx.cfg.linkTokenTtlSeconds) });
  return { token };
}

/* =============================== 16. LIVE PRICES (median of several exchanges) =============================== */
export const COINS = ['BTC', 'ETH', 'SOL'];
const PAIRS = { BTC: { binance: 'BTCUSDT', coinbase: 'BTC-USD', kraken: 'XBTUSD' }, ETH: { binance: 'ETHUSDT', coinbase: 'ETH-USD', kraken: 'ETHUSD' }, SOL: { binance: 'SOLUSDT', coinbase: 'SOL-USD', kraken: 'SOLUSD' } };
async function getJson(ctx, url, ms = 6000) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
  try { const r = await ctx.fetch(url, { signal: ac.signal, headers: { accept: 'application/json' } }); if (!r.ok) throw new Error('http ' + r.status); return await r.json(); } finally { clearTimeout(t); }
}
const minuteFloor = (ms) => Math.floor(ms / 60000) * 60000;
const SOURCES = {
  binance: {
    async spot(ctx, coin) {
      for (const host of ['https://api.binance.com', 'https://data-api.binance.vision']) {
        try { const d = await getJson(ctx, `${host}/api/v3/ticker/price?symbol=${PAIRS[coin].binance}`); const p = decOrNull(d.price); if (p) return p; } catch { /* try next host */ }
      }
      throw new Error('binance');
    },
    async at(ctx, coin, ts) {
      for (const host of ['https://api.binance.com', 'https://data-api.binance.vision']) {
        try { const d = await getJson(ctx, `${host}/api/v3/klines?symbol=${PAIRS[coin].binance}&interval=1m&startTime=${minuteFloor(ts)}&limit=1`); if (d[0] && Number(d[0][0]) === minuteFloor(ts)) { const p = decOrNull(d[0][1]); if (p) return p; } } catch { /* next */ }
      }
      throw new Error('binance');
    }
  },
  coinbase: {
    async spot(ctx, coin) { const d = await getJson(ctx, `https://api.coinbase.com/v2/prices/${PAIRS[coin].coinbase}/spot`); const p = decOrNull(d.data && d.data.amount); if (!p) throw new Error('coinbase'); return p; },
    async at(ctx, coin, ts) {
      const s = minuteFloor(ts); const d = await getJson(ctx, `https://api.exchange.coinbase.com/products/${PAIRS[coin].coinbase}/candles?granularity=60&start=${new Date(s).toISOString()}&end=${new Date(s + 60000).toISOString()}`);
      const c = Array.isArray(d) ? d.find((x) => x[0] * 1000 === s) : null; const p = c && decOrNull(String(c[3])); if (!p) throw new Error('coinbase'); return p;
    }
  },
  kraken: {
    async spot(ctx, coin) { const d = await getJson(ctx, `https://api.kraken.com/0/public/Ticker?pair=${PAIRS[coin].kraken}`); const k = d.result && Object.keys(d.result)[0]; const p = k && decOrNull(d.result[k].c && d.result[k].c[0]); if (!p) throw new Error('kraken'); return p; },
    async at(ctx, coin, ts) {
      const s = minuteFloor(ts); const d = await getJson(ctx, `https://api.kraken.com/0/public/OHLC?pair=${PAIRS[coin].kraken}&interval=1&since=${Math.floor(s / 1000) - 1}`);
      const k = d.result && Object.keys(d.result).find((x) => x !== 'last'); const row = k && d.result[k].find((x) => x[0] * 1000 === s); const p = row && decOrNull(String(row[1])); if (!p) throw new Error('kraken'); return p;
    }
  }
};
const median = (arr) => { const a = [...arr].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2n; };
export function aggregatePrices(list) {   // [{source, price: BigInt}]
  if (list.length < 2) throw new AppError(503, 'PRICE_UNAVAILABLE', 'not enough price sources');
  const med = median(list.map((x) => x.price));
  const ok = list.filter((x) => (x.price > med ? x.price - med : med - x.price) * 20n <= med);   // drop anything more than 5% away
  if (ok.length < 2) throw new AppError(503, 'PRICE_UNAVAILABLE', 'price sources disagree');
  return { price: median(ok.map((x) => x.price)), sources: ok.map((x) => x.source) };
}
async function gather(ctx, kind, coin, ts) {
  const out = await Promise.all(Object.entries(SOURCES).map(async ([source, fn]) => { try { return { source, price: await fn[kind](ctx, coin, ts) }; } catch { return null; } }));
  return aggregatePrices(out.filter(Boolean));
}
export async function spotPrice(ctx, coin) {
  if (!COINS.includes(coin)) throw new AppError(400, 'BAD_COIN');
  const hit = ctx.cache.get('spot:' + coin);
  if (hit && ctx.now().getTime() - hit.at < 5000) return hit.v;
  const v = await gather(ctx, 'spot', coin);
  ctx.cache.set('spot:' + coin, { at: ctx.now().getTime(), v });
  return v;
}
// Price at an exact moment = open price of the 1-minute candle starting at that minute, median of the sources that have it.
export const priceAt = (ctx, coin, ts) => gather(ctx, 'at', coin, ts);
export async function savePrice(ctx, { symbol, price, sources, ts, purpose }) {
  return ctx.store.insert('price_snapshots', { symbol, price: fmt(price), source: sources.join('+'), sources, ts: new Date(ts), purpose });
}
// 7-day hourly chart for the Earnings page (the frontend draws it). Binance first, Coinbase as backup.
export async function chartPoints(ctx, coin) {
  if (!COINS.includes(coin)) throw new AppError(400, 'BAD_COIN');
  const hit = ctx.cache.get('chart:' + coin);
  if (hit && ctx.now().getTime() - hit.at < 60000) return hit.v;
  let pts = null;
  for (const host of ['https://api.binance.com', 'https://data-api.binance.vision']) {
    try { const d = await getJson(ctx, `${host}/api/v3/klines?symbol=${PAIRS[coin].binance}&interval=1h&limit=168`, 9000); if (Array.isArray(d) && d.length > 24) { pts = d.map((k) => [Number(k[0]), Number(k[4])]); break; } } catch { /* next */ }
  }
  if (!pts) {
    try { const d = await getJson(ctx, `https://api.exchange.coinbase.com/products/${PAIRS[coin].coinbase}/candles?granularity=3600`, 9000); if (Array.isArray(d) && d.length > 24) pts = d.slice(0, 168).map((k) => [k[0] * 1000, Number(k[4])]).sort((a, b) => a[0] - b[0]); } catch { /* none */ }
  }
  if (!pts) throw new AppError(503, 'CHART_UNAVAILABLE');
  const v = { points: pts }; ctx.cache.set('chart:' + coin, { at: ctx.now().getTime(), v }); return v;
}

/* =============================== 17. PLISIO DEPOSITS (mainnet USDT only) =============================== */
export const NETWORKS = { TRC20: { cid: 'USDT_TRX', re: /^T[1-9A-HJ-NP-Za-km-z]{33}$/ }, ERC20: { cid: 'USDT', re: /^0x[a-fA-F0-9]{40}$/ }, BEP20: { cid: 'USDT_BSC', re: /^0x[a-fA-F0-9]{40}$/ }, TON: { cid: 'USDT_TON', re: /^(?:[EUk0]Q[A-Za-z0-9_+/-]{46}|-?[01]:[a-fA-F0-9]{64})$/ } };
const networkOfCid = (cid) => Object.keys(NETWORKS).find((n) => NETWORKS[n].cid === cid) || null;
async function plisioGet(ctx, path, params = {}) {
  const url = new URL('https://api.plisio.net/api/v1' + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('api_key', ctx.cfg.plisioKey);
  let j;
  try { j = await getJson(ctx, url.toString(), 12000); } catch (e) { throw new AppError(502, 'PLISIO_UNREACHABLE', 'payment provider unreachable'); }   // never log the URL: it contains the key
  if (!j || j.status !== 'success') throw new AppError(502, 'PLISIO_ERROR', 'payment provider error');
  return j.data;
}
export async function getDepositAddress(ctx, user, network) {
  if (!NETWORKS[network]) throw new AppError(400, 'BAD_NETWORK');
  if (!user.username) throw new AppError(403, 'REGISTER_FIRST');
  const cfg = NETWORKS[network];
  if (!ctx.cfg.plisioAllowed.includes(cfg.cid)) throw new AppError(503, 'NETWORK_DISABLED');
  let a = await ctx.store.get('deposit_addresses', { user_id: user.id, network });
  if (!a) {
    await limit(ctx, ['depaddr', user.id], 3600, 12);
    a = await ctx.store.tx(async (tx) => {
      await tx.get('users', { id: user.id }, { lock: true });                       // one address creation per user at a time
      const again = await tx.get('deposit_addresses', { user_id: user.id, network });
      if (again) return again;
      const uid = `bc${user.id}`;
      const data = await plisioGet(ctx, '/shops/deposit/new', { psys_cid: cfg.cid, uid });
      const address = String(data && data.hash || '').trim();
      if (!cfg.re.test(address)) throw new AppError(502, 'PLISIO_BAD_ADDRESS', 'provider returned an unexpected address');
      return tx.insert('deposit_addresses', { user_id: user.id, network, psys_cid: cfg.cid, address, uid });
    });
  }
  const deps = await ctx.store.list('deposits', { user_id: user.id, network }, { order: 'id DESC', limit: 10 });
  return { network, currency: cfg.cid, address: a.address, deposits: deps.map((d) => ({ amount: d.amount_credited ? fmt(dec(d.amount_credited)) : d.amount_sent ? fmt(dec(d.amount_sent)) : null, status: d.status === 'credited' ? 'completed' : 'pending', confirmations: d.confirmations })) };
}
// Credits a deposit exactly once. The money decision is based on Plisio's own authenticated API answer, not on the callback alone.
export async function processDeposit(ctx, { txnId, userId, network, psysCid, callbackSum, confirmations }) {
  if (!ctx.cfg.plisioAllowed.includes(psysCid) || NETWORKS[network].cid !== psysCid) return { outcome: 'ignored_not_allowed_network' };
  const op = await plisioGet(ctx, `/operations/${encodeURIComponent(txnId)}`);
  const o = (op && op.operation) || op || {};
  if (o.psys_cid && o.psys_cid !== psysCid) return { outcome: 'mismatch_currency' };
  if (o.type && String(o.type) !== 'cash_in') return { outcome: 'ignored_not_deposit' };
  const status = String(o.status || '');
  const sent = decOrNull(o.amount);
  let dep = await ctx.store.get('deposits', { txn_id: txnId });
  if (!dep) {
    try { dep = await ctx.store.insert('deposits', { user_id: userId, network, txn_id: txnId, psys_cid: psysCid, amount_sent: sent != null ? fmt(sent) : null, status: 'pending', confirmations: confirmations ?? null, provider_status: status, raw: { type: o.type, status } }); }
    catch (e) { if (e.code !== 'DUPLICATE') throw e; dep = await ctx.store.get('deposits', { txn_id: txnId }); }
  } else if (dep.user_id !== userId) return { outcome: 'user_mismatch' };
  if (status !== 'completed') { await ctx.store.update('deposits', { id: dep.id }, { provider_status: status, confirmations: confirmations ?? dep.confirmations }); return { outcome: 'pending' }; }
  if (dep.status === 'credited') return { outcome: 'duplicate' };
  const cb = decOrNull(callbackSum);
  const amount = cb != null && sent != null ? (cb < sent ? cb : sent) : (cb ?? null);   // never credit more than Plisio says was received
  if (amount == null || amount <= 0n) { await alertAdmins(ctx, 'deposit_needs_review', { txnId, userId }); return { outcome: 'needs_review' }; }
  await ctx.store.tx(async (tx) => {
    const claimed = await tx.update('deposits', { id: dep.id, credited_at: null }, { status: 'credited', credited_at: nowD(ctx), amount_credited: fmt(amount), provider_status: status });
    if (claimed !== 1) return;
    const j = await tx.postJournal({ kind: 'deposit', idempotencyKey: `deposit:${txnId}`, entries: [SYS('external', 'clearing', 'USDT', neg(amount)), U(userId, 'deposit', 'USDT', amount)], meta: { txn: txnId, network } });
    await tx.update('deposits', { id: dep.id }, { journal_id: j.journalId });
  });
  await notify(ctx, { userId, kind: 'deposit_credited', payload: { amount: fmt(amount) } });
  return { outcome: 'credited' };
}
export async function plisioCallback(ctx, { raw, body, ip }) {
  await limit(ctx, ['plisiocb', ip], 60, 120);
  const eventKey = sha256(raw || JSON.stringify(body));
  let ev;
  try { ev = await ctx.store.insert('provider_events', { event_key: eventKey, provider: 'plisio', txn_id: body.txn_id || null, payload: { ...body, verify_hash: undefined } }); }
  catch (e) { if (e.code !== 'DUPLICATE') throw e; ev = await ctx.store.get('provider_events', { event_key: eventKey }); if (ev && ['credited', 'duplicate', 'ignored_not_allowed_network'].includes(ev.outcome)) return { outcome: 'duplicate' }; }
  const done = (outcome) => ctx.store.update('provider_events', { id: ev.id }, { outcome }).then(() => ({ outcome }));
  const { verify_hash: vh, ...rest } = body || {};
  const hashOk = !!vh && safeEq(hmacHex(ctx.cfg.plisioKey, JSON.stringify(rest), 'sha1'), vh);
  if (!hashOk) await alertAdmins(ctx, 'plisio_signature_mismatch', { txn: body.txn_id });   // Plisio's API answer below still decides; a forged callback cannot make Plisio say "completed"
  const txnId = String(body.txn_id || '');
  if (!/^[A-Za-z0-9_-]{6,80}$/.test(txnId)) return done('bad_txn');
  if (body.ipn_type && body.ipn_type !== 'pay_in') return done('ignored_type');
  const psys = String(body.psys_cid || '');
  if (!ctx.cfg.plisioAllowed.includes(psys)) { await alertAdmins(ctx, 'deposit_ignored_non_mainnet', { psys, txn: txnId }); return done('ignored_not_allowed_network'); }
  const network = networkOfCid(psys);
  const m = /^bc(\d+)$/.exec(String(body.deposit_uid || ''));
  const userId = m ? Number(m[1]) : null;
  const addr = userId ? await ctx.store.get('deposit_addresses', { user_id: userId, network }) : null;
  if (!addr) { await alertAdmins(ctx, 'deposit_unknown_address', { txn: txnId }); return done('unknown_address'); }
  try {
    const r = await processDeposit(ctx, { txnId, userId, network, psysCid: psys, callbackSum: body.deposit_sum, confirmations: Number.isFinite(Number(body.confirmations)) ? Number(body.confirmations) : null });
    return done(r.outcome);
  } catch (e) { ctx.log('deposit processing failed', e.message); await done('error'); throw e; }
}
export async function reconcileDeposits(ctx) {
  const rows = await ctx.store.list('deposits', { status: 'pending', created_at: { gte: new Date(ctx.now().getTime() - 3 * 86400e3) } }, { order: 'id ASC', limit: 100 });
  let credited = 0;
  for (const d of rows) {
    try { const r = await processDeposit(ctx, { txnId: d.txn_id, userId: d.user_id, network: d.network, psysCid: d.psys_cid, callbackSum: d.amount_sent, confirmations: d.confirmations }); if (r.outcome === 'credited') credited++; } catch (e) { ctx.log('reconcile failed', d.txn_id, e.message); }
  }
  return { checked: rows.length, credited };
}

/* =============================== 18. BUYING BTC / ETH / SOL (internal records, no fee) =============================== */
const qtyOf = (usdt, price) => floorTo8(divDec(usdt, price));
export async function createQuote(ctx, user, { coin, amountUsdt }) {
  if (!COINS.includes(coin)) throw new AppError(400, 'BAD_COIN');
  if (!user.username) throw new AppError(403, 'REGISTER_FIRST');
  if (await isPaused(ctx, 'purchases_paused')) throw new AppError(503, 'PURCHASES_PAUSED');
  const amt = decOrNull(amountUsdt);
  if (amt == null || amt < dec(ctx.cfg.minPurchaseUsdt) || amt > dec('1000000')) throw new AppError(400, 'BAD_AMOUNT');
  await limit(ctx, ['quote', user.id], 60, 20);
  const p = await spotPrice(ctx, coin);
  const qty = qtyOf(amt, p.price);
  if (qty <= 0n) throw new AppError(400, 'BAD_AMOUNT');
  const snap = await savePrice(ctx, { symbol: coin, price: p.price, sources: p.sources, ts: ctx.now(), purpose: 'quote' });
  const q = await ctx.store.insert('quotes', { public_id: randId('Q', 14), user_id: user.id, coin, usdt_amount: fmt(amt), price: fmt(p.price), qty: fmt(qty), expires_at: addSec(ctx, ctx.cfg.quoteTtlSeconds) });
  return { quoteId: q.public_id, estimatedAmount: fmt(qty), fee: '0', feeAsset: 'USDT', expiresAt: q.expires_at, priceSnapshot: snap.id };
}
export async function executeQuote(ctx, user, { quoteId }) {
  if (await isPaused(ctx, 'purchases_paused')) throw new AppError(503, 'PURCHASES_PAUSED');
  const res = await ctx.store.tx(async (tx) => {
    const q = await tx.get('quotes', { public_id: String(quoteId || ''), user_id: user.id }, { lock: true });
    if (!q) throw new AppError(404, 'QUOTE_NOT_FOUND');
    const done = await tx.get('purchases', { quote_id: q.id });
    if (done) return { completed: true, duplicate: true, coin: q.coin, qty: fmt(dec(done.qty)) };      // a retry of the same purchase: no second charge
    if (q.status !== 'open') throw new AppError(409, 'QUOTE_USED');
    if (new Date(q.expires_at).getTime() <= ctx.now().getTime()) { await tx.update('quotes', { id: q.id }, { status: 'expired' }); return { expired: true }; }
    if ((await tx.update('quotes', { id: q.id, status: 'open' }, { status: 'used' })) !== 1) throw new AppError(409, 'QUOTE_USED');
    const usdt = dec(q.usdt_amount); const qty = dec(q.qty);
    const j = await tx.postJournal({ kind: 'purchase', idempotencyKey: `buy:${q.id}`, entries: [U(user.id, 'deposit', 'USDT', neg(usdt)), SYS('purchases', 'pool', 'USDT', usdt), U(user.id, 'holding', q.coin, qty), SYS('holdings', 'liability', q.coin, neg(qty))], meta: { quote: q.public_id } });
    await tx.insert('purchases', { user_id: user.id, quote_id: q.id, coin: q.coin, usdt_amount: q.usdt_amount, qty: q.qty, price: q.price, journal_id: j.journalId });
    return { completed: true, coin: q.coin, qty: fmt(qty), usdt: fmt(usdt) };
  });
  if (res.expired) throw new AppError(410, 'QUOTE_EXPIRED');
  if (!res.duplicate) await notify(ctx, { userId: user.id, kind: 'purchase_done', payload: { qty: res.qty, coin: res.coin } });
  return res;
}

/* =============================== 19. SEVEN-DAY BETS AND SETTLEMENT =============================== */
// Total payouts INCLUDING the stake, exactly as shown in the approved frontend.
export const BET_PAYOUTS = { BTC: { 500: 3000, 1000: 6000, 2000: 12000, 3000: 18000 }, ETH: { 500: 2500, 1000: 5000, 2000: 10000, 3000: 15000 }, SOL: { 500: 1500, 1000: 3000, 2000: 6000, 3000: 9000 } };
export function betOutcome(startStr, finalStr) {          // exact integer maths, never rounded: +/-1% band is inclusive for STEADY
  const s = dec(startStr); const f = dec(finalStr); const d = f - s;
  if (d * 100n > s) return 'UP';
  if (-d * 100n > s) return 'DROP';
  return 'STEADY';
}
export async function placeBet(ctx, user, { coin, prediction, stake, idemKey }) {
  if (!user.username) throw new AppError(403, 'REGISTER_FIRST');
  if (!user.age_confirmed_at) throw new AppError(403, 'AGE_NOT_CONFIRMED');
  if (!COINS.includes(coin) || !['UP', 'DROP', 'STEADY'].includes(prediction)) throw new AppError(400, 'BAD_BET');
  const st = Number(stake); const total = BET_PAYOUTS[coin][st];
  if (!total) throw new AppError(400, 'BAD_STAKE');
  const key = String(idemKey || '').slice(0, 100) || newToken(12);
  const prior = await ctx.store.get('bets', { user_id: user.id, idem_key: key });
  if (prior) return { accepted: true, duplicate: true, bet: betView(prior) };
  if (await isPaused(ctx, 'bets_paused')) throw new AppError(503, 'BETS_PAUSED');
  await limit(ctx, ['bet', user.id], 60, 20);
  const p = await spotPrice(ctx, coin);
  await savePrice(ctx, { symbol: coin, price: p.price, sources: p.sources, ts: ctx.now(), purpose: 'bet_start' });
  const bet = await ctx.store.tx(async (tx) => {
    const b = await tx.insert('bets', { public_id: randId('B', 12), user_id: user.id, idem_key: key, coin, prediction, stake: String(st), payout_total: String(total), start_price: fmt(p.price), start_source: p.sources.join('+'), start_ts: nowD(ctx), settles_at: addSec(ctx, ctx.cfg.betDays * 86400) });
    const j = await tx.postJournal({ kind: 'bet_stake', idempotencyKey: `bet-stake:${b.id}`, entries: [U(user.id, 'deposit', 'USDT', neg(String(st))), SYS('bets', 'pool', 'USDT', String(st))], meta: { bet: b.public_id } });
    await tx.update('bets', { id: b.id }, { stake_journal_id: j.journalId });
    return b;
  });
  await notify(ctx, { userId: user.id, kind: 'bet_placed', payload: { coin, prediction, stake: String(st) } });
  return { accepted: true, bet: betView(bet) };
}
export function betView(b) {
  return { id: b.public_id, coin: b.coin, prediction: b.prediction, stake: fmt(dec(b.stake)), payout: fmt(dec(b.payout_total)), startPrice: fmt(dec(b.start_price)), finalPrice: b.final_price ? fmt(dec(b.final_price)) : null, settlesAt: b.settles_at,
    status: b.status === 'open' ? 'pending' : b.status === 'void' ? 'cancelled' : (b.result === b.prediction ? 'won' : 'lost'), result: b.result, createdAt: b.created_at };
}
async function settleBet(ctx, bet) {
  const settleMs = new Date(bet.settles_at).getTime();
  let fp = null;
  try { fp = await priceAt(ctx, bet.coin, settleMs); } catch { fp = null; }
  const stake = dec(bet.stake);
  const voidIt = !fp && ctx.now().getTime() - settleMs > ctx.cfg.voidAfterHours * 3600e3;
  if (!fp && !voidIt) return 'waiting';
  const result = fp ? betOutcome(bet.start_price, fmt(fp.price)) : null;
  const won = fp && result === bet.prediction;
  const out = await ctx.store.tx(async (tx) => {
    if ((await tx.update('bets', { id: bet.id, status: 'open' }, { status: voidIt ? 'void' : 'settled', result, final_price: fp ? fmt(fp.price) : null, final_source: fp ? fp.sources.join('+') : null, final_ts: new Date(settleMs), settled_at: nowD(ctx) })) !== 1) return null;   // already settled by someone else
    let entries; let kind; let info;
    if (voidIt) { kind = 'bet_void'; entries = [SYS('bets', 'pool', 'USDT', neg(stake)), U(bet.user_id, 'earnings', 'USDT', stake)]; info = { kind: 'bet_void', payload: { stake: fmt(stake) } }; }
    else if (won) { const payout = dec(bet.payout_total); kind = 'bet_win'; entries = [SYS('bets', 'pool', 'USDT', neg(stake)), SYS('house', 'pnl', 'USDT', neg(payout - stake)), U(bet.user_id, 'earnings', 'USDT', payout)]; info = { kind: 'bet_won', payload: { payout: fmt(payout) } }; }
    else { const back = stake / 2n; kind = 'bet_loss'; entries = [SYS('bets', 'pool', 'USDT', neg(stake)), U(bet.user_id, 'earnings', 'USDT', back), SYS('house', 'pnl', 'USDT', stake - back)]; info = { kind: 'bet_lost', payload: { returned: fmt(back) } }; }
    const j = await tx.postJournal({ kind, idempotencyKey: `bet-settle:${bet.id}`, entries, meta: { bet: bet.public_id, result } });
    await tx.update('bets', { id: bet.id }, { settle_journal_id: j.journalId });
    return info;
  });
  if (!out) return 'skipped';
  if (fp) await savePrice(ctx, { symbol: bet.coin, price: fp.price, sources: fp.sources, ts: settleMs, purpose: 'bet_final' });
  await notify(ctx, { userId: bet.user_id, kind: out.kind, payload: out.payload });
  return voidIt ? 'void' : 'settled';
}
// Safe to run many times and from several places at once: each bet can only be settled once.
export async function settleDueBets(ctx, { limit: n = 50 } = {}) {
  const due = await ctx.store.list('bets', { status: 'open', settles_at: { lte: nowD(ctx) } }, { order: 'settles_at ASC', limit: n });
  const r = { due: due.length, settled: 0, void: 0, waiting: 0, errors: 0 };
  for (const b of due) {
    try { const s = await settleBet(ctx, b); if (s === 'settled') r.settled++; else if (s === 'void') r.void++; else if (s === 'waiting') r.waiting++; }
    catch (e) { r.errors++; ctx.log('settle failed', b.public_id, e.message); await alertAdmins(ctx, 'settlement_error', { bet: b.public_id, error: String(e.message).slice(0, 120) }); }
  }
  return r;
}

/* =============================== 20. WITHDRAWALS (manual payout by admin) =============================== */
export const WD_ADDR = { BTC: /^(bc1[a-z0-9]{25,87}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/, ETH: /^0x[a-fA-F0-9]{40}$/, SOL: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/ };
const wdView = (w) => ({ id: w.public_id, asset: w.asset, network: w.network, amount: fmt(dec(w.amount)), address: w.address, status: w.status, reason: w.reason, createdAt: w.requested_at });
export const srcBucket = (asset) => (asset === 'USDT' ? 'earnings' : 'holding');
export async function createWithdrawal(ctx, user, { asset, network, amount, address, idemKey }) {
  if (!user.username) throw new AppError(403, 'REGISTER_FIRST');
  if (!ASSETS.includes(asset)) throw new AppError(400, 'BAD_ASSET');
  let net = null;
  if (asset === 'USDT') { if (!NETWORKS[network]) throw new AppError(400, 'BAD_NETWORK'); net = network; }
  const addr = String(address || '').trim();
  const re = asset === 'USDT' ? NETWORKS[net].re : WD_ADDR[asset];
  if (!re.test(addr)) throw new AppError(400, 'BAD_ADDRESS');
  const amt = /^\d+(\.\d{1,8})?$/.test(String(amount)) ? dec(String(amount)) : null;
  if (!amt || amt <= 0n) throw new AppError(400, 'BAD_AMOUNT');
  const key = String(idemKey || '').slice(0, 100) || newToken(12);
  const prior = await ctx.store.get('withdrawals', { user_id: user.id, idem_key: key });
  if (prior) return { accepted: true, duplicate: true, request: wdView(prior) };
  if (await isPaused(ctx, 'withdrawals_paused')) throw new AppError(503, 'WITHDRAWALS_PAUSED');
  const price = asset === 'USDT' ? ONE : (await spotPrice(ctx, asset)).price;
  const usd = mulDec(amt, price);
  if (usd < dec(String(ctx.cfg.minWithdrawUsdt))) throw new AppError(400, 'BELOW_MINIMUM');
  if ((await qualifyingCount(ctx, user.id)) < ctx.cfg.requiredReferrals) throw new AppError(403, 'NOT_ENOUGH_REFERRALS');
  const w = await ctx.store.tx(async (tx) => {
    let row;
    try { row = await tx.insert('withdrawals', { public_id: randId('W', 12), user_id: user.id, idem_key: key, asset, network: net, amount: fmt(amt), usd_value: fmt(usd), address: addr }); }
    catch (e) { if (e.code === 'DUPLICATE') throw new AppError(409, 'WITHDRAWAL_PENDING'); throw e; }       // one open request per balance
    const j = await tx.postJournal({ kind: 'withdrawal_hold', idempotencyKey: `wd-hold:${row.id}`, entries: [U(user.id, srcBucket(asset), asset, neg(amt)), U(user.id, 'reserved', asset, amt)], meta: { wd: row.public_id } });
    await tx.update('withdrawals', { id: row.id }, { hold_journal_id: j.journalId });
    return row;
  });
  await notify(ctx, { userId: user.id, kind: 'withdrawal_submitted', payload: { amount: fmt(amt), asset } });
  await alertAdmins(ctx, 'new_withdrawal', { id: w.public_id, asset, amount: fmt(amt), usd: fmt(usd) });
  return { accepted: true, request: wdView(w) };
}
async function releaseWithdrawal(ctx, tx, w, kind) {
  const amt = dec(w.amount);
  return tx.postJournal({ kind, idempotencyKey: `wd-release:${w.id}`, entries: [U(w.user_id, 'reserved', w.asset, neg(amt)), U(w.user_id, srcBucket(w.asset), w.asset, amt)], meta: { wd: w.public_id } });
}
export async function cancelWithdrawal(ctx, user, publicId) {
  const w = await ctx.store.tx(async (tx) => {
    const row = await tx.get('withdrawals', { public_id: String(publicId), user_id: user.id }, { lock: true });
    if (!row) throw new AppError(404, 'NOT_FOUND');
    if ((await tx.update('withdrawals', { id: row.id, status: 'pending' }, { status: 'cancelled', decided_at: nowD(ctx) })) !== 1) throw new AppError(409, 'NOT_PENDING');
    const j = await releaseWithdrawal(ctx, tx, row, 'withdrawal_release'); await tx.update('withdrawals', { id: row.id }, { final_journal_id: j.journalId });
    return row;
  });
  return { cancelled: true, request: wdView({ ...w, status: 'cancelled' }) };
}
export async function adminDecideWithdrawal(ctx, adminId, publicId, action, { reason, txnHash } = {}) {
  const res = await ctx.store.tx(async (tx) => {
    const w = await tx.get('withdrawals', { public_id: String(publicId) }, { lock: true });
    if (!w) throw new AppError(404, 'NOT_FOUND');
    if (action === 'approve') {
      if ((await tx.update('withdrawals', { id: w.id, status: 'pending' }, { status: 'approved', admin_id: adminId, decided_at: nowD(ctx) })) !== 1) throw new AppError(409, 'BAD_STATE');
      return { w, kind: 'withdrawal_approved' };
    }
    if (action === 'reject') {
      if (!String(reason || '').trim()) throw new AppError(400, 'REASON_REQUIRED');
      if (!['pending', 'approved'].includes(w.status)) throw new AppError(409, 'BAD_STATE');
      await tx.update('withdrawals', { id: w.id }, { status: 'rejected', reason: String(reason).slice(0, 300), admin_id: adminId, decided_at: nowD(ctx) });
      const j = await releaseWithdrawal(ctx, tx, w, 'withdrawal_release'); await tx.update('withdrawals', { id: w.id }, { final_journal_id: j.journalId });
      return { w, kind: 'withdrawal_rejected', reason };
    }
    if (action === 'paid') {
      const hash = String(txnHash || '').trim();
      if (hash.length < 6 || hash.length > 200) throw new AppError(400, 'TXN_HASH_REQUIRED');
      if ((await tx.update('withdrawals', { id: w.id, status: 'approved' }, { status: 'paid', txn_hash: hash, paid_at: nowD(ctx), admin_id: adminId })) !== 1) throw new AppError(409, 'BAD_STATE');
      const amt = dec(w.amount);
      const j = await tx.postJournal({ kind: 'withdrawal_paid', idempotencyKey: `wd-paid:${w.id}`, entries: [U(w.user_id, 'reserved', w.asset, neg(amt)), SYS('withdrawals', 'out', w.asset, amt)], meta: { wd: w.public_id, txn: hash } });
      await tx.update('withdrawals', { id: w.id }, { final_journal_id: j.journalId });
      return { w, kind: 'withdrawal_paid' };
    }
    throw new AppError(400, 'BAD_ACTION');
  });
  await notify(ctx, { userId: res.w.user_id, kind: res.kind, payload: { amount: fmt(dec(res.w.amount)), asset: res.w.asset, reason: res.reason } });
  await audit(ctx, { actorType: 'admin', actorId: adminId, action: `withdrawal_${action}`, targetType: 'withdrawal', targetId: publicId, details: { reason: reason || null } });
  return { ok: true };
}

/* =============================== 21. BALANCES, HISTORY, NOTIFICATIONS =============================== */
export async function balancesOf(ctx, user) {
  const b = await ctx.store.balances(user.id); const g = (k) => b[k] || '0';
  return { deposit: g('deposit|USDT'), earnings: g('earnings|USDT'), holdings: { BTC: g('holding|BTC'), ETH: g('holding|ETH'), SOL: g('holding|SOL') },
    reserved: { USDT: g('reserved|USDT'), BTC: g('reserved|BTC'), ETH: g('reserved|ETH'), SOL: g('reserved|SOL') }, qualifyingReferrals: await qualifyingCount(ctx, user.id), withdrawNetworks: Object.keys(NETWORKS) };
}
const TX_TYPE = { deposit: 'deposit', bet_stake: 'bet', bet_win: 'payout', bet_loss: 'returned_stake', bet_void: 'returned_stake', purchase: 'purchase', referral_reward: 'referral_reward' };
export async function transactionsOf(ctx, user) {
  const led = (await ctx.store.ledgerRows(user.id, 200)).filter((r) => TX_TYPE[r.kind] && (r.bucket === 'deposit' || r.bucket === 'earnings'));
  const items = led.map((r) => ({ id: 'l' + r.id, type: TX_TYPE[r.kind], status: 'completed', amount: r.amount, asset: r.asset, createdAt: r.created_at }));
  for (const w of await ctx.store.list('withdrawals', { user_id: user.id }, { order: 'id DESC', limit: 50 })) items.push({ id: 'w' + w.id, type: 'withdrawal', status: w.status === 'cancelled' ? 'failed' : w.status, amount: fmt(dec(w.amount)), asset: w.asset, createdAt: w.requested_at });
  return { items: items.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 100) };
}
export async function notificationsOf(ctx, user) {
  const rows = await ctx.store.list('notifications', { user_id: user.id, audience: 'user' }, { order: 'id DESC', limit: 30 });
  return { items: rows.filter((r) => NOTE_TEXT[r.kind]).map((r) => ({ id: r.id, text: NOTE_TEXT[r.kind](r.payload || {}), createdAt: r.created_at })) };
}

/* =============================== 22. TRANSLATION (Azure AI Translator free tier, cached forever) =============================== */
// Only the 50 languages that are NOT bundled in the frontend need this. English is always the fallback.
export const AZURE_LANG = { id: 'id', 'zh-TW': 'zh-Hant', ja: 'ja', ko: 'ko', it: 'it', nl: 'nl', pl: 'pl', uk: 'uk', vi: 'vi', th: 'th', fa: 'fa', he: 'he', ur: 'ur', bn: 'bn', ms: 'ms', fil: 'fil', ro: 'ro', el: 'el', cs: 'cs', hu: 'hu', sv: 'sv', da: 'da', fi: 'fi', no: 'nb', bg: 'bg', sr: 'sr-Cyrl', hr: 'hr', sk: 'sk', sl: 'sl', lt: 'lt', lv: 'lv', et: 'et', ka: 'ka', hy: 'hy', az: 'az', kk: 'kk', uz: 'uz', ky: 'ky', tg: 'tg', tk: 'tk', mn: 'mn-Cyrl', ne: 'ne', si: 'si', ta: 'ta', te: 'te', mr: 'mr', gu: 'gu', kn: 'kn', ml: 'ml', pa: 'pa' };
const PH = /\{[a-zA-Z_]+\}/g;
const stripHtml = (s) => s.replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
export async function translateStrings(ctx, { target, strings }) {
  const to = AZURE_LANG[target];
  if (!to) throw new AppError(400, 'UNSUPPORTED_LANGUAGE');
  if (!strings || typeof strings !== 'object') throw new AppError(400, 'BAD_REQUEST');
  const entries = Object.entries(strings).filter(([k, v]) => /^[a-z0-9_]{1,60}$/.test(k) && typeof v === 'string' && v.length > 0 && v.length <= 1000);
  if (!entries.length || entries.length > 500 || entries.reduce((n, [, v]) => n + v.length, 0) > 80000) throw new AppError(400, 'BAD_REQUEST');
  const ckey = (k, v) => `${k}:${sha256(v).slice(0, 8)}`;
  const have = new Map((await ctx.store.list('translations', { lang: target }, { limit: 1000 })).map((r) => [r.key, r.text]));
  const missing = entries.filter(([k, v]) => !have.has(ckey(k, v)));
  if (missing.length) {
    if (!ctx.cfg.azureKey) throw new AppError(501, 'TRANSLATION_NOT_CONFIGURED');
    await limit(ctx, ['translate', target], 3600, 6);
    for (let i = 0; i < missing.length; i += 40) {
      const batch = missing.slice(i, i + 40);
      const chars = batch.reduce((n, [, v]) => n + v.length, 0);
      const used = await ctx.store.translationChars(ctx.now().toISOString().slice(0, 7), chars);
      if (used > ctx.cfg.azureMonthlyCharCap) throw new AppError(503, 'TRANSLATION_QUOTA');
      const body = batch.map(([, v]) => ({ Text: v.replace(PH, (m) => `<span class="notranslate">${m}</span>`) }));
      let data;
      try {
        const r = await ctx.fetch(`https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&from=en&to=${encodeURIComponent(to)}&textType=html`, { method: 'POST', headers: { 'Ocp-Apim-Subscription-Key': ctx.cfg.azureKey, 'Ocp-Apim-Subscription-Region': ctx.cfg.azureRegion, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (!r.ok) throw new Error('azure ' + r.status);
        data = await r.json();
      } catch (e) { ctx.log('translation failed', e.message); throw new AppError(502, 'TRANSLATION_UNAVAILABLE'); }
      for (let j = 0; j < batch.length; j++) {
        const [k, v] = batch[j]; const text = stripHtml(String((data[j] && data[j].translations && data[j].translations[0] && data[j].translations[0].text) || '')).trim();
        const want = (v.match(PH) || []).sort().join(); const got = (text.match(PH) || []).sort().join();
        if (!text || want !== got) continue;                       // placeholders must survive untouched, otherwise keep English for this string
        try { await ctx.store.insert('translations', { lang: target, key: ckey(k, v), text, provider: 'azure' }); } catch (e) { if (e.code !== 'DUPLICATE') throw e; }
        have.set(ckey(k, v), text);
      }
    }
  }
  const out = {};
  for (const [k, v] of entries) { const t = have.get(ckey(k, v)); if (t) out[k] = t; }
  if (Object.keys(out).length < entries.length) throw new AppError(502, 'TRANSLATION_INCOMPLETE');   // the frontend keeps English instead of caching a half translation
  return { strings: out };
}

/* =============================== 23. ADMIN: Telegram identity + password + authenticator code =============================== */
const ADMIN_PRE_MIN = 15;
export async function adminAuthTelegram(ctx, { initData, ip }) {
  await limit(ctx, ['adminauth', ip], 600, 20);
  const t = verifyInitData(initData, ctx.cfg.botToken, { maxAgeSec: 3600, nowSec: Math.floor(ctx.now().getTime() / 1000) });
  if (!ctx.cfg.adminTelegramIds.includes(t.tgId)) { await audit(ctx, { action: 'admin_login_denied', details: { tg: t.tgId } }); throw new AppError(403, 'NOT_ADMIN'); }
  let a = await ctx.store.get('admins', { tg_id: t.tgId });
  if (!a) a = await ctx.store.insert('admins', { tg_id: t.tgId, label: t.username });
  const token = newToken();
  await ctx.store.insert('admin_sessions', { token_hash: sha256(token), admin_id: a.id, stage: 'password', expires_at: addSec(ctx, ADMIN_PRE_MIN * 60) });
  return { token, stage: a.password_hash ? 'password' : 'setup' };
}
export async function adminSession(ctx, token, { need = 'full', reauth = false } = {}) {
  if (!token) throw new AppError(401, 'ADMIN_UNAUTH');
  const s = await ctx.store.get('admin_sessions', { token_hash: sha256(token), revoked_at: null });
  if (!s || new Date(s.expires_at).getTime() <= ctx.now().getTime()) throw new AppError(401, 'ADMIN_UNAUTH');
  if (need && s.stage !== need) throw new AppError(401, 'ADMIN_STAGE');
  const admin = await ctx.store.get('admins', { id: s.admin_id });
  if (!admin || !ctx.cfg.adminTelegramIds.includes(admin.tg_id)) throw new AppError(403, 'NOT_ADMIN');   // removing an ID from the allowlist cuts access immediately
  if (reauth && (!s.reauth_at || ctx.now().getTime() - new Date(s.reauth_at).getTime() > 10 * 60000)) throw new AppError(403, 'REAUTH_REQUIRED');
  return { admin, session: s };
}
export async function adminPassword(ctx, token, { password }) {
  const { admin, session } = await adminSession(ctx, token, { need: 'password' });
  await limit(ctx, ['adminpw', admin.id], 900, 6);
  if (!admin.password_hash) {
    if (String(password || '').length < 12 || passwordProblem(password)) throw new AppError(400, 'WEAK_ADMIN_PASSWORD');
    const secret = newTotpSecret();
    await ctx.store.update('admins', { id: admin.id }, { password_hash: await hashPassword(password), totp_secret: encryptSecret(ctx.cfg, secret), totp_enabled: false });
    await ctx.store.update('admin_sessions', { id: session.id }, { stage: 'totp' });
    return { stage: 'totp', totpSetup: { secret, otpauthUrl: `otpauth://totp/BETCRYPTO%20Admin:${encodeURIComponent(admin.label || admin.tg_id)}?secret=${secret}&issuer=BETCRYPTO%20Admin` } };
  }
  if (!(await verifyPassword(password, admin.password_hash))) { await audit(ctx, { actorType: 'admin', actorId: admin.id, action: 'admin_password_failed' }); throw new AppError(401, 'BAD_ADMIN_LOGIN'); }
  await ctx.store.update('admin_sessions', { id: session.id }, { stage: 'totp' });
  return { stage: 'totp' };
}
export async function adminTotp(ctx, token, { code }) {
  const { admin, session } = await adminSession(ctx, token, { need: 'totp' });
  await limit(ctx, ['admintotp', admin.id], 900, 8);
  if (!admin.totp_secret || !totpVerify(decryptSecret(ctx.cfg, admin.totp_secret), code, ctx.now().getTime())) { await audit(ctx, { actorType: 'admin', actorId: admin.id, action: 'admin_totp_failed' }); throw new AppError(401, 'BAD_ADMIN_CODE'); }
  if (!admin.totp_enabled) await ctx.store.update('admins', { id: admin.id }, { totp_enabled: true });
  await ctx.store.update('admin_sessions', { id: session.id }, { stage: 'full', expires_at: addSec(ctx, ctx.cfg.adminSessionHours * 3600), reauth_at: nowD(ctx) });
  await audit(ctx, { actorType: 'admin', actorId: admin.id, action: 'admin_login' });
  return { stage: 'full' };
}
export async function adminReauth(ctx, token, { password }) {
  const { admin, session } = await adminSession(ctx, token);
  await limit(ctx, ['adminpw', admin.id], 900, 6);
  if (!(await verifyPassword(password, admin.password_hash))) throw new AppError(401, 'BAD_ADMIN_LOGIN');
  await ctx.store.update('admin_sessions', { id: session.id }, { reauth_at: nowD(ctx) });
  return { ok: true };
}

/* =============================== 24. ADMIN: dashboard data, reports and controls =============================== */
const pubUser = (u) => ({ id: u.id, accountId: u.public_id, username: u.username, status: u.status, createdAt: u.created_at, ageConfirmedAt: u.age_confirmed_at });
async function findUser(ctx, idOrName) {
  const s = String(idOrName);
  if (/^\d+$/.test(s)) return ctx.store.get('users', { id: Number(s) });
  if (/^BC-/.test(s)) return ctx.store.get('users', { public_id: s });
  if (s.includes('@')) { const c = await ctx.store.get('credentials', { email: s.toLowerCase() }); return c ? ctx.store.get('users', { id: c.user_id }) : null; }
  return ctx.store.userByUsername(s);
}
export async function adminOverview(ctx) {
  const c = (t, w) => ctx.store.count(t, w); const day = (d) => ({ gte: new Date(ctx.now().getTime() - d * 86400e3) });
  return {
    users: { total: await c('users', {}), new7d: await c('users', { created_at: day(7) }), new24h: await c('users', { created_at: day(1) }), suspended: await c('users', { status: 'suspended' }), banned: await c('users', { status: 'banned' }), withUsername: await c('users', { username: { ne: null } }) },
    deposits: { credited: await c('deposits', { status: 'credited' }), pending: await c('deposits', { status: 'pending' }) },
    bets: { open: await c('bets', { status: 'open' }), settled: await c('bets', { status: 'settled' }), void: await c('bets', { status: 'void' }), dueNow: await c('bets', { status: 'open', settles_at: { lte: nowD(ctx) } }) },
    purchases: await c('purchases', {}), referralsQualified: await c('referrals', { status: 'qualified' }),
    withdrawals: { pending: await c('withdrawals', { status: 'pending' }), approved: await c('withdrawals', { status: 'approved' }), paid: await c('withdrawals', { status: 'paid' }), rejected: await c('withdrawals', { status: 'rejected' }) },
    systemBalances: await ctx.store.systemBalances(),     // external|clearing (negative = total deposited), bets|pool, house|pnl, withdrawals|out ...
    ledgerProblems: await ctx.store.verifyLedger(),        // must be an empty list
    settings: await adminSettings(ctx)
  };
}
export async function adminUsers(ctx, { q, status, offset = 0 }) {
  if (q) { const u = await findUser(ctx, q); return { items: u ? [pubUser(u)] : [] }; }
  return { items: (await ctx.store.list('users', status ? { status } : {}, { order: 'id DESC', limit: 50, offset })).map(pubUser) };
}
export async function adminUserFull(ctx, idOrName) {
  const u = await findUser(ctx, idOrName); if (!u) throw new AppError(404, 'NOT_FOUND');
  const s = ctx.store; const cred = await s.get('credentials', { user_id: u.id }); const tg = await s.get('tg_identities', { user_id: u.id });
  const inviterRef = await s.get('referrals', { invitee_id: u.id }); const inviter = inviterRef ? await s.get('users', { id: inviterRef.inviter_id }) : null;
  const invitees = await s.list('referrals', { inviter_id: u.id }, { order: 'id DESC', limit: 200 });
  const locs = await s.list('user_locations', { user_id: u.id }, { order: 'id DESC', limit: 30 });
  const ipHashes = [...new Set(locs.map((l) => l.ip_hash).filter(Boolean))];
  const sameIp = [];
  for (const h of ipHashes) for (const l of await s.list('user_locations', { ip_hash: h }, { limit: 50 })) if (l.user_id !== u.id && !sameIp.includes(l.user_id)) sameIp.push(l.user_id);
  return {
    user: pubUser(u), signupReferralCode: u.signup_referral_code, referralCode: u.referral_code,
    email: cred ? { address: cred.email, verified: !!cred.email_verified_at, hasPassword: !!cred.password_hash } : null,
    telegram: tg ? { id: tg.tg_id, username: tg.username } : null,
    invitedBy: inviter ? pubUser(inviter) : null, invitees: invitees.map((r) => ({ inviteeId: r.invitee_id, status: r.status, reward: r.reward_amount, at: r.created_at })),
    locations: locs.map((l) => ({ source: l.source, country: l.country, region: l.region, city: l.city, lat: l.lat, lng: l.lng, accuracyM: l.accuracy_m, at: l.created_at, consentAt: l.consent_at })),
    accountsSharingNetwork: sameIp,
    balances: await s.balances(u.id), depositAddresses: await s.list('deposit_addresses', { user_id: u.id }, { limit: 10 }),
    deposits: await s.list('deposits', { user_id: u.id }, { order: 'id DESC', limit: 100 }), purchases: await s.list('purchases', { user_id: u.id }, { order: 'id DESC', limit: 100 }),
    bets: await s.list('bets', { user_id: u.id }, { order: 'id DESC', limit: 100 }), withdrawals: await s.list('withdrawals', { user_id: u.id }, { order: 'id DESC', limit: 100 }),
    ledger: await s.ledgerRows(u.id, 100), audit: await s.list('audit_log', { target_id: String(u.id) }, { order: 'id DESC', limit: 50 })
  };
}
export async function adminWithdrawals(ctx, { status, offset = 0 }) {
  const rows = await ctx.store.list('withdrawals', status ? { status } : {}, { order: 'id DESC', limit: 50, offset }); const items = [];
  for (const w of rows) {
    const u = await ctx.store.get('users', { id: w.user_id }); const tg = await ctx.store.get('tg_identities', { user_id: w.user_id }); const cred = await ctx.store.get('credentials', { user_id: w.user_id }); const bal = await ctx.store.balances(w.user_id);
    const refs = await qualifyingCount(ctx, w.user_id);
    items.push({ ...w, user: { id: u.id, accountId: u.public_id, username: u.username, status: u.status, telegramId: tg ? tg.tg_id : null, telegramUsername: tg ? tg.username : null, email: cred ? cred.email : null, registeredAt: u.created_at },
      qualifyingReferrals: refs, balanceNow: bal[`${srcBucket(w.asset)}|${w.asset}`] || '0', reservedNow: bal[`reserved|${w.asset}`] || '0', eligible: { minimum: dec(w.usd_value || '0') >= dec(String(ctx.cfg.minWithdrawUsdt)), referrals: refs >= ctx.cfg.requiredReferrals } });
  }
  return { items };
}
export async function adminSetStatus(ctx, adminId, idOrName, status, reason) {
  if (!['active', 'suspended', 'banned'].includes(status)) throw new AppError(400, 'BAD_STATUS');
  const u = await findUser(ctx, idOrName); if (!u) throw new AppError(404, 'NOT_FOUND');
  await ctx.store.update('users', { id: u.id }, { status });
  await audit(ctx, { actorType: 'admin', actorId: adminId, action: 'user_status', targetType: 'user', targetId: u.id, details: { from: u.status, to: status, reason: reason || null } });
  await notify(ctx, { userId: u.id, kind: 'account_status', payload: { status } });
  return { ok: true };
}
export async function adminAdjust(ctx, adminId, { userId, bucket, asset, amount, reason }) {
  if (!String(reason || '').trim()) throw new AppError(400, 'REASON_REQUIRED');
  if (!['deposit', 'earnings', 'holding'].includes(bucket) || !ASSETS.includes(asset)) throw new AppError(400, 'BAD_REQUEST');
  const a = dec(String(amount)); if (a === 0n) throw new AppError(400, 'BAD_AMOUNT');
  const u = await ctx.store.get('users', { id: Number(userId) }); if (!u) throw new AppError(404, 'NOT_FOUND');
  const j = await ctx.store.postJournal({ kind: 'admin_adjustment', idempotencyKey: `adjust:${adminId}:${newToken(8)}`, entries: [SYS('admin', 'adjustment', asset, -a), U(u.id, bucket, asset, a)], meta: { by: adminId, reason: String(reason).slice(0, 300) } });
  await audit(ctx, { actorType: 'admin', actorId: adminId, action: 'ledger_adjustment', targetType: 'user', targetId: u.id, details: { bucket, asset, amount: fmt(a), reason, journal: j.journalId } });
  return { ok: true, journalId: j.journalId };
}
const SWITCHES = ['bets_paused', 'withdrawals_paused', 'purchases_paused'];
export async function adminSettings(ctx) { const o = {}; for (const k of SWITCHES) o[k] = await isPaused(ctx, k); return o; }
export async function adminSetSetting(ctx, adminId, { key, on }) {
  if (!SWITCHES.includes(key) || typeof on !== 'boolean') throw new AppError(400, 'BAD_REQUEST');
  const cur = await ctx.store.get('settings', { key });
  if (cur) await ctx.store.update('settings', { key }, { value: { on }, updated_at: nowD(ctx) }); else await ctx.store.insert('settings', { key, value: { on }, updated_at: nowD(ctx) });
  await audit(ctx, { actorType: 'admin', actorId: adminId, action: 'setting_changed', details: { key, on } });
  return { ok: true, settings: await adminSettings(ctx) };
}
// ---- reports: where users are (country/city from the connection; exact GPS only for users who allowed it) ----
export async function adminLocationReport(ctx) {
  const sum = await ctx.store.locationSummary();
  const gps = await ctx.store.list('user_locations', { source: 'gps' }, { order: 'id DESC', limit: 200 });
  const names = new Map();
  for (const l of gps) if (!names.has(l.user_id)) { const u = await ctx.store.get('users', { id: l.user_id }); names.set(l.user_id, u ? { accountId: u.public_id, username: u.username } : {}); }
  return { countries: sum.countries, cities: sum.cities, usersWithGps: sum.gpsUsers, note: 'Country and city come from the network connection and are approximate. Exact GPS points exist only for users who tapped Allow.',
    gpsPoints: gps.map((l) => ({ ...(names.get(l.user_id) || {}), userId: l.user_id, lat: l.lat, lng: l.lng, accuracyM: l.accuracy_m, at: l.created_at })) };
}
export async function adminSharedNetworks(ctx) {
  const rows = await ctx.store.sharedIps(2); const out = [];
  for (const r of rows) { const users = []; for (const id of r.user_ids || []) { const u = await ctx.store.get('users', { id: Number(id) }); if (u) users.push(pubUser(u)); } out.push({ users: r.users, accounts: users }); }
  return { items: out };
}
const csvCell = (v) => { let s = v == null ? '' : v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
export async function adminExport(ctx, name) {
  const allowed = { users: 'users', deposits: 'deposits', bets: 'bets', withdrawals: 'withdrawals', referrals: 'referrals', purchases: 'purchases' };
  const table = allowed[name]; if (!table) throw new AppError(404, 'NOT_FOUND');
  const cols = SCHEMA[table].cols.filter((c) => !['password_hash', 'raw'].includes(c)); const lines = [cols.join(',')];
  for (let off = 0; off < 10000; off += 500) { const rows = await ctx.store.list(table, {}, { order: 'id ASC', limit: 500, offset: off }); for (const r of rows) lines.push(cols.map((c) => csvCell(r[c])).join(',')); if (rows.length < 500) break; }
  return { __csv: lines.join('\n'), filename: `${name}-${ctx.now().toISOString().slice(0, 10)}.csv` };
}

/* =============================== 25. HTTP LAYER =============================== */
const redact = (v) => (typeof v === 'string' ? v.replace(/(api_key=)[^&\s]+/gi, '$1***').replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot***') : v);
const MAX_BODY = 64 * 1024;
function readBody(req) {
  return new Promise((resolve, reject) => {
    if (req.body !== undefined && req.body !== null) return resolve(typeof req.body === 'string' ? req.body : JSON.stringify(req.body));   // already parsed by a host such as Vercel
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(new AppError(413, 'TOO_LARGE')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
const compile = (path) => { const keys = []; const re = new RegExp('^' + path.replace(/:([a-z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$'); return { re, keys }; };

export function createApp({ store, cfg, mailer, fetchImpl = globalThis.fetch, now = () => new Date(), log = (...a) => console.log(...a) }) {
  const ctx = { store, cfg, mailer, fetch: fetchImpl, now, cache: new Map(), log: (...a) => log('[bc]', ...a.map(redact)) };
  const routes = [];
  const add = (method, path, auth, fn) => routes.push({ method, ...compile(path), auth, fn });
  const cookieName = 'bc_session';
  const setCookie = (res, token, expires) => res.setHeader('Set-Cookie', `${cookieName}=${token}; Path=/; HttpOnly; Max-Age=${Math.max(0, Math.floor((expires - now().getTime()) / 1000))}; ${cfg.cookieSecure ? 'SameSite=None; Secure' : 'SameSite=Lax'}`);
  const clearCookie = (res) => res.setHeader('Set-Cookie', `${cookieName}=; Path=/; HttpOnly; Max-Age=0; ${cfg.cookieSecure ? 'SameSite=None; Secure' : 'SameSite=Lax'}`);
  const need = (cond, code = 'BAD_REQUEST') => { if (!cond) throw new AppError(400, code); };
  const off = (r) => Number(r.query.offset) || 0;

  /* --- public / session --- */
  add('GET', '/health', 'none', async () => ({ ok: true, db: await store.ping() }));
  add('POST', '/auth/telegram', 'none', (r) => telegramAuth(ctx, { initData: r.body.initData, ip: r.ip, geo: r.geo }));
  add('GET', '/auth/session', 'any', async (r) => ({ user: await profileOf(ctx, r.user) }));
  add('POST', '/auth/email/start', 'none', async (r) => { await startSignup(ctx, { email: r.body.email, ref: r.body.referralCode, ip: r.ip }); return {}; });
  add('POST', '/auth/email/verify', 'none', (r) => verifySignup(ctx, { email: r.body.email, code: r.body.code, password: r.body.password, ip: r.ip }));
  add('POST', '/auth/register', 'none', async (r, res) => { const o = await registerAccount(ctx, { ticket: r.body.ticket, username: r.body.username, ref: r.body.referralCode, ip: r.ip, geo: r.geo }); setCookie(res, o.session.token, o.session.expires.getTime()); return { user: o.user }; });
  add('POST', '/auth/login', 'none', async (r, res) => { const o = await login(ctx, { identifier: r.body.identifier, password: r.body.password, ip: r.ip, geo: r.geo }); setCookie(res, o.session.token, o.session.expires.getTime()); return { user: o.user }; });
  add('POST', '/auth/telegram-login', 'none', async (r, res) => { const o = await telegramWidgetLogin(ctx, { authData: r.body.authData, ip: r.ip, geo: r.geo }); setCookie(res, o.session.token, o.session.expires.getTime()); return { user: o.user }; });
  add('POST', '/auth/logout', 'none', async (r, res) => { await logout(ctx, r.token); clearCookie(res); return {}; });
  add('POST', '/auth/password-reset/start', 'none', async (r) => { await resetStart(ctx, { email: r.body.email, ip: r.ip }); return {}; });
  add('POST', '/auth/password-reset/confirm', 'none', async (r) => { await resetConfirm(ctx, { email: r.body.email, code: r.body.code, password: r.body.password, ip: r.ip }); return {}; });
  add('POST', '/auth/link/start', 'user', async (r) => { await linkStart(ctx, r.user, { identifier: r.body.identifier, password: r.body.password, ip: r.ip }); return {}; });
  add('POST', '/auth/link/confirm', 'user', (r) => linkConfirm(ctx, r.user, { code: r.body.code, ip: r.ip }));
  add('POST', '/auth/link/telegram-token', 'user', (r) => telegramLinkToken(ctx, r.user));

  /* --- profile --- */
  add('GET', '/profile', 'any', (r) => profileOf(ctx, r.user));
  add('POST', '/profile/username', 'user', (r) => setUsername(ctx, r.user, r.body.username));
  add('POST', '/profile/age-confirmation', 'user', (r) => { need(r.body.confirmed === true); return confirmAge(ctx, r.user, r.body.policyVersion); });
  add('POST', '/profile/email/start', 'user', async (r) => { await emailLinkStart(ctx, r.user, { email: r.body.email, ip: r.ip }); return {}; });
  add('POST', '/profile/email/verify', 'user', (r) => emailLinkVerify(ctx, r.user, { email: r.body.email, code: r.body.code, ip: r.ip }));
  add('POST', '/profile/location', 'user', (r) => saveGps(ctx, r.user, { lat: r.body.lat, lng: r.body.lng, accuracy: r.body.accuracy, consent: r.body.consent }));
  add('POST', '/profile/location/delete', 'user', (r) => deleteGps(ctx, r.user));

  /* --- money screens --- */
  add('GET', '/balances', 'user', (r) => balancesOf(ctx, r.user));
  add('GET', '/transactions', 'user', (r) => transactionsOf(ctx, r.user));
  add('GET', '/notifications', 'user', (r) => notificationsOf(ctx, r.user));
  add('GET', '/referral', 'user', (r) => referralInfo(ctx, r.user));
  add('GET', '/deposit/address', 'user', (r) => getDepositAddress(ctx, r.user, String(r.query.network || '').toUpperCase()));
  add('POST', '/buy/quote', 'user', (r) => createQuote(ctx, r.user, { coin: r.body.coin, amountUsdt: r.body.amountUsdt }));
  add('POST', '/buy/execute', 'user', (r) => executeQuote(ctx, r.user, { quoteId: r.body.quoteId }));
  add('GET', '/bets', 'user', async (r) => ({ items: (await store.list('bets', { user_id: r.user.id }, { order: 'id DESC', limit: 100 })).map(betView) }));
  add('POST', '/bets', 'user', (r) => placeBet(ctx, r.user, { coin: r.body.coin, prediction: r.body.prediction, stake: r.body.stake, idemKey: r.idemKey }));
  add('POST', '/withdrawals', 'user', (r) => createWithdrawal(ctx, r.user, { asset: r.body.asset, network: r.body.network, amount: r.body.amount, address: r.body.address, idemKey: r.idemKey }));
  add('POST', '/withdrawals/:id/cancel', 'user', (r) => cancelWithdrawal(ctx, r.user, r.params.id));
  add('POST', '/translations', 'none', (r) => translateStrings(ctx, { target: String(r.body.target || ''), strings: r.body.strings }));
  add('GET', '/prices', 'none', async () => { const o = {}; for (const c of COINS) o[c] = fmt((await spotPrice(ctx, c)).price); return o; });
  add('GET', '/chart', 'none', (r) => chartPoints(ctx, String(r.query.coin || '').toUpperCase()));

  /* --- provider callback and scheduled jobs --- */
  add('POST', '/webhooks/plisio', 'none', async (r) => { const o = await plisioCallback(ctx, { raw: r.raw, body: r.body, ip: r.ip }); return { ok: true, outcome: o.outcome }; });
  const cron = async (r, fn) => { const given = String(r.headers['x-cron-secret'] || (r.headers.authorization || '').replace(/^Bearer /i, '')); if (!cfg.cronSecret || !safeEq(given, cfg.cronSecret)) throw new AppError(401, 'UNAUTHORIZED'); return fn(); };
  for (const m of ['GET', 'POST']) {
    add(m, '/jobs/settle', 'none', (r) => cron(r, () => settleDueBets(ctx)));
    add(m, '/jobs/reconcile', 'none', (r) => cron(r, () => reconcileDeposits(ctx)));
    add(m, '/jobs/maintenance', 'none', (r) => cron(r, () => maintenance(ctx)));
  }

  /* --- admin: login --- */
  add('POST', '/admin/auth/telegram', 'none', (r) => adminAuthTelegram(ctx, { initData: r.body.initData, ip: r.ip }));
  add('POST', '/admin/auth/password', 'none', (r) => adminPassword(ctx, r.token, { password: r.body.password }));
  add('POST', '/admin/auth/totp', 'none', (r) => adminTotp(ctx, r.token, { code: r.body.code }));
  add('POST', '/admin/reauth', 'admin', (r) => adminReauth(ctx, r.token, { password: r.body.password }));
  add('POST', '/admin/logout', 'admin', async (r) => { await store.update('admin_sessions', { id: r.adminSession.id }, { revoked_at: nowD(ctx) }); return {}; });
  /* --- admin: data --- */
  add('GET', '/admin/overview', 'admin', () => adminOverview(ctx));
  add('GET', '/admin/users', 'admin', (r) => adminUsers(ctx, { q: r.query.q, status: r.query.status, offset: off(r) }));
  add('GET', '/admin/users/:id', 'admin', (r) => adminUserFull(ctx, r.params.id));
  add('POST', '/admin/users/:id/status', 'adminReauth', (r) => adminSetStatus(ctx, r.admin.id, r.params.id, r.body.status, r.body.reason));
  add('GET', '/admin/deposits', 'admin', async (r) => ({ items: await store.list('deposits', r.query.status ? { status: r.query.status } : {}, { order: 'id DESC', limit: 100, offset: off(r) }) }));
  add('GET', '/admin/bets', 'admin', async (r) => ({ items: await store.list('bets', r.query.status ? { status: r.query.status } : {}, { order: 'id DESC', limit: 100, offset: off(r) }) }));
  add('GET', '/admin/purchases', 'admin', async (r) => ({ items: await store.list('purchases', {}, { order: 'id DESC', limit: 100, offset: off(r) }) }));
  add('GET', '/admin/referrals', 'admin', async (r) => ({ items: await store.list('referrals', {}, { order: 'id DESC', limit: 100, offset: off(r) }) }));
  add('GET', '/admin/withdrawals', 'admin', (r) => adminWithdrawals(ctx, { status: r.query.status, offset: off(r) }));
  for (const act of ['approve', 'reject', 'paid']) add('POST', `/admin/withdrawals/:id/${act}`, 'adminReauth', (r) => adminDecideWithdrawal(ctx, r.admin.id, r.params.id, act, { reason: r.body.reason, txnHash: r.body.txnHash }));
  add('GET', '/admin/notifications', 'admin', async () => ({ items: await store.list('notifications', { audience: 'admin' }, { order: 'id DESC', limit: 100 }) }));
  add('GET', '/admin/audit', 'admin', async (r) => ({ items: await store.list('audit_log', {}, { order: 'id DESC', limit: 200, offset: off(r) }) }));
  add('GET', '/admin/events', 'admin', async () => ({ items: await store.list('provider_events', {}, { order: 'id DESC', limit: 100 }) }));
  add('POST', '/admin/ledger/adjust', 'adminReauth', (r) => adminAdjust(ctx, r.admin.id, r.body));
  add('GET', '/admin/settings', 'admin', () => adminSettings(ctx));
  add('POST', '/admin/settings', 'adminReauth', (r) => adminSetSetting(ctx, r.admin.id, { key: r.body.key, on: r.body.on }));
  add('POST', '/admin/jobs/:name', 'admin', async (r) => { if (r.params.name === 'settle') return settleDueBets(ctx); if (r.params.name === 'reconcile') return reconcileDeposits(ctx); throw new AppError(404, 'NOT_FOUND'); });
  /* --- admin: reports --- */
  add('GET', '/admin/reports/summary', 'admin', () => adminOverview(ctx));
  add('GET', '/admin/reports/daily', 'admin', async (r) => ({ items: await store.dailyStats(Number(r.query.days) || 30) }));
  add('GET', '/admin/reports/locations', 'admin', () => adminLocationReport(ctx));
  add('GET', '/admin/reports/shared-networks', 'admin', () => adminSharedNetworks(ctx));
  add('GET', '/admin/export/:name', 'admin', (r) => adminExport(ctx, r.params.name));

  async function handler(req, res) {
    const started = Date.now(); let status = 500;
    const send = (code, obj) => { status = code; const s = JSON.stringify(obj); res.statusCode = code; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.end(s); };
    try {
      const url = new URL(req.url, 'http://x'); const origin = req.headers.origin ? String(req.headers.origin).replace(/\/+$/, '') : '';
      const originOk = !origin || cfg.allowedOrigins.includes(origin);
      if (origin && originOk) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Access-Control-Allow-Credentials', 'true'); res.setHeader('Vary', 'Origin'); }
      if (req.method === 'OPTIONS') {
        if (!originOk) return send(403, { code: 'ORIGIN_NOT_ALLOWED' });
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Idempotency-Key'); res.setHeader('Access-Control-Max-Age', '600');
        res.statusCode = 204; return res.end();
      }
      const route = routes.map((rt) => { const m = rt.method === req.method && rt.re.exec(url.pathname); return m ? { rt, m } : null; }).find(Boolean);
      if (!route) return send(404, { code: 'NOT_FOUND' });
      const raw = req.method === 'GET' ? '' : await readBody(req);
      let body = {};
      if (raw) { try { body = JSON.parse(raw); } catch { if (/x-www-form-urlencoded/.test(req.headers['content-type'] || '')) body = Object.fromEntries(new URLSearchParams(raw)); else throw new AppError(400, 'BAD_JSON'); } }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError(400, 'BAD_JSON');
      const ip = (cfg.trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || (req.socket && req.socket.remoteAddress) || 'unknown';
      const cookies = Object.fromEntries(String(req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]));
      const bearer = (req.headers.authorization || '').replace(/^Bearer /i, '');
      const token = bearer || cookies[cookieName] || '';
      const viaCookie = !bearer && !!cookies[cookieName];
      const r = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, raw, ip, geo: geoFromHeaders(req.headers), headers: req.headers, token, params: Object.fromEntries(route.rt.keys.map((k, i) => [k, decodeURIComponent(route.m[i + 1])])), idemKey: String(req.headers['idempotency-key'] || '').trim() };
      if (viaCookie && req.method !== 'GET' && route.rt.auth !== 'none' && !(origin && originOk)) throw new AppError(403, 'ORIGIN_REQUIRED');   // blocks cross-site request forgery for cookie sessions
      if (route.rt.auth === 'user' || route.rt.auth === 'any') { const a = await authenticate(ctx, token, { allowRestricted: route.rt.auth === 'any' }); r.user = a.user; r.session = a.session; }
      if (route.rt.auth === 'admin' || route.rt.auth === 'adminReauth') { const a = await adminSession(ctx, token, { need: 'full', reauth: route.rt.auth === 'adminReauth' }); r.admin = a.admin; r.adminSession = a.session; }
      const out = await route.rt.fn(r, res);
      if (out && out.__csv !== undefined) { status = 200; res.statusCode = 200; res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`); res.setHeader('Cache-Control', 'no-store'); return res.end(out.__csv); }
      send(200, out === undefined ? {} : out);
    } catch (e) {
      if (e instanceof AppError) send(e.status, { code: e.code, message: e.message === e.code ? undefined : e.message, ...(e.extra || {}) });
      else { ctx.log('unhandled error', e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e)); send(500, { code: 'SERVER_ERROR' }); }
    } finally { if (cfg.nodeEnv !== 'test') ctx.log(`${req.method} ${String(req.url).split('?')[0]} ${status} ${Date.now() - started}ms`); }
  }
  return { handler, ctx };
}

/* =============================== 26. HOUSEKEEPING =============================== */
export async function maintenance(ctx) {
  const old = (d) => ({ lt: new Date(ctx.now().getTime() - d * 86400e3) });
  const r = { sessions: await ctx.store.del('sessions', { expires_at: old(7) }), codes: await ctx.store.del('codes', { expires_at: old(2) }), tickets: await ctx.store.del('tickets', { expires_at: old(2) }), linkTokens: await ctx.store.del('link_tokens', { expires_at: old(2) }), adminSessions: await ctx.store.del('admin_sessions', { expires_at: old(2) }) };
  if (ctx.store.purge) r.rateLimits = await ctx.store.purge();
  return r;
}

/* =============================== 27. START-UP, DATABASE CHECK, COMMANDS =============================== */
export async function bootstrap(env = process.env) {
  const cfg = loadConfig(env);
  const store = await createPgStore(cfg.databaseUrl);
  const app = createApp({ store, cfg, mailer: createMailer(cfg) });
  return { app, store, cfg };
}
async function selftest() {
  const url = process.env.DATABASE_URL; if (!url) throw new Error('Set DATABASE_URL first');
  const schema = 'bc_selftest_' + crypto.randomBytes(4).toString('hex');
  const admin = await createPgStore(url, { max: 1 });
  await admin.pool.query(`CREATE SCHEMA ${schema}`);
  const store = await createPgStore(url, { schema, max: 4 });
  const results = []; const ok = (name, pass, info = '') => { results.push(pass); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${info ? '  - ' + info : ''}`); };
  try {
    await runMigrations(store); ok('tables and rules created', true);
    const u = await store.insert('users', { public_id: 'BC-TEST000001', username: 'SelfTest' });
    ok('username unique ignoring upper/lower case', await store.insert('users', { public_id: 'BC-TEST000002', username: 'selftest' }).then(() => false, (e) => e.code === 'DUPLICATE'));
    const dep = (key, amt) => store.postJournal({ kind: 'deposit', idempotencyKey: key, entries: [SYS('external', 'clearing', 'USDT', neg(amt)), U(u.id, 'deposit', 'USDT', amt)] });
    const first = await dep('t1', '100'); const second = await dep('t1', '100');
    ok('same money event is applied only once', !first.duplicate && second.duplicate && (await store.balances(u.id))['deposit|USDT'] === '100');
    ok('cannot spend more than the balance', await store.postJournal({ kind: 'bet_stake', idempotencyKey: 't2', entries: [U(u.id, 'deposit', 'USDT', '-101'), SYS('bets', 'pool', 'USDT', '101')] }).then(() => false, (e) => e.code === 'INSUFFICIENT_FUNDS'));
    const race = await Promise.all([1, 2, 3, 4].map((i) => store.postJournal({ kind: 'bet_stake', idempotencyKey: 'race' + i, entries: [U(u.id, 'deposit', 'USDT', '-60'), SYS('bets', 'pool', 'USDT', '60')] }).then(() => 1, () => 0)));
    ok('simultaneous spending cannot overdraw', race.reduce((a, b) => a + b, 0) === 1 && (await store.balances(u.id))['deposit|USDT'] === '40', `accepted ${race.reduce((a, b) => a + b, 0)} of 4`);
    ok('ledger totals match every entry', (await store.verifyLedger()).length === 0);
    ok('ledger entries cannot be edited', await store.pool.query('UPDATE journal_entries SET amount = 1').then(() => false, () => true));
    ok('unbalanced journals are refused by the database itself', await store.pool.query(`INSERT INTO journals(kind, idempotency_key) VALUES ('x','bad1')`).then(() => store.pool.query(`INSERT INTO journal_entries(journal_id, account_id, amount) SELECT (SELECT id FROM journals WHERE idempotency_key='bad1'), id, 5 FROM accounts LIMIT 1`)).then(() => false, () => true));
    const w1 = await store.insert('withdrawals', { public_id: 'W1', user_id: u.id, idem_key: 'a', asset: 'BTC', amount: '1', address: 'x' });
    ok('only one open withdrawal per balance', await store.insert('withdrawals', { public_id: 'W2', user_id: u.id, idem_key: 'b', asset: 'BTC', amount: '1', address: 'x' }).then(() => false, (e) => e.code === 'DUPLICATE') && !!w1);
    ok('a different balance can have its own request', !!(await store.insert('withdrawals', { public_id: 'W3', user_id: u.id, idem_key: 'c', asset: 'ETH', amount: '1', address: 'x' })));
    ok('report queries run', Array.isArray((await store.dailyStats(7))) && Array.isArray((await store.locationSummary()).countries) && Array.isArray(await store.sharedIps(2)));
  } catch (e) { ok('self-test ran to the end', false, e.message); }
  finally { await admin.pool.query(`DROP SCHEMA ${schema} CASCADE`).catch(() => {}); await store.close(); await admin.close(); }
  console.log(results.every(Boolean) ? '\nALL CHECKS PASSED - your database is ready.' : '\nSOME CHECKS FAILED - do not go live. Send me this output.');
  process.exit(results.every(Boolean) ? 0 : 1);
}
async function main() {
  const cmd = process.argv[2] || 'serve';
  if (cmd === 'selftest') return selftest();
  if (cmd === 'migrate') { const cfg = loadConfig(process.env, { strict: false }); if (!cfg.databaseUrl) throw new Error('Set DATABASE_URL first'); const s = await createPgStore(cfg.databaseUrl); console.log('Applied:', (await runMigrations(s)).join(', ') || 'nothing new (already up to date)'); return s.close(); }
  const { app, cfg } = await bootstrap();
  const server = http.createServer(app.handler);
  server.listen(cfg.port, () => console.log(`BETCRYPTO backend listening on port ${cfg.port}`));
  if (cfg.enableScheduler) {
    const run = (name, fn) => setInterval(() => fn().then((r) => { if (r && (r.due || r.checked)) console.log(`[job:${name}]`, JSON.stringify(r)); }).catch((e) => console.log(`[job:${name}] failed`, e.message)), 5 * 60 * 1000);
    run('settle', () => settleDueBets(app.ctx)); run('reconcile', () => reconcileDeposits(app.ctx));
    setInterval(() => maintenance(app.ctx).catch(() => {}), 6 * 3600 * 1000);
    console.log('Built-in scheduler is ON: bet settlement and deposit re-checks run every 5 minutes.');
  }
}
// Hosting on Vercel: this file can be used as the function (export default).
let _boot;
export default async function vercelHandler(req, res) { _boot = _boot || bootstrap(); const { app } = await _boot; return app.handler(req, res); }
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e.message); process.exit(1); });
