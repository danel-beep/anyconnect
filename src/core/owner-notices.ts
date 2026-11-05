/**
 * Messages the hub sends to a workspace's owners on its own (not as an answer to them): today,
 * accounts that stopped working. Each notice is plain data; a channel (`OwnerNotifier`) renders
 * it in the owner's language. New notices are new `kind`s; new channels (email, web push) are new
 * notifiers.
 */
export type OwnerNotice = {
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
};

/**
 * `sent`: delivered. `no_channel`: the owner has nowhere to receive it (not an error: the dashboard
 * shows the same). `failed`: the channel exists but is not reachable now; try again later.
 */
export type NoticeDelivery = 'sent' | 'no_channel' | 'failed';

export interface OwnerNotifier {
  notify(userId: string, notice: OwnerNotice): Promise<NoticeDelivery>;
}
