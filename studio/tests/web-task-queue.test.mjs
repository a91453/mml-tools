import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskQueue } from '../web/task-queue.mjs';

test('busy task queue retains every waiter and drains in FIFO order', () => {
  const queue = createTaskQueue();
  const first = { id: 'first' };
  const second = { id: 'second' };
  const third = { id: 'third' };

  assert.equal(queue.enqueue(first), 1);
  assert.equal(queue.enqueue(second), 2);
  assert.equal(queue.enqueue(third), 3);
  assert.equal(queue.length, 3);
  assert.equal(queue.dequeue(), first);
  assert.equal(queue.dequeue(), second);
  assert.equal(queue.dequeue(), third);
  assert.equal(queue.dequeue(), null);
  assert.equal(queue.length, 0);
});
