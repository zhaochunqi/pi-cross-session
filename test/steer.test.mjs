import test from 'node:test';
import assert from 'node:assert/strict';
import { component, wire, message, hello, info } from './support/component.mjs';

// `delivery` is new wire surface: absent means queue, so a receiver that never
// heard of busy-steer-v1 keeps the old behaviour instead of silently "steering".
const steer = (text, overrides = {}) => message(text, { delivery: 'steer', ...overrides });

test('component/IPC: busy steer enters the running turn; absent delivery still queues', async () => {
  const a = await component('steer-sender'), b = await component('steer-receiver', { rpc: true });
  try {
    await b.busy();
    const m = steer('change direction');
    assert.equal((await wire(a, b, m)).status, 'steered');
    assert.equal(b.calls.length, 1);
    assert.equal(b.calls[0].opts.deliverAs, 'steer');
    assert.equal(info(b).states.at(-1).state, 'steered');

    // Wire compatibility: no delivery field is the old queue path.
    assert.equal((await wire(a, b, message('plain'))).status, 'queued');
    assert.equal(b.calls.length, 1);

    // Claiming the steered message leaves the turn intact and does not queue it twice.
    await b.emit('message_start', { message: { role: 'custom', ...b.calls[0].message } });
    assert.equal(info(b).states.at(-2).state, 'submitted');
    // It joins a user turn but must not upgrade it: task/control tools stay blocked.
    const gate = (toolName, input = {}) => b.emit('tool_call', { toolName, input, toolCallId: 'steer-call' });
    assert.equal((await gate('Agent', { prompt: 'x' }))?.block, true);
    assert.equal((await gate('mesh', { action: 'run' }))?.block, true);
    assert.equal(await gate('read', { path: 'a.ts' }), undefined);
    await b.settled();
    assert.equal(b.calls.length, 2, 'only the queued plain message flushes after settle');
  } finally { await b.close(); await a.close(); }
});

test('component/IPC: steer is refused when the receiver has no active turn or lacks the capability', async () => {
  const a = await component('steer-sender2'), b = await component('steer-receiver2', { rpc: true });
  try {
    // A real turn first, so a normal settle does not latch the inbox.
    await b.busy();
    assert.equal((await wire(a, b, steer('running'))).status, 'steered');
    await b.settled();

    // Idle receivers submit normally regardless of the requested delivery.
    assert.equal((await wire(a, b, steer('idle'))).status, 'submitted');
    assert.equal(b.calls.at(-1).opts.deliverAs, 'steer');
    b.controller = new AbortController(); b.ctx.signal = b.controller.signal;
    await b.emit('agent_start');
    await b.settled();

    // A busy phase without a confirmed active signal must refuse, never guess.
    await b.emit('input', { source: 'interactive' });
    b.setIdle(false);
    const before = b.calls.length;
    assert.equal((await wire(a, b, steer('unknown signal'))).status, 'busy');
    assert.equal(b.calls.length, before);

    // A sender that never negotiated busy-steer-v1 gets the status it understands:
    // its steer request falls back to the queue it already knows, not a "steered" receipt.
    await b.busy();
    const reply = await wire(a, b, steer('no capability'), { hello: hello(a, b, true, ['cancel-safe-queue-v1']) });
    assert.equal(reply.ok, true);
    assert.equal(reply.status, 'queued');
    assert.match(reply.error ?? '', /lacks busy-steer-v1/);
    assert.equal(b.calls.length, before);
  } finally { await b.close(); await a.close(); }
});

test('component/IPC: a bound child reporting into its parent goal is queued, not steered', async () => {
  const child = await component('steer-child'), parent = await component('steer-parent');
  try {
    await parent.busy();
    const { details } = await parent.tool('peer_goal', { action: 'start', objective: 'Authorized objective' });
    await parent.tool('peer_goal', { action: 'bind', goalId: details.goalId, peerIds: [child.peer.instanceId] });
    await parent.settled();

    await parent.busy();
    const reply = await wire(child, parent, steer('child status report', { goalId: details.goalId }));
    assert.equal(reply.status, 'queued');
    assert.match(reply.error ?? '', /queued, not steered/);
    assert.equal(parent.calls.length, 0, 'child report never interrupts the running parent turn');

    // Steering still works for peers that are not bound to this Host's goal.
    const other = await component('steer-other');
    try {
      assert.equal((await wire(other, parent, steer('external peer'))).status, 'steered');
      assert.equal(parent.calls.length, 1);
    } finally { await other.close(); }
  } finally { await parent.close(); await child.close(); }
});

test('component/IPC: a steer retained across cancellation is injected without user authority', async () => {
  const a = await component('steer-sender3'), b = await component('steer-receiver3', { rpc: true });
  try {
    await b.busy();
    const m = steer('cancelled work');
    assert.equal((await wire(a, b, m)).status, 'steered');
    const steered = b.calls[0].message;

    // The user aborts: the SDK keeps its steering queue, so the message can still
    // surface in a later turn. It must not become notification/user authority there.
    await b.controller.abort();
    await b.settled(false, true);
    assert.equal(info(b).stopped, true);

    await b.busy();
    await b.emit('message_start', { message: { role: 'custom', ...steered } });
    assert.ok(b.notices.some(([text]) => /steering 队列/.test(String(text))), 'user is told the cancelled message resurfaced');

    // Task creation and control stay blocked for that turn; ordinary tools do not.
    const gate = (toolName, input = {}) => b.emit('tool_call', { toolName, input, toolCallId: 'cancelled-call' });
    assert.equal((await gate('Agent', { prompt: 'x' }))?.block, true);
    assert.equal((await gate('mesh', { action: 'run' }))?.block, true);
    assert.equal(await gate('read', { path: 'a.ts' }), undefined);
  } finally { await b.close(); await a.close(); }
});
