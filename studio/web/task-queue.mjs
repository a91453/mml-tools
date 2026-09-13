export function createTaskQueue() {
  const pending = [];
  return Object.freeze({
    enqueue(task) {
      pending.push(task);
      return pending.length;
    },
    dequeue() {
      return pending.shift() ?? null;
    },
    get length() {
      return pending.length;
    },
  });
}
