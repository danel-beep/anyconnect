import { randomBytes } from 'node:crypto';
import { and, count, eq, sql } from 'drizzle-orm';
import { getDefaultWorkspace } from '../core/identity.js';
import type { Db } from '../db/client.js';
import { referrals, users, workspaceMembers } from '../db/schema.js';
import type { NoticeService } from '../notices/notices.js';
import type { EntitlementService } from './entitlements.js';
import { getPlan, METRICS } from './plans.js';
import { type BillingListener, BillingService } from './service.js';

const DAY = 86_400_000;
/** How long the inviter's Pro lasts per paying invitee. */
export const REFERRAL_REWARD_DAYS = 30;
const REWARD_PLAN = 'pro';
/** Subscription provider of a Pro month given for an invite (not charged by anyone). */
export const REFERRAL_PROVIDER = 'referral';

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export const REFERRAL_CODE = /^[a-z0-9]{6,16}$/;

export type ReferralReward = 'pro_plan' | 'pro_limits' | 'already_pro';

export interface ReferralStats {
  code: string;
  link: string;
  invited: number;
  rewarded: number;
  rewardDays: number;
}

/**
 * Invites: every user has a link (`/?ref=<code>`); someone who signs up through it is recorded as
 * invited, and when they start paying, the inviter gets a month of Pro. Rewarding on payment, not
 * on sign-up, keeps fake accounts worthless. A free inviter gets the Pro plan for 30 days (several
 * rewards add up); an inviter paying for a smaller plan gets Pro limits on top of it for 30 days;
 * one already on Pro or bigger is recorded as `already_pro` (shown to admins, who can compensate).
 */
export class ReferralService implements BillingListener {
  constructor(
    private readonly deps: {
      db: Db;
      entitlements: EntitlementService;
      notices: NoticeService | undefined;
      publicUrl: string;
      now?: () => Date;
    },
  ) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** The user's invite code, created on first use. */
  async codeFor(userId: string): Promise<string> {
    const [user] = await this.deps.db
      .select({ code: users.referralCode })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (user?.code) return user.code;
    for (let attempt = 0; attempt < 5; attempt++) {
      const bytes = randomBytes(8);
      const code = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
      const [row] = await this.deps.db
        .update(users)
        .set({ referralCode: sql`coalesce(${users.referralCode}, ${code})` })
        .where(eq(users.id, userId))
        .returning({ code: users.referralCode })
        .catch((error: { code?: string; cause?: { code?: string } }) => {
          // Unique violation: someone else has this code; try another.
          if ((error.cause?.code ?? error.code) === '23505') return [];
          throw error;
        });
      if (row?.code) return row.code;
    }
    throw new Error('Could not create an invite code');
  }

  linkFor(code: string): string {
    return `${this.deps.publicUrl}/?ref=${code}`;
  }

  async stats(userId: string): Promise<ReferralStats> {
    const code = await this.codeFor(userId);
    const [row] = await this.deps.db
      .select({
        invited: count(),
        rewarded: sql<number>`count(*) filter (where ${referrals.status} = 'rewarded')`.mapWith(Number),
      })
      .from(referrals)
      .where(eq(referrals.referrerUserId, userId));
    return {
      code,
      link: this.linkFor(code),
      invited: row?.invited ?? 0,
      rewarded: row?.rewarded ?? 0,
      rewardDays: REFERRAL_REWARD_DAYS,
    };
  }

  /** Records that a new user came through an invite link. Unknown codes and self-invites are ignored. */
  async attach(newUserId: string, code: string): Promise<boolean> {
    if (!REFERRAL_CODE.test(code)) return false;
    const [referrer] = await this.deps.db
      .select({ id: users.id, status: users.status })
      .from(users)
      .where(eq(users.referralCode, code))
      .limit(1);
    if (!referrer || referrer.id === newUserId || referrer.status !== 'active') return false;
    const inserted = await this.deps.db
      .insert(referrals)
      .values({ referredUserId: newUserId, referrerUserId: referrer.id })
      .onConflictDoNothing()
      .returning({ id: referrals.referredUserId });
    return inserted.length > 0;
  }

  /** Rewards the inviter of a workspace's owner when the workspace starts paying (once per invitee). */
  async subscriptionChanged({ workspaceId, after }: Parameters<BillingListener['subscriptionChanged']>[0]) {
    if (!BillingService.isPaidByProvider(after) || after.status !== 'active') return;
    const owners = await this.deps.db
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.role, 'owner')));
    for (const { userId } of owners) await this.reward(userId);
  }

  private async reward(referredUserId: string): Promise<void> {
    const now = this.now();
    // Claim the referral first so concurrent webhooks reward once.
    const [claimed] = await this.deps.db
      .update(referrals)
      .set({ status: 'rewarded', rewardedAt: now })
      .where(and(eq(referrals.referredUserId, referredUserId), eq(referrals.status, 'signed_up')))
      .returning();
    if (!claimed) return;
    const workspace = await getDefaultWorkspace(this.deps.db, claimed.referrerUserId);
    if (!workspace) return;
    const ent = this.deps.entitlements;
    const sub = await ent.subscription(workspace.id);
    const current = ent.planFor(sub, now);
    const pro = getPlan(REWARD_PLAN);
    let reward: ReferralReward;
    let until: Date;
    if (BillingService.isPaidByProvider(sub) && current.priceMonthly < pro.priceMonthly) {
      // Paying for a smaller plan: Pro limits on top of it for a month (the plan stays as it is).
      until = new Date(now.getTime() + REFERRAL_REWARD_DAYS * DAY);
      for (const metric of METRICS) {
        const target = pro.limits[metric];
        const own = current.limits[metric];
        if (own === null) continue;
        const amount = target === null ? null : target - own;
        if (amount !== null && amount <= 0) continue;
        await ent.grant(workspace.id, { metric, amount, expiresAt: until, reason: 'referral' });
      }
      reward = 'pro_limits';
    } else if (current.priceMonthly === 0 && current.public) {
      // Free: a month of Pro; a Pro month from an earlier invite is extended.
      const running =
        sub?.provider === REFERRAL_PROVIDER && current.id === REWARD_PLAN && sub.currentPeriodEnd;
      const from = running ? sub.currentPeriodEnd!.getTime() : now.getTime();
      until = new Date(from + REFERRAL_REWARD_DAYS * DAY);
      await ent.setPlan(workspace.id, REWARD_PLAN, {
        provider: REFERRAL_PROVIDER,
        periodEnd: until,
        note: 'invite reward',
      });
      reward = 'pro_plan';
    } else {
      await this.deps.db
        .update(referrals)
        .set({ status: 'no_reward', reward: 'already_pro' })
        .where(eq(referrals.referredUserId, referredUserId));
      return;
    }
    await this.deps.db.update(referrals).set({ reward }).where(eq(referrals.referredUserId, referredUserId));
    await this.deps.notices?.notify(workspace.id, 'referral_reward', referredUserId, {
      tag: 'referral.reward',
      subject: 'email.referral.subject',
      paragraphs: [reward === 'pro_plan' ? 'email.referral.body' : 'email.referral.bodyLimits'],
      cta: { label: 'email.referral.cta', url: `${this.deps.publicUrl}/app/billing` },
      vars: {},
      dates: { date: until },
    });
  }
}
