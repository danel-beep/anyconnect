import { describe, expect, it } from 'vitest';
import { actionText } from '../src/connectors/sdk.js';
import { SETUP_LOCALE_RU } from '../src/hub/setup-locale.js';
import { SETUP_ACTIONS, SETUP_CONNECTOR } from '../src/hub/setup-tools.js';

describe('setup tools in the dashboard language', () => {
  it('has a Russian title for every setup action and none for actions that are gone', () => {
    const names = SETUP_ACTIONS.map((a) => a.name).sort();
    expect(Object.keys(SETUP_LOCALE_RU.actions ?? {}).sort()).toEqual(names);
  });

  it('shows the Russian title in Russian and keeps the English one for the AI and English pages', () => {
    const services = SETUP_ACTIONS.find((a) => a.name === 'services')!;
    expect(actionText(SETUP_CONNECTOR, services, 'ru').title).toBe('Сервисы для подключения');
    expect(actionText(SETUP_CONNECTOR, services, 'en').title).toBe(services.title);
  });
});
