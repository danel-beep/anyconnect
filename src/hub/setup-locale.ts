import type { ConnectorLocale } from '../connectors/sdk.js';

/**
 * The setup tools' titles in Russian, for the dashboard (activity log, confirmations, rules): the
 * AI sees the English ones. One entry per action in `SETUP_ACTIONS`; a test keeps them in step.
 */
export const SETUP_LOCALE_RU: ConnectorLocale = {
  actions: {
    services: { title: 'Сервисы для подключения' },
    connect_account: { title: 'Подключить аккаунт' },
    update_account: { title: 'Изменить аккаунт' },
    test_account: { title: 'Проверить аккаунт' },
    remove_account: { title: 'Удалить аккаунт' },
    add_service: { title: 'Добавить сервис' },
    remove_service: { title: 'Удалить сервис' },
    rules: { title: 'Показать правила доступа' },
    set_rule: { title: 'Изменить правило доступа' },
    update_settings: { title: 'Изменить настройки хаба' },
    access_profiles: { title: 'Показать профили доступа' },
    create_access_profile: { title: 'Создать профиль доступа' },
    update_access_profile: { title: 'Изменить профиль доступа' },
    delete_access_profile: { title: 'Удалить профиль доступа' },
    plan: { title: 'Тариф и расход' },
    buy_plan: { title: 'Сменить тариф' },
    cancel_plan: { title: 'Отменить платный тариф' },
    team_billing: { title: 'Кто платит за команду' },
    apps: { title: 'Показать ИИ-приложения' },
    rename_app: { title: 'Переименовать ИИ-приложение' },
    disconnect_app: { title: 'Отключить ИИ-приложение' },
    check_triggers: { title: 'Проверить триггеры на новое' },
    triggers: { title: 'Показать триггеры' },
    create_trigger: { title: 'Создать триггер' },
    update_trigger: { title: 'Изменить триггер' },
    test_trigger: { title: 'Опробовать триггер на настоящем сообщении' },
    trigger_runs: { title: 'Показать запуски триггеров' },
    delete_trigger: { title: 'Удалить триггер' },
    team: { title: 'Команда' },
    share_account: { title: 'Открыть аккаунт команде' },
    invite_member: { title: 'Пригласить человека в команду' },
    remove_member: { title: 'Убрать человека из команды' },
    security: { title: 'Показать защиту входа' },
    invite: { title: 'Пригласить друзей' },
    ai_keys: { title: 'Показать API-ключи ИИ' },
    update_ai_key: { title: 'Изменить API-ключ ИИ' },
    remove_ai_key: { title: 'Удалить API-ключ ИИ' },
  },
};
