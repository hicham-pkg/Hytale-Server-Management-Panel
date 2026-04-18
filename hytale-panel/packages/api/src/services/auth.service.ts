import { eq, lt, or } from 'drizzle-orm';
import * as OTPAuth from 'otpauth';
import * as QRCode from 'qrcode';
import { getDb, schema } from '../db';
import { verifyPassword, hashPassword, generateUuid } from '../utils/crypto';
import { getConfig } from '../config';
import type { User } from '@hytale-panel/shared';

const { users, sessions } = schema;

const TOTP_PERIOD_SECONDS = 30;

// Lazy-cached placeholder Argon2 hash so that failed lookups and locked
// accounts spend roughly the same CPU as a real password verification,
// preventing username enumeration via response timing (H3).
let _placeholderHashPromise: Promise<string> | null = null;
function getPlaceholderHash(): Promise<string> {
  if (!_placeholderHashPromise) {
    _placeholderHashPromise = hashPassword(
      'placeholder-for-constant-time-compare:' + generateUuid()
    );
  }
  return _placeholderHashPromise;
}

async function burnPasswordTime(password: string): Promise<void> {
  try {
    await verifyPassword(await getPlaceholderHash(), password);
  } catch {
    // ignore — only the CPU cost matters
  }
}

function currentTotpStep(now: Date = new Date()): number {
  return Math.floor(now.getTime() / 1000 / TOTP_PERIOD_SECONDS);
}

type SessionUser = Pick<User, 'id' | 'username' | 'role' | 'totpEnabled'>;

export interface LoginResult {
  success: boolean;
  requires2fa: boolean;
  requiresTotpSetup?: boolean;
  sessionId?: string;
  user?: SessionUser;
  cookieMaxAgeSeconds?: number;
  error?: string;
}

export interface SessionValidationResult {
  valid: boolean;
  user?: SessionUser;
  pending2fa?: boolean;
  requiresTotpSetup?: boolean;
  cookieMaxAgeSeconds?: number;
}

export interface ConfirmTotpResult {
  success: boolean;
  user?: SessionUser;
  sessionId?: string;
  cookieMaxAgeSeconds?: number;
}

function toSessionUser(user: {
  id: string;
  username: string;
  role: string;
  totpEnabled: boolean;
}): SessionUser {
  return {
    id: user.id,
    username: user.username,
    role: user.role as User['role'],
    totpEnabled: user.totpEnabled,
  };
}

function getIdleTimeoutMs(role: User['role']): number {
  const config = getConfig();
  const timeoutMinutes =
    role === 'admin' ? config.adminSessionIdleTimeoutMinutes : config.sessionIdleTimeoutMinutes;

  return timeoutMinutes * 60_000;
}

function getAbsoluteExpiry(createdAt: Date): Date {
  const config = getConfig();
  return new Date(createdAt.getTime() + config.sessionMaxAgeHours * 3600_000);
}

function getSlidingExpiry(role: User['role'], createdAt: Date, now: Date): Date {
  const idleExpiry = new Date(now.getTime() + getIdleTimeoutMs(role));
  const absoluteExpiry = getAbsoluteExpiry(createdAt);
  return idleExpiry.getTime() < absoluteExpiry.getTime() ? idleExpiry : absoluteExpiry;
}

function getRemainingLifetimeSeconds(expiresAt: Date, now: Date): number {
  return Math.max(1, Math.ceil((expiresAt.getTime() - now.getTime()) / 1000));
}

async function deleteSession(sessionId: string): Promise<void> {
  const db = getDb();
  await db.delete(sessions).where(eq(sessions.id, sessionId));
}

async function getSessionContext(sessionId: string): Promise<{
  session: {
    id: string;
    userId: string;
    pending2fa: boolean;
    expiresAt: Date;
    createdAt: Date;
  };
  user: SessionUser;
  cookieMaxAgeSeconds: number;
} | null> {
  const db = getDb();

  const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  if (!session) {
    return null;
  }

  const now = new Date();
  const expiresAt = new Date(session.expiresAt);
  const createdAt = new Date(session.createdAt);
  const absoluteExpiry = getAbsoluteExpiry(createdAt);

  if (expiresAt <= now || absoluteExpiry <= now) {
    await deleteSession(sessionId);
    return null;
  }

  const [user] = await db.select().from(users).where(eq(users.id, session.userId)).limit(1);
  if (!user) {
    await deleteSession(sessionId);
    return null;
  }

  const nextExpiry = getSlidingExpiry(user.role as User['role'], createdAt, now);
  if (nextExpiry <= now) {
    await deleteSession(sessionId);
    return null;
  }

  if (nextExpiry.getTime() !== expiresAt.getTime()) {
    await db.update(sessions).set({ expiresAt: nextExpiry }).where(eq(sessions.id, sessionId));
  }

  return {
    session: {
      id: session.id,
      userId: session.userId,
      pending2fa: session.pending2fa,
      expiresAt: nextExpiry,
      createdAt,
    },
    user: toSessionUser(user),
    cookieMaxAgeSeconds: getRemainingLifetimeSeconds(nextExpiry, now),
  };
}

