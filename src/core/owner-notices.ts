/**
 * Messages the hub sends to a workspace's owners on its own (not as an answer to them): today,
 * accounts that stopped working and what triggers report. Each notice is plain data; a channel (`OwnerNotifier`) renders
 * it in the owner's language. New notices are new `kind`s; new channels (email, web push) are new
 * notifiers.
 */
export type OwnerNotice =
  | {
      kind: 'accounts_need_reauth';
      accounts: Array<{
        /** Service name, e.g. "Gmail". */
        service: string;
        /** Account label as the owner named it. */
        account: string;
        /** The service's own words (scrubbed), if any. */
        reason: string | null;
        /** Where the owner signs in again. */
        url: string;
      }>;
    }
  | {
      /** A trigger with the `notify` action matched (or a woken AI reports back). */
      kind: 'trigger_fired';
      trigger: string;
      /** Service name, e.g. "Telegram". */
      service: string;
      account: string;
      from: string | null;
      /** Chat title or email subject. */
      title: string | null;
      /** Start of the message or email (third-party text, shown as is). */
      preview: string;
      /** What the AI did, when it was woken. */
      summary: string | null;
      url: string;
    }
  | {
      /** A trigger's action waits for the owner's confirmation and they have no Telegram linked. */
      kind: 'confirmation_waiting';
      /** What it wants to do, e.g. "Send message". */
      action: string;
      service: string;
      account: string;
      /** The confirmation page. */
      url: string;
      /** It is cancelled after this long without an answer. */
      expiresMinutes: number;
    }
  | {
      /** A trigger reached the daily limit the user set (`limit`) or its AI key did (`ai_limit`). */
      kind: 'trigger_paused';
      trigger: string;
      reason: 'limit' | 'ai_limit';
      limit: number;
      url: string;
    };

/**
 * `sent`: delivered. `no_channel`: the owner has nowhere to receive it (not an error: the dashboard
 * shows the same). `failed`: the channel exists but is not reachable now; try again later.
 */
export type NoticeDelivery = 'sent' | 'no_channel' | 'failed';

export interface OwnerNotifier {
  notify(userId: string, notice: OwnerNotice): Promise<NoticeDelivery>;
}
