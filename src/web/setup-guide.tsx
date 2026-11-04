import type { FC } from 'hono/jsx';
import type { RiskLevel, SetupGuide, SetupStep } from '../connectors/sdk.js';
import type { Translate } from './i18n.js';
import { Icon } from './ui.js';

/**
 * A service's setup guide (from the connector's `ui.locales.*.setup`): what you need, numbered
 * steps with links straight to the right page of the service, steps per variant (e.g. per mail
 * provider) and tips. Used next to the connect form, on the dashboard's service page and on the
 * public service page.
 */

const StepLink: FC<{ step: SetupStep }> = ({ step }) =>
  step.link ? (
    <a class="btn sm step-link" href={step.link.url} target="_blank" rel="noopener noreferrer">
      {step.link.label} <Icon name="external" />
    </a>
  ) : null;

const Steps: FC<{ steps: SetupStep[] }> = ({ steps }) => (
  <ol class="guide-steps">
    {steps.map((step) => (
      <li>
        <span>{step.text}</span>
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
  guide: SetupGuide;
  /** In the connect form: the variant follows what the user picks or types (`/assets/site.js`). */
  picker?: GuideVariantPicker | undefined;
  /** Hide the summary line (when the page shows it elsewhere). */
  bare?: boolean;
}> = ({ t, guide, picker, bare }) => {
  const variants = Object.entries(guide.variants ?? {});
  return (
    <div
      class="setup-guide"
      data-guide={picker ? '' : undefined}
      data-guide-field={picker?.field}
      data-guide-email={picker?.emailField}
      data-guide-domains={picker?.domains ? JSON.stringify(picker.domains) : undefined}
    >
      {guide.summary && !bare ? (
        <p class="guide-summary">
          <Icon name="clock" /> {guide.summary}
        </p>
      ) : null}
      <Steps steps={guide.steps} />
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
              <Steps steps={variant.steps} />
            </details>
          ))}
        </div>
      ) : null}
      {guide.tips?.length ? (
        <ul class="guide-tips">
          {guide.tips.map((tip) => (
            <li>{tip}</li>
          ))}
        </ul>
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
  <span class={`badge risk-${risk}`}>
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