export async function login(
  username: string,
  password: string,
  ipAddress: string,
  userAgent: string
): Promise<LoginResult> {
  const db = getDb();
  const config = getConfig();

  const [user] = await db.select().from(users).where(eq(users.username, username)).limit(1);

  if (!user) {
    // Burn roughly equivalent CPU to a real Argon2 verify so response
    // timing does not reveal whether the username exists (H3).
    await burnPasswordTime(password);
    return { success: false, requires2fa: false, error: 'Invalid credentials' };
  }

  // Check account lockout. Return the generic message so a locked account
  // is indistinguishable from a wrong password (M10).
  if (user.lockedUntil && new Date(user.lockedUntil) > new Date()) {
    await burnPasswordTime(password);
    return { success: false, requires2fa: false, error: 'Invalid credentials' };
  }

  const passwordValid = await verifyPassword(user.passwordHash, password);
  if (!passwordValid) {
    // Increment failed attempts
    const newAttempts = user.failedLoginAttempts + 1;
    const lockUntil =
      newAttempts >= config.maxFailedLogins
        ? new Date(Date.now() + config.lockoutDurationMinutes * 60_000)
        : null;

    await db
      .update(users)
      .set({
        failedLoginAttempts: newAttempts,
        lockedUntil: lockUntil,
        updatedAt: new Date(),
      })
      .where(eq(users.id, user.id));

    return { success: false, requires2fa: false, error: 'Invalid credentials' };
  }

  // Reset failed attempts on successful password
  await db
    .update(users)
    .set({ failedLoginAttempts: 0, lockedUntil: null, updatedAt: new Date() })
    .where(eq(users.id, user.id));

  // Create session
  const sessionId = generateUuid();
  const now = new Date();
  const requiresTotpSetup = user.role === 'admin' && !user.totpEnabled;
  const expiresAt = getSlidingExpiry(user.role as User['role'], now, now);

  await db.insert(sessions).values({
    id: sessionId,
    userId: user.id,
    ipAddress,
    userAgent: userAgent?.slice(0, 500) ?? null,
    pending2fa: user.totpEnabled || requiresTotpSetup,
    expiresAt,
  });

  if (user.totpEnabled) {
    return {
      success: true,
      requires2fa: true,
      sessionId,
      cookieMaxAgeSeconds: getRemainingLifetimeSeconds(expiresAt, now),
    };
  }

  if (requiresTotpSetup) {
    return {
      success: true,
      requires2fa: false,
      requiresTotpSetup: true,
      sessionId,
      cookieMaxAgeSeconds: getRemainingLifetimeSeconds(expiresAt, now),
    };
  }

  return {
    success: true,
    requires2fa: false,
    sessionId,
    user: toSessionUser(user),
    cookieMaxAgeSeconds: getRemainingLifetimeSeconds(expiresAt, now),
  };
}

export async function verifyTotp(sessionId: string, code: string): Promise<LoginResult> {
  const db = getDb();

  const [session] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);

  if (!session || !session.pending2fa) {
    return { success: false, requires2fa: false, error: 'Invalid or expired session' };
  }

  const now = new Date();
  const expiresAt = new Date(session.expiresAt);
  const createdAt = new Date(session.createdAt);
  if (expiresAt <= now || getAbsoluteExpiry(createdAt) <= now) {
    await deleteSession(sessionId);
    return { success: false, requires2fa: false, error: 'Invalid or expired session' };
  }

  const [user] = await db.select().from(users).where(eq(users.id, session.userId)).limit(1);
  if (!user || !user.totpSecret) {
    return { success: false, requires2fa: false, error: 'TOTP not configured' };
  }

  const totp = new OTPAuth.TOTP({
    issuer: 'HytalePanel',
    label: user.username,
    algorithm: 'SHA1',
    digits: 6,
    period: TOTP_PERIOD_SECONDS,
    secret: OTPAuth.Secret.fromBase32(user.totpSecret),
  });

  const delta = totp.validate({ token: code, window: 1 });
  if (delta === null) {
    return { success: false, requires2fa: true, error: 'Invalid TOTP code' };
  }

  // Reject replay of a previously-consumed TOTP step (H1). The counter is
  // the absolute 30-second step index that the code hashed against, which
  // is monotonic across codes, so any step <= the stored high-water mark
  // has already been accepted (either as this code or a later one).
  const submittedStep = currentTotpStep(now) + delta;
  if (submittedStep <= user.lastTotpCounter) {
    return { success: false, requires2fa: true, error: 'Invalid TOTP code' };
  }

  const nextExpiry = getSlidingExpiry(user.role as User['role'], createdAt, now);
  const newSessionId = generateUuid();

  // Rotate the session UUID atomically with recording the consumed TOTP
  // step (H2). Insert-new then delete-old keeps the row-level foreign
  // keys from audit_logs / backup_metadata valid at all times.
  await db.transaction(async (tx) => {
    await tx.insert(sessions).values({
      id: newSessionId,
      userId: session.userId,
      ipAddress: session.ipAddress,
      userAgent: session.userAgent,
      pending2fa: false,
      expiresAt: nextExpiry,
      createdAt: session.createdAt,
    });
    await tx.delete(sessions).where(eq(sessions.id, sessionId));
    await tx
      .update(users)
      .set({ lastTotpCounter: submittedStep, updatedAt: new Date() })
      .where(eq(users.id, user.id));
  });

  return {
    success: true,
    requires2fa: false,
    sessionId: newSessionId,
    user: toSessionUser(user),
    cookieMaxAgeSeconds: getRemainingLifetimeSeconds(nextExpiry, now),
  };
}

