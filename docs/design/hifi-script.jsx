// hifi-script.jsx — sample scripted conversation for the hi-fi demo
// Creative/writing flavor: blog-post drafting continuing from the handoff agent.

window.HIFI_SCRIPT = [
  // Turn 1 — user. A LONG monologue: ~60 seconds at normal pace. This is
  // the real shape of voice-first drafting — you spill a whole paragraph
  // or two in one take, and the app has to handle it without choking.
  {
    who: 'user',
    text: "Okay, I'm in the car now, let me just keep rolling on the blog post — I want to draft the whole opening out loud and we'll fix it up later. So the hook, the thing I keep coming back to, is that commuting is actually the only place where you're forced to think in full sentences. You can't edit, you can't re-open a tab, you can't go to the whiteboard. You just have to keep the thought going until it lands somewhere. And I think that's weirdly generative. Like, the number of real ideas I've had in meetings over the last year is basically zero, but the drive back from the airport on Tuesday, I had three. Three actual ideas, one of which is this blog post. And I think the reason is that at a desk, with tools, you start shaping words before you even know what you want to say — you're in the interface, not the idea. Whereas when you're driving, the interface falls away, and the only unit of thought available is the spoken sentence. Which is, I don't know, I think that's the essay. I want to argue that the commute is an underrated cognitive environment, and that voice — specifically one-way voice, not dialogue — is the format that forces you to finish a thought. And JSON, or wait, sorry, I meant JSON as in the config format earlier, not anything related to this — scratch that. So the structure I'm thinking is: open with the counterintuitive claim, then a personal anecdote, then the 'you can't backspace' line which we already have, and then land the essay on something practical — like, here's what I'd build if I believed this, which is basically this app.",
  },
  {
    who: 'ai',
    text: "Yes — and the paradox: the place with the least tools is the best place to think. Want me to draft an opening paragraph around that, or keep exploring the frame first?",
  },
  {
    who: 'user',
    text: "Keep exploring. What's the counterargument? Someone could say you think better at a desk with tools.",
  },
  {
    who: 'ai',
    text: "Right. The counter is that tools create affordances for editing, not for thinking. At a desk you start shaping words before you have the idea. In the car you have to finish the thought because you can't backspace.",
  },
  {
    who: 'user',
    text: "That's the line. 'You can't backspace.' Save that, it's going in the piece. Now draft me a two paragraph opening.",
  },
  {
    who: 'ai',
    text: "Got it. Here's a draft: The best ideas I've had this year came between exits 42 and 58 on the interstate, with nothing but my voice and a road. No whiteboards, no docs, no outline. Just the pressure of having to finish a sentence before the next merge. You can't backspace at seventy miles an hour, and it turns out that's a feature.",
  },
];

// Char-by-char streaming: split a string into chunks that look like
// real speech-to-text output (words + small pauses).
window.streamText = function streamText(text, onChar, onDone, speed = 45) {
  let i = 0;
  const id = setInterval(() => {
    if (i >= text.length) { clearInterval(id); onDone && onDone(); return; }
    onChar(text.slice(0, i + 1));
    i++;
  }, speed);
  return () => clearInterval(id);
};
