const { eventPriorities } = require('./eventConfig');

function createEventFeedStore({ priorities = eventPriorities } = {}) {
  const queue = [];

  function sortQueue() {
    queue.sort((first, second) => {
      const priorityDifference = (priorities[first.type] ?? 5) - (priorities[second.type] ?? 5);
      return priorityDifference || new Date(second.time) - new Date(first.time);
    });
  }

  return {
    getAll() {
      return [...queue].sort((first, second) => {
        const priorityDifference = (priorities[first.type] ?? 5) - (priorities[second.type] ?? 5);
        return priorityDifference || new Date(second.time) - new Date(first.time);
      });
    },
    push(entry) {
      queue.push(entry);
      sortQueue();
      return queue.length;
    },
    clear() {
      queue.length = 0;
    },
  };
}

module.exports = { createEventFeedStore };
