import type { FC } from 'hono/jsx';
import type { ResolvedSetupGuide, RiskLevel, SetupStep } from '../connectors/sdk.js';
import type { Translate } from './i18n.js';
import { Icon } from './ui.js';

/**
 * A service's setup guide (from the connector's `ui.locales.*.setup`, written to the standard in
 * docs/CONNECTORS.md): how long it takes, what you need, the one thing to know first, numbered
 * steps with links straight to the right page and the form field each value goes into, steps per
 * variant (e.g. per mail provider), tips and fixes for common problems. Used next to the connect
 * form, on the dashboard's service page and on the public service page.
 */

/** Guide text with exact button and menu names in `**double asterisks**`, shown in bold. */
export const GuideText: FC<{ text: string }> = ({ text }) => (
  <>{text.split(/\*\*(.+?)\*\*/g).map((part, i) => (i % 2 ? <b>{part}</b> : part))}</>
);

/** "About 5 min · You create an API token in Todoist and paste it here." */
export const GuideSummary: FC<{ t: Translate; guide: ResolvedSetupGuide }> = ({ t, guide }) => (
  <>
    <Icon name="clock" />{' '}
    <span>
      <b class="guide-minutes">{t('guide.minutes', { minutes: String(guide.minutes) })}</b> · {guide.summary}
    </span>
  </>
);

const StepLink: FC<{ step: SetupStep }> = ({ step }) =>
  step.link ? (
    <a class="btn sm step-link" href={step.link.url} target="_blank" rel="noopener noreferrer">
      {step.link.label} <Icon name="external" />
    </a>
  ) : null;

const Steps: FC<{ t: Translate; steps: SetupStep[]; labels: Record<string, string> }> = ({
  t,
  steps,
  labels,
}) => (
  <ol class="guide-steps">
    {steps.map((step) => (
      <li>
        <span>
          <GuideText text={step.text} />
        </span>
        {step.fills?.length ? (
          <span class="guide-fills">
            {t('guide.fills')}{' '}
            {step.fills.map((key, i) => (
              <>
                {i ? ', ' : ''}
                <b>{labels[key] ?? key}</b>
              </>
            ))}
          </span>
        ) : null}
        <StepLink step={step} />
      </li>
    ))}
  </ol>
);

export interface GuideVariantPicker {
  /** Input name of the field whose value names the variant, e.g. `config.provider`. */
  field: string;
  /** Input name of an email field whose domain picks the variant while `field` is empty. */
  emailField?: string | undefined;
  domains?: Record<string, string[]> | undefined;
}

export const SetupGuideView: FC<{
  t: Translate;
  guide: ResolvedSetupGuide;
  /** In the connect form: the variant follows what the user picks or types (`/assets/site.js`). */
  picker?: GuideVariantPicker | undefined;
  /** Hide the summary line and the notice (when the page shows them above the form). */
  bare?: boolean;
}> = ({ t, guide, picker, bare }) => {
  const variants = Object.entries(guide.variants ?? {});
  const labels = guide.fieldLabels;
  return (
    <div
      data-guide={picker ? '' : undefined}
      data-guide-field={picker?.field}
      data-guide-email={picker?.emailField}
      data-guide-domains={picker?.domains ? JSON.stringify(picker.domains) : undefined}
    >
      {bare ? null : (
        <p class="guide-summary">
          <GuideSummary t={t} guide={guide} />
        </p>
      )}
      {guide.needs.length ? (
        <div class="guide-needs">
          <p class="guide-label">{t('guide.needs')}</p>
          <ul>
            {guide.needs.map((need) => (
              <li>
                <GuideText text={need} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {guide.notice && !bare ? (
        <p class="notice info guide-notice">
          <GuideText text={guide.notice} />
        </p>
      ) : null}
      <p class="guide-label">{t('guide.steps')}</p>
      <Steps t={t} steps={guide.steps} labels={labels} />
      {variants.length ? (
        <div class="guide-variants">
          <p class="guide-variants-title">{guide.variantsTitle ?? t('guide.variants')}</p>
          {variants.map(([key, variant]) => (
            <details class="guide-variant" data-variant={key}>
              <summary>
                {variant.title}
                <span class="badge accent tiny-badge" data-variant-match hidden>
                  {t('guide.detected')}
                </span>
              </summary>
              <Steps t={t} steps={variant.steps} labels={labels} />
            </details>
          ))}
        </div>
      ) : null}
      {guide.tips?.length ? (
        <ul class="guide-tips">
          {guide.tips.map((tip) => (
            <li>
              <GuideText text={tip} />
            </li>
          ))}
        </ul>
      ) : null}
      {guide.problems.length ? (
        <details class="guide-problems">
          <summary>{t('guide.problems')}</summary>
          <dl>
            {guide.problems.map((p) => (
              <>
                <dt>
                  <GuideText text={p.problem} />
                </dt>
                <dd>
                  <GuideText text={p.fix} />
                </dd>
              </>
            ))}
          </dl>
        </details>
      ) : null}
    </div>
  );
};

/** How a risk level reads for people: what the action does and whether it asks first. */
export const RISK_KEYS: Record<RiskLevel, 'risk.read' | 'risk.write' | 'risk.dangerous'> = {
  read: 'risk.read',
  write: 'risk.write',
  dangerous: 'risk.dangerous',
};

export const RiskBadge: FC<{ t: Translate; risk: RiskLevel }> = ({ t, risk }) => (
  <span class="badge">
    <span class={`dot ${risk === 'dangerous' ? 'bad' : risk === 'write' ? 'accent' : 'ok'}`} />
    {t(RISK_KEYS[risk])}
  </span>
);

/** Example requests for the AI, each with a copy button. */
export const PromptList: FC<{ t: Translate; prompts: string[]; idPrefix: string }> = ({
  t,
  prompts,
  idPrefix,
}) => (
  <ul class="prompt-list">
    {prompts.map((prompt, i) => (
      <li>
        <span id={`${idPrefix}-${i}`}>{prompt}</span>
        <button
          type="button"
          class="icon-btn"
          data-copy={`#${idPrefix}-${i}`}
          aria-label={t('ui.copy')}
          title={t('ui.copy')}
        >
          <Icon name="copy" class="copy-label" />
          <Icon name="check" class="copy-done" />
        </button>
      </li>
    ))}
  </ul>
);
