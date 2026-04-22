// Sample data ported from docs/design/hifi-screens.jsx and hifi-script.jsx.
// Used by History/Transcript previews (disabled in V1) and by the Driving
// screen's scripted demo state machine.

export interface ParsedSession {
  raw: string;
  agent: string;
  app: string;
  channelId: string | null;
  threadId: string | null;
}

export function parseSession(raw: string): ParsedSession {
  const parts = raw.split(':');
  return {
    raw,
    agent: parts[1] || 'main',
    app: parts[2] || 'discord',
    channelId: parts[3] || null,
    threadId: parts[4] || null,
  };
}

export interface AppBrand {
  name: string;
  bg: string;
  letter: string;
}

export const HIFI_APPS: Record<string, AppBrand> = {
  discord: { name: 'Discord', bg: '#5865F2', letter: 'D' },
  whatsapp: { name: 'WhatsApp', bg: '#25D366', letter: 'W' },
  slack: { name: 'Slack', bg: '#4A154B', letter: 'S' },
  telegram: { name: 'Telegram', bg: '#229ED9', letter: 'T' },
};

export interface SessionRecord {
  id: string;
  when: string;
  duration: string;
  turns: number;
  lastLine: string;
  active?: boolean;
  channelName?: string;
  threadName?: string | null;
}

export const HIFI_SESSIONS: SessionRecord[] = [
  {
    id: 'agent:main:discord:1495266157463208138:1766284491',
    when: 'Today, 3:42pm',
    duration: '14:08',
    turns: 18,
    lastLine:
      "You can't backspace at seventy miles an hour, and it turns out that's a feature.",
    active: true,
    channelName: '#ai-writing',
    threadName: null,
  },
  {
    id: 'agent:main:discord:1487112330095788192',
    when: 'Yesterday, 8:12am',
    duration: '22:40',
    turns: 31,
    lastLine: 'Try it with the team name moved to step three and see what happens.',
    channelName: '#product',
    threadName: 'onboarding v3 rethink',
  },
  {
    id: 'agent:main:discord:1491008377213210112',
    when: 'Mon, 9:04am',
    duration: '06:22',
    turns: 9,
    lastLine: 'Three things this week: retention dip, Stripe migration, hiring.',
    channelName: '#standup',
    threadName: null,
  },
  {
    id: 'agent:main:whatsapp:15551234567@c.us',
    when: 'Sat, 11:15am',
    duration: '38:51',
    turns: 42,
    lastLine:
      'He walked in and the whole room stopped, which is exactly what he wanted.',
    channelName: 'Gym crew',
    threadName: null,
  },
  {
    id: 'agent:main:discord:1489113008224701001:1748293847',
    when: 'Thu, 7:02pm',
    duration: '11:44',
    turns: 14,
    lastLine: "I keep framing it as a work problem but it's really about my dad.",
    channelName: '#journal',
    threadName: null,
  },
];

export interface Turn {
  who: 'user' | 'ai';
  text: string;
}

export const HIFI_FULL_TRANSCRIPT: Turn[] = [
  { who: 'user', text: "Okay, I'm in the car now, let me just keep rolling on the blog post — I want to draft the whole opening out loud and we'll fix it up later." },
  { who: 'ai', text: 'Perfect. Go.' },
  { who: 'user', text: "So the hook, the thing I keep coming back to, is that commuting is actually the only place where you're forced to think in full sentences." },
  { who: 'ai', text: 'Good frame. Why full sentences specifically?' },
  { who: 'user', text: "Because you can't edit. You can't re-open a tab, you can't go to the whiteboard. You just have to keep the thought going until it lands somewhere." },
  { who: 'ai', text: "Right — the interface falls away, so the only unit of thought available is the spoken sentence." },
  { who: 'user', text: "Exactly. What's the counterargument? Someone could say you think better at a desk with tools." },
  { who: 'ai', text: "The counter is that tools create affordances for editing, not for thinking. At a desk you start shaping words before you have the idea. In the car you have to finish the thought because you can't backspace." },
  { who: 'user', text: "That's the line. 'You can't backspace.' Save that, it's going in the piece." },
  { who: 'ai', text: 'Saved. Want me to draft the opening two paragraphs?' },
  { who: 'user', text: 'Yeah, go for it.' },
  { who: 'ai', text: "Here's a draft: The best ideas I've had this year came between exits 42 and 58 on the interstate, with nothing but my voice and a road. No whiteboards, no docs, no outline. Just the pressure of having to finish a sentence before the next merge. You can't backspace at seventy miles an hour, and it turns out that's a feature." },
];
