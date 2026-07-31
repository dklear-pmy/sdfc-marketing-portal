import { humanizeAttr } from './format';

/* One human-friendly detail line for an activity-ledger event, shared by the
   Fan Activity table and the per-fan Activity ledger card.

   feature_json holds whatever the arm that wrote the event captured — for
   Customer.io email events that includes the subject and the internal
   campaign/newsletter name alongside plumbing ids (cio_id, delivery_id,
   newsletter_id…). People recognize subjects, not ids, so subject leads and
   plumbing is dropped; anything else falls back to filtered key: value pairs. */

/* Activities whose from_value/to_value are a flip of one named CIO attribute.
   The polarity is the INVERSE of the activity name — "Resubscribed email"
   means `unsubscribed` went true → false — so naming the attribute in the
   detail is what makes the row readable. */
const FLAG_ATTRIBUTE: Record<string, string> = {
  unsubscribed_email: 'Unsubscribed',
  resubscribed_email: 'Unsubscribed',
};

/* Identifiers and routing plumbing — never what a human is looking for. */
const NOISE_KEYS = new Set([
  'cio_id',
  'delivery_id',
  'channel',
  'campaign_id',
  'newsletter_id',
  'transactional_message_id',
  'broadcast_id',
  'action_id',
  'content_id',
  'journey_id',
  'parent_action_id',
]);

/* Sources stringify their empties differently ('' vs 'None' vs null). */
const junk = (v: unknown) =>
  v == null || ['', 'none', 'null', 'undefined'].includes(String(v).trim().toLowerCase());

function flagValue(v: unknown): string {
  const s = String(v).toLowerCase();
  if (s === 'true') return 'True';
  if (s === 'false') return 'False';
  return String(v);
}

export function ledgerEventDetail(activity: string, featureJson: string | null): string {
  if (!featureJson) return '';
  try {
    const obj = JSON.parse(featureJson) as Record<string, unknown>;
    const val = (k: string) => (junk(obj[k]) ? null : String(obj[k]).trim());

    const attr = FLAG_ATTRIBUTE[activity];
    if (attr && !junk(obj.to_value)) {
      const to = `${attr}=${flagValue(obj.to_value)}`;
      // A missing `from` means the attribute was set for the first time rather
      // than flipped, so there is no prior state to show.
      return junk(obj.from_value) ? to : `${attr}=${flagValue(obj.from_value)} → ${to}`;
    }

    const subject = val('subject');
    const name = val('campaign_name') ?? val('newsletter_name');
    if (subject || name) return [subject && `“${subject}”`, name].filter(Boolean).join(' · ');

    return Object.entries(obj)
      .filter(([k, v]) => !NOISE_KEYS.has(k) && !junk(v))
      .slice(0, 3)
      .map(([k, v]) => `${humanizeAttr(k)}: ${String(v)}`)
      .join(' · ');
  } catch {
    return featureJson;
  }
}