export async function validateSession(
  sessionId: string,
  options: { allowAdminTotpSetup?: boolean } = {}
): Promise<SessionValidationResult> {
  const db = getDb();
  const context = await getSessionContext(sessionId);
  if (!context) {
    return { valid: false };
  }

  const requiresTotpSetup = context.user.role === 'admin' && !context.user.totpEnabled;

  if (requiresTotpSetup && !context.session.pending2fa) {
    await db.update(sessions).set({ pending2fa: true }).where(eq(sessions.id, sessionId));
  }

  if (requiresTotpSetup) {
    if (options.allowAdminTotpSetup) {
      return {
        valid: true,
        user: context.user,
        pending2fa: true,
        requiresTotpSetup: true,
        cookieMaxAgeSeconds: context.cookieMaxAgeSeconds,
      };
    }

    return { valid: false, pending2fa: true, requiresTotpSetup: true };
  }

  if (context.session.pending2fa) {
    return { valid: false, pending2fa: true };
  }

  return {
    valid: true,
    user: context.user,
    cookieMaxAgeSeconds: context.cookieMaxAgeSeconds,
  };
}

export async function destroySession(sessionId: string): Promise<void> {
  await deleteSession(sessionId);
}

export async function setupTotp(userId: string): Promise<{ secret: string; qrDataUrl: string }> {
  const db = getDb();

  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new Error('User not found');

  const secret = new OTPAuth.Secret({ size: 20 });

  const totp = new OTPAuth.TOTP({
    issuer: 'HytalePanel',
    label: user.username,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret,
  });

  const uri = totp.toString();
  const qrDataUrl = await QRCode.toDataURL(uri);

  // Store secret temporarily (not enabled until confirmed)
  await db
    .update(users)
    .set({ totpSecret: secret.base32, updatedAt: new Date() })
    .where(eq(users.id, userId));

  return { secret: secret.base32, qrDataUrl };
}

export async function confirmTotp(
  userId: string,
  code: string,
  sessionId?: string
): Promise<ConfirmTotpResult> {
  const db = getDb();

  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user || !user.totpSecret) return { success: false };

  const totp = new OTPAuth.TOTP({
    issuer: 'HytalePanel',
    label: user.username,
    algorithm: 'SHA1',
    digits: 6,
    period: TOTP_PERIOD_SECONDS,
    secret: OTPAuth.Secret.fromBase32(user.totpSecret),
  });

  const delta = totp.validate({ token: code, window: 1 });
  if (delta === null) return { success: false };

  const now = new Date();
  const submittedStep = currentTotpStep(now) + delta;
  if (submittedStep <= user.lastTotpCounter) {
    return { success: false };
  }

  if (!sessionId) {
    await db
      .update(users)
      .set({
        totpEnabled: true,
        lastTotpCounter: submittedStep,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));
    return { success: true };
  }

  // Read the session row once up front and validate it here, rather than
  // routing through getSessionContext which performs its own user lookup
  // and sliding-window update that we would have to undo/redo inside the
  // rotation transaction.
  const [session] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);

  if (!session || session.userId !== userId) {
    await db
      .update(users)
      .set({
        totpEnabled: true,
        lastTotpCounter: submittedStep,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));
    return { success: true };
  }

  const createdAt = new Date(session.createdAt);
  const expiresAt = new Date(session.expiresAt);
  if (expiresAt <= now || getAbsoluteExpiry(createdAt) <= now) {
    await deleteSession(sessionId);
    await db
      .update(users)
      .set({
        totpEnabled: true,
        lastTotpCounter: submittedStep,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));
    return { success: true };
  }

  const nextExpiry = getSlidingExpiry(user.role as User['role'], createdAt, now);
  const newSessionId = generateUuid();

  await db.transaction(async (tx) => {
    await tx.insert(sessions).values({
      id: newSessionId,
      userId: session.userId,
      ipAddress: session.ipAddress,
      userAgent: session.userAgent,
      pending2fa: false,
      expiresAt: nextExpiry,
      createdAt: session.createdAt,
    });
    await tx.delete(sessions).where(eq(sessions.id, sessionId));
    await tx
      .update(users)
      .set({
        totpEnabled: true,
        lastTotpCounter: submittedStep,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));
  });

  return {
    success: true,
    user: { ...toSessionUser(user), totpEnabled: true },
    sessionId: newSessionId,
    cookieMaxAgeSeconds: getRemainingLifetimeSeconds(nextExpiry, now),
  };
}
