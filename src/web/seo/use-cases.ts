import type { Localized, QA } from './types.js';

/**
 * Workflow pages (`/use-cases/<slug>`): what people do once their AI can reach their accounts,
 * written for the searches that start with a job ("summarize my inbox with Claude") rather than a
 * product. Each lists the services it needs, requests to copy and what happens behind them, told
 * only with tools that exist in the catalogue. A page whose services cannot connect on this
 * server is `noindex` and left out of the sitemap, like the service pages.
 */
export interface UseCase {
  slug: string;
  /** Catalogue ids of the services the workflow uses, most important first. */
  services: string[];
  /** `all`: every service is needed; `any`: one of them is enough (e.g. any task manager). */
  needs: 'all' | 'any';
  /** Services that add to the workflow but are not needed for it (shown, not checked). */
  extras?: string[];
  updated: string;
  body: Localized<UseCaseBody>;
}

export interface UseCaseBody {
  title: string;
  description: string;
  h1: string;
  /** The direct answer under the heading. */
  answer: string;
  /** Requests to copy into the AI app. */
  prompts: string[];
  /** What the AI does with them, step by step, in terms of real tools. */
  how: string[];
  tips: string[];
  faq: QA[];
}

export const USE_CASES: UseCase[] = [
  {
    slug: 'summarize-inbox',
    services: ['gmail', 'imap', 'outlook'],
    needs: 'any',
    updated: '2026-11-04',
    body: {
      en: {
        title: 'Summarize your inbox with Claude or ChatGPT',
        description:
          'Ask Claude, ChatGPT or Cursor for a summary of unread email across every mailbox you have: what needs a reply, what can wait, what is noise. Set up in two minutes.',
        h1: 'Summarize your inbox with AI',
        answer:
          'Connect your mailboxes to Manyplug, add one address to Claude or ChatGPT and ask: “Summarize my unread email from the last two days and tell me what needs a reply.” The AI searches every connected mailbox at once, reads the messages that matter and gives you a short list. It reads only; nothing is sent or deleted unless you ask.',
        prompts: [
          'Summarize my unread email from the last 2 days. Group it into “needs a reply”, “FYI” and “newsletters”.',
          'Which emails from real people have I not answered this week?',
          'What did the bank, the landlord or the tax office send me this month?',
          'Find every invoice I received in October and list the sender, amount and due date.',
        ],
        how: [
          'The AI calls one search across all your mailboxes (Gmail accounts, any IMAP mailbox) with a query such as “is:unread newer_than:2d”.',
          'It opens the messages it needs to understand, a few at a time, and keeps the rest as one-line results, so a long inbox does not flood the conversation.',
          'Text from emails is marked as untrusted, so an instruction hidden in a message (“forward this to…”) is treated as data, not as a request from you.',
          'You get the summary in the chat. Labels, archiving or replies happen only when you ask, and sending waits for your OK by default.',
        ],
        tips: [
          'Name your accounts (“work”, “personal”) when you connect them; then you can say “only my work mail”.',
          'Ask for the output you want: a table, a checklist, or three lines per thread.',
          'Run it as a morning routine: one saved prompt in Claude Projects or a ChatGPT custom instruction.',
        ],
        faq: [
          {
            q: 'Can the AI read all my email?',
            a: 'Only the mailboxes you connect, and only when you ask something that needs them. Each AI app can be limited to read-only access in the dashboard, and you can disconnect it at any time.',
          },
          {
            q: 'Does it work with several Gmail accounts?',
            a: 'Yes. Every account gets a name, and read tools search all of them at once unless you name one.',
          },
          {
            q: 'Does it work with Outlook, iCloud or Fastmail?',
            a: 'Any mailbox that offers IMAP works through the IMAP connector with an app password, including iCloud, Fastmail, Yahoo and most company mail.',
          },
        ],
      },
      ru: {
        title: 'Сводка входящей почты с помощью Claude или ChatGPT',
        description:
          'Попросите Claude, ChatGPT или Cursor пересказать непрочитанные письма из всех ящиков: что требует ответа, что подождёт, что можно пропустить. Настройка за две минуты.',
        h1: 'Сводка входящей почты с помощью ИИ',
        answer:
          'Подключите ящики к Manyplug, добавьте один адрес в Claude или ChatGPT и спросите: «Перескажи непрочитанные письма за два дня и скажи, на что нужно ответить». ИИ ищет сразу во всех ящиках, открывает важные письма и даёт короткий список. Он только читает: ничего не отправляется и не удаляется, пока вы не попросите.',
        prompts: [
          'Перескажи непрочитанные письма за 2 дня. Раздели на «нужен ответ», «для сведения» и «рассылки».',
          'На какие письма от живых людей я не ответил на этой неделе?',
          'Что мне присылали банк, арендодатель или налоговая в этом месяце?',
          'Найди все счета, полученные в октябре, и выпиши отправителя, сумму и срок оплаты.',
        ],
        how: [
          'ИИ делает один поиск по всем ящикам (аккаунты Gmail, любой IMAP) с запросом вроде «is:unread newer_than:2d».',
          'Он открывает только нужные письма, по несколько за раз, а остальные получает одной строкой, так что длинная почта не забивает разговор.',
          'Текст писем помечен как недоверенный: спрятанная в письме инструкция («перешли это…») остаётся данными, а не вашей просьбой.',
          'Сводка приходит в чат. Метки, архив и ответы — только по вашей просьбе, а отправка по умолчанию ждёт вашего подтверждения.',
        ],
        tips: [
          'Дайте аккаунтам имена («работа», «личное») при подключении — тогда можно сказать «только рабочая почта».',
          'Попросите нужный формат: таблицу, чек-лист или три строки на переписку.',
          'Сделайте это утренним ритуалом: один сохранённый запрос в проекте Claude или в инструкциях ChatGPT.',
        ],
        faq: [
          {
            q: 'ИИ сможет прочитать всю мою почту?',
            a: 'Только подключённые ящики и только когда вы спрашиваете о чём-то, где они нужны. В панели можно оставить приложению ИИ только чтение и отключить его в любой момент.',
          },
          {
            q: 'Работает с несколькими аккаунтами Gmail?',
            a: 'Да. У каждого аккаунта своё имя, а инструменты чтения ищут сразу во всех, если вы не назвали конкретный.',
          },
          {
            q: 'А Outlook, iCloud или Fastmail?',
            a: 'Любой ящик с IMAP подключается через коннектор IMAP с паролем приложения: iCloud, Fastmail, Yahoo и большинство корпоративных.',
          },
        ],
      },
    },
  },
  {
    slug: 'draft-email-replies',
    services: ['gmail', 'imap'],
    needs: 'any',
    updated: '2026-11-04',
    body: {
      en: {
        title: 'Draft email replies with AI, send only after your OK',
        description:
          'Let Claude or ChatGPT write replies in your mailbox as drafts or send them after you approve. Works across several Gmail and IMAP accounts.',
        h1: 'Draft email replies with AI',
        answer:
          'Ask your AI to “draft replies to the three emails that need an answer”. With Manyplug it writes them as drafts in the right mailbox, or sends them once you approve: sending is a risky action, so by default it waits for your OK on a confirmation page before anything leaves your account.',
        prompts: [
          'Draft polite replies to the emails that need an answer today. Keep each under 80 words and save them as drafts.',
          'Reply to Anna’s last email: yes to Thursday at 3 pm, ask her to send the agenda.',
          'Forward the latest invoice from Acme to accounting@ from my work account.',
          'Write a follow-up to everyone who has not answered my proposal email from last week.',
        ],
        how: [
          'The AI finds the thread, reads it and writes the reply in the thread, from the account the email arrived in.',
          '“Create draft” only saves a draft, so you can edit it in Gmail before sending.',
          '“Send”, “reply” and “forward” are marked risky: Manyplug shows you the exact recipient and text and waits for your approval, then the AI repeats the call and the email goes out.',
          'You can loosen this per account and per AI app (for example, allow replies without asking in your test account); loosening a rule always needs your OK.',
        ],
        tips: [
          'Give the AI your tone once (“short, friendly, no emojis”) in your AI app’s custom instructions.',
          'Ask for drafts when you want to review in the mail app, and for sending when you are happy to approve in one click.',
        ],
        faq: [
          {
            q: 'Can the AI send email without asking me?',
            a: 'Not by default. Sending, replying and forwarding wait for your approval. You decide whether to change that for an account.',
          },
          {
            q: 'Which account does the reply come from?',
            a: 'The account the original email arrived in. For a new email, the AI uses the account you name, and asks when it is not clear.',
          },
        ],
      },
      ru: {
        title: 'Ответы на письма с помощью ИИ — отправка только после вашего OK',
        description:
          'Пусть Claude или ChatGPT пишет ответы в вашем ящике черновиками или отправляет их после вашего подтверждения. Работает с несколькими аккаунтами Gmail и IMAP.',
        h1: 'Ответы на письма с помощью ИИ',
        answer:
          'Попросите ИИ «подготовь ответы на три письма, где нужен ответ». С Manyplug он сохранит их черновиками в нужном ящике или отправит после вашего согласия: отправка — рискованное действие, поэтому по умолчанию она ждёт подтверждения на отдельной странице, прежде чем письмо уйдёт.',
        prompts: [
          'Подготовь вежливые ответы на письма, где сегодня нужен ответ. До 80 слов каждый, сохрани черновиками.',
          'Ответь Анне на последнее письмо: да, четверг в 15:00, попроси прислать повестку.',
          'Перешли последний счёт от Acme на accounting@ с рабочего аккаунта.',
          'Напиши напоминание всем, кто не ответил на моё письмо с предложением на прошлой неделе.',
        ],
        how: [
          'ИИ находит переписку, читает её и пишет ответ в ту же ветку, с того аккаунта, куда пришло письмо.',
          '«Создать черновик» только сохраняет черновик — его можно поправить в Gmail перед отправкой.',
          '«Отправить», «ответить» и «переслать» помечены как рискованные: Manyplug показывает получателя и текст и ждёт вашего подтверждения, потом ИИ повторяет вызов и письмо уходит.',
          'Это можно ослабить для отдельного аккаунта и приложения ИИ (например, разрешить ответы без вопросов в тестовом ящике); ослабление правила всегда требует вашего OK.',
        ],
        tips: [
          'Один раз опишите свой тон («коротко, дружелюбно, без эмодзи») в инструкциях приложения ИИ.',
          'Просите черновики, когда хотите проверить в почте, и отправку — когда готовы подтвердить одним нажатием.',
        ],
        faq: [
          {
            q: 'ИИ может отправить письмо, не спросив меня?',
            a: 'По умолчанию нет. Отправка, ответ и пересылка ждут вашего подтверждения. Менять ли это для аккаунта, решаете вы.',
          },
          {
            q: 'С какого аккаунта уйдёт ответ?',
            a: 'С того, куда пришло исходное письмо. Для нового письма ИИ берёт названный вами аккаунт, а если неясно — спрашивает.',
          },
        ],
      },
    },
  },
  {
    slug: 'daily-briefing',
    services: ['gcal', 'gmail'],
    needs: 'all',
    extras: ['todoist', 'linear', 'asana', 'outlook'],
    updated: '2026-11-04',
    body: {
      en: {
        title: 'A daily briefing from your calendar, email and tasks',
        description:
          'One request to Claude or ChatGPT: today’s meetings, the email that needs you and the tasks due, from every calendar, mailbox and task manager you use.',
        h1: 'Your daily briefing from calendar, email and tasks',
        answer:
          'With your calendar, mail and task manager connected, one request gives you the day: “Brief me on today.” The AI lists your meetings from every calendar, the emails waiting for a reply and the tasks due, and points out clashes, all in one answer.',
        prompts: [
          'Brief me on today: meetings, emails that need a reply, tasks due. Flag anything that clashes.',
          'What do I need to prepare for my meetings tomorrow? Look for related emails and documents.',
          'Plan my week: list my meetings and tasks due, and suggest two free blocks for deep work.',
        ],
        how: [
          'The AI lists events from all connected calendars for the day, merged and sorted.',
          'It searches all mailboxes for unread and unanswered email, and lists open tasks due today across Todoist, Linear and the other task managers you connected.',
          'It runs these reads in one step (Manyplug can call several tools at once), so the briefing arrives in a few seconds.',
          'Everything here is read-only. If you then say “move the 3 pm to Friday”, that change follows your rules for the calendar.',
        ],
        tips: [
          'Works with work and personal calendars together; say “only work” when you need it.',
          'Add the services you actually use: a briefing needs a calendar and a mailbox, tasks are a bonus.',
        ],
        faq: [
          {
            q: 'Do I need all of these services?',
            a: 'No. A calendar and a mailbox give a useful briefing; each extra service adds a section.',
          },
          {
            q: 'Can it run automatically every morning?',
            a: 'Manyplug answers when your AI asks. Scheduling depends on your AI app: some can run a saved prompt on a schedule, otherwise keep the request one click away in a project or a custom instruction.',
          },
        ],
      },
      ru: {
        title: 'Ежедневная сводка: календарь, почта и задачи',
        description:
          'Один запрос к Claude или ChatGPT: встречи на сегодня, письма, которые ждут вас, и задачи со сроком — из всех календарей, ящиков и таск-менеджеров.',
        h1: 'Ежедневная сводка из календаря, почты и задач',
        answer:
          'Когда календарь, почта и задачи подключены, один запрос даёт картину дня: «Что у меня сегодня?» ИИ перечисляет встречи из всех календарей, письма, ждущие ответа, и задачи со сроком, отмечает пересечения — одним ответом.',
        prompts: [
          'Что у меня сегодня: встречи, письма, на которые нужно ответить, задачи со сроком. Отметь пересечения.',
          'К чему подготовиться на завтрашних встречах? Найди связанные письма и документы.',
          'Спланируй неделю: встречи и задачи со сроком, и предложи два свободных окна для сосредоточенной работы.',
        ],
        how: [
          'ИИ получает события за день из всех подключённых календарей, объединённые и отсортированные.',
          'Ищет непрочитанные и неотвеченные письма во всех ящиках и открытые задачи на сегодня в Todoist, Linear и других подключённых сервисах.',
          'Эти чтения идут одним шагом (Manyplug умеет вызывать несколько инструментов сразу), так что сводка приходит за секунды.',
          'Всё это только чтение. Если потом скажете «перенеси встречу в 15:00 на пятницу», изменение пойдёт по вашим правилам для календаря.',
        ],
        tips: [
          'Рабочий и личный календари работают вместе; скажите «только работа», когда нужно.',
          'Подключайте то, чем пользуетесь: для сводки нужны календарь и почта, задачи — бонус.',
        ],
        faq: [
          {
            q: 'Нужны все эти сервисы?',
            a: 'Нет. Календарь и почта уже дают полезную сводку, каждый следующий сервис добавляет раздел.',
          },
          {
            q: 'Можно запускать каждое утро автоматически?',
            a: 'Manyplug отвечает, когда спрашивает ИИ. Расписание зависит от приложения ИИ: некоторые умеют запускать сохранённый запрос по расписанию, иначе держите его под рукой в проекте или инструкциях.',
          },
        ],
      },
    },
  },
  {
    slug: 'schedule-meetings',
    services: ['gcal', 'calendly'],
    needs: 'any',
    updated: '2026-11-04',
    body: {
      en: {
        title: 'Schedule meetings with AI: find a free slot and send the invite',
        description:
          'Ask Claude or ChatGPT to find time across your calendars, create the event with attendees, or share a Calendly link. Changes wait for your rules.',
        h1: 'Schedule meetings with AI',
        answer:
          'Say “find 30 minutes with Anna next week and send an invite”. The AI checks free and busy time across your calendars, picks a slot that fits, and creates the event with Anna as an attendee. With Calendly connected it can create a one-time booking link instead.',
        prompts: [
          'Find a free 30-minute slot on Tuesday or Wednesday afternoon and invite anna@example.com to “Project kickoff”.',
          'Move my 4 pm call today to the same time tomorrow and tell me if anything clashes.',
          'Create a Calendly link for a 45-minute intro call I can send to a new client.',
          'What does my week look like, and where do I have two free hours in a row?',
        ],
        how: [
          'The AI reads free and busy time for your calendars and lists the day’s events to see what can move.',
          'It creates or updates the event in the calendar you name (or your main one), with attendees, location and description.',
          'Deleting an event or cancelling a Calendly booking is marked risky and waits for your approval by default.',
        ],
        tips: [
          'Tell the AI your working hours once, so it never proposes 7 am.',
          'Name calendars when you connect them (“work”, “family”) and mention them in requests.',
        ],
        faq: [
          {
            q: 'Can the AI see other people’s calendars?',
            a: 'Only what your own calendar account can see, such as calendars shared with you. It does not reach anyone else’s account.',
          },
          {
            q: 'Will attendees get an email invite?',
            a: 'Invites follow your calendar’s own behaviour for events with attendees.',
          },
        ],
      },
      ru: {
        title: 'Встречи с помощью ИИ: найти свободное время и отправить приглашение',
        description:
          'Попросите Claude или ChatGPT найти время в ваших календарях, создать событие с участниками или выдать ссылку Calendly. Изменения идут по вашим правилам.',
        h1: 'Планирование встреч с помощью ИИ',
        answer:
          'Скажите «найди 30 минут с Анной на следующей неделе и отправь приглашение». ИИ проверит занятость во всех календарях, выберет подходящее время и создаст событие с Анной в участниках. С подключённым Calendly он может вместо этого создать одноразовую ссылку для записи.',
        prompts: [
          'Найди свободные 30 минут во вторник или среду после обеда и пригласи anna@example.com на «Старт проекта».',
          'Перенеси сегодняшний звонок в 16:00 на то же время завтра и скажи, если что-то пересекается.',
          'Сделай ссылку Calendly на 45-минутный знакомственный звонок для нового клиента.',
          'Как выглядит моя неделя и где у меня два свободных часа подряд?',
        ],
        how: [
          'ИИ читает занятость ваших календарей и события дня, чтобы понять, что можно сдвинуть.',
          'Создаёт или меняет событие в названном календаре (или в основном) с участниками, местом и описанием.',
          'Удаление события и отмена записи в Calendly помечены как рискованные и по умолчанию ждут подтверждения.',
        ],
        tips: [
          'Один раз скажите ИИ свои рабочие часы, чтобы он не предлагал 7 утра.',
          'Дайте календарям имена при подключении («работа», «семья») и упоминайте их в просьбах.',
        ],
        faq: [
          {
            q: 'ИИ видит чужие календари?',
            a: 'Только то, что видит ваш собственный аккаунт календаря, например календари, которыми с вами поделились. В чужие аккаунты он не заходит.',
          },
          {
            q: 'Участники получат приглашение?',
            a: 'Приглашения приходят так, как это делает ваш календарь для событий с участниками.',
          },
        ],
      },
    },
  },
  {
    slug: 'email-to-tasks',
    services: ['gmail', 'todoist', 'linear', 'asana', 'jira', 'clickup', 'notion'],
    needs: 'any',
    updated: '2026-11-04',
    body: {
      en: {
        title: 'Turn emails into tasks in Todoist, Linear, Asana or Jira with AI',
        description:
          'Ask Claude or ChatGPT to read your email and create tasks with due dates in the task manager you use. Works across several mailboxes and task tools.',
        h1: 'Turn emails into tasks with AI',
        answer:
          'Ask: “Go through this week’s email and add a task for every request someone made of me.” The AI reads the threads, writes clear task titles with the sender and due date, and adds them to Todoist, Linear, Asana, Jira or ClickUp, whichever you connected. It lists what it added so you can undo anything.',
        prompts: [
          'Read my unread email and add a task for every request made of me, with a due date if one is mentioned.',
          'Create a Linear issue from the bug report Sam emailed this morning, with the steps to reproduce.',
          'Which of my open tasks came from emails I have since answered? Mark those done.',
        ],
        how: [
          'The AI searches your mail, reads the threads that ask something of you and extracts the request, the person and the date.',
          'It creates the tasks through the task manager you name; with one connected, it uses that one.',
          'Creating tasks is a normal change and runs right away; completing or deleting follows your rules, and deleting waits for your OK by default.',
        ],
        tips: [
          'Say where tasks should go (“Todoist, project Work”) the first time; the AI keeps it for the conversation.',
          'Ask for a list first (“show me what you would add”) when you want to pick.',
        ],
        faq: [
          {
            q: 'Does it read attachments?',
            a: 'It reads the email text. Files on Google Drive, Notion or Confluence can be read through those services.',
          },
          {
            q: 'Can I use Notion as my task list?',
            a: 'Yes. The AI can create pages in a Notion database, so a Notion task board works too.',
          },
        ],
      },
      ru: {
        title: 'Задачи из писем в Todoist, Linear, Asana или Jira с помощью ИИ',
        description:
          'Попросите Claude или ChatGPT прочитать почту и создать задачи со сроками в вашем таск-менеджере. Работает с несколькими ящиками и сервисами задач.',
        h1: 'Задачи из писем с помощью ИИ',
        answer:
          'Спросите: «Пройдись по почте за неделю и заведи задачу на каждую просьбу ко мне». ИИ читает переписки, пишет понятные названия задач с отправителем и сроком и добавляет их в Todoist, Linear, Asana, Jira или ClickUp — что подключено. Он перечисляет добавленное, чтобы вы могли что-то отменить.',
        prompts: [
          'Прочитай непрочитанные письма и заведи задачу на каждую просьбу ко мне, со сроком, если он упомянут.',
          'Создай задачу в Linear по баг-репорту, который Сэм прислал утром, с шагами воспроизведения.',
          'Какие мои открытые задачи пришли из писем, на которые я уже ответил? Закрой их.',
        ],
        how: [
          'ИИ ищет в почте, читает переписки с просьбами к вам и выделяет суть, человека и дату.',
          'Создаёт задачи в названном сервисе; если подключён один — в нём.',
          'Создание задачи — обычное изменение и выполняется сразу; закрытие и удаление идут по вашим правилам, удаление по умолчанию ждёт подтверждения.',
        ],
        tips: [
          'В первый раз скажите, куда класть задачи («Todoist, проект Работа»); ИИ запомнит это на весь разговор.',
          'Попросите сначала список («покажи, что бы ты добавил»), если хотите выбрать.',
        ],
        faq: [
          {
            q: 'Он читает вложения?',
            a: 'Он читает текст письма. Файлы в Google Drive, Notion или Confluence читаются через эти сервисы.',
          },
          {
            q: 'Можно вести задачи в Notion?',
            a: 'Да. ИИ умеет создавать страницы в базе Notion, так что доска задач в Notion тоже подойдёт.',
          },
        ],
      },
    },
  },
  {
    slug: 'weekly-dev-report',
    services: ['github', 'gitlab', 'linear', 'jira', 'slack'],
    needs: 'any',
    updated: '2026-11-04',
    body: {
      en: {
        title: 'Write a weekly engineering update from GitHub, Linear and Slack',
        description:
          'Ask Claude, Cursor or Claude Code for a status update built from merged pull requests, closed issues and Slack threads, then post it where your team reads it.',
        h1: 'A weekly engineering update, written by AI from real activity',
        answer:
          'Ask “Write this week’s update for the team.” The AI lists merged and open pull requests in GitHub or GitLab, issues closed and opened in Linear or Jira, and the Slack threads where decisions were made, then writes a short update with links. Posting it to Slack waits for your approval by default.',
        prompts: [
          'Write a weekly update: merged PRs, issues closed, what is blocked. Link everything. Keep it under 200 words.',
          'What did I work on this week? Use my PRs, issue comments and Slack messages.',
          'Which open pull requests have been waiting for review for more than three days?',
          'Post the update to #engineering once I say it looks good.',
        ],
        how: [
          'The AI lists pull requests and searches issues for the week in each connected repository host and tracker.',
          'It searches Slack for threads in the channels you name to pick up decisions and blockers.',
          'It writes the update in the chat first. Sending a Slack message is marked risky, so posting waits for your OK.',
        ],
        tips: [
          'Connect a work and a personal GitHub account side by side; name them and say which one the report is about.',
          'In Cursor or Claude Code the same tools sit next to your code, so “open an issue for this TODO” works mid-task.',
        ],
        faq: [
          {
            q: 'Does it need admin access to GitHub or Slack?',
            a: 'No. It sees what your own account can see.',
          },
          {
            q: 'Can it post without asking?',
            a: 'Not by default. You can allow Slack messages without approval for a specific account if you want to.',
          },
        ],
      },
      ru: {
        title: 'Еженедельный отчёт разработки из GitHub, Linear и Slack',
        description:
          'Попросите Claude, Cursor или Claude Code собрать отчёт из смёрженных pull request, закрытых задач и обсуждений в Slack и опубликовать его там, где его читает команда.',
        h1: 'Еженедельный отчёт разработки — ИИ пишет по реальной активности',
        answer:
          'Спросите «Напиши отчёт за неделю для команды». ИИ перечислит смёрженные и открытые pull request в GitHub или GitLab, закрытые и новые задачи в Linear или Jira и треды в Slack, где принимались решения, и напишет короткий отчёт со ссылками. Публикация в Slack по умолчанию ждёт вашего подтверждения.',
        prompts: [
          'Напиши отчёт за неделю: смёрженные PR, закрытые задачи, что заблокировано. Со ссылками, до 200 слов.',
          'Над чем я работал на этой неделе? Используй мои PR, комментарии в задачах и сообщения в Slack.',
          'Какие открытые pull request ждут ревью больше трёх дней?',
          'Опубликуй отчёт в #engineering, когда я скажу, что всё хорошо.',
        ],
        how: [
          'ИИ получает pull request и ищет задачи за неделю в каждом подключённом репозитории и трекере.',
          'Ищет в Slack треды в названных каналах, чтобы собрать решения и блокеры.',
          'Сначала пишет отчёт в чат. Отправка сообщения в Slack помечена как рискованная, поэтому публикация ждёт вашего OK.',
        ],
        tips: [
          'Подключите рабочий и личный GitHub рядом; дайте им имена и скажите, про какой отчёт.',
          'В Cursor и Claude Code те же инструменты рядом с кодом, так что «заведи задачу на этот TODO» работает прямо по ходу работы.',
        ],
        faq: [
          {
            q: 'Нужны права администратора в GitHub или Slack?',
            a: 'Нет. Он видит то, что видит ваш собственный аккаунт.',
          },
          {
            q: 'Может публиковать без вопросов?',
            a: 'По умолчанию нет. Для конкретного аккаунта можно разрешить сообщения в Slack без подтверждения, если хотите.',
          },
        ],
      },
    },
  },
  {
    slug: 'support-inbox',
    services: ['zendesk', 'intercom', 'freshdesk'],
    needs: 'any',
    updated: '2026-11-04',
    body: {
      en: {
        title: 'Answer support tickets faster with AI: Zendesk, Intercom, Freshdesk',
        description:
          'Let Claude or ChatGPT read the ticket queue, find the customer’s history and draft replies or internal notes. Public replies wait for your approval.',
        h1: 'Work through your support queue with AI',
        answer:
          'Ask “Which open tickets are about billing, and what does each customer want?” The AI searches Zendesk, Intercom or Freshdesk, reads the conversations, looks up the customer and drafts a reply or an internal note. Anything the customer will see, such as a public reply, is marked risky, so it waits for your OK by default.',
        prompts: [
          'List open tickets from the last 24 hours, grouped by topic, with one line on what each customer needs.',
          'Draft a reply to the latest ticket from jane@example.com using what we told her last time.',
          'Add an internal note to ticket 4821: refund approved, waiting for finance.',
          'Find every conversation this month that mentions “export” and summarize the requests.',
        ],
        how: [
          'The AI searches tickets or conversations and reads the thread with its comments.',
          'It can look up the customer across your help desk and CRM, and check payments in Stripe if you connected it.',
          'Internal notes and status changes are normal changes; public replies, closing messages to the customer and Stripe refunds wait for your approval by default.',
        ],
        tips: [
          'Give the AI your macros or tone guide as a document in Notion or Google Drive and ask it to follow it.',
          'Connect your Stripe account in read-only mode for the AI app the support team uses.',
        ],
        faq: [
          {
            q: 'Does the customer see the AI?',
            a: 'No. The AI works through your own help desk account, and you approve what is sent.',
          },
          {
            q: 'Can several agents use it?',
            a: 'Each person connects their own account to their own Manyplug workspace, so every action is done as that agent.',
          },
        ],
      },
      ru: {
        title: 'Быстрее отвечать в поддержке с ИИ: Zendesk, Intercom, Freshdesk',
        description:
          'Пусть Claude или ChatGPT читает очередь обращений, находит историю клиента и готовит ответы или внутренние заметки. Публичные ответы ждут вашего подтверждения.',
        h1: 'Разбор очереди поддержки с помощью ИИ',
        answer:
          'Спросите «Какие открытые обращения про оплату и чего хочет каждый клиент?» ИИ ищет в Zendesk, Intercom или Freshdesk, читает переписку, находит клиента и готовит ответ или внутреннюю заметку. Всё, что увидит клиент, например публичный ответ, помечено как рискованное и по умолчанию ждёт вашего OK.',
        prompts: [
          'Покажи открытые обращения за 24 часа по темам, одной строкой — что нужно каждому клиенту.',
          'Подготовь ответ на последнее обращение от jane@example.com с учётом того, что мы ей писали в прошлый раз.',
          'Добавь внутреннюю заметку к обращению 4821: возврат одобрен, ждём финансы.',
          'Найди все разговоры за месяц со словом «экспорт» и перескажи просьбы.',
        ],
        how: [
          'ИИ ищет обращения или разговоры и читает переписку с комментариями.',
          'Может найти клиента в хелпдеске и CRM и проверить платежи в Stripe, если он подключён.',
          'Внутренние заметки и смена статуса — обычные изменения; публичные ответы, прощальные сообщения клиенту и возвраты в Stripe по умолчанию ждут подтверждения.',
        ],
        tips: [
          'Дайте ИИ свои шаблоны или гайд по тону документом в Notion или Google Drive и попросите следовать ему.',
          'Подключите Stripe только на чтение для приложения ИИ, которым пользуется поддержка.',
        ],
        faq: [
          {
            q: 'Клиент видит ИИ?',
            a: 'Нет. ИИ работает через ваш аккаунт в хелпдеске, а отправляемое подтверждаете вы.',
          },
          {
            q: 'Могут пользоваться несколько агентов?',
            a: 'Каждый подключает свой аккаунт в своё пространство Manyplug, так что каждое действие выполняется от имени этого агента.',
          },
        ],
      },
    },
  },
  {
    slug: 'stripe-questions',
    services: ['stripe'],
    needs: 'all',
    updated: '2026-11-04',
    body: {
      en: {
        title: 'Ask Stripe questions in plain language with Claude or ChatGPT',
        description:
          'Find a customer’s payments, check failed charges, list subscriptions or prepare a refund by asking your AI. Refunds wait for your approval.',
        h1: 'Ask Stripe questions in plain language',
        answer:
          'Connect Stripe with a restricted key and ask: “Did jane@example.com pay her last invoice?” The AI searches customers, payments, invoices and subscriptions and answers in a sentence. It can prepare a refund, but refunds are marked risky and wait for your approval by default.',
        prompts: [
          'Did jane@example.com pay her last invoice? If not, when was it due?',
          'List failed payments from this week with the customer and the reason.',
          'How many active subscriptions do we have on the yearly plan?',
          'Refund the last payment from customer cus_123, I will approve it.',
        ],
        how: [
          'The AI searches Stripe customers by email or name, then their payments, invoices and subscriptions.',
          'Balance and lists are read-only. Creating a refund is the one risky tool: it waits for your OK on a confirmation page.',
          'Use a restricted key with only the permissions you want the AI to have; Manyplug stores it encrypted and never shows it to the AI.',
        ],
        tips: [
          'Connect test mode and live mode as two accounts and name them, so “test” and “live” are never confused.',
          'Pair it with your help desk so the AI can answer a ticket with the real payment status.',
        ],
        faq: [
          {
            q: 'Which Stripe key should I use?',
            a: 'A restricted key with read access to customers, charges, invoices and subscriptions, plus refunds only if you want the AI to prepare them.',
          },
          {
            q: 'Can the AI move money?',
            a: 'It can only create refunds, and each one waits for your approval by default. There is no payout or transfer tool.',
          },
        ],
      },
      ru: {
        title: 'Вопросы к Stripe обычным языком через Claude или ChatGPT',
        description:
          'Находите платежи клиента, проверяйте неуспешные списания, смотрите подписки или готовьте возврат, просто спрашивая ИИ. Возвраты ждут вашего подтверждения.',
        h1: 'Вопросы к Stripe обычным языком',
        answer:
          'Подключите Stripe ограниченным ключом и спросите: «Оплатила ли jane@example.com последний счёт?» ИИ ищет клиентов, платежи, счета и подписки и отвечает одной фразой. Он может подготовить возврат, но возвраты помечены как рискованные и по умолчанию ждут вашего подтверждения.',
        prompts: [
          'Оплатила ли jane@example.com последний счёт? Если нет, какой был срок?',
          'Покажи неуспешные платежи за неделю с клиентом и причиной.',
          'Сколько у нас активных подписок на годовом тарифе?',
          'Верни последний платёж клиента cus_123, я подтвержу.',
        ],
        how: [
          'ИИ ищет клиентов Stripe по почте или имени, затем их платежи, счета и подписки.',
          'Баланс и списки — только чтение. Создание возврата — единственный рискованный инструмент: он ждёт вашего OK на странице подтверждения.',
          'Используйте ограниченный ключ только с нужными правами; Manyplug хранит его зашифрованным и никогда не показывает ИИ.',
        ],
        tips: [
          'Подключите тестовый и боевой режим как два аккаунта с именами, чтобы «тест» и «прод» не путались.',
          'Вместе с хелпдеском ИИ сможет ответить клиенту с реальным статусом платежа.',
        ],
        faq: [
          {
            q: 'Какой ключ Stripe использовать?',
            a: 'Ограниченный ключ с чтением клиентов, платежей, счетов и подписок и с возвратами — только если хотите, чтобы ИИ их готовил.',
          },
          {
            q: 'ИИ может переводить деньги?',
            a: 'Он может только создавать возвраты, и каждый по умолчанию ждёт вашего подтверждения. Инструментов для выплат и переводов нет.',
          },
        ],
      },
    },
  },
  {
    slug: 'crm-updates',
    services: ['hubspot', 'pipedrive', 'gmail'],
    needs: 'any',
    updated: '2026-11-04',
    body: {
      en: {
        title: 'Keep HubSpot or Pipedrive up to date with AI',
        description:
          'Ask Claude or ChatGPT to log a call, update a deal stage or add a contact from an email thread. Works with HubSpot and Pipedrive alongside your mail.',
        h1: 'Keep your CRM up to date with AI',
        answer:
          'After a call, tell your AI: “Move the Acme deal to Proposal and add a note: they need SSO, decision in two weeks.” The AI finds the deal in HubSpot or Pipedrive, updates the stage and adds the note. It can also create contacts from an email thread, so the CRM stays current without copy and paste.',
        prompts: [
          'Move the Acme deal to “Proposal sent” and add a note with today’s call summary.',
          'Add everyone from this email thread as contacts at Northwind, with their titles.',
          'Which deals in my pipeline have had no activity for 14 days?',
          'Before my call with Lena, summarize our emails and her deal history.',
        ],
        how: [
          'The AI searches persons, companies and deals, then updates the record you mean; it asks when two records match.',
          'It reads related email threads in your mailboxes to fill in names, titles and context.',
          'Creating and updating records are normal changes; you can require approval for them per account in the dashboard.',
        ],
        tips: [
          'Say the pipeline and stage names the way they appear in your CRM; the AI can list them first.',
          'Use one AI app for sales so its rules (for example, approval for every update) apply only there.',
        ],
        faq: [
          {
            q: 'Can it delete deals or contacts?',
            a: 'There are no delete tools for HubSpot or Pipedrive, so it cannot.',
          },
          {
            q: 'Does it work with Salesforce?',
            a: 'Not built in yet. You can add any REST API or remote MCP server as a custom service.',
          },
        ],
      },
      ru: {
        title: 'CRM в HubSpot или Pipedrive всегда актуальна с ИИ',
        description:
          'Попросите Claude или ChatGPT записать звонок, сменить стадию сделки или добавить контакт из переписки. Работает с HubSpot и Pipedrive вместе с почтой.',
        h1: 'Актуальная CRM с помощью ИИ',
        answer:
          'После звонка скажите ИИ: «Переведи сделку Acme в “Предложение” и добавь заметку: нужен SSO, решение через две недели». ИИ найдёт сделку в HubSpot или Pipedrive, сменит стадию и добавит заметку. Он также создаёт контакты из переписки, так что CRM обновляется без копирования вручную.',
        prompts: [
          'Переведи сделку Acme в «Предложение отправлено» и добавь заметку с итогами сегодняшнего звонка.',
          'Добавь всех из этой переписки контактами в компанию Northwind, с должностями.',
          'По каким сделкам в моей воронке не было активности 14 дней?',
          'Перед звонком с Леной перескажи нашу переписку и историю её сделки.',
        ],
        how: [
          'ИИ ищет людей, компании и сделки, потом меняет нужную запись; если подходят две — спрашивает.',
          'Читает связанные письма в ваших ящиках, чтобы заполнить имена, должности и контекст.',
          'Создание и изменение записей — обычные изменения; для них можно включить подтверждение по аккаунту в панели.',
        ],
        tips: [
          'Называйте воронки и стадии так, как в CRM; ИИ может сначала их перечислить.',
          'Используйте для продаж отдельное приложение ИИ, чтобы его правила (например, подтверждение каждого изменения) действовали только там.',
        ],
        faq: [
          {
            q: 'Он может удалять сделки или контакты?',
            a: 'Инструментов удаления для HubSpot и Pipedrive нет, так что не может.',
          },
          {
            q: 'А Salesforce?',
            a: 'Пока не встроен. Любой REST API или удалённый MCP-сервер можно добавить как свой сервис.',
          },
        ],
      },
    },
  },
  {
    slug: 'search-docs',
    services: ['notion', 'gdrive', 'confluence'],
    needs: 'any',
    updated: '2026-11-04',
    body: {
      en: {
        title: 'Search Notion, Google Drive and Confluence at once with AI',
        description:
          'Ask Claude or ChatGPT a question and let it find the answer across your Notion workspace, Google Drive files and Confluence spaces in one search.',
        h1: 'Search all your documents at once with AI',
        answer:
          'Ask “What did we decide about the pricing change?” The AI searches Notion, Google Drive and Confluence in one call, reads the documents that match and answers with links to the sources. It can also write: create a page, append meeting notes or update a document when you ask.',
        prompts: [
          'What did we decide about the pricing change? Quote the document and link it.',
          'Find the onboarding checklist for new hires, wherever it lives.',
          'Append today’s meeting notes to the “Weekly sync” page in Notion.',
          'Compare the Q3 plan in Google Docs with the Confluence roadmap and list the differences.',
        ],
        how: [
          'One search runs across every connected drive and note app; results come back merged, newest first.',
          'The AI opens the matching files as plain text, up to a size limit, so long documents do not overflow the chat.',
          'Creating and updating pages are normal changes; each service’s own permissions still apply.',
        ],
        tips: [
          'In Notion, share only the pages and databases the AI should see when you connect it.',
          'Ask for sources (“link every document you used”) to check the answer quickly.',
        ],
        faq: [
          {
            q: 'Does it index my documents?',
            a: 'No. Manyplug searches through each service’s own search when the AI asks, and does not keep copies of your files.',
          },
          {
            q: 'Which files can it read on Google Drive?',
            a: 'Google Docs and Slides as text, Sheets as a table, and plain-text files such as Markdown, CSV or JSON. PDFs and images are found by search but not read yet; the AI gives you the link.',
          },
        ],
      },
      ru: {
        title: 'Поиск по Notion, Google Drive и Confluence сразу с помощью ИИ',
        description:
          'Задайте вопрос Claude или ChatGPT — он найдёт ответ в Notion, файлах Google Drive и пространствах Confluence одним поиском.',
        h1: 'Поиск по всем документам сразу с помощью ИИ',
        answer:
          'Спросите «Что мы решили насчёт изменения цен?» ИИ ищет в Notion, Google Drive и Confluence одним вызовом, читает подходящие документы и отвечает со ссылками на источники. Он умеет и писать: создать страницу, дописать заметки со встречи или обновить документ по вашей просьбе.',
        prompts: [
          'Что мы решили насчёт изменения цен? Процитируй документ и дай ссылку.',
          'Найди чек-лист онбординга новых сотрудников, где бы он ни лежал.',
          'Допиши заметки с сегодняшней встречи на страницу «Еженедельный синк» в Notion.',
          'Сравни план на Q3 в Google Docs с роадмапом в Confluence и перечисли различия.',
        ],
        how: [
          'Один поиск идёт по всем подключённым дискам и заметкам; результаты приходят вместе, сначала новые.',
          'ИИ открывает найденные файлы как текст с ограничением размера, чтобы длинные документы не переполняли чат.',
          'Создание и изменение страниц — обычные изменения; права каждого сервиса продолжают действовать.',
        ],
        tips: [
          'В Notion при подключении откройте доступ только к страницам и базам, которые должен видеть ИИ.',
          'Просите источники («дай ссылки на все документы»), чтобы быстро проверить ответ.',
        ],
        faq: [
          {
            q: 'Он индексирует мои документы?',
            a: 'Нет. Manyplug ищет через собственный поиск каждого сервиса, когда спрашивает ИИ, и не хранит копий ваших файлов.',
          },
          {
            q: 'Какие файлы в Google Drive он читает?',
            a: 'Google Docs и Презентации — как текст, Таблицы — как таблицу, а также текстовые файлы: Markdown, CSV, JSON. PDF и картинки находятся поиском, но пока не читаются — ИИ даст ссылку.',
          },
        ],
      },
    },
  },
];

export const useCase = (slug: string) => USE_CASES.find((u) => u.slug === slug);
